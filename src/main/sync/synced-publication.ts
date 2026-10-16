import { randomUUID } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import { mkdir, open, readFile, readdir, rename } from 'node:fs/promises'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type Database from 'better-sqlite3'
import type { WebDavSyncConfig } from '../../shared/webdav-sync'
import { parseStrictJson } from '../../shared/strictJson'
import { ATTACHMENT_MAX_FILE_BYTES } from '../../shared/attachments'
import { assertSyncedShape, isSyncedUuid, parseSyncedBlockPayload } from '../../shared/syncedBlockValidation'
import { buildSyncedPortableAssetUri, parseSyncedPortableAssetUri, rewriteSyncedGroupAssets,
  rewriteSyncedPortableHostAssets, syncedManagedAssetBudgetUri } from '../../shared/syncedBlockPortable'
import { AttachmentStore } from '../attachments'
import { WebDavClient, WebDavHttpError, normalizeWebDavConfig } from './webdav-client'
import { bindSyncedPublicationCapture, captureSyncedPublicationSnapshot, claimSyncedPublication, confirmSyncedPublication,
  currentSyncedPublicationMatches, readSyncedPublicationAttempt, readSyncedPublicationCapture, recoverSyncedPublicationClaim,
  syncedPublicationRequestHash, type SyncedPublicationClaim, type SyncedPublicationLocalSnapshot } from '../database/synced-publication'
import { SyncedPublicationError, decodePublicationJson, frozenPublicationFacts, mapPublicationCatalog, publicationCompare,
  publicationHash, publicationInvalid, publicationJson, publicationRecordKey, PUBLICATION_RECORD_MAX_BYTES,
  validateInitialSnapshot, validateInitialManifest5, validatePublicationDescriptor, type InitialPublicationRecord, type PublicationDescriptor,
  type PublicationAssetDescriptor, type SyncedInitialManifest5 } from './synced-publication-model'
