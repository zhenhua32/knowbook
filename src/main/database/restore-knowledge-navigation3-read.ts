import { deriveRootRestoreNavigationRewriteInputs3 } from './restore-knowledge-navigation3-model'
import { assertRootRestoreIdentityOriginalBytes3, readRootRestoreIdentityGraphInputs3, type RootRestoreIdentityPlan3 } from './restore-knowledge-identity3-read'
import { graph3Conflict } from './restore-knowledge-graph3-data'

export interface RootRestoreNavigationRewriteInputs3 { readonly kind: 'main-root-restore-navigation-rewrite-inputs' }
type Saved = { identity: RootRestoreIdentityPlan3; expectedHash: string }
const sources = new WeakMap<RootRestoreNavigationRewriteInputs3, Saved>()
async function reconstruct(identity: RootRestoreIdentityPlan3) {
  const data = await readRootRestoreIdentityGraphInputs3(identity)
  const value = deriveRootRestoreNavigationRewriteInputs3(data)
  await assertRootRestoreIdentityOriginalBytes3(identity)
  return value
}
/** Main-owned original reads supply the immutable source graph and durable
 * allocation together. No caller URL resolver, DTO or map grants provenance. */
export async function prepareRootRestoreNavigationRewriteInputs3(identity: RootRestoreIdentityPlan3) {
  const value = await reconstruct(identity)
  const source: RootRestoreNavigationRewriteInputs3 = Object.freeze({ kind: 'main-root-restore-navigation-rewrite-inputs' })
  sources.set(source, { identity, expectedHash: value.navigationInputHash })
  return Object.freeze({ source, value })
}
export async function readRootRestoreNavigationRewriteInputs3(source: RootRestoreNavigationRewriteInputs3) {
  const saved = sources.get(source)
  if (!saved) return graph3Conflict('not-an-actual-main-navigation-input', null)
  const value = await reconstruct(saved.identity)
  if (value.navigationInputHash !== saved.expectedHash) return graph3Conflict('navigation-original-inputs-changed', null)
  return value
}
