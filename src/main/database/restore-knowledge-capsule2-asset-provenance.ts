// Capture-time base-observer facts only. All supplemental/final coverage remains false.
// Captured facts only. A parsed proof never opens a live path or mints an owner.
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { parseSyncedPortableAssetUri } from '../../shared/syncedBlockPortable'
import { ATTACHMENT_MAX_FILE_BYTES } from '../../shared/attachments'
import { capsuleBytesHash, capsuleJson, capsuleRecord, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { readOwnedRawCapsuleOriginal, assertOwnedRawCapsuleOriginal, type OwnedRawCapsuleOriginal } from './restore-knowledge-capsule-files'
import type { Capsule2ManagedTreeData } from './restore-knowledge-capsule2-managed-assets-files'
import { assertRestorePath } from './restore-safety-files'

export interface Capsule2AssetReferenceBinding1 {
  readonly sourceContentHash: string; readonly workspaceHistoryObservationHash: string
  readonly assetReferencesObservationHash: string; readonly referenceUris: readonly string[]
}
export type Capsule2AssetUnresolvedReason1 = 'foreign-uri' | 'unsupported-scheme' | 'invalid-local-uri'
  | 'invalid-portable-uri' | 'missing-managed-root' | 'missing-managed-alias' | 'unprovable-root-alias'
export type Capsule2AssetReferenceEntry1 = readonly [number, 'portable', number]
  | readonly [number, 'file', number, number] | readonly [number, 'unresolved', Capsule2AssetUnresolvedReason1]
export interface Capsule2AssetReferenceProvenance1 {
  readonly kind: 'capsule2-captured-managed-reference-provenance'; readonly version: 1
  readonly sourceContentHash: string; readonly workspaceHistoryObservationHash: string; readonly assetReferencesObservationHash: string
  readonly referenceUrisHash: string; readonly managedTreeHash: string
  readonly assetRoot: { readonly uri: string; readonly present: boolean; readonly device: string | null; readonly inode: string | null }
  readonly rootSpellings: readonly { readonly uri: string; readonly device: string; readonly inode: string }[]
  readonly identities: readonly { readonly aliasIndex: number; readonly device: string; readonly inode: string; readonly bytes: number; readonly links: string; readonly mode: string }[]
  readonly entries: readonly Capsule2AssetReferenceEntry1[]
  readonly knownReferenceClassificationComplete: true; readonly certified: false; readonly semanticValidationComplete: false; readonly permit: false
}
const fail = (message: string): never => { throw new Error('capsule2捕获资产来源无效：' + message + '；不访问外部文件内容，不授认证/安装权。') }
const samePath = (left: string, right: string) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
const digest = (domain: string, value: unknown) => capsuleBytesHash(domain + '\0' + capsuleJson(value))
export const capsule2AssetReferenceProvenanceHash = (value: Capsule2AssetReferenceProvenance1) => digest('knowbook.capsule2.captured-reference-provenance.v1', value)
const uriHash = (uris: readonly string[]) => digest('knowbook.capsule2.captured-reference-uris.v1', uris)
const treeHash = (tree: Capsule2ManagedTreeData) => digest('knowbook.capsule2.captured-reference-tree.v1', tree)
const unresolvedReasons = ['foreign-uri', 'unsupported-scheme', 'invalid-local-uri', 'invalid-portable-uri', 'missing-managed-root', 'missing-managed-alias', 'unprovable-root-alias'] as const
function hash(value: unknown): string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : fail('缺准确hash') }
function whole(value: unknown, positive = false): string {
  return typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value) && (!positive || value !== '0') ? value : fail('原生整数证据无效')
}
function number(value: unknown, maximum: number): number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : fail('有限索引/长度无效') }
function fileUri(value: unknown): string {
  if (typeof value !== 'string') return fail('root URI不是TEXT')
  let uri: URL
  try { uri = new URL(value) } catch { return fail('root URI无效') }
  if (uri.protocol !== 'file:' || uri.username || uri.password || uri.port || uri.search || uri.hash || uri.href !== value) return fail('root URI不是原规范file locator')
  return value
}
/** Pure closure codec. Its only supported authority is a pinned source
 * material/seal/qualified-original chain, never this DTO or its matching hash. */
