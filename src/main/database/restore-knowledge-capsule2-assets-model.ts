import { ATTACHMENT_MAX_FILE_BYTES } from '../../shared/attachments'
import { parseStrictJson } from '../../shared/strictJson'
import { capsuleBytesHash, capsuleJson, capsuleRecord, capsuleText, freezeCapsuleValue, validateDurableSqlCapsuleInventory } from './restore-knowledge-capsule-model'
import { CAPSULE2_RAW_MAX_JSON_BYTES } from './restore-knowledge-capsule2-raw-model'
import type { Capsule2KnownAssetManifest } from './restore-knowledge-capsule2-assets-files'
import type { Capsule2ManagedAssetManifest } from './restore-knowledge-capsule2-managed-assets-files'

type Alias = Capsule2ManagedAssetManifest['aliases'][number]
type KnownAlias = Capsule2KnownAssetManifest['aliases'][number]
const maxFiles = 5_000, maxBytes = 500 * 1024 * 1024, maxEntries = 20_000
const bad = (message: string): never => { throw new Error('capsule2持久附件manifest无效：' + message + '；仅验证准备原件，不授认证或安装权。') }
const baseKeys = ['kind', 'version', 'state', 'certified', 'semanticValidationComplete', 'permit', 'capsuleId', 'schemaVersion', 'sourceInventory',
  'sourceContentHash', 'workspaceHistoryObservationHash', 'assetReferencesObservationHash', 'aliases', 'files']
function hash(value: unknown): string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : bad('原hash无效') }
function integer(value: unknown, max: number): number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : bad('有限整数无效') }
function list(value: unknown, max: number): unknown[] { return Array.isArray(value) && value.length <= max ? value : bad('完整集合超预算') }
function ordered<T>(rows: T[], key: (row: T) => string): T[] {
  for (let index = 1; index < rows.length; index++) if (key(rows[index - 1]) >= key(rows[index])) return bad('原集合未准确排序或重复')
  return rows
}
function pathParts(value: unknown, file: boolean): string[] {
  if (value === '' && !file) return []
  const text = capsuleText(value, 8192), parts = text.split('/')
  if (file && parts.length !== 4 || parts.length > (file ? 4 : 3) || parts[0] !== 'attachments'
    || parts.some(part => !part || part === '.' || part === '..' || /[\\\0]/.test(part))
    || parts.length >= 2 && !/^[a-f0-9]{2}$/.test(parts[1])
    || parts.length >= 3 && (!/^[a-f0-9]{64}$/.test(parts[2]) || !parts[2].startsWith(parts[1]))) return bad('不是原管理附件相对布局')
  return parts
}
function aliases(value: unknown, known: boolean): Array<Alias | KnownAlias> {
  let total = 0
  return ordered(list(value, maxFiles).map(value => {
    const row = capsuleRecord(value, known ? ['uri', 'relativePath', 'hash', 'name', 'bytes'] : ['relativePath', 'hash', 'name', 'bytes'])
    const parts = pathParts(row.relativePath, true), bytes = integer(row.bytes, ATTACHMENT_MAX_FILE_BYTES), digest = hash(row.hash)
    if (capsuleText(row.name, 8192) !== parts[3] || digest !== parts[2] || (total += bytes) > maxBytes) return bad('alias名称/hash/完整字节预算不闭合')
    const alias: Alias = { relativePath: parts.join('/'), hash: digest, name: parts[3], bytes }
    if (!known) return alias
    const uri = capsuleText(row.uri, 8192 * 4)
    if (uri.length > 8192) return bad('原URI超过已有字符长度边界')
    return { uri, ...alias }
  }), row => known ? (row as KnownAlias).uri : row.relativePath)
}
function files(value: unknown, actualAliases: readonly Alias[]) {
  let total = 0
  const result = ordered(list(value, maxFiles).map(value => {
    const row = capsuleRecord(value, ['hash', 'bytes']), bytes = integer(row.bytes, ATTACHMENT_MAX_FILE_BYTES)
    if ((total += bytes) > maxBytes) return bad('完整blob预算不闭合')
    return { hash: hash(row.hash), bytes }
  }), row => row.hash)
  const expected = new Map<string, number>()
  for (const alias of actualAliases) { const previous = expected.get(alias.hash); if (previous !== undefined && previous !== alias.bytes) return bad('同hash长度不同'); expected.set(alias.hash, alias.bytes) }
  if (capsuleJson(result) !== capsuleJson([...expected].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([hash, bytes]) => ({ hash, bytes })))) return bad('blob不是完整alias闭集')
  return result
}
function base(row: Record<string, unknown>, capsuleId: string) {
  if (row.version !== 1 || row.capsuleId !== capsuleId || row.certified !== false || row.semanticValidationComplete !== false || row.permit !== false
    || row.schemaVersion !== 26 && row.schemaVersion !== 27) return bad('原件身份/版本或准备权限标志无效')
  const schemaVersion: 26 | 27 = row.schemaVersion
  return {    
version: 1 as const, certified: false as const, semanticValidationComplete: false as const, permit: false as const, capsuleId,
    schemaVersion, sourceInventory: validateDurableSqlCapsuleInventory(row.sourceInventory), sourceContentHash: hash(row.sourceContentHash),
    workspaceHistoryObservationHash: hash(row.workspaceHistoryObservationHash), assetReferencesObservationHash: hash(row.assetReferencesObservationHash)  
}
}
function parse(text: string, expectedHash: string, domain: string, keys: string[]) {
  hash(expectedHash)
  const parsed = parseStrictJson(text, { maxBytes: CAPSULE2_RAW_MAX_JSON_BYTES, maxDepth: 12 })
  const row = capsuleRecord(parsed, keys), encoded = capsuleJson(parsed)
  if (text !== encoded + '\n' || capsuleBytesHash(domain + '\0' + encoded) !== expectedHash) return bad('原规范字节或owning root给出的hash不符')
  return row
}
/** Structure and byte commitment only. A pinned hash is supplied by the owner;
 * neither parsed manifest can certify SQL, file provenance or an accepted root. */
