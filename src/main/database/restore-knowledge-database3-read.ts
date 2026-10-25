import { deriveRootRestoreDatabaseReferences3 } from './restore-knowledge-database3-model'
import { assertRootRestoreIdentityOriginalBytes3, readRootRestoreIdentityGraphInputs3, type RootRestoreIdentityPlan3 } from './restore-knowledge-identity3-read'
import { graph3Conflict } from './restore-knowledge-graph3-data'

export interface RootRestoreDatabaseReferencePlan3 { readonly kind:'main-root-restore-database-reference-plan' }
type Saved = { identity:RootRestoreIdentityPlan3; expectedHash:string }
const plans=new WeakMap<RootRestoreDatabaseReferencePlan3,Saved>()
async function reconstruct(identity:RootRestoreIdentityPlan3) {
  const inputs=await readRootRestoreIdentityGraphInputs3(identity)
  const value=deriveRootRestoreDatabaseReferences3(inputs)
  await assertRootRestoreIdentityOriginalBytes3(identity)
  return value
}
/** Only a genuine Main identity owner can supply originals and the durable
 * kernel. No returned DTO, caller mapper, callback, seed or old K is authority. */
export async function prepareRootRestoreDatabaseReferencePlan3(identity:RootRestoreIdentityPlan3) {
  const value=await reconstruct(identity)
  const plan:RootRestoreDatabaseReferencePlan3=Object.freeze({kind:'main-root-restore-database-reference-plan'})
  plans.set(plan,{identity,expectedHash:value.databaseReferenceHash})
  return Object.freeze({plan,value})
}
/** Every use reopens and authenticates the complete original closure. Reopening
 * the durable identity plan and preparing here yields the same candidate hash. */
export async function readRootRestoreDatabaseReferencePlan3(plan:RootRestoreDatabaseReferencePlan3) {
  const saved=plans.get(plan)
  if (!saved) return graph3Conflict('not-an-actual-main-database-reference-plan',null)
  const value=await reconstruct(saved.identity)
  if (value.databaseReferenceHash !== saved.expectedHash) return graph3Conflict('database-reference-inputs-changed',null)
  return value
}