export function validateCapsule2AssetReferenceProvenance1(value: unknown, binding: Capsule2AssetReferenceBinding1, tree: Capsule2ManagedTreeData): Capsule2AssetReferenceProvenance1 {
  const row = capsuleRecord(value, ['kind', 'version', 'sourceContentHash', 'workspaceHistoryObservationHash', 'assetReferencesObservationHash', 'referenceUrisHash', 'managedTreeHash',
    'assetRoot', 'rootSpellings', 'identities', 'entries', 'knownReferenceClassificationComplete', 'certified', 'semanticValidationComplete', 'permit'])
  if (row.kind !== 'capsule2-captured-managed-reference-provenance' || row.version !== 1 || row.knownReferenceClassificationComplete !== true
    || row.certified !== false || row.semanticValidationComplete !== false || row.permit !== false) return fail('未知证明版本或权限提升')
  for (const name of ['sourceContentHash', 'workspaceHistoryObservationHash', 'assetReferencesObservationHash'] as const)
    if (hash(row[name]) !== binding[name]) return fail('证明不属于同次实际SQL/scope观察')
  if (hash(row.referenceUrisHash) !== uriHash(binding.referenceUris) || hash(row.managedTreeHash) !== treeHash(tree)) return fail('证明与完整URI/管理树不闭合')
  const root = capsuleRecord(row.assetRoot, ['uri', 'present', 'device', 'inode'])
  if (root.present !== tree.rootPresent) return fail('真实根存在状态不同')
  const assetRoot = { uri: fileUri(root.uri), present: tree.rootPresent,
    device: tree.rootPresent ? whole(root.device) : root.device === null ? null : fail('缺失根不可伪造设备'),
    inode: tree.rootPresent ? whole(root.inode, true) : root.inode === null ? null : fail('缺失根不可伪造inode') }
  if (!Array.isArray(row.rootSpellings) || row.rootSpellings.length > binding.referenceUris.length
    || !Array.isArray(row.identities) || row.identities.length > tree.aliases.length
    || !Array.isArray(row.entries) || row.entries.length !== binding.referenceUris.length) return fail('证明集合不完整或超实际来源范围')
  const rootSpellings = row.rootSpellings.map(value => { const item = capsuleRecord(value, ['uri', 'device', 'inode'])
    const result = { uri: fileUri(item.uri), device: whole(item.device), inode: whole(item.inode, true) }
    if (!assetRoot.present || result.device !== assetRoot.device || result.inode !== assetRoot.inode) return fail('别名根不是实际原根身份')
    return result })
  if (rootSpellings.some((item, index) => index > 0 && rootSpellings[index - 1].uri >= item.uri)) return fail('根拼写集合未严格排序')
  const identities = row.identities.map(value => { const item = capsuleRecord(value, ['aliasIndex', 'device', 'inode', 'bytes', 'links', 'mode'])
    const aliasIndex = number(item.aliasIndex, tree.aliases.length - 1), alias = tree.aliases[aliasIndex]
    const result = { aliasIndex, device: whole(item.device), inode: whole(item.inode, true), bytes: number(item.bytes, ATTACHMENT_MAX_FILE_BYTES), links: whole(item.links, true), mode: whole(item.mode) }
    if (!alias || result.bytes !== alias.bytes) return fail('实际FD证据不对应原alias长度')
    return result })
  if (identities.some((item, index) => index > 0 && identities[index - 1].aliasIndex >= item.aliasIndex)) return fail('原FD证据alias重复')
  const blobs = new Map(tree.files.map(file => [file.hash, file.bytes]))
  const byAlias = new Set(identities.map(item => item.aliasIndex)), usedAliases = new Set<number>(), usedRoots = new Set<number>()
  const entries = row.entries.map((value, index): Capsule2AssetReferenceEntry1 => {
    if (!Array.isArray(value) || value[0] !== index) return fail('每个原URI必须恰有一次分类')
    if (value[1] === 'unresolved' && value.length === 3 && unresolvedReasons.includes(value[2] as Capsule2AssetUnresolvedReason1)) return [index, 'unresolved', value[2] as Capsule2AssetUnresolvedReason1]
    const aliasIndex = number(value[2], tree.aliases.length - 1), alias = tree.aliases[aliasIndex], uri = binding.referenceUris[index]
    if (!alias || blobs.get(alias.hash) !== alias.bytes) return fail('授权alias没有完整原blob支持')
    if (value[1] === 'portable' && value.length === 3) {
      const asset = parseSyncedPortableAssetUri(uri)
      if (asset.hash !== alias.hash || asset.name !== alias.name) return fail('portable URI与原alias不符')
      return [index, 'portable', aliasIndex]
    }
    if (value[1] === 'file' && value.length === 4 && /^file:/i.test(uri) && byAlias.has(aliasIndex)) {
      const rootIndex = number(value[3], rootSpellings.length - 1)
      if (!rootSpellings[rootIndex]) return fail('file引用缺实际根别名支持')
      usedAliases.add(aliasIndex); usedRoots.add(rootIndex); return [index, 'file', aliasIndex, rootIndex]
    }
    return fail('未知/无原FD支持的分类')
  })
  if (usedAliases.size !== identities.length || usedRoots.size !== rootSpellings.length) return fail('存在未被真实file引用使用的多余权属证据')
  return freezeCapsuleValue({ kind: row.kind, version: 1, sourceContentHash: binding.sourceContentHash, workspaceHistoryObservationHash: binding.workspaceHistoryObservationHash,
    assetReferencesObservationHash: binding.assetReferencesObservationHash, referenceUrisHash: uriHash(binding.referenceUris), managedTreeHash: treeHash(tree), assetRoot,
    rootSpellings, identities, entries, knownReferenceClassificationComplete: true, certified: false, semanticValidationComplete: false, permit: false })
}