export function parseCapsule2KnownAssetManifest(text: string, capsuleId: string, expectedHash: string): Capsule2KnownAssetManifest {
  const row = parse(text, expectedHash, 'knowbook.capsule2.known-managed-asset-originals.v1', baseKeys)
  if (row.kind !== 'capsule2-known-managed-asset-originals' || row.state !== 'known-markdown-files-only') return bad('未知known原件格式')
  const actualAliases = aliases(row.aliases, true) as KnownAlias[]
  return freezeCapsuleValue({ kind: row.kind, state: row.state, ...base(row, capsuleId), aliases: actualAliases, files: files(row.files, actualAliases) })
}
export function parseCapsule2ManagedAssetManifest(text: string, capsuleId: string, expectedHash: string): Capsule2ManagedAssetManifest {
  const row = parse(text, expectedHash, 'knowbook.capsule2.managed-asset-originals.v1', [...baseKeys, 'knownAssetManifestHash', 'knownAliases', 'rootPresent', 'directories'])
  if (row.kind !== 'capsule2-managed-asset-originals' || row.state !== 'all-managed-files-only' || typeof row.rootPresent !== 'boolean') return bad('未知完整管理原件格式')
  const actualAliases = aliases(row.aliases, false) as Alias[], knownAliases = aliases(row.knownAliases, true) as KnownAlias[]
  const directories = ordered(list(row.directories, maxEntries).map(value => pathParts(value, false).join('/')), value => value)
  if (directories.length + actualAliases.length > maxEntries) return bad('完整目录和文件项超过原准备预算')
  if (row.rootPresent ? directories[0] !== '' : directories.length !== 0 || actualAliases.length !== 0 || knownAliases.length !== 0) return bad('原管理根存在状态不闭合')
  const directorySet = new Set(directories)
  for (const directory of directories) if (directory && !directorySet.has(directory.split('/').slice(0, -1).join('/'))) return bad('缺原目录祖先')
  const byPath = new Map(actualAliases.map(alias => [alias.relativePath, alias]))
  for (const alias of actualAliases) if (!directorySet.has(alias.relativePath.split('/').slice(0, -1).join('/'))) return bad('alias缺原父目录')
  for (const alias of knownAliases) { const actual = byPath.get(alias.relativePath); if (!actual || actual.hash !== alias.hash || actual.name !== alias.name || actual.bytes !== alias.bytes) return bad('known alias不是完整管理原件子集') }
  return freezeCapsuleValue({    
kind: row.kind, state: row.state, ...base(row, capsuleId), knownAssetManifestHash: hash(row.knownAssetManifestHash), knownAliases,
    rootPresent: row.rootPresent, directories, aliases: actualAliases, files: files(row.files, actualAliases)  
})
}
