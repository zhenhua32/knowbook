import type Database from 'better-sqlite3'
import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, writeSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { readManagedAssetSourceSync as readAlias, type ManagedAssetSource } from '../managed-asset-source'
import { assertSyncedShape, isSyncedUuid, validateSyncedHostForest } from '../../shared/syncedBlockValidation'
import { buildSyncedPortableAssetUri, rewriteSyncedGroupAssets, rewriteSyncedPortableHostAssets,
  syncedManagedAssetBudgetUri, syncedPortableAssetBackupPath, measureSyncedPortableGroup, measureSyncedPortableHost } from '../../shared/syncedBlockPortable'
import { buildBackupV3Files, parseBackupV3Files, type ArchiveV3Snapshot, type BackupV3File } from './v3-format'
import { readBackupV3Files } from './v3-reader'
import { captureSyncedBackupV3, readSyncedBackupV3Capture, claimSyncedBackupV3, confirmSyncedBackupV3,
  type SyncedBackupV3Snapshot } from '../database/synced-backup-v3'
import { SyncedPublicationError, publicationHash, publicationJson, publicationCompare, publicationInvalid } from '../sync/synced-publication-model'

export interface WriteSyncedBackupV3Input { userDataRoot: string; destination: string; snapshotId: string }
export interface WriteSyncedBackupV3Result { snapshotId: string; documents: number; groups: number }
type Paths = { root: string; storage: string; assets: string; destination: string; databasePath: string }
type Alias = ManagedAssetSource
const assetTotalLimit = 500 * 1024 * 1024
const spelling = (path: string): string => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
function error(code: 'asset' | 'spool' | 'unavailable', message: string, cause?: unknown): never { throw new SyncedPublicationError(code, message, cause) }
function within(path: string, root: string): boolean {
  const child = relative(root, path); return child === '' || child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child)
}
function safe(path: string): void {
  const absolute = resolve(path); let current = parse(absolute).root
  for (const part of relative(current, absolute).split(sep).filter(Boolean)) {
    current = join(current, part)
    const info = lstatSync(current, { throwIfNoEntry: false })
    if (info?.isSymbolicLink()) return error('spool', 'V3 文件路径不允许符号链接。')
    if (info && current !== absolute && !info.isDirectory()) return error('spool', 'V3 路径中间项不是目录。')
  }
}
function environment(db: Database.Database, input: WriteSyncedBackupV3Input): Paths {
  assertSyncedShape(input, ['userDataRoot', 'destination', 'snapshotId'])
  if (typeof input.userDataRoot !== 'string' || !isAbsolute(input.userDataRoot) || typeof input.destination !== 'string'
    || !isAbsolute(input.destination) || !isSyncedUuid(input.snapshotId)) return publicationInvalid('V3 root/destination 必须绝对路径，snapshotId 必须 UUID。')
  if (!db.open || db.readonly) return error('unavailable', 'V3 producer 要求真实可写 connection。')
  if (db.inTransaction || db.pragma('foreign_keys', { simple: true }) !== 1) return publicationInvalid('V3 producer 不接受 caller transaction 或 FK 关闭。')
  const root = resolve(input.userDataRoot), storage = join(root, 'storage'), databasePath = join(storage, 'knowbook.db')
  safe(root); safe(databasePath)
  if (!lstatSync(root).isDirectory() || !lstatSync(databasePath).isFile()
    || spelling(realpathSync(root)) !== spelling(root) || spelling(realpathSync(db.name)) !== spelling(realpathSync(databasePath))) return error('unavailable', 'V3 connection 不是原 userDataRoot 下的 knowbook.db。')
  const destination = resolve(input.destination), parent = dirname(destination), assets = join(storage, 'assets')
  safe(destination); safe(assets)
  if (destination === parse(destination).root || within(destination, storage) || within(storage, destination)
    || !lstatSync(parent).isDirectory() || existsSync(destination)) return error('spool', 'V3 destination 必须是已存在安全父目录下的全新独立目录，不能覆盖应用 storage。')
  return { root, storage, assets, destination, databasePath: realpathSync(databasePath) }
}
function sourceHosts(snapshot: SyncedBackupV3Snapshot) {
  const facts = new Map(snapshot.hosts.map(host => [host.id, host]))
  return snapshot.documents.map(document => {
    const host = facts.get(document.id)
    if (!host) return publicationInvalid('V3 原宿主 identity 事实缺失。')
    return { kind: 'document' as const, id: document.id, parentId: host.parentId, sortOrder: host.sortOrder, createdAt: host.createdAt,
      content: { title: document.title, summary: document.summary, blocks: validateSyncedHostForest(document.blocks.map(({ sortOrder: _sortOrder, ...block }) => block)) } }
  })
}
function rewrite(snapshot: SyncedBackupV3Snapshot, mapper: (uri: string) => string): Pick<ArchiveV3Snapshot, 'documents' | 'groups'> {
  const rewritten = new Map(sourceHosts(snapshot).map(host => [host.id, rewriteSyncedPortableHostAssets(host, mapper)]))
  return {
    documents: snapshot.documents.map(document => {
      const host = rewritten.get(document.id)!
      return { ...document, summary: host.content.summary, blocks: host.content.blocks.map((block, index) => ({ ...block, sortOrder: document.blocks[index].sortOrder })) }
    }),
    groups: snapshot.groups.map(group => ({ ...group, wire: rewriteSyncedGroupAssets(group.wire, mapper) }))
  }
}
function portable(snapshot: SyncedBackupV3Snapshot, paths: Paths): { snapshot: ArchiveV3Snapshot; aliases: Alias[] } {
  const wanted = new Set<string>()
  // Only discovery uses syntactic placeholders, and its output is discarded.
  rewrite(snapshot, uri => { wanted.add(uri); return /^file:/i.test(uri) ? syncedManagedAssetBudgetUri(uri) : uri })
  const replacements = new Map<string, string>(), aliases: Alias[] = []
  const files = new Map<string, ArchiveV3Snapshot['assets'][number]>()
  let total = 0
  try {
    for (const uri of wanted) {
      // Read every source alias even when another name/URI already has the same content hash.
      const alias = readAlias(paths.assets, uri), canonical = buildSyncedPortableAssetUri(alias), relativePath = syncedPortableAssetBackupPath(canonical)
      aliases.push(alias); replacements.set(uri, canonical)
      const existing = files.get(relativePath)
      if (existing) { if (!Buffer.from(existing.bytes).equals(alias.bytes)) throw new Error('同资产 alias 原字节不一致。') }
      else {
        total += alias.bytes.length
        if (files.size >= 5_000 || total > assetTotalLimit) throw new Error('附件集合超过原 V3 文件数/总字节门槛。')
        files.set(relativePath, { relativePath, hash: alias.hash, name: alias.name, bytes: alias.bytes })
      }
    }
  } catch (cause) { return error('asset', 'V3 真实附件缺失、越界或原字节校验失败。', cause) }
  const rewritten = rewrite(snapshot, uri => replacements.get(uri) ?? publicationInvalid('V3 附件映射未闭合。'))
  const groups = new Map(rewritten.groups.map(group => [group.wire.id, group.wire]))
  for (const group of groups.values()) measureSyncedPortableGroup(group)
  // Use the actual original host envelope/birth, never an archive-invented createdAt.
  for (const host of sourceHosts({ ...snapshot, ...rewritten })) measureSyncedPortableHost(host, groups)
  return { snapshot: { ...rewritten,
    catalog: snapshot.catalog, standaloneDatabases: snapshot.standaloneDatabases,
    assets: [...files.values()].sort((a, b) => publicationCompare(a.relativePath, b.relativePath)) }, aliases }
}
function verifyAliases(aliases: Alias[], paths: Paths): void {
  try {
    for (const old of aliases) {
      const current = readAlias(paths.assets, old.uri)
      if (spelling(current.path) !== spelling(old.path) || current.hash !== old.hash || current.name !== old.name || !current.bytes.equals(old.bytes)) throw new Error('附件来源或原字节变化。')
    }
  } catch (cause) { return error('asset', 'V3 首文件前附件原映射/bytes 失效。', cause) }
}
function outputPath(root: string, file: BackupV3File): string {
  if (typeof file.relativePath !== 'string' || !file.relativePath || file.relativePath.includes('\\')
    || file.relativePath.split('/').some(part => !part || part === '.' || part === '..' || /[:\0]/.test(part)) || isAbsolute(file.relativePath)) return publicationInvalid('V3 codec 输出路径无效。')
  const path = join(root, ...file.relativePath.split('/'))
  if (!within(path, root) || spelling(path) === spelling(root)) return publicationInvalid('V3 输出越过新目录。')
  return path
}
function digest(files: BackupV3File[]): string {
  return publicationHash(publicationJson(files.map(file => ({ relativePath: file.relativePath, hash: publicationHash(file.bytes), bytes: file.bytes.byteLength }))
    .sort((a, b) => publicationCompare(a.relativePath, b.relativePath))))
}
function syncFile(path: string, bytes: Uint8Array): void {
  const fd = openSync(path, 'wx')
  try {
    let offset = 0
    while (offset < bytes.byteLength) { const written = writeSync(fd, bytes, offset, bytes.byteLength - offset); if (!written) throw new Error('V3 文件写入未推进。'); offset += written }
    fsyncSync(fd)
  } finally { closeSync(fd) }
}
function syncDirectory(path: string): void {
  safe(path)
  if (!lstatSync(path).isDirectory()) return error('spool', 'V3 目录 flush 目标不是目录。')
  let fd: number
  try { fd = openSync(path, 'r') } catch (cause) {
    // Node/libuv on Windows cannot open directories as flushable handles.
    // This explicit platform limitation is not a swallowed disk/permission error elsewhere.
    if (process.platform === 'win32' && cause && typeof cause === 'object' && 'code' in cause
      && (cause.code === 'EPERM' || cause.code === 'EISDIR')) return
    throw cause
  }
  try {
    if (!fstatSync(fd).isDirectory()) return error('spool', 'V3 目录 flush handle 不是目录。')
    try { fsyncSync(fd) } catch (cause) {
      // Electron/Windows may open a directory but deny flushing that verified directory handle.
      if (process.platform === 'win32' && cause && typeof cause === 'object' && 'code' in cause
        && (cause.code === 'EPERM' || cause.code === 'EISDIR')) return
      throw cause
    }
  } finally { closeSync(fd) }
}
/** Synchronous Main consumer, used directly and by the existing export worker.
 * It never opens Store, accepts caller records, overwrites a directory, or resumes a failed export. */
