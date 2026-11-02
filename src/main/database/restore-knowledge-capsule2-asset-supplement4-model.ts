// Archive4 compact observation2 commitments. Legacy descriptor1 is unchanged.
import { capsuleBytesHash, capsuleJson, capsuleRecord, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { validateCapsule2AssetScopeSupplementDescriptor3 } from './restore-knowledge-capsule2-asset-supplement-model'
import type { Root3SupplementalAssetObservation4 } from './restore-knowledge-assets4-supplement'
export interface Capsule2AssetScopeSupplementDescriptor4 {
  readonly version: 2; readonly observerVersion: 2; readonly sourceContentHash: string; readonly observationHash: string
  readonly scopeCount: number; readonly referenceCount: number; readonly referenceUris: readonly string[]
  readonly unsupportedHolders: { readonly count: number; readonly hash: string }
  readonly contextBindingsHash: string; readonly settledBindingsHash: string; readonly pendingPortableBindingsHash: string
  readonly settledPortableBindingsHash: string; readonly baseManifestHash: string; readonly settledEvidenceHash: string
}
const hash = (domain: string, value: unknown) => capsuleBytesHash(domain + '\0' + capsuleJson(value))
const fail = (reason: string): never => { throw new Error('capsule4 supplemental descriptor: ' + reason) }
const digest = (value: unknown): string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : fail('缺准确hash')
export function describeCapsule2AssetScopeSupplement4(value: Root3SupplementalAssetObservation4): Capsule2AssetScopeSupplementDescriptor4 {
  const referenceCount = value.scopes.reduce((n, scope) => n + scope.destinations.length, 0)
  if (!Number.isSafeInteger(referenceCount)) return fail('引用总数越界')
  return freezeCapsuleValue({ version: 2, observerVersion: 2, sourceContentHash: value.sourceContentHash, observationHash: value.observationHash,
    scopeCount: value.scopes.length, referenceCount, referenceUris: [...new Set(value.scopes.flatMap(scope => scope.destinations.map(item => item.uri)))].sort(),
    unsupportedHolders: { count: value.unsupportedHolders.length, hash: hash('knowbook.capsule4.asset-supplement-unsupported.v2', value.unsupportedHolders) },
    contextBindingsHash: hash('knowbook.capsule4.asset-supplement-contexts.v2', value.contextBindings),
    settledBindingsHash: hash('knowbook.capsule4.asset-supplement-settled-working.v2', value.settledBindings),
    pendingPortableBindingsHash: hash('knowbook.capsule4.asset-supplement-pending-assets.v2', value.pendingPortableBindings),
    settledPortableBindingsHash: hash('knowbook.capsule4.asset-supplement-settled-portable.v1', value.settledPortableBindings),
    baseManifestHash: value.baseManifestHash, settledEvidenceHash: value.settledEvidenceHash })
}
export function validateCapsule2AssetScopeSupplementDescriptor4(value: unknown): Capsule2AssetScopeSupplementDescriptor4 {
  const row = capsuleRecord(value, ['version','observerVersion','sourceContentHash','observationHash','scopeCount','referenceCount','referenceUris',
    'unsupportedHolders','contextBindingsHash','settledBindingsHash','pendingPortableBindingsHash','settledPortableBindingsHash','baseManifestHash','settledEvidenceHash'])
  if (row.version !== 2 || row.observerVersion !== 2) return fail('未知observer/descriptor版本')
  const { version: _v, observerVersion: _o, settledPortableBindingsHash, baseManifestHash, settledEvidenceHash, ...old } = row
  // Pure shared grammar only; no v1 observation or authority is minted.
  const legacy = validateCapsule2AssetScopeSupplementDescriptor3({ ...old, version: 1, observerVersion: 1 })
  return freezeCapsuleValue({ ...legacy, version: 2, observerVersion: 2,
    settledPortableBindingsHash: digest(settledPortableBindingsHash), baseManifestHash: digest(baseManifestHash), settledEvidenceHash: digest(settledEvidenceHash) })
}
export function capsule2CombinedAssetUris4(base: readonly string[], supplemental: Capsule2AssetScopeSupplementDescriptor4) {
  return [...new Set([...base, ...supplemental.referenceUris])].sort()
}
