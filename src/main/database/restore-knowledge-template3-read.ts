import { deriveRootRestoreTemplateReferences3 } from './restore-knowledge-template3-model'
import { assertRootRestoreIdentityOriginalBytes3, readRootRestoreIdentityGraphInputs3, type RootRestoreIdentityPlan3 } from './restore-knowledge-identity3-read'
import { graph3Conflict } from './restore-knowledge-graph3-data'

export interface RootRestoreTemplateReferencePlan3 { readonly kind: 'main-root-restore-template-reference-plan' }
type Saved = { identity: RootRestoreIdentityPlan3; expectedHash: string }
const plans = new WeakMap<RootRestoreTemplateReferencePlan3, Saved>()
async function reconstruct(identity: RootRestoreIdentityPlan3) {
  const data = await readRootRestoreIdentityGraphInputs3(identity)
  const value = deriveRootRestoreTemplateReferences3(data)
  await assertRootRestoreIdentityOriginalBytes3(identity)
  return value
}
export async function prepareRootRestoreTemplateReferencePlan3(identity: RootRestoreIdentityPlan3) {
  const value = await reconstruct(identity)
  const plan: RootRestoreTemplateReferencePlan3 = Object.freeze({ kind: 'main-root-restore-template-reference-plan' })
  plans.set(plan, { identity, expectedHash: value.templateReferenceHash })
  return Object.freeze({ plan, value })
}
/** Never keep K, template results or caller maps. Cold reopening is performed
 * by the original/identity owners; every read repeats the complete SQL bracket. */
export async function readRootRestoreTemplateReferencePlan3(plan: RootRestoreTemplateReferencePlan3) {
  const saved = plans.get(plan)
  if (!saved) return graph3Conflict('not-an-actual-main-template-plan', null)
  const value = await reconstruct(saved.identity)
  if (value.templateReferenceHash !== saved.expectedHash) return graph3Conflict('template-reference-inputs-changed', null)
  return value
}