export function writeSyncedBackupV3(db: Database.Database, input: WriteSyncedBackupV3Input): WriteSyncedBackupV3Result {
  try {
    const paths = environment(db, input), capture = captureSyncedBackupV3(db), source = readSyncedBackupV3Capture(capture)
    if (!source) return error('unavailable', 'V3 原 capture 不存在。')
    const material = portable(source, paths), files = buildBackupV3Files(material.snapshot, input.snapshotId)
    parseBackupV3Files(files) // Strict whole-archive preflight before any exposure/output.
    const archiveHash = digest(files), pathsSeen = new Set<string>()
    for (const file of files) { const path = spelling(outputPath(paths.destination, file)); if (pathsSeen.has(path)) return publicationInvalid('V3 输出路径在本机碰撞。'); pathsSeen.add(path) }
    verifyAliases(material.aliases, paths)
    environment(db, input) // Recheck the exact root/new destination immediately before the owned claim.
    claimSyncedBackupV3(db, capture, { snapshotId: input.snapshotId, destination: paths.destination, archiveHash })
    // No external file/directory is created until the possible transaction has committed.
    try {
      safe(paths.destination); mkdirSync(paths.destination)
      const directories = new Set<string>([paths.destination, dirname(paths.destination)])
      for (const file of files) {
        const path = outputPath(paths.destination, file)
        safe(path); mkdirSync(dirname(path), { recursive: true }); safe(path)
        let directory = dirname(path)
        while (within(directory, paths.destination)) {
          directories.add(directory)
          if (spelling(directory) === spelling(paths.destination)) break
          directory = dirname(directory)
        }
        syncFile(path, file.bytes)
      }
      for (const directory of [...directories].sort((a, b) => b.split(sep).length - a.split(sep).length || publicationCompare(a, b))) syncDirectory(directory)
      const actual = readBackupV3Files(paths.destination)
      if (digest(actual) !== archiveHash) throw new Error('V3 实际文件集合/字节不等于原 preflight。')
      const parsed = parseBackupV3Files(actual)
      if (parsed.manifest.snapshotId !== input.snapshotId) throw new Error('V3 实际 snapshotId 不等于原请求。')
    } catch (cause) { return error('spool', 'V3 写出/真实回读失败；partial 和 durable possible 保留，不覆盖或自动清理。', { cause, destination: paths.destination, snapshotId: input.snapshotId }) }
    confirmSyncedBackupV3(db, capture)
    return Object.freeze({ snapshotId: input.snapshotId, documents: source.documents.length, groups: source.groups.length })
  } catch (cause) {
    if (cause instanceof SyncedPublicationError) throw cause
    const sql = cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string' && cause.code.startsWith('SQLITE')
    throw new SyncedPublicationError(sql ? 'database' : 'invalid', 'V3 Main producer 失败；已提交曝光不会回退，已写文件不会伪称回滚。', cause)
  }
}
