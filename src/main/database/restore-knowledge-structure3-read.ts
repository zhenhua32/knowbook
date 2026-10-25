import { deriveRootRestoreStructureReferences3 } from './restore-knowledge-structure3-model'
import { assertRootRestoreIdentityOriginalBytes3, readRootRestoreIdentityGraphInputs3, type RootRestoreIdentityPlan3 } from './restore-knowledge-identity3-read'
import { graph3Conflict } from './restore-knowledge-graph3-data'

export interface RootRestoreStructureReferencePlan3 { readonly kind: 'main-root-restore-structure-reference-plan' }
type Saved = { identity: RootRestoreIdentityPlan3; expectedHash: string }
const plans = new WeakMap<RootRestoreStructureReferencePlan3, Saved>()
async function reconstruct(identity: RootRestoreIdentityPlan3) {
  const inputs = await readRootRestoreIdentityGraphInputs3(identity)
  const value = deriveRootRestoreStructureReferences3(inputs)
  await assertRootRestoreIdentityOriginalBytes3(identity)
  return value
}
/** Only the actual Main identity owner supplies originals and the persistent
 * kernel. This is an intermediate column plan, never a validated group wire. */
export async function prepareRootRestoreStructureReferencePlan3(identity: RootRestoreIdentityPlan3) {
  const value = await reconstruct(identity)
  const plan: RootRestoreStructureReferencePlan3 = Object.freeze({ kind: 'main-root-restore-structure-reference-plan' })
  plans.set(plan, { identity, expectedHash: value.structureReferenceHash })
  return Object.freeze({ plan, value })
}
/** Rebuild all complete SQL/K/content/assets and both transforms on every use.
 * Reopening the identity owner from copied originals reproduces this result. */
export async function readRootRestoreStructureReferencePlan3(plan: RootRestoreStructureReferencePlan3) {
  const saved = plans.get(plan)
  if (!saved) return graph3Conflict('not-an-actual-main-structure-reference-plan', null)
  const value = await reconstruct(saved.identity)
  if (value.structureReferenceHash !== saved.expectedHash) return graph3Conflict('structure-reference-inputs-changed', null)
  return value
}