export { SyncedPublicationError } from './synced-publication-model'
export type { SyncedInitialManifest5, PublicationDescriptor, InitialPublicationRecord } from './synced-publication-model'
export interface PreparedSyncedPublication { readonly kind: 'prepared-synced-publication' }
export interface SyncedPublishedSnapshot { readonly kind: 'synced-published-initial-snapshot' }
export interface SyncedPublicationPrepareInput { attemptId: string; userDataRoot: string; target: WebDavSyncConfig }
export interface SyncedPublicationRuntime { password: string; signal?: AbortSignal }
export type SyncedPublicationPreparedResult = { status: 'prepared'; prepared: PreparedSyncedPublication }
export type SyncedPublicationPrepareResult = SyncedPublicationPreparedResult | { status: 'unsupported'; reason: 'schema-27-required' | 'no-active-groups' }
export interface SyncedPublicationIdentity { attemptId: string; publicationHash: string }
export type SyncedPublicationConfirmed = SyncedPublicationIdentity & { status: 'confirmed'; replayed: boolean }
export type SyncedPublicationConflict = SyncedPublicationIdentity & { status: 'conflict' }
export type SyncedPublicationStale = SyncedPublicationIdentity & { status: 'stale' }
export type SyncedPublicationMissing = SyncedPublicationIdentity & { status: 'missing' }
export interface PreparedSyncedPublicationFacts extends SyncedPublicationIdentity { workspaceScope: string; recoveryEpoch: string; targetFingerprint: string; requestHash: string; descriptor: PublicationDescriptor }
export interface SyncedPublishedSnapshotFacts { manifest: SyncedInitialManifest5; records: Array<{ key: string; hash: string; bytes: number; record: InitialPublicationRecord }>; assets: PublicationAssetDescriptor[] }
type Paths = { root: string; databasePath: string; assetRoot: string; spoolRoot: string; directory: string }
type StoredTarget = Pick<WebDavSyncConfig, 'url' | 'username' | 'directory' | 'allowInsecureHttp'>
type SpoolState = { kind: 'synced-publication-spool'; version: 1; attemptId: string; databasePath: string; target: StoredTarget; descriptor: PublicationDescriptor; publicationHash: string; requestHash: string }
type LoadedSpool = { state: SpoolState; manifest: Buffer; objects: Map<string, Buffer>; assets: Map<string, Buffer> }
type Prepared = { db: Database.Database; paths: Paths; target: WebDavSyncConfig; state: SpoolState; claim: SyncedPublicationClaim; closed: boolean; busy: boolean }
type Remote = { facts: SyncedPublishedSnapshotFacts; manifest: Buffer; objects: Map<string, Buffer>; assets: Map<string, Buffer> }
const prepareds = new WeakMap<PreparedSyncedPublication, Prepared>(), remotes = new WeakMap<SyncedPublishedSnapshot, Remote>()
const targetKeys = ['enabled', 'url', 'username', 'directory', 'intervalMinutes', 'allowInsecureHttp'] as const
function unavailable(message: string): never { throw new SyncedPublicationError('unavailable', message) }
function spelling(path: string): string { return process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path) }
function assertSafe(path: string, root?: string): void {
  const absolute = resolve(path)
  if (root) { const child = relative(resolve(root), absolute); if (child === '..' || child.startsWith('..' + sep) || isAbsolute(child)) throw new SyncedPublicationError('spool', '文件越过应用私有目录。') }
  let current = parse(absolute).root
  for (const part of relative(current, absolute).split(sep).filter(Boolean)) { current = join(current, part); const info = lstatSync(current, { throwIfNoEntry: false }); if (info?.isSymbolicLink()) throw new SyncedPublicationError('spool', '应用私有路径包含符号链接。') }
}
function databaseBoundary(db: Database.Database): void {
  if (db.readonly) return unavailable('只读 connection 不具备本片发布/确认权限。')
  if (!db.open) return unavailable('原 connection 已关闭。')
  if (db.inTransaction) return publicationInvalid('不能使用调用方事务。')
  if (db.pragma('foreign_keys', { simple: true }) !== 1) return publicationInvalid('外键保护必须开启。')
}
function environment(db: Database.Database, input: SyncedPublicationPrepareInput): { paths: Paths; target: WebDavSyncConfig } {
  databaseBoundary(db); assertSyncedShape(input, ['attemptId', 'userDataRoot', 'target'])
  if (!isSyncedUuid(input.attemptId) || typeof input.userDataRoot !== 'string' || !isAbsolute(input.userDataRoot)) return publicationInvalid('attempt UUID 或 Main userDataRoot 无效。')
  assertSyncedShape(input.target, targetKeys)
  let target: WebDavSyncConfig
  try { target = Object.freeze(normalizeWebDavConfig(input.target)) } catch (cause) { throw new SyncedPublicationError('invalid', '发布目标无效。', cause) }
  const root = resolve(input.userDataRoot), storage = join(root, 'storage'), expectedDatabase = join(storage, 'knowbook.db')
  assertSafe(root); assertSafe(expectedDatabase)
  if (typeof db.name !== 'string' || spelling(db.name) !== spelling(expectedDatabase) || !lstatSync(expectedDatabase).isFile()
    || spelling(realpathSync(expectedDatabase)) !== spelling(expectedDatabase) || spelling(realpathSync(root)) !== spelling(root)) return unavailable('connection 不是该 Main 应用根的真实 knowbook.db。')
  const spoolRoot = join(storage, 'synced-publications-v1'), assetRoot = join(storage, 'assets'); assertSafe(spoolRoot, storage); assertSafe(assetRoot, storage)
  return { paths: { root, databasePath: realpathSync(expectedDatabase), assetRoot, spoolRoot, directory: join(spoolRoot, input.attemptId) }, target }
}
function storedTarget(target: WebDavSyncConfig): StoredTarget { return { url: target.url, username: target.username, directory: target.directory, allowInsecureHttp: target.allowInsecureHttp } }
function targetFingerprint(target: WebDavSyncConfig): string { return publicationHash(publicationJson({ kind: 'webdav-target', version: 1, channel: 'webdav-manifest5', url: target.url, username: target.username, directory: target.directory })) }
function runtime(input: SyncedPublicationRuntime): SyncedPublicationRuntime {
  assertSyncedShape(input, ['password'], ['signal'])
  if (typeof input.password !== 'string' || input.signal !== undefined && !(input.signal instanceof AbortSignal)) return publicationInvalid('runtime credentials/signal 无效。')
  return { password: input.password, ...(input.signal ? { signal: input.signal } : {}) }
}
function accept(db: Database.Database, prepared: PreparedSyncedPublication): Prepared {
  databaseBoundary(db); const data = prepareds.get(prepared)
  if (!data || data.db !== db || data.closed) return unavailable('不是本 connection 的 live prepared publication。')
  if (data.busy) return unavailable('同一 prepared publication 已有在途 job。')
  assertSafe(data.paths.directory, data.paths.spoolRoot)
  if (spelling(db.name) !== spelling(data.paths.databasePath)) return unavailable('原数据库路径已变。')
  data.busy = true; return data
}
async function publicBoundary<T>(run: () => Promise<T>): Promise<T> {
  try { return await run() } catch (cause) {
    if (cause instanceof SyncedPublicationError) throw cause
    const sql = cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string' && cause.code.startsWith('SQLITE')
    throw new SyncedPublicationError(sql ? 'database' : 'invalid', '准备或严格发布边界失败。', cause)
  }
}
async function network<T>(run: () => Promise<T>): Promise<T> { try { return await run() } catch (cause) { if (cause instanceof SyncedPublicationError) throw cause; if (cause instanceof Error && cause.message === '远端同步文件超过大小限制。') throw new SyncedPublicationError('invalid', '远端原bytes超过既有读取门槛。', cause); throw new SyncedPublicationError('transport', '真实 WebDAV 请求失败；possible 证据保持。', cause) } }
async function contentNetwork<T>(data: Prepared, run: () => Promise<T>): Promise<T> {
  if (readSyncedPublicationAttempt(data.db, data.claim) === 'missing') return unavailable('内容请求没有原durable attempt。')
  return network(run)
}
function identity(data: Prepared): SyncedPublicationIdentity { return { attemptId: data.state.attemptId, publicationHash: data.state.publicationHash } }
function facts(data: Prepared): PreparedSyncedPublicationFacts { return { ...identity(data), workspaceScope: data.state.descriptor.workspaceScope, recoveryEpoch: data.state.descriptor.recoveryEpoch, targetFingerprint: data.state.descriptor.targetFingerprint, requestHash: data.state.requestHash, descriptor: data.state.descriptor } }
function mint(data: Prepared): SyncedPublicationPreparedResult { const prepared = Object.freeze({ kind: 'prepared-synced-publication' as const }); prepareds.set(prepared, data); return { status: 'prepared', prepared } }
export function readPreparedSyncedPublication(prepared: PreparedSyncedPublication): Readonly<PreparedSyncedPublicationFacts> | null { const data = prepareds.get(prepared); return data && !data.closed ? frozenPublicationFacts(facts(data)) : null }
export function disposePreparedSyncedPublication(prepared: PreparedSyncedPublication): boolean { const data = prepareds.get(prepared); if (!data || data.closed) return false; data.closed = true; return true }
export function readSyncedPublishedSnapshotFacts(plan: SyncedPublishedSnapshot): Readonly<SyncedPublishedSnapshotFacts> | null { const data = remotes.get(plan); return data ? frozenPublicationFacts(data.facts) : null }
function recordAssets(records: InitialPublicationRecord[], mapper: (uri: string) => string): InitialPublicationRecord[] { return records.map(record => record.kind === 'synced-group' ? rewriteSyncedGroupAssets(record, mapper) : record.kind === 'document' ? rewriteSyncedPortableHostAssets(record, mapper) : record) }
async function portable(snapshot: SyncedPublicationLocalSnapshot, paths: Paths): Promise<{ records: InitialPublicationRecord[]; assets: Map<string, Buffer> }> {
  const records = mapPublicationCatalog(snapshot.records, snapshot.catalogId), wanted = new Set<string>()
  // Discovery output is discarded; syntactic placeholders are never spooled, sent or used as byte authority.
  recordAssets(records, uri => { wanted.add(uri); return /^file:/i.test(uri) ? syncedManagedAssetBudgetUri(uri) : uri })
  const replacements = new Map<string, string>(), assets = new Map<string, Buffer>(), attachments = new AttachmentStore(paths.assetRoot)
  try {
    for (const uri of wanted) {
      let local: string, expectedHash: string, name: string
      if (/^file:/i.test(uri)) {
        local = attachments.resolve(uri); name = attachments.get(uri).name; const child = relative(paths.assetRoot, local).split(sep)
        if (child.length !== 4 || child[0] !== 'attachments' || !/^[a-f0-9]{64}$/.test(child[2]) || child[1] !== child[2].slice(0, 2) || child[3] !== name) throw new Error('不是原 managed hash/name 路径。')
        expectedHash = child[2]
      } else { const asset = parseSyncedPortableAssetUri(uri); expectedHash = asset.hash; name = asset.name; local = attachments.resolve(pathToFileURL(join(paths.assetRoot, 'attachments', asset.hash.slice(0, 2), asset.hash, asset.name)).href) }
      const info = lstatSync(local)
      if (!info.isFile() || info.size > ATTACHMENT_MAX_FILE_BYTES) throw new Error('真实附件超过原单文件25MiB门槛。')
      const bytes = await readFile(local)
      if (bytes.length !== info.size || publicationHash(bytes) !== expectedHash) throw new Error('真实附件原 bytes 与 managed hash 不一致。')
      const previous = assets.get(expectedHash); if (previous && !previous.equals(bytes)) throw new Error('同hash附件 bytes 不一致。')
      assets.set(expectedHash, bytes); replacements.set(uri, buildSyncedPortableAssetUri({ hash: expectedHash, name }))
    }
  } catch (cause) { throw new SyncedPublicationError('asset', '真实本机附件缺失、越界或原 bytes 校验失败。', cause) }
  return { records: recordAssets(records, uri => replacements.get(uri) ?? publicationInvalid('附件映射未闭合。')), assets }
}
function build(snapshot: SyncedPublicationLocalSnapshot, target: WebDavSyncConfig, attemptId: string, material: { records: InitialPublicationRecord[]; assets: Map<string, Buffer> }): LoadedSpool {
  const entries: Record<string, string> = {}, objects = new Map<string, Buffer>()
  const descriptors = material.records.map(record => {
    const key = publicationRecordKey(record), bytes = Buffer.from(publicationJson(record)), hash = publicationHash(bytes)
    if (bytes.length > PUBLICATION_RECORD_MAX_BYTES) return publicationInvalid('记录超过原16MiB门槛。')
    entries[key] = hash; objects.set(key, bytes); return { key, path: 'objects/' + hash + '.json', hash, bytes: bytes.length }
  }).sort((a, b) => publicationCompare(a.key, b.key))
  const syncedInstances = material.records.flatMap(record => record.kind !== 'document' ? [] : record.content.blocks.flatMap(block => {
    if (block.type !== 'synced-block') return []
    const payload = parseSyncedBlockPayload(block.content)
    return [{ documentId: record.id, instanceId: block.id, groupId: payload.groupId, groupHash: entries['group:' + payload.groupId] }]
  })).sort((a, b) => publicationCompare(a.documentId, b.documentId) || publicationCompare(a.instanceId, b.instanceId))
  const manifest: SyncedInitialManifest5 = { version: 5, workspaceId: snapshot.workspaceScope, entries, syncedInstances }
  const validated = validateInitialSnapshot(manifest, material.records.map(record => ({ key: publicationRecordKey(record), record })))
  const manifestBytes = Buffer.from(publicationJson(validated.manifest))
  if (manifestBytes.length > PUBLICATION_RECORD_MAX_BYTES) return publicationInvalid('Manifest5超过原16MiB门槛。')
  const assets = [...validated.assetNames].map(([hash, names]) => {
    const bytes = material.assets.get(hash); if (!bytes) return publicationInvalid('实际引用资产缺少原bytes。')
    return { path: 'assets/' + hash, hash, bytes: bytes.length, names: [...names].sort(publicationCompare) }
  }).sort((a, b) => publicationCompare(a.path, b.path))
  if (assets.length !== material.assets.size) return publicationInvalid('资产没有精确闭合实际引用。')
  const descriptor = validatePublicationDescriptor({ kind: 'synced-publication', version: 1, channel: 'webdav-manifest5', workspaceScope: snapshot.workspaceScope,
    recoveryEpoch: snapshot.recoveryEpoch, localFingerprint: snapshot.localFingerprint, targetFingerprint: targetFingerprint(target),
    manifest: { path: 'manifest.json', hash: publicationHash(manifestBytes), bytes: manifestBytes.length }, objects: descriptors, assets,
    members: snapshot.groups.map(item => ({ groupId: item.wire.id, creationId: item.wire.creationId, revision: item.revision,
      topologyRevision: item.topologyRevision, semanticHash: item.semanticHash, portableHash: entries['group:' + item.wire.id] })) })
  const state: SpoolState = { kind: 'synced-publication-spool', version: 1, attemptId, databasePath: '', target: storedTarget(target), descriptor,
    publicationHash: publicationHash(publicationJson(descriptor)), requestHash: syncedPublicationRequestHash(attemptId, descriptor) }
  return { state, manifest: manifestBytes, objects, assets: material.assets }
}
async function durableFile(path: string, bytes: Uint8Array): Promise<void> { const handle = await open(path, 'wx', 0o600); try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() } }
async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return // File sync+finished rename: process-crash recovery, never a power-loss guarantee.
  const handle = await open(path, 'r'); try { await handle.sync() } finally { await handle.close() }
}
async function writeSpool(paths: Paths, spool: LoadedSpool): Promise<void> {
  assertSafe(paths.spoolRoot); await mkdir(paths.spoolRoot, { recursive: true, mode: 0o700 }); assertSafe(paths.spoolRoot)
  if (lstatSync(paths.directory, { throwIfNoEntry: false })) {
    const saved = await loadSpool(paths)
    if (publicationJson(saved.state) !== publicationJson(spool.state)) throw new SyncedPublicationError('spool', '同attempt成品不是原request/bytes/target；不会覆盖。')
    return
  }
  const temporary = join(paths.spoolRoot, '.preparing-' + spool.state.attemptId + '-' + randomUUID())
  assertSafe(temporary, paths.spoolRoot); await mkdir(temporary, { mode: 0o700 }); await mkdir(join(temporary, 'objects'), { mode: 0o700 }); await mkdir(join(temporary, 'assets'), { mode: 0o700 })
  for (const object of spool.state.descriptor.objects) await durableFile(join(temporary, object.path), spool.objects.get(object.key)!)
  for (const asset of spool.state.descriptor.assets) await durableFile(join(temporary, asset.path), spool.assets.get(asset.hash)!)
  await durableFile(join(temporary, 'manifest.json'), spool.manifest)
  const state = Buffer.from(publicationJson(spool.state)); await durableFile(join(temporary, 'state.json'), state)
  await durableFile(join(temporary, 'ready.json'), Buffer.from(publicationJson({ kind: 'synced-publication-ready', version: 1, attemptId: spool.state.attemptId,
    publicationHash: spool.state.publicationHash, requestHash: spool.state.requestHash, stateHash: publicationHash(state) })))
  await syncDirectory(join(temporary, 'objects')); await syncDirectory(join(temporary, 'assets')); await syncDirectory(temporary); assertSafe(paths.directory, paths.spoolRoot)
  try { await rename(temporary, paths.directory) } catch (cause) {
    if (!lstatSync(paths.directory, { throwIfNoEntry: false })) throw cause
    const saved = await loadSpool(paths)
    if (publicationJson(saved.state) !== publicationJson(spool.state)) throw new SyncedPublicationError('spool', '并发attempt成品不同；不会覆盖。', cause)
  }
  await syncDirectory(paths.spoolRoot)
}
async function spoolFile(paths: Paths, name: string, expected?: { hash: string; bytes: number }): Promise<Buffer> {
  const file = join(paths.directory, name); assertSafe(file, paths.directory); const info = lstatSync(file)
  if (!info.isFile() || expected && info.size !== expected.bytes) throw new Error('spool文件类型/长度不符。')
  const bytes = await readFile(file)
  if (bytes.length !== info.size || expected && publicationHash(bytes) !== expected.hash) throw new Error('spool准确原bytes哈希不符。')
  return bytes
}
async function loadSpool(paths: Paths): Promise<LoadedSpool> {
  try {
    assertSafe(paths.directory, paths.spoolRoot)
    const readyBytes = await spoolFile(paths, 'ready.json'), ready = decodePublicationJson(readyBytes, Math.max(1, readyBytes.length))
    assertSyncedShape(ready, ['kind', 'version', 'attemptId', 'publicationHash', 'requestHash', 'stateHash'])
    if (ready.kind !== 'synced-publication-ready' || ready.version !== 1) throw new Error('spool未完成。')
    const stateBytes = await spoolFile(paths, 'state.json'); if (publicationHash(stateBytes) !== ready.stateHash) throw new Error('原stateHash不符。')
    const raw = decodePublicationJson(stateBytes, Math.max(1, stateBytes.length))
    assertSyncedShape(raw, ['kind', 'version', 'attemptId', 'databasePath', 'target', 'descriptor', 'publicationHash', 'requestHash'])
    assertSyncedShape(raw.target, ['url', 'username', 'directory', 'allowInsecureHttp'])
    if (raw.kind !== 'synced-publication-spool' || raw.version !== 1 || !isSyncedUuid(raw.attemptId) || typeof raw.publicationHash !== 'string' || typeof raw.requestHash !== 'string' || raw.attemptId !== ready.attemptId
      || raw.publicationHash !== ready.publicationHash || raw.requestHash !== ready.requestHash || typeof raw.databasePath !== 'string'
      || spelling(raw.databasePath) !== spelling(paths.databasePath) || typeof raw.target.url !== 'string' || typeof raw.target.username !== 'string'
      || typeof raw.target.directory !== 'string' || typeof raw.target.allowInsecureHttp !== 'boolean') throw new Error('原spool身份/目标或数据库路径不符。')
    const descriptor = validatePublicationDescriptor(raw.descriptor)
    if (publicationHash(publicationJson(descriptor)) !== raw.publicationHash || syncedPublicationRequestHash(raw.attemptId, descriptor) !== raw.requestHash) throw new Error('原publication/request不符。')
    const state: SpoolState = { kind: 'synced-publication-spool', version: 1, attemptId: raw.attemptId, databasePath: raw.databasePath,
      target: { url: raw.target.url, username: raw.target.username, directory: raw.target.directory, allowInsecureHttp: raw.target.allowInsecureHttp },
      descriptor, publicationHash: raw.publicationHash, requestHash: raw.requestHash }
    const manifest = await spoolFile(paths, 'manifest.json', descriptor.manifest), objects = new Map<string, Buffer>(), assets = new Map<string, Buffer>()
    for (const object of descriptor.objects) objects.set(object.key, await spoolFile(paths, object.path, object))
    for (const asset of descriptor.assets) assets.set(asset.hash, await spoolFile(paths, asset.path, asset))
    const files = ['state.json', 'ready.json', 'manifest.json', ...descriptor.objects.map(item => item.path), ...descriptor.assets.map(item => item.path)].sort(publicationCompare), found: string[] = []
    for (const entry of await readdir(paths.directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('spool含symlink。')
      if (entry.isDirectory()) {
        if (entry.name !== 'objects' && entry.name !== 'assets') throw new Error('spool出现未登记目录。')
        for (const child of await readdir(join(paths.directory, entry.name), { withFileTypes: true })) { if (!child.isFile() || child.isSymbolicLink()) throw new Error('spool出现非原文件。'); found.push(entry.name + '/' + child.name) }
      } else if (entry.isFile()) found.push(entry.name); else throw new Error('spool出现非原文件。')
    }
    if (publicationJson(found.sort(publicationCompare)) !== publicationJson([...new Set(files)].sort(publicationCompare))) throw new Error('spool不是精确文件闭集。')
    const validated = validateInitialSnapshot(decodePublicationJson(manifest), descriptor.objects.map(item => ({ key: item.key, record: decodePublicationJson(objects.get(item.key)!) })))
    if (validated.manifest.workspaceId !== descriptor.workspaceScope) throw new Error('manifest workspace不符。')
    const expectedAssets = [...validated.assetNames].map(([hash, names]) => ({ path: 'assets/' + hash, hash, bytes: assets.get(hash)?.length ?? -1,
      names: [...names].sort(publicationCompare) })).sort((a, b) => publicationCompare(a.path, b.path))
    if (publicationJson(expectedAssets) !== publicationJson(descriptor.assets)) throw new Error('实际资产名/bytes闭集不符。')
    const actualGroups = validated.records.filter(item => item.record.kind === 'synced-group'), memberMap = new Map(descriptor.members.map(item => [item.groupId, item]))
    if (actualGroups.length !== descriptor.members.length) throw new Error('实际groups与members不符。')
    for (const item of actualGroups) { if (item.record.kind !== 'synced-group') continue; const member = memberMap.get(item.record.id)
      if (!member || member.creationId !== item.record.creationId || member.portableHash !== validated.manifest.entries[item.key]) throw new Error('实际portable group hash不符。') }
    return { state, manifest, objects, assets }
  } catch (cause) { if (cause instanceof SyncedPublicationError && cause.code === 'spool') throw cause; throw new SyncedPublicationError('spool', '私有完整原bytes缺失、损坏或不是该原spool。', cause) }
}
function originalSpool(data: Prepared, loaded: LoadedSpool): void { if (publicationJson(data.state) !== publicationJson(loaded.state)) throw new SyncedPublicationError('spool', 'spool不是该真实handle的原状态。') }
export async function prepareInitialSyncedPublication(db: Database.Database, input: SyncedPublicationPrepareInput): Promise<SyncedPublicationPrepareResult> {
  return publicBoundary(async () => {
    const { paths, target } = environment(db, input), capture = captureSyncedPublicationSnapshot(db)
    if (capture.status === 'unsupported') return capture
    const snapshot = readSyncedPublicationCapture(capture.capture) ?? unavailable('真实捕获缺失。')
    const loaded = build(snapshot, target, input.attemptId, await portable(snapshot, paths)); loaded.state.databasePath = paths.databasePath
    try { await writeSpool(paths, loaded) } catch (cause) { if (cause instanceof SyncedPublicationError) throw cause; throw new SyncedPublicationError('spool', '私有spool未能完整持久完成。', cause) }
    const verified = await loadSpool(paths)
    if (publicationJson(verified.state) !== publicationJson(loaded.state)) throw new SyncedPublicationError('spool', '成品不是原准备bytes。')
    const claim = bindSyncedPublicationCapture(db, capture.capture, { attemptId: input.attemptId, descriptor: loaded.state.descriptor })
    return mint({ db, paths, target, state: frozenPublicationFacts(loaded.state), claim, closed: false, busy: false })
  })
}
export async function recoverInitialSyncedPublication(db: Database.Database, input: SyncedPublicationPrepareInput): Promise<SyncedPublicationPreparedResult> {
  return publicBoundary(async () => {
    const { paths, target } = environment(db, input), loaded = await loadSpool(paths)
    if (loaded.state.attemptId !== input.attemptId || loaded.state.descriptor.targetFingerprint !== targetFingerprint(target)
      || publicationJson(loaded.state.target) !== publicationJson(storedTarget(target))) return unavailable('原attempt/目标/私有spool不匹配。')
    const claim = recoverSyncedPublicationClaim(db, { attemptId: input.attemptId, descriptor: loaded.state.descriptor, publicationHash: loaded.state.publicationHash, requestHash: loaded.state.requestHash })
    return mint({ db, paths, target, state: frozenPublicationFacts(loaded.state), claim, closed: false, busy: false })
  })
}
export async function readSyncedPublishedSnapshot(client: WebDavClient): Promise<{ status: 'missing' } | { status: 'ready'; plan: SyncedPublishedSnapshot } | { status: 'unsupported'; reason: 'initial-snapshot-only' }> {
  return publicBoundary(async () => {
    if (!(client instanceof WebDavClient) || Object.getPrototypeOf(client) !== WebDavClient.prototype) return publicationInvalid('readonly reader需要真实WebDavClient。')
    const response = await network(() => client.getVersioned('manifest.json', PUBLICATION_RECORD_MAX_BYTES))
    if (!response) return { status: 'missing' as const }
    const rawManifest = parseStrictJson(Buffer.from(response.bytes).toString('utf8'), { maxBytes: PUBLICATION_RECORD_MAX_BYTES, maxDepth: 32 })
    if (!rawManifest || typeof rawManifest !== 'object' || !('version' in rawManifest)) return publicationInvalid('Manifest版本缺失。')
    if (rawManifest.version !== 5) return { status: 'unsupported' as const, reason: 'initial-snapshot-only' as const }
    const manifest = validateInitialManifest5(decodePublicationJson(response.bytes)), records: Array<{ key: string; record: unknown }> = [], objects = new Map<string, Buffer>()
    for (const [key, hash] of Object.entries(manifest.entries)) {
      const object = await network(() => client.get('objects/' + hash + '.json', PUBLICATION_RECORD_MAX_BYTES))
      if (!object || publicationHash(object.bytes) !== hash) return publicationInvalid('远端对象原bytes缺失或hash不符。')
      const record = decodePublicationJson(object.bytes)
      if (record && typeof record === 'object' && 'kind' in record && (record.kind === 'deleted' || record.kind === 'synced-group-deleted')) return { status: 'unsupported' as const, reason: 'initial-snapshot-only' as const }
      objects.set(key, Buffer.from(object.bytes)); records.push({ key, record })
    }
    const validated = validateInitialSnapshot(manifest, records), assets = new Map<string, Buffer>(), assetFacts: PublicationAssetDescriptor[] = []
    for (const [hash, names] of validated.assetNames) {
      const object = await network(() => client.get('assets/' + hash, ATTACHMENT_MAX_FILE_BYTES))
      if (!object || publicationHash(object.bytes) !== hash) return publicationInvalid('远端真实资产缺失或hash不符。')
      assets.set(hash, Buffer.from(object.bytes)); assetFacts.push({ path: 'assets/' + hash, hash, bytes: object.bytes.length, names: [...names].sort(publicationCompare) })
    }
    const plan = Object.freeze({ kind: 'synced-published-initial-snapshot' as const })
    remotes.set(plan, { manifest: Buffer.from(response.bytes), objects, assets, facts: frozenPublicationFacts({ manifest: validated.manifest,
      records: validated.records.map(item => ({ ...item, hash: manifest.entries[item.key], bytes: objects.get(item.key)!.length })),
      assets: assetFacts.sort((a, b) => publicationCompare(a.path, b.path)) }) })
    return { status: 'ready' as const, plan }
  })
}
function matches(data: Prepared, spool: LoadedSpool, remote: Remote): boolean {
  const descriptor = data.state.descriptor
  const objects = remote.facts.records.map(item => ({ key: item.key, path: 'objects/' + item.hash + '.json', hash: item.hash, bytes: item.bytes })).sort((a, b) => publicationCompare(a.key, b.key))
  return remote.manifest.equals(spool.manifest) && publicationJson(objects) === publicationJson(descriptor.objects) && publicationJson(remote.facts.assets) === publicationJson(descriptor.assets)
}
async function query(data: Prepared, spool: LoadedSpool, client: WebDavClient): Promise<SyncedPublicationConfirmed | SyncedPublicationConflict | SyncedPublicationMissing> {
  const result = await readSyncedPublishedSnapshot(client)
  if (result.status === 'missing') return { status: 'missing', ...identity(data) }
  if (result.status !== 'ready' || !matches(data, spool, remotes.get(result.plan)!)) return { status: 'conflict', ...identity(data) }
  const confirmed = confirmSyncedPublication(data.db, data.claim)
  return { status: 'confirmed', ...identity(data), replayed: confirmed.replayed }
}
export async function queryInitialSyncedPublication(db: Database.Database, prepared: PreparedSyncedPublication, options: SyncedPublicationRuntime): Promise<SyncedPublicationConfirmed | SyncedPublicationConflict | SyncedPublicationMissing> {
  return publicBoundary(async () => {
    const data = accept(db, prepared)
    try {
      const credentials = runtime(options), spool = await loadSpool(data.paths); originalSpool(data, spool)
      if (readSyncedPublicationAttempt(db, data.claim) === 'missing') return unavailable('没有可查询确认的原durable attempt。')
      // No test/initialize: only versioned GET and its necessary readonly HEAD/PROPFIND.
      return await query(data, spool, new WebDavClient(data.target, credentials.password, credentials.signal))
    } finally { data.busy = false }
  })
}
async function verifyCurrentAssets(data: Prepared, spool: LoadedSpool): Promise<boolean> {
  if (!currentSyncedPublicationMatches(data.db, data.claim)) return false
  const capture = captureSyncedPublicationSnapshot(data.db)
  if (capture.status !== 'ready') return false
  const snapshot = readSyncedPublicationCapture(capture.capture)
  if (!snapshot || snapshot.localFingerprint !== data.state.descriptor.localFingerprint) return false
  // This proof is discarded; every HTTP payload still comes only from the original spool buffers.
  const checked = build(snapshot, data.target, data.state.attemptId, await portable(snapshot, data.paths))
  return publicationJson(checked.state.descriptor) === publicationJson(spool.state.descriptor)
}
export async function publishInitialSyncedPublication(db: Database.Database, prepared: PreparedSyncedPublication, options: SyncedPublicationRuntime): Promise<SyncedPublicationConfirmed | SyncedPublicationConflict | SyncedPublicationStale> {
  return publicBoundary(async () => {
    const data = accept(db, prepared)
    try {
      const credentials = runtime(options), spool = await loadSpool(data.paths); originalSpool(data, spool)
      const prior = readSyncedPublicationAttempt(db, data.claim)
      if (prior === 'confirmed') return { status: 'confirmed', ...identity(data), replayed: true }
      const client = new WebDavClient(data.target, credentials.password, credentials.signal)
      const remote = await network(() => client.getVersioned('manifest.json', PUBLICATION_RECORD_MAX_BYTES))
      if (remote) {
        if (prior === 'missing') return { status: 'conflict', ...identity(data) }
        const checked = await query(data, spool, client)
        return checked.status === 'missing' ? { status: 'conflict', ...identity(data) } : checked
      }
      if (!currentSyncedPublicationMatches(db, data.claim)) return { status: 'stale', ...identity(data) }
      await network(() => client.test()) // Only nonknowledge probes/MKCOL before durable claim.
      if (!await verifyCurrentAssets(data, spool)) return { status: 'stale', ...identity(data) }
      const claimed = claimSyncedPublication(db, data.claim)
      if (claimed === 'stale') return { status: 'stale', ...identity(data) }
      if (claimed === 'confirmed') return { status: 'confirmed', ...identity(data), replayed: true }
      // All content HEAD/PUT requests, cached paths and later temporary Manifest PUT are after committed all-member possible.
      for (const asset of data.state.descriptor.assets) {
        if (await contentNetwork(data, () => client.exists(asset.path))) {
          const cached = await contentNetwork(data, () => client.get(asset.path, ATTACHMENT_MAX_FILE_BYTES))
          if (!cached || publicationHash(cached.bytes) !== asset.hash) return publicationInvalid('目标缓存资产不是原hash bytes。')
        } else await contentNetwork(data, () => client.put(asset.path, spool.assets.get(asset.hash)!))
      }
      for (const object of data.state.descriptor.objects) {
        if (await contentNetwork(data, () => client.exists(object.path))) {
          const cached = await contentNetwork(data, () => client.get(object.path, PUBLICATION_RECORD_MAX_BYTES))
          if (!cached || publicationHash(cached.bytes) !== object.hash) return publicationInvalid('目标缓存对象不是原hash bytes。')
        } else await contentNetwork(data, () => client.put(object.path, spool.objects.get(object.key)!))
      }
      if (!await verifyCurrentAssets(data, spool) || !currentSyncedPublicationMatches(db, data.claim)) return { status: 'stale', ...identity(data) }
      readSyncedPublicationAttempt(db, data.claim) // Recheck original connection/epoch before the actual create job.
      try { await client.create('manifest.json', spool.manifest) } catch (cause) {
        if (!(cause instanceof WebDavHttpError) || cause.status !== 412) throw new SyncedPublicationError('transport', 'Manifest落盘响应失败；原possible保持，使用显式query确认。', cause)
        const checked = await query(data, spool, client)
        return checked.status === 'missing' ? { status: 'conflict', ...identity(data) } : checked
      }
      const checked = await query(data, spool, client)
      return checked.status === 'missing' ? { status: 'conflict', ...identity(data) } : checked
    } finally { data.busy = false }
  })
}
