import { capsuleBytesHash, capsuleJson, capsuleRecord, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { CAPSULE2_RAW_MAX_JSON_BYTES } from './restore-knowledge-capsule2-raw-model'
import { graph3Conflict } from './restore-knowledge-graph3-data'
import { assertRootRestoreIdentityOriginalBytes3, readRootRestoreIdentityGraphInputs3, type RootRestoreIdentityPlan3 } from './restore-knowledge-identity3-read'
import { deriveRootRestoreMergedContent3 } from './restore-knowledge-merge3-model'
import { checkMerge3NativeStorage3 } from './restore-knowledge-merge3-native'
import { assertMerge3JsonBudget } from './restore-knowledge-merge3-storage'

export interface RootRestoreMergedContentPlan3 { readonly kind: 'main-root-restore-merged-content-plan' }
export interface RootRestoreMergedContentChoices3 { readonly anonymousValues: 'source' | 'current' | 'unresolved' }
type Saved = { identity: RootRestoreIdentityPlan3; choices: RootRestoreMergedContentChoices3; checkedMergeHash: string }
const plans = new WeakMap<RootRestoreMergedContentPlan3, Saved>()
function choices(input?: RootRestoreMergedContentChoices3): RootRestoreMergedContentChoices3 {
  if (input === undefined) return Object.freeze({ anonymousValues: 'unresolved' })
  const row = capsuleRecord(input, ['anonymousValues'])
  if (row.anonymousValues !== 'source' && row.anonymousValues !== 'current' && row.anonymousValues !== 'unresolved')
    return graph3Conflict('merge-invalid-anonymous-value-choice', null)
  return Object.freeze({ anonymousValues: row.anonymousValues })
}
async function reconstruct(identity: RootRestoreIdentityPlan3, selected: RootRestoreMergedContentChoices3) {
  const data = await readRootRestoreIdentityGraphInputs3(identity)
  const model = deriveRootRestoreMergedContent3(data, selected), nativeStorageChecks = checkMerge3NativeStorage3(model.tables)
  const conflicts = [...model.conflicts, ...nativeStorageChecks.conflicts]
  await assertRootRestoreIdentityOriginalBytes3(identity)
  const body = { ...model, nativeStorageChecks, conflicts, conflictFree: conflicts.length === 0, candidateConflictFree: conflicts.length === 0,
    catalogNameNativeCheckPending: false as const, semanticValidationComplete: false as const,
    acceptedCoverage: false as const, effective: false as const, permit: false as const }
  assertMerge3JsonBudget(body)
  const encoded = capsuleJson(body)
  if (Buffer.byteLength(encoded) > CAPSULE2_RAW_MAX_JSON_BYTES) return graph3Conflict('merge-checked-result-budget', null)
  return freezeCapsuleValue({ ...body, checkedMergeHash: capsuleBytesHash('knowbook.restore.merge3.checked.v1\0' + encoded) })
}

/** A genuine identity owner supplies the same fresh source/current/K/kernel
 * inputs. The sole caller decision is the closed finite anonymous-value side;
 * no records, source DTOs, allocation maps, entropy or validators enter. */
export async function prepareRootRestoreMergedContentPlan3(identity: RootRestoreIdentityPlan3, input?: RootRestoreMergedContentChoices3) {
  const selected = choices(input), value = await reconstruct(identity, selected)
  const plan: RootRestoreMergedContentPlan3 = Object.freeze({ kind: 'main-root-restore-merged-content-plan' })
  plans.set(plan, { identity, choices: selected, checkedMergeHash: value.checkedMergeHash })
  return Object.freeze({ plan, value })
}
/** Only identity, a frozen finite choice and the expected hash survive reads.
 * Every call rebuilds full real inputs, the model and native comparisons, then
 * checks all original bytes. Conflict data is preview material, never an
 * accepted Root3/C, complete installation graph or permission to apply it. */
export async function readRootRestoreMergedContentPlan3(plan: RootRestoreMergedContentPlan3) {
  const saved = plans.get(plan)
  if (!saved) return graph3Conflict('not-an-actual-main-merged-content-plan', null)
  const value = await reconstruct(saved.identity, saved.choices)
  if (value.checkedMergeHash !== saved.checkedMergeHash) return graph3Conflict('merged-content-inputs-changed', null)
  return value
}