const regular = (value: BigIntStats) => value.isFile() && !value.isSymbolicLink() && value.ino > 0n && value.nlink > 0n
const sameFd = (left: BigIntStats, right: BigIntStats) => regular(left) && regular(right) && left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
  && left.size === right.size && left.nlink === right.nlink && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
const pathFd = (named: BigIntStats, held: BigIntStats) => regular(named) && regular(held) && named.ino === held.ino && named.mode === held.mode
  && (named.dev === held.dev || process.platform === 'win32' && (named.dev === 0n || BigInt.asUintN(32, named.dev) === held.dev))
  && named.size === held.size && named.nlink === held.nlink && named.mtimeNs === held.mtimeNs && named.ctimeNs === held.ctimeNs
const rootIdentity = (left: BigIntStats, right: BigIntStats) => left.isDirectory() && right.isDirectory() && !left.isSymbolicLink() && !right.isSymbolicLink()
  && left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.ino > 0n
const inside = (path: string, root: string) => { const child = relative(root, path); return child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child) }
const shortName = (part: string) => {
  const match = /^([A-Za-z0-9_$!#%&'()@^`{}-]{1,6})~([0-9]{1,6})(?:\.[A-Za-z0-9_$!#%&'()@^`{}-]{1,3})?$/.exec(part)
  return !!match && match[1].length + match[2].length + 1 <= 8
}
function candidateFile(uri: string, root: string): string | null {
  let url: URL, path: string
  try {
    url = new URL(uri)
    if (url.protocol !== 'file:' || url.username || url.password || url.port || url.search || url.hash || uri.includes('\\')) return null
    const sourcePath = uri.replace(/^file:(?:\/\/[^/]*)?/i, '').split(/[?#]/)[0]
    if (sourcePath.split('/').some(part => ['.', '..'].includes(decodeURIComponent(part)))) return null
    path = fileURLToPath(url)
  } catch { return null }
  // No device path, unknown UNC authority/share, or other volume is probed.
  if (/^\\\\[?.]\\/.test(path) || !samePath(parse(path).root, parse(root).root)) return null
  return resolve(path)
}
async function restrictedRootAlias(candidate: string, canonical: string): Promise<boolean> {
  if (!samePath(parse(candidate).root, parse(canonical).root)) return false
  const left = relative(parse(candidate).root, candidate).split(sep).filter(Boolean), right = relative(parse(canonical).root, canonical).split(sep).filter(Boolean)
  if (left.length !== right.length || left.some((part, index) => !samePath(part, right[index]) && !(process.platform === 'win32' && shortName(part)))) return false
  let candidateAncestor = parse(candidate).root, knownAncestor = parse(canonical).root
  for (let index = 0; index < left.length; index++) {
    candidateAncestor = join(candidateAncestor, left[index]); knownAncestor = join(knownAncestor, right[index])
    let alias: BigIntStats, known: BigIntStats
    try { alias = await lstat(candidateAncestor, { bigint: true }); known = await lstat(knownAncestor, { bigint: true }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
    if (!rootIdentity(alias, known) || !samePath(await realpath(candidateAncestor), await realpath(knownAncestor))) return false
  }
  return true
}
async function readCanonicalAlias(path: string, root: string, expected: { hash: string; bytes: number }): Promise<BigIntStats> {
  await assertRestorePath(path, root)
  const prior = await lstat(path, { bigint: true })
  if (!regular(prior) || prior.size !== BigInt(expected.bytes) || expected.bytes > ATTACHMENT_MAX_FILE_BYTES) return fail('源alias不是原25MiB范围内的准确普通文件')
  const fd = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = await fd.stat({ bigint: true })
    if (!pathFd(prior, before) || process.platform === 'win32' && before.dev === 0n) return fail('源alias的实际FD/卷身份变化')
    const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024); let offset = 0
    while (offset < expected.bytes) { const amount = (await fd.read(buffer, 0, Math.min(buffer.length, expected.bytes - offset), offset)).bytesRead
      if (!amount) return fail('源alias提前EOF'); hash.update(buffer.subarray(0, amount)); offset += amount }
    if ((await fd.read(buffer, 0, 1, offset)).bytesRead || hash.digest('hex') !== expected.hash) return fail('源alias全部bytes/hash不对应已封存tree')
    const after = await fd.stat({ bigint: true })
    await assertRestorePath(path, root)
    if (!sameFd(before, after) || !pathFd(await lstat(path, { bigint: true }), after)) return fail('源alias读取期间FD/path/metadata变化')
    return before
  } finally { await fd.close() }
}

/** Narrow named-path compatibility may check a path against ITS OWN FD only.
 * Cross-alias identity uses two simultaneously opened native FDs with exact
 * dev/ino and metadata; zero devices or truncation never establish an alias.
 * The URI FD supplies identity only. All content reads stay canonical. */
async function assertActualAliasIdentity(candidate: string, canonical: string, root: string, captured: BigIntStats): Promise<void> {
  await assertRestorePath(canonical, root)
  const canonicalPath = await lstat(canonical, { bigint: true }), canonicalFd = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const actual = await canonicalFd.stat({ bigint: true })
    if (!pathFd(canonicalPath, actual) || !sameFd(actual, captured) || process.platform === 'win32' && actual.dev === 0n)
      return fail('canonical alias打开身份不属于本次完整byte捕获')
    await assertRestorePath(candidate)
    const namedPath = await lstat(candidate, { bigint: true }), namedFd = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const named = await namedFd.stat({ bigint: true })
      if (!pathFd(namedPath, named) || !sameFd(actual, named)) return fail('原URI与canonical alias不是两个同时打开的同一native文件')
      await assertRestorePath(candidate); await assertRestorePath(canonical, root)
      const namedAfter = await namedFd.stat({ bigint: true }), canonicalAfter = await canonicalFd.stat({ bigint: true })
      if (!sameFd(named, namedAfter) || !sameFd(actual, canonicalAfter)
        || !pathFd(await lstat(candidate, { bigint: true }), namedAfter)
        || !pathFd(await lstat(canonical, { bigint: true }), canonicalAfter)) return fail('真实alias身份核验期间FD/path变化')
    } finally { await namedFd.close() }
  } finally { await canonicalFd.close() }
}

/** The only capture factory. Original ownership is looked up before properties;
 * bytes are read exclusively from the canonical, already captured managed tree.
 * Restricted URI metadata can establish real 8.3 aliases, never file authority
 * by a suffix or hash. Cold readers never call this factory on old source paths. */
export async function captureCapsule2AssetReferenceProvenanceOwned3(original: OwnedRawCapsuleOriginal, binding: Capsule2AssetReferenceBinding1, tree: Capsule2ManagedTreeData): Promise<Capsule2AssetReferenceProvenance1> {
  const info = readOwnedRawCapsuleOriginal(original)
  await assertOwnedRawCapsuleOriginal(original)
  await assertRestorePath(info.profileRoot)
  const canonicalProfile = await realpath(info.profileRoot)
  const expectedRoot = join(info.profileRoot, 'storage', 'assets')
  let root = expectedRoot, rootStat: BigIntStats | null = null
  if (tree.rootPresent) {
    await assertRestorePath(expectedRoot, info.profileRoot); root = await realpath(expectedRoot); rootStat = await lstat(root, { bigint: true })
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !rootStat.ino || !inside(root, canonicalProfile)) return fail('实际管理根不是Main原profile的普通真实目录')
  }
  const aliases = new Map(tree.aliases.map((alias, index) => [alias.relativePath, { alias, index }]))
  const identities = new Map<number, { stat: BigIntStats; path: string }>(), roots = new Map<string, BigIntStats>()
  const pending: Array<{ entry: Capsule2AssetReferenceEntry1; rootUri?: string }> = []
  for (const [index, uri] of binding.referenceUris.entries()) {
    const unresolved = (reason: Capsule2AssetUnresolvedReason1) => pending.push({ entry: [index, 'unresolved', reason] })
    if (/^knowbook-asset:/i.test(uri)) {
      let asset: ReturnType<typeof parseSyncedPortableAssetUri>
      try { asset = parseSyncedPortableAssetUri(uri) } catch { unresolved('invalid-portable-uri'); continue }
      const found = aliases.get(`attachments/${asset.hash.slice(0, 2)}/${asset.hash}/${asset.name}`)
      if (!found) { unresolved('missing-managed-alias'); continue }
      pending.push({ entry: [index, 'portable', found.index] }); continue
    }
    if (!/^file:/i.test(uri)) { unresolved('unsupported-scheme'); continue }
    const candidate = candidateFile(uri, root)
    if (!candidate) { unresolved('invalid-local-uri'); continue }
    if (!tree.rootPresent || !rootStat) { unresolved('missing-managed-root'); continue }
    let prefix = candidate
    for (let count = 0; count < 4; count++) prefix = dirname(prefix)
    if (!await restrictedRootAlias(prefix, root)) { unresolved('foreign-uri'); continue }
    // Only now is the candidate known to live under the genuine managed root.
    // Reparse rejection and realpath cover short aliases in the four tail parts.
    await assertRestorePath(candidate)
    let physical: string
    try { physical = await realpath(candidate) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { unresolved('missing-managed-alias'); continue } throw error }
    if (!inside(physical, root)) return fail('已证明根的URI尾部在native解析后越界')
    const found = aliases.get(relative(root, physical).split(sep).join('/'))
    if (!found) { unresolved('missing-managed-alias'); continue }
    const canonical = join(root, ...found.alias.relativePath.split('/'))
    const captured = identities.get(found.index) ?? { stat: await readCanonicalAlias(canonical, root, found.alias), path: canonical }
    identities.set(found.index, captured)
    await assertActualAliasIdentity(candidate, canonical, root, captured.stat)
    const spelling = pathToFileURL(prefix).href
    roots.set(spelling, rootStat); pending.push({ entry: [index, 'file', found.index, 0], rootUri: spelling })
  }
  // A bounded final byte pass catches contents changed with matching timestamp
  // observations. This is not a filesystem snapshot or exclusion lease.
  for (const [aliasIndex, captured] of identities) {
    const actual = await readCanonicalAlias(captured.path, root, tree.aliases[aliasIndex])
    if (!sameFd(captured.stat, actual)) return fail('capture结束前真实源FD身份变化')
  }
  if (rootStat) {
    await assertRestorePath(root, canonicalProfile)
    if (!rootIdentity(rootStat, await lstat(root, { bigint: true })) || !samePath(await realpath(root), root)) return fail('capture结束前实际管理根变化')
  }
  await assertOwnedRawCapsuleOriginal(original)
  const rootSpellings = [...roots].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([uri, value]) => ({ uri, device: value.dev.toString(), inode: value.ino.toString() }))
  const rootIndices = new Map(rootSpellings.map((row, index) => [row.uri, index]))
  const entries = pending.map(({ entry, rootUri }): Capsule2AssetReferenceEntry1 => entry[1] === 'file'
    ? [entry[0], 'file', entry[2], rootIndices.get(rootUri!) ?? fail('root spelling索引遗漏')] : entry)
  return validateCapsule2AssetReferenceProvenance1({ kind: 'capsule2-captured-managed-reference-provenance', version: 1,
    sourceContentHash: binding.sourceContentHash, workspaceHistoryObservationHash: binding.workspaceHistoryObservationHash,
    assetReferencesObservationHash: binding.assetReferencesObservationHash, referenceUrisHash: uriHash(binding.referenceUris), managedTreeHash: treeHash(tree),
    assetRoot: { uri: pathToFileURL(root).href, present: tree.rootPresent, device: rootStat?.dev.toString() ?? null, inode: rootStat?.ino.toString() ?? null }, rootSpellings,
    identities: [...identities].sort(([left], [right]) => left - right).map(([aliasIndex, value]) => ({ aliasIndex, device: value.stat.dev.toString(), inode: value.stat.ino.toString(),
      bytes: Number(value.stat.size), links: value.stat.nlink.toString(), mode: value.stat.mode.toString() })), entries,
    knownReferenceClassificationComplete: true, certified: false, semanticValidationComplete: false, permit: false }, binding, tree)
}

