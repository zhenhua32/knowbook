import { deriveRootRestoreProvenanceSources3 } from './restore-knowledge-provenance3-model'
import { assertRootRestoreIdentityOriginalBytes3, readRootRestoreIdentityGraphInputs3, type RootRestoreIdentityPlan3 } from './restore-knowledge-identity3-read'
import { graph3Conflict } from './restore-knowledge-graph3-data'

export interface RootRestoreProvenanceSources3 { readonly kind: 'main-root-restore-provenance-sources' }
type Saved = { identity: RootRestoreIdentityPlan3; expectedHash: string }
const sources = new WeakMap<RootRestoreProvenanceSources3, Saved>()
async function reconstruct(identity: RootRestoreIdentityPlan3) {
  const data = await readRootRestoreIdentityGraphInputs3(identity)
  const value = deriveRootRestoreProvenanceSources3(data)
  await assertRootRestoreIdentityOriginalBytes3(identity)
  return value
}
/** The complete original reader supplies every origin and captured binding.
 * A caller's source DTO or identity mapping cannot authenticate its history. */
export async function prepareRootRestoreProvenanceSources3(identity: RootRestoreIdentityPlan3) {
  const value = await reconstruct(identity)
  const source: RootRestoreProvenanceSources3 = Object.freeze({ kind: 'main-root-restore-provenance-sources' })
  sources.set(source, { identity, expectedHash: value.provenanceSourceHash })
  return Object.freeze({ source, value })
}
/** Keep no K, proof or result cache. Every read repeats the actual complete
 * SQL/material authentication and its final immutable-byte bracket. */
export async function readRootRestoreProvenanceSources3(source: RootRestoreProvenanceSources3) {
  const saved = sources.get(source)
  if (!saved) return graph3Conflict('not-an-actual-main-provenance-source', null)
  const value = await reconstruct(saved.identity)
  if (value.provenanceSourceHash !== saved.expectedHash) return graph3Conflict('provenance-source-inputs-changed', null)
  return value
}
