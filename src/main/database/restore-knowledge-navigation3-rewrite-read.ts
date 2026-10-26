import { capsuleBytesHash, capsuleJson, capsuleRecord, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { graph3Conflict } from './restore-knowledge-graph3-data'
import { assertRootRestoreIdentityOriginalBytes3, readRootRestoreIdentityGraphInputs3,
  type RootRestoreIdentityPlan3 } from './restore-knowledge-identity3-read'
import type { RootRestoreMergedContentChoices3 } from './restore-knowledge-merge3-read'
import { checkMerge3NativeStorage3 } from './restore-knowledge-merge3-native'
import { assertMerge3JsonBudget } from './restore-knowledge-merge3-storage'
import { deriveRootRestoreNavigationRewrite3 } from './restore-knowledge-navigation3-rewrite-model'

export interface RootRestoreNavigationRewritePlan3 { readonly kind: 'main-root-restore-navigation-rewrite-plan' }
type Saved = { identity: RootRestoreIdentityPlan3; choices: RootRestoreMergedContentChoices3; expectedHash: string }
const plans = new WeakMap<RootRestoreNavigationRewritePlan3, Saved>()
function choices(input?: RootRestoreMergedContentChoices3): RootRestoreMergedContentChoices3 {
  if (input === undefined) return Object.freeze({ anonymousValues: 'unresolved' })
  const value = capsuleRecord(input, ['anonymousValues'])
  if (value.anonymousValues !== 'source' && value.anonymousValues !== 'current' && value.anonymousValues !== 'unresolved')
    return graph3Conflict('navigation-rewrite-invalid-choice', null)
  return Object.freeze({ anonymousValues: value.anonymousValues })
}
async function reconstruct(identity: RootRestoreIdentityPlan3, selected: RootRestoreMergedContentChoices3) {
  // One fresh authenticated read supplies both sides, their original knowledge,
  // the durable identity allocation and every later pure transform.
  const data = await readRootRestoreIdentityGraphInputs3(identity)
  const model = deriveRootRestoreNavigationRewrite3(data, selected)
  const nativeStorageChecks = checkMerge3NativeStorage3(model.tables)
  const conflicts = [...model.conflicts, ...nativeStorageChecks.conflicts]
  await assertRootRestoreIdentityOriginalBytes3(identity)
  const body = { ...model, nativeStorageChecks, conflicts, candidateConflictFree: conflicts.length === 0,
    catalogNameNativeCheckPending: false as const, referenceRewriteComplete: false as const,
    semanticValidationComplete: false as const, acceptedCoverage: false as const, effective: false as const, permit: false as const }
  assertMerge3JsonBudget(body)
  return freezeCapsuleValue({ ...body, checkedNavigationRewriteHash:
    capsuleBytesHash('knowbook.restore.navigation3.checked-rewrite.v1\0' + capsuleJson(body)) })
}

/** A caller can choose only a finite whole anonymous-value family. It cannot
 * supply SQL rows, destination maps, resolvers or an asserted validation proof. */
export async function prepareRootRestoreNavigationRewritePlan3(identity: RootRestoreIdentityPlan3, input?: RootRestoreMergedContentChoices3) {
  const selected = choices(input), value = await reconstruct(identity, selected)
  const plan: RootRestoreNavigationRewritePlan3 = Object.freeze({ kind: 'main-root-restore-navigation-rewrite-plan' })
  plans.set(plan, { identity, choices: selected, expectedHash: value.checkedNavigationRewriteHash })
  return Object.freeze({ plan, value })
}
export async function readRootRestoreNavigationRewritePlan3(plan: RootRestoreNavigationRewritePlan3) {
  const saved = plans.get(plan)
  if (!saved) return graph3Conflict('not-an-actual-main-navigation-rewrite-plan', null)
  const value = await reconstruct(saved.identity, saved.choices)
  if (value.checkedNavigationRewriteHash !== saved.expectedHash) return graph3Conflict('navigation-rewrite-inputs-changed', null)
  return value
}