/** Archive v3 has a distinct combined-observation proof. The published base
 * archive v2/proof1 format and its three original hash meanings stay intact. */
export interface Capsule2AssetReferenceBinding2 extends Capsule2AssetReferenceBinding1 {
  readonly assetScopeSupplementHash: string
}
export type Capsule2AssetReferenceProvenance2 = Omit<Capsule2AssetReferenceProvenance1, 'version'> & {
  readonly version: 2; readonly assetScopeSupplementHash: string
}
const nativeBinding2 = (binding: Capsule2AssetReferenceBinding2): Capsule2AssetReferenceBinding1 => ({
  sourceContentHash: binding.sourceContentHash, workspaceHistoryObservationHash: binding.workspaceHistoryObservationHash,
  assetReferencesObservationHash: binding.assetReferencesObservationHash, referenceUris: binding.referenceUris })
export const capsule2AssetReferenceProvenance2Hash = (value: Capsule2AssetReferenceProvenance2) => digest('knowbook.capsule2.captured-reference-provenance.v2', value)
export function validateCapsule2AssetReferenceProvenance2(value: unknown, binding: Capsule2AssetReferenceBinding2,
  tree: Capsule2ManagedTreeData): Capsule2AssetReferenceProvenance2 {
  const row = capsuleRecord(value, ['kind', 'version', 'sourceContentHash', 'workspaceHistoryObservationHash', 'assetReferencesObservationHash',
    'assetScopeSupplementHash', 'referenceUrisHash', 'managedTreeHash', 'assetRoot', 'rootSpellings', 'identities', 'entries',
    'knownReferenceClassificationComplete', 'certified', 'semanticValidationComplete', 'permit'])
  if (row.version !== 2 || hash(row.assetReferencesObservationHash) !== binding.assetReferencesObservationHash
    || hash(row.assetScopeSupplementHash) !== binding.assetScopeSupplementHash) return fail('v3独立证明的base/supplement域不同')
  const { version: _version, assetScopeSupplementHash: _supplement, ...native } = row
  // Reuse the exact native-fact grammar, not a persisted v1 authority. This
  // temporary value never crosses an archive/material boundary as proof1.
  const checked = validateCapsule2AssetReferenceProvenance1({ ...native, version: 1 }, nativeBinding2(binding), tree)
  return freezeCapsuleValue({ ...checked, version: 2, assetReferencesObservationHash: binding.assetReferencesObservationHash,
    assetScopeSupplementHash: binding.assetScopeSupplementHash })
}
export async function captureCapsule2AssetReferenceProvenance2Owned3(original: OwnedRawCapsuleOriginal,
  binding: Capsule2AssetReferenceBinding2, tree: Capsule2ManagedTreeData): Promise<Capsule2AssetReferenceProvenance2> {
  const native = await captureCapsule2AssetReferenceProvenanceOwned3(original, nativeBinding2(binding), tree)
  return validateCapsule2AssetReferenceProvenance2({ ...native, version: 2, assetReferencesObservationHash: binding.assetReferencesObservationHash,
    assetScopeSupplementHash: binding.assetScopeSupplementHash }, binding, tree)
}
