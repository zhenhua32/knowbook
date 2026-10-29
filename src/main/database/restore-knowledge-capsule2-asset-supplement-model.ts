// Compact commitments; genuine source owners supply scope and file authority.
import { capsuleBytesHash, capsuleJson, capsuleRecord, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import type { Root3SupplementalAssetObservation3 } from './restore-knowledge-assets3-supplement'

export interface Capsule2AssetScopeSupplementDescriptor3 {
  readonly version: 1; readonly observerVersion: 1; readonly sourceContentHash: string; readonly observationHash: string
  readonly scopeCount: number; readonly referenceCount: number; readonly referenceUris: readonly string[]
  readonly unsupportedHolders: { readonly count: number; readonly hash: string }
  readonly contextBindingsHash: string; readonly settledBindingsHash: string; readonly pendingPortableBindingsHash: string
}
const hash = (domain: string, value: unknown) => capsuleBytesHash(domain + '\0' + capsuleJson(value))
const fail = (reason: string): never => { throw new Error('capsule2 supplemental资产摘要无效：' + reason) }
const digest = (value: unknown): string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : fail('缺准确hash')
const integer = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fail('计数不是有限整数')
export function describeCapsule2AssetScopeSupplement3(value: Root3SupplementalAssetObservation3): Capsule2AssetScopeSupplementDescriptor3 {
  const referenceCount = value.scopes.reduce((count, scope) => count + scope.destinations.length, 0)
  if (!Number.isSafeInteger(referenceCount)) return fail('完整引用计数越界')
  return freezeCapsuleValue({ version: 1, observerVersion: 1, sourceContentHash: value.sourceContentHash, observationHash: value.observationHash,
    scopeCount: value.scopes.length, referenceCount, referenceUris: [...new Set(value.scopes.flatMap(scope => scope.destinations.map(item => item.uri)))].sort(),
    unsupportedHolders: { count: value.unsupportedHolders.length, hash: hash('knowbook.capsule2.asset-supplement-unsupported.v1', value.unsupportedHolders) },
    contextBindingsHash: hash('knowbook.capsule2.asset-supplement-contexts.v1', value.contextBindings),
    settledBindingsHash: hash('knowbook.capsule2.asset-supplement-settled-working.v1', value.settledBindings),
    pendingPortableBindingsHash: hash('knowbook.capsule2.asset-supplement-pending-assets.v1', value.pendingPortableBindings) })
}
export function validateCapsule2AssetScopeSupplementDescriptor3(value: unknown): Capsule2AssetScopeSupplementDescriptor3 {
  const row = capsuleRecord(value, ['version', 'observerVersion', 'sourceContentHash', 'observationHash', 'scopeCount', 'referenceCount', 'referenceUris', 'unsupportedHolders', 'contextBindingsHash', 'settledBindingsHash', 'pendingPortableBindingsHash'])
  if (row.version !== 1 || row.observerVersion !== 1 || !Array.isArray(row.referenceUris)) return fail('未知supplemental observer版本')
  const referenceCount = integer(row.referenceCount), references = row.referenceUris.map(uri => typeof uri === 'string' ? uri : fail('URI不是原TEXT'))
  if (references.length > referenceCount || referenceCount > 0 && references.length === 0
    || references.some((uri, index) => index > 0 && references[index - 1] >= uri)) return fail('完整URI集合未排序/去重/闭合')
  const unsupported = capsuleRecord(row.unsupportedHolders, ['count', 'hash'])
  return freezeCapsuleValue({ version: 1, observerVersion: 1, sourceContentHash: digest(row.sourceContentHash), observationHash: digest(row.observationHash),
    scopeCount: integer(row.scopeCount), referenceCount, referenceUris: references,
    unsupportedHolders: { count: integer(unsupported.count), hash: digest(unsupported.hash) }, contextBindingsHash: digest(row.contextBindingsHash),
    settledBindingsHash: digest(row.settledBindingsHash), pendingPortableBindingsHash: digest(row.pendingPortableBindingsHash) })
}
export function capsule2CombinedAssetUris3(base: readonly string[], supplemental: Capsule2AssetScopeSupplementDescriptor3) {
  return [...new Set([...base, ...supplemental.referenceUris])].sort()
}
