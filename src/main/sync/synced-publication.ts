import { assertSyncedBlockSchema } from '../database/synced-schema'
import { validateSyncedProtocol5Record, validateSyncedProtocol5Snapshot,
  type SyncedProtocol5Record } from './synced-protocol5-model'
import { readInitialIncomingLocal, readInitialIncomingReceipt, readInitialIncomingBaseline, readInitialIncomingIdentityDigest, type InitialIncomingLocal } from '../database/synced-initial-incoming-read'
import { readSyncedPersistentPublicationSnapshot } from '../database/synced-publication'
import { MarkdownLinkIndex } from '../database/markdown-link-index'
import { parseDatabaseViewPayload } from '../../shared/databaseViewBlock'
import { SYNC_TABLE_COLUMNS, SYNC_TABLES, type SyncDatabases } from './model'
import { initialIncomingTargetFingerprint, initialIncomingRequestHash, initialIncomingBaselineKey, initialIncomingReservationKey,
  initialIncomingPortableDigest, initialIncomingReservationDigest, incomingComponents, inverseInitialIncomingCatalog,
  validateInitialIncomingReceipt, validateInitialIncomingBaseline, type InitialIncomingRequest, type InitialIncomingReceipt,
  type InitialIncomingBaseline, type InitialIncomingReservationSource, type SyncedInitialIncomingInput,
  type SyncedInitialIncomingResult, type SyncedInitialIncomingAccepted, type SyncedInitialIncomingComponent } from './synced-initial-incoming-model'
export type { SyncedInitialIncomingInput, SyncedInitialIncomingResult, SyncedInitialIncomingAccepted,
  SyncedInitialIncomingConflictReason, SyncedInitialIncomingComponent } from './synced-initial-incoming-model'
import { assertSyncedLifecycleSchema } from '../database/synced-lifecycle-schema'
import { readSyncedGroupLifecycles, syncedLifecycleSemanticHash } from '../database/synced-lifecycle-state'
import { getSyncedGroupSnapshots } from '../database/synced-blocks-read'
import { assertSyncedRemoteObservationRecords, readObservedLocalIncarnation, readSyncedRemoteObservation } from '../database/synced-remote-observation-read'
import { holdSyncedObservationPending, releaseSyncedObservationPending, observationDatabasePath, type SyncedObservationPendingLease } from '../database/synced-remote-observation-pending'
import { observationKey, sameObservedIncarnation, validateObservedIncarnation, validateRemoteObservationMarker, observationRequestHash, observationCorrupt, SYNCED_OBSERVATION_CHANNEL, SYNCED_RETIRED_OBSERVATION_CHANNEL, type SyncedObservedIncarnation, type SyncedRemoteObservationMarker, type SyncedObservationRemote } from '../database/synced-remote-observation-codec'
import type { SyncedGroupSnapshot, SyncedGroupWire, SyncedStableBlockDraft, SyncedCanonicalWire } from '../../shared/synced-blocks'
import { SYNCED_MAX_BLOCKS } from '../../shared/syncedBlockValidation'
import { randomUUID } from 'node:crypto'
import { lstatSync, realpathSync, readFileSync, mkdirSync, linkSync } from 'node:fs'
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import type Database from 'better-sqlite3'
import type { WebDavSyncConfig } from '../../shared/webdav-sync'
import { parseStrictJson } from '../../shared/strictJson'
import { ATTACHMENT_MAX_FILE_BYTES } from '../../shared/attachments'
import { assertSyncedShape, isSyncedUuid, parseSyncedBlockPayload } from '../../shared/syncedBlockValidation'
import { buildSyncedPortableAssetUri, parseSyncedPortableAssetUri, rewriteSyncedGroupAssets,
  rewriteSyncedPortableHostAssets, localizeSyncedPortableGroupAssets, localizeSyncedPortableHostAssets, syncedManagedAssetBudgetUri } from '../../shared/syncedBlockPortable'
import { AttachmentStore } from '../attachments'
import { WebDavClient, WebDavHttpError, normalizeWebDavConfig } from './webdav-client'
import { bindSyncedPublicationCapture, captureSyncedPublicationSnapshot, claimSyncedPublication, confirmSyncedPublication,
  currentSyncedPublicationMatches, readSyncedPublicationAttempt, readSyncedPublicationCapture, recoverSyncedPublicationClaim,
  syncedPublicationRequestHash, type SyncedPublicationClaim, type SyncedPublicationLocalSnapshot } from '../database/synced-publication'
import { SyncedPublicationError, decodePublicationJson, frozenPublicationFacts, mapPublicationCatalog, publicationCompare,
  publicationHash, publicationInvalid, publicationJson, publicationRecordKey, PUBLICATION_RECORD_MAX_BYTES,
  validateInitialSnapshot, validateInitialRecord, validateInitialManifest5, validatePublicationDescriptor, type InitialPublicationRecord, type PublicationDescriptor,
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
type Remote = { facts: SyncedPublishedSnapshotFacts; manifestEtag: string; manifest: Buffer; objects: Map<string, Buffer>; assets: Map<string, Buffer> }
type ObservedClosure = { manifest: Buffer; facts: { manifest: SyncedInitialManifest5;
  records: Array<{ key: string; hash: string; bytes: number; record: SyncedProtocol5Record }>; assets: PublicationAssetDescriptor[] } }
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
async function readPublishedSnapshot(client: WebDavClient, completed?: (remote: Remote) => void): Promise<{ status: 'missing' } | { status: 'ready'; plan: SyncedPublishedSnapshot } | { status: 'unsupported'; reason: 'initial-snapshot-only' }> {
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
    const remote: Remote = { manifestEtag: response.etag, manifest: Buffer.from(response.bytes), objects, assets, facts: frozenPublicationFacts({ manifest: validated.manifest,
      records: validated.records.map(item => ({ ...item, hash: manifest.entries[item.key], bytes: objects.get(item.key)!.length })),
      assets: assetFacts.sort((a, b) => publicationCompare(a.path, b.path)) }) }
    // Private completion runs synchronously after full closure, before any ready delivery.
    completed?.(remote)
    const plan = Object.freeze({ kind: 'synced-published-initial-snapshot' as const })
    remotes.set(plan, remote)
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

export async function readSyncedPublishedSnapshot(client: WebDavClient): ReturnType<typeof readPublishedSnapshot> { return readPublishedSnapshot(client) }

// Main-only historical observation. No incoming/install authority is exposed.
export interface SyncedRemoteObservation { readonly kind: 'synced-remote-observation' }
export type SyncedRemoteObservationOpen = { status: 'ready'; observation: SyncedRemoteObservation }
  | { status: 'unsupported'; reason: 'schema-27-required' }
export interface SyncedObservedGroupResult { groupId: string; creationId: string; outcome: 'active-confirmed' | 'retired-disabled'; reused: boolean }
export type SyncedRemoteExposureResult = { status: 'missing' } | { status: 'unsupported'; reason: 'initial-snapshot-only' }
  | { status: 'observed'; workspaceScope: string; recoveryEpoch: string; remoteWorkspaceId: string; manifestHash: string; closureHash: string;
      groups: SyncedObservedGroupResult[]; ignoredRemoteGroups: number }
export type SyncedRemoteObservationRetry = { status: 'no-pending' } | { status: 'committed'; proofs: number; groups: SyncedObservedGroupResult[] }
type ObservationContext = { workspaceScope: string; recoveryEpoch: string }
type Observation = { db: Database.Database; root: string; databasePath: string; target: WebDavSyncConfig;
  targetFingerprint: string; context: ObservationContext; busy: boolean; closed: boolean }
type ObservationProof = { databasePath: string; workspaceScope: string; recoveryEpoch: string; targetFingerprint: string;
  remoteWorkspaceId: string; manifestHash: string; closureHash: string; ignoredRemoteGroups: number;
  groups: Array<{ incarnation: SyncedObservedIncarnation; groupHash: string }> }
type PendingObservation = { proof: ObservationProof; leases: SyncedObservationPendingLease[] }
const observations = new WeakMap<SyncedRemoteObservation, Observation>()
// Only verified completion below can populate this registry. No db or payload buffers are retained here.
const pendingObservations = new Set<PendingObservation>()
function observationBoundary<T>(run: () => T): T {
  try { return run() } catch (cause) {
    if (cause instanceof SyncedPublicationError) throw cause
    const sql = cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string' && cause.code.startsWith('SQLITE')
    throw new SyncedPublicationError(sql ? 'database' : 'invalid', '远端历史观察边界失败；已知 pending 不会被撤销。', cause)
  }
}
function observationTargetFingerprint(target: WebDavSyncConfig): string {
  return publicationHash(publicationJson({ kind: 'webdav-target', version: 1, channel: SYNCED_OBSERVATION_CHANNEL,
    url: target.url, username: target.username, directory: target.directory }))
}
function observationEnvironment(db: Database.Database, input: { userDataRoot: string; target: WebDavSyncConfig }): { root: string; databasePath: string; target: WebDavSyncConfig } {
  databaseBoundary(db); assertSyncedShape(input, ['userDataRoot', 'target'])
  if (typeof input.userDataRoot !== 'string' || !isAbsolute(input.userDataRoot)) return publicationInvalid('观察必须使用 Main 真实应用根。')
  assertSyncedShape(input.target, targetKeys)
  let target: WebDavSyncConfig
  try { target = Object.freeze(normalizeWebDavConfig(input.target)) } catch (cause) { throw new SyncedPublicationError('invalid', '观察目标无效。', cause) }
  const root = resolve(input.userDataRoot), file = join(root, 'storage', 'knowbook.db')
  assertSafe(root); assertSafe(file)
  if (typeof db.name !== 'string' || spelling(db.name) !== spelling(file) || !lstatSync(file).isFile()
    || spelling(realpathSync(file)) !== spelling(file) || spelling(realpathSync(root)) !== spelling(root)) return unavailable('观察 connection 不是原 Main knowbook.db。')
  return { root, databasePath: observationDatabasePath(file), target }
}
function observationContext(db: Database.Database): ObservationContext {
  const row = db.prepare('SELECT workspace_scope,recovery_epoch FROM synced_workspace_state WHERE singleton=1').get() as { workspace_scope: unknown; recovery_epoch: unknown } | undefined
  if (!row || !isSyncedUuid(row.workspace_scope) || !isSyncedUuid(row.recovery_epoch)) return publicationInvalid('观察 workspace/recovery 身份无效。')
  return { workspaceScope: row.workspace_scope, recoveryEpoch: row.recovery_epoch }
}
/** Called only inside an owned read/IMMEDIATE; no caller transaction or raw context can enter. */
function currentObservation(data: Observation): void {
  if (!data.db.open || data.db.readonly) return unavailable('观察原 writable connection 已失效。')
  if (data.db.pragma('foreign_keys', { simple: true }) !== 1) return publicationInvalid('观察外键保护失效。')
  const file = join(data.root, 'storage', 'knowbook.db')
  assertSafe(data.root); assertSafe(file)
  if (observationDatabasePath(data.db.name) !== data.databasePath || observationDatabasePath(file) !== data.databasePath) return unavailable('观察真实数据库路径已变。')
  if (data.db.pragma('user_version', { simple: true }) !== 27) return unavailable('观察原 schema 世代已变。')
  assertSyncedBlockSchema(data.db)
  assertSyncedLifecycleSchema(data.db)
  if (publicationJson(observationContext(data.db)) !== publicationJson(data.context)) return unavailable('观察原 workspace/recovery 世代已变。')
}
export function openSyncedRemoteObservation(db: Database.Database, input: { userDataRoot: string; target: WebDavSyncConfig }): SyncedRemoteObservationOpen {
  return observationBoundary((): SyncedRemoteObservationOpen => {
    const environment = observationEnvironment(db, input), version = db.pragma('user_version', { simple: true })
    if (version === 26) { assertSyncedBlockSchema(db); return Object.freeze({ status: 'unsupported' as const, reason: 'schema-27-required' as const }) }
    if (version !== 27) return publicationInvalid('观察不迁移或修复未知/未来 schema。')
    const context = db.transaction(() => { assertSyncedBlockSchema(db); assertSyncedLifecycleSchema(db); return observationContext(db) })()
    const observation = Object.freeze({ kind: 'synced-remote-observation' as const })
    observations.set(observation, { db, ...environment, targetFingerprint: observationTargetFingerprint(environment.target), context, busy: false, closed: false })
    return Object.freeze({ status: 'ready' as const, observation })
  })
}
export function disposeSyncedRemoteObservation(observation: SyncedRemoteObservation): boolean {
  const data = observations.get(observation)
  if (!data || data.closed) return false
  data.closed = true; return true
}
function acceptObservation(observation: SyncedRemoteObservation): Observation {
  const data = observations.get(observation)
  if (!data || data.closed || data.busy) return unavailable('观察 handle 不存在、已关闭或 busy。')
  data.busy = true
  try { databaseBoundary(data.db); data.db.transaction(() => currentObservation(data))(); return data }
  catch (cause) { data.busy = false; throw cause }
}
function knownObservationIncarnations(data: Observation): Map<string, SyncedObservedIncarnation> {
  databaseBoundary(data.db)
  return data.db.transaction(() => {
    currentObservation(data)
    const ids = (data.db.prepare('SELECT id FROM synced_groups ORDER BY id').all() as Array<{ id: unknown }>).map(row => {
      if (!isSyncedUuid(row.id)) return publicationInvalid('本机观察索引的 group UUID 损坏。'); return row.id
    })
    for (let from = 0; from < ids.length; from += SYNCED_MAX_BLOCKS) readSyncedGroupLifecycles(data.db, ids.slice(from, from + SYNCED_MAX_BLOCKS))
    const tuples = new Map<string, SyncedObservedIncarnation>()
    for (const id of ids) {
      const tuple = readObservedLocalIncarnation(data.db, id)
      if (!tuple) return publicationInvalid('原本机 incarnation 在同一读取中缺失。')
      tuples.set(id, tuple)
    }
    return tuples
  })()
}
function sourceObservationProof(data: Observation, remote: ObservedClosure, known: Map<string, SyncedObservedIncarnation>): ObservationProof {
  const groups: ObservationProof['groups'] = []; let total = 0
  for (const item of remote.facts.records) {
    if (item.record.kind !== 'synced-group') continue
    total += 1
    const tuple = validateObservedIncarnation({ groupId: item.record.id, creationId: item.record.creationId, createdAt: item.record.createdAt, origin: item.record.origin })
    const original = known.get(tuple.groupId)
    if (original && sameObservedIncarnation(original, tuple)) groups.push({ incarnation: tuple, groupHash: item.hash })
  }
  const manifestHash = publicationHash(remote.manifest)
  const closureHash = publicationHash(publicationJson({ kind: 'synced-remote-initial-closure', version: 1,
    manifest: { hash: manifestHash, bytes: remote.manifest.length },
    records: remote.facts.records.map(({ key, hash, bytes }) => ({ key, hash, bytes })).sort((a, b) => publicationCompare(a.key, b.key)),
    assets: remote.facts.assets }))
  return frozenPublicationFacts({ databasePath: data.databasePath, ...data.context, targetFingerprint: data.targetFingerprint,
    remoteWorkspaceId: remote.facts.manifest.workspaceId, manifestHash, closureHash, ignoredRemoteGroups: total - groups.length,
    groups: groups.sort((a, b) => publicationCompare(observationKey(a.incarnation), observationKey(b.incarnation))) })
}
function retainObservationProof(proof: ObservationProof): PendingObservation {
  const leases: SyncedObservationPendingLease[] = []
  const pending = { proof, leases }; pendingObservations.add(pending)
  // Finish all independent holds before entering SQLite; no callout/await releases them on failure.
  for (const item of proof.groups) leases.push(holdSyncedObservationPending(proof.databasePath, item.incarnation))
  return pending
}
function localGroupWire(snapshot: SyncedGroupSnapshot): SyncedGroupWire {
  return { kind: 'synced-group', id: snapshot.groupId, creationId: snapshot.creationId, createdAt: snapshot.createdAt,
    origin: snapshot.origin, bindings: snapshot.bindings, blocks: snapshot.blocks }
}
function persistObservedIncarnation(data: Observation, source: ObservationProof, item: ObservationProof['groups'][number]): SyncedObservedGroupResult {
  const db = data.db, tuple = readObservedLocalIncarnation(db, item.incarnation.groupId)
  if (!tuple || !sameObservedIncarnation(tuple, item.incarnation)) return observationCorrupt('原本机 immutable tuple 在观察期间被替换')
  const existing = readSyncedRemoteObservation(db, tuple)
  if (existing) return { groupId: tuple.groupId, creationId: tuple.creationId, outcome: existing.persistence.kind, reused: true }
  const lifecycle = readSyncedGroupLifecycles(db, [tuple.groupId]).get(tuple.groupId)
  const current = db.prepare('SELECT revision,topology_revision FROM synced_groups WHERE id=?').get(tuple.groupId) as { revision: string; topology_revision: string } | undefined
  if (!lifecycle || !current) return publicationInvalid('本机观察组失去当前生命周期/CAS。')
  const observedAt = new Date().toISOString(), remote: SyncedObservationRemote = { channel: SYNCED_OBSERVATION_CHANNEL,
    targetFingerprint: source.targetFingerprint, remoteWorkspaceId: source.remoteWorkspaceId,
    manifestHash: source.manifestHash, groupHash: item.groupHash, closureHash: source.closureHash }
  const base = { kind: 'synced-remote-exposure-observation', version: 1, ...data.context, incarnation: tuple, remote, observedAt }
  let marker: SyncedRemoteObservationMarker
  if (lifecycle.state === 'active') {
    const read = getSyncedGroupSnapshots(db, { groupIds: [tuple.groupId] }), entry = read.items[0]
    if (read.workspaceScope !== data.context.workspaceScope || !entry || entry.status !== 'ready') return publicationInvalid('active 观察没有真实本机 snapshot。')
    marker = validateRemoteObservationMarker({ ...base, local: { state: 'active', revision: entry.snapshot.revision,
      topologyRevision: entry.snapshot.topologyRevision, semanticHash: syncedLifecycleSemanticHash(localGroupWire(entry.snapshot)), createHistoryId: lifecycle.createHistoryId },
      persistence: { kind: 'active-confirmed', attemptId: randomUUID() } })
  } else {
    if (current.revision !== lifecycle.activationRevision || current.topology_revision !== lifecycle.activationTopologyRevision) return observationCorrupt('retired mint时原CAS不等activation')
    const retirement = db.prepare('SELECT wire_json,semantic_hash,retired_at FROM synced_group_retirements WHERE group_id=?').get(tuple.groupId) as { wire_json: string; semantic_hash: string; retired_at: string } | undefined
    if (!retirement || lifecycle.createHistoryId === null) return publicationInvalid('retired 观察缺原准确 frozen retirement。')
    marker = validateRemoteObservationMarker({ ...base, local: { state: 'retired-create', revision: current.revision, topologyRevision: current.topology_revision,
      semanticHash: retirement.semantic_hash, createHistoryId: lifecycle.createHistoryId, retiredAt: retirement.retired_at,
      retirementHash: syncedLifecycleSemanticHash(parseStrictJson(retirement.wire_json, { maxBytes: Math.max(1, Buffer.byteLength(retirement.wire_json)), maxDepth: 32 })) },
      persistence: { kind: 'retired-disabled', anchorId: observationKey(tuple) } })
  }
  const requestHash = observationRequestHash(marker)
  db.prepare('INSERT INTO synced_operations(client_operation_id,request_hash,result_json,created_at) VALUES(?,?,?,?)')
    .run(observationKey(tuple), requestHash, publicationJson(marker), observedAt)
  const persistence = marker.persistence
  const id = persistence.kind === 'active-confirmed' ? persistence.attemptId : persistence.anchorId
  const channel = persistence.kind === 'active-confirmed' ? SYNCED_OBSERVATION_CHANNEL : SYNCED_RETIRED_OBSERVATION_CHANNEL
  db.prepare("INSERT INTO synced_exposure_attempts(id,request_hash,channel,target_fingerprint,publication_hash,state,created_at,confirmed_at) VALUES(?,?,?,?,?,'possible',?,NULL)")
    .run(id, requestHash, channel, remote.targetFingerprint, remote.closureHash, observedAt)
  if (marker.local.state === 'active' && persistence.kind === 'active-confirmed') {
    db.prepare('INSERT INTO synced_group_exposure_members(attempt_id,group_id,creation_id,revision,topology_revision,semantic_hash) VALUES(?,?,?,?,?,?)')
      .run(id, tuple.groupId, tuple.creationId, marker.local.revision, marker.local.topologyRevision, marker.local.semanticHash)
    if (db.prepare("UPDATE synced_exposure_attempts SET state='confirmed',confirmed_at=? WHERE id=? AND state='possible'").run(observedAt, id).changes !== 1) return publicationInvalid('active observed confirmation 没有唯一原行。')
  }
  return { groupId: tuple.groupId, creationId: tuple.creationId, outcome: persistence.kind, reused: false }
}
function commitObservationProofs(data: Observation, pending: PendingObservation[]): SyncedObservedGroupResult[] {
  databaseBoundary(data.db)
  const groups = data.db.transaction(() => {
    currentObservation(data)
    const result = new Map<string, SyncedObservedGroupResult>()
    for (const job of pending) {
      const proof = job.proof
      if (proof.databasePath !== data.databasePath || proof.workspaceScope !== data.context.workspaceScope || proof.recoveryEpoch !== data.context.recoveryEpoch
        || proof.targetFingerprint !== data.targetFingerprint) return unavailable('旧 pending proof 不授予其它路径/世代/目标的持久写权限。')
      for (const item of proof.groups) {
        const entry = persistObservedIncarnation(data, proof, item), key = observationKey(item.incarnation), previous = result.get(key)
        result.set(key, previous ? { ...previous, reused: previous.reused && entry.reused } : entry)
      }
    }
    assertSyncedRemoteObservationRecords(data.db)
    return [...result.values()].sort((a, b) => publicationCompare(observationKey(a), observationKey(b)))
  }).immediate()
  // Commit has succeeded. Release exactly these holds, never another job's group/key.
  for (const job of pending) {
    for (const lease of job.leases) releaseSyncedObservationPending(lease)
    pendingObservations.delete(job)
  }
  return groups
}
export function retrySyncedRemoteObservationCommit(observation: SyncedRemoteObservation): SyncedRemoteObservationRetry {
  return observationBoundary((): SyncedRemoteObservationRetry => {
    const data = acceptObservation(observation)
    try {
      const pending = [...pendingObservations].filter(item => item.proof.databasePath === data.databasePath && item.proof.targetFingerprint === data.targetFingerprint)
      if (!pending.length) return Object.freeze({ status: 'no-pending' as const })
      return frozenPublicationFacts({ status: 'committed' as const, proofs: pending.length, groups: commitObservationProofs(data, pending) })
    } finally { data.busy = false }
  })
}
export async function observeSyncedRemoteExposure(observation: SyncedRemoteObservation, input: SyncedPublicationRuntime): Promise<SyncedRemoteExposureResult> {
  return publicBoundary(async () => {
    const data = acceptObservation(observation)
    try {
      const options = runtime(input), known = knownObservationIncarnations(data)
      const client = new WebDavClient(data.target, options.password, options.signal)
      let observed: Extract<SyncedRemoteExposureResult, { status: 'observed' }> | undefined
      const response = await readPublishedSnapshot(client, remote => {
        const proof = sourceObservationProof(data, remote, known), pending = retainObservationProof(proof)
        // No signal/closed check or await after this full-closure boundary may skip persistence.
        const groups = observationBoundary(() => commitObservationProofs(data, [pending]))
        observed = frozenPublicationFacts({ status: 'observed' as const, ...data.context, remoteWorkspaceId: proof.remoteWorkspaceId,
          manifestHash: proof.manifestHash, closureHash: proof.closureHash, groups, ignoredRemoteGroups: proof.ignoredRemoteGroups })
      })
      if (response.status === 'missing' || response.status === 'unsupported') return Object.freeze(response)
      if (!observed) return publicationInvalid('真实 reader 没有经过同次观察完成点。')
      return observed
    } finally { data.busy = false }
  })
}

type IncomingPlan = { mode: 'applied' | 'noop'; local: InitialIncomingLocal; records: InitialPublicationRecord[];
  documentPaths: Map<string, string>; physicalIds: string[]; reservedIds: string[]; reservationSources: InitialIncomingReservationSource[];
  reservationSourceKey: string; reservationDigest: string; portableDigest: string }
function completeObservedRemote(data: Observation, remote: ObservedClosure, known: Map<string, SyncedObservedIncarnation>): ObservationProof {
  const proof = sourceObservationProof(data, remote, known), pending = retainObservationProof(proof)
  observationBoundary(() => commitObservationProofs(data, [pending]))
  return proof
}
function incomingAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SyncedPublicationError('transport', '接收在知识提交前已取消；原观察事实保持。', signal.reason)
}
function incomingAssetPath(root: string, hash: string, name: string): string {
  return join(root, 'storage', 'assets', 'attachments', hash.slice(0, 2), hash, name)
}
function incomingLocalRecords(remote: Remote, root: string, catalogId: string, catalogBirth: string): InitialPublicationRecord[] {
  const localize = (uri: string): string => {
    const asset = parseSyncedPortableAssetUri(uri)
    return pathToFileURL(incomingAssetPath(root, asset.hash, asset.name)).href.replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase())
  }
  const records = remote.facts.records.map(({ record }) => record.kind === 'synced-group'
    ? localizeSyncedPortableGroupAssets(record, localize)
    : record.kind === 'document' ? localizeSyncedPortableHostAssets(record, localize) : record)
  return inverseInitialIncomingCatalog(records, catalogId, catalogBirth)
}
/** Deterministic local->wire projection; actual bytes/path checks are separate and mandatory. */
function incomingPortableRecords(snapshot: SyncedPublicationLocalSnapshot, root: string): InitialPublicationRecord[] {
  return recordAssets(mapPublicationCatalog(snapshot.records, snapshot.catalogId), uri => {
    if (!/^file:/i.test(uri)) { parseSyncedPortableAssetUri(uri); return uri }
    const parsed = new URL(uri)
    if (parsed.protocol !== 'file:' || parsed.hostname && parsed.hostname !== 'localhost') return publicationInvalid('接收 portable 回读不是本机 file URI。')
    const file = resolve(fileURLToPath(parsed)), child = relative(join(root, 'storage', 'assets'), file).split(sep)
    if (child.length !== 4 || child[0] !== 'attachments' || !/^[a-f0-9]{64}$/.test(child[2]) || child[1] !== child[2].slice(0, 2)) return publicationInvalid('接收 portable 回读不是实际 managed hash/name。')
    const portable = buildSyncedPortableAssetUri({ hash: child[2], name: child[3] })
    if (spelling(file) !== spelling(incomingAssetPath(root, child[2], child[3]))) return publicationInvalid('接收 portable 回读资产路径不一致。')
    return portable
  })
}
function incomingEntries(records: InitialPublicationRecord[]): Record<string, string> {
  return Object.fromEntries(records.map(record => [publicationRecordKey(record), publicationHash(publicationJson(record))]))
}
function incomingDocumentPaths(records: InitialPublicationRecord[]): Map<string, string> | null {
  const docs = new Map(records.flatMap(record => record.kind === 'document' ? [[record.id, record] as const] : []))
  const paths = new Map<string, string>(), used = new Set<string>(), siblings = new Set<string>()
  for (const record of docs.values()) {
    if (record.content.title !== record.content.title.trim()) return null
    // Store.documentTitleExists uses SQLite NOCASE (ASCII only); titles cannot contain NUL.
    const sibling = publicationJson([record.parentId, record.content.title.replace(/[A-Z]/g, letter => letter.toLowerCase())])
    if (siblings.has(sibling)) return null; siblings.add(sibling)
    if (paths.has(record.id)) continue
    const chain: string[] = [], visiting = new Set<string>(); let next: string | null = record.id
    while (next !== null && !paths.has(next)) {
      if (visiting.has(next) || !docs.has(next)) return null
      visiting.add(next); chain.push(next); next = docs.get(next)!.parentId
    }
    let prefix = next === null ? '' : paths.get(next)!
    for (let index = chain.length - 1; index >= 0; index--) {
      const item = docs.get(chain[index])!; prefix = prefix ? prefix + '/' + item.content.title : item.content.title
      if (used.has(prefix)) return null; used.add(prefix); paths.set(item.id, prefix)
    }
  }
  return paths
}
function planInitialIncoming(db: Database.Database, remote: Remote, local: InitialIncomingLocal, request: InitialIncomingRequest, root: string): IncomingPlan | SyncedInitialIncomingComponent[] {
  const conflicts: SyncedInitialIncomingComponent[] = [], allKeys = remote.facts.records.map(item => item.key)
  const add = (reason: SyncedInitialIncomingComponent['reason'], keys: string[]) => { if (keys.length) conflicts.push({ reason, keys }) }
  const localCatalog = local.snapshot.records.find((record): record is SyncDatabases => record.kind === 'databases')
  const defaultRow = localCatalog?.tables.databases.find(row => row.id === local.snapshot.catalogId)
  if (!localCatalog || !defaultRow || typeof defaultRow.created_at !== 'string') return publicationInvalid('接收默认 catalog 原身份/birth 缺失。')
  const catalogId = local.snapshot.catalogId
  if (catalogId !== 'catalog') for (const item of remote.facts.records) {
    const record = item.record
    if (record.kind === 'databases') {
      if (record.tables.databases.some(row => row.id === catalogId) || SYNC_TABLES.some(table => record.tables[table].some(row => row.database_id === catalogId))) add('catalog', [item.key])
    } else {
      const blocks = record.kind === 'document' ? record.content.blocks : record.blocks
      if (blocks.some(block => block.type === 'database-view' && parseDatabaseViewPayload(block.content).databaseId === catalogId)) add('catalog', [item.key])
    }
  }
  if (conflicts.length) return incomingComponents(conflicts)
  const records = incomingLocalRecords(remote, root, catalogId, defaultRow.created_at), documentPaths = incomingDocumentPaths(records)
  if (!documentPaths) return [{ reason: 'path', keys: allKeys.filter(key => key.startsWith('doc:')) }]
  if (publicationJson(incomingEntries(incomingPortableRecords({ ...local.snapshot, records }, root))) !== publicationJson(remote.facts.manifest.entries)) return publicationInvalid('接收候选不能无损逆映射为原 portable 记录；未发布资产。')
  const rawPaths = new Map((db.prepare('SELECT id,path FROM documents ORDER BY id').all() as Array<{ id: string; path: string }>).map(row => [row.id, row.path]))
  const projected = incomingPortableRecords(local.snapshot, root)
  const exact = publicationJson(incomingEntries(projected)) === publicationJson(remote.facts.manifest.entries)
    && [...documentPaths].every(([id, path]) => rawPaths.get(id) === path)
    && rawPaths.size === documentPaths.size
  const docs = records.filter(record => record.kind === 'document'), groups = records.filter(record => record.kind === 'synced-group')
  const physical = new Map<string, { kind: 'document' | 'group'; owner: string; birth: string | null; key: string }>()
  for (const record of records) if (record.kind !== 'databases') {
    const blocks: Array<SyncedStableBlockDraft | SyncedCanonicalWire> = record.kind === 'document' ? record.content.blocks : record.blocks
    for (const block of blocks) {
      if (physical.has(block.id)) return publicationInvalid('接收 physical 全图重复 ID。')
      physical.set(block.id, { kind: record.kind === 'document' ? 'document' : 'group', owner: record.id,
        birth: 'createdAt' in block ? block.createdAt : null, key: publicationRecordKey(record) })
    }
  }
  const reserved = new Set<string>(), sources: InitialIncomingReservationSource[] = [], sourceGroups = new Map<string, Set<string>>(), remoteDocIds = new Set(docs.map(record => record.id))
  for (const record of remote.facts.records) if (record.record.kind === 'synced-group') for (const binding of record.record.bindings) {
    const target = binding.target
    if (target.kind === 'block' && !physical.has(target.id)) {
      reserved.add(target.id); const { target: _target, ...key } = binding
      sources.push({ groupId: record.record.id, key, targetId: target.id })
      const keys = sourceGroups.get(target.id) ?? new Set<string>(); keys.add(record.key); sourceGroups.set(target.id, keys)
    } else if (target.kind === 'document' && !remoteDocIds.has(target.id) || target.kind === 'heading' && !remoteDocIds.has(target.documentId)) {
      const id = target.kind === 'heading' ? target.documentId : target.kind === 'document' ? target.id : ''
      if (rawPaths.has(id) || local.historyDocuments.has(id)) add('external-target', [record.key])
    }
  }
  sources.sort((a, b) => publicationCompare(publicationJson([a.groupId, a.key]), publicationJson([b.groupId, b.key])))
  const reservedIds = [...reserved].sort(publicationCompare), sourceKey = initialIncomingReservationKey(request.targetFingerprint, remote.facts.manifest.workspaceId)
  const reservationDigest = initialIncomingReservationDigest(sourceKey, reservedIds, sources)
  const originalReserved = new Set(local.baseline?.provenance.reservedIds ?? [])
  for (const id of reservedIds) {
    const identity = local.identities.get(id)
    const original = local.baseline
    const proven = exact && original?.provenance.reservationSourceKey === sourceKey && original.provenance.reservationDigest === reservationDigest
      && originalReserved.has(id)
    if (identity && !(proven && identity.last_owner_kind === 'reserved' && identity.last_owner_id === sourceKey && identity.state === 'retained' && identity.created_at === null)) {
      add('external-target', [...sourceGroups.get(id)!])
    } else if (!identity && local.historyBlocks.has(id)) return publicationInvalid('missing 来源目标的旧保留 ledger 缺失。')
    else if (!identity && exact) add('external-target', [...sourceGroups.get(id)!])
  }
  if (!exact) {
    for (const record of docs) if (rawPaths.has(record.id) || local.historyDocuments.has(record.id)) add('history', ['doc:' + record.id])
    const currentGroups = new Map(local.snapshot.groups.map(group => [group.wire.id, group.wire]))
    for (const record of groups) if (local.groupIds.has(record.id)) {
      const actual = currentGroups.get(record.id)
      add(actual && actual.creationId === record.creationId && actual.createdAt === record.createdAt && publicationJson(actual.origin) === publicationJson(record.origin) ? 'non-initial-target' : 'incarnation', ['group:' + record.id])
    }
    for (const [id, item] of physical) {
      const old = local.identities.get(id)
      if (!old) continue
      const reason = old.last_owner_kind === 'reserved' ? 'occupied-identity'
        : old.created_at === null ? 'unknown-birth'
        : item.birth !== null && old.created_at !== null && item.birth !== old.created_at ? 'birth-mismatch'
        : old.last_owner_kind !== item.kind || old.last_owner_id !== item.owner ? 'owner-transfer' : 'occupied-identity'
      add(reason, [item.key])
    }
    if (local.snapshot.records.some(record => record.kind === 'document') || local.snapshot.groups.length) add('non-initial-target', allKeys)
    const pristine = localCatalog.tables.databases.length === 1 && defaultRow.name === 'Default' && defaultRow.description === 'Default database'
      && SYNC_TABLES.filter(table => table !== 'databases').every(table => localCatalog.tables[table].length === 0)
    if (!pristine) add('catalog', ['databases'])
  }
  if (conflicts.length) return incomingComponents(conflicts)
  return { mode: exact ? 'noop' : 'applied', local, records, documentPaths, physicalIds: [...physical.keys()].sort(publicationCompare),
    reservedIds, reservationSources: sources, reservationSourceKey: sourceKey, reservationDigest,
    portableDigest: initialIncomingPortableDigest(remote.facts.manifest.entries, remote.facts.manifest.syncedInstances) }
}
function verifyIncomingAliases(remote: Remote, root: string): void {
  try {
    const assetRoot = join(root, 'storage', 'assets'), attachments = new AttachmentStore(assetRoot)
    for (const item of remote.facts.assets) for (const name of item.names) {
      const destination = incomingAssetPath(root, item.hash, name); assertSafe(destination, assetRoot)
      const safe = attachments.resolve(pathToFileURL(destination).href), info = lstatSync(safe)
      if (!info.isFile() || info.size !== item.bytes || info.size > ATTACHMENT_MAX_FILE_BYTES || publicationHash(readFileSync(safe)) !== item.hash) throw new Error('接收 alias 原文件缺失或 hash 不符。')
    }
  } catch (cause) { throw new SyncedPublicationError('asset', '接收目标每个 alias 的真实 bytes/path 校验失败。', cause) }
}
async function publishIncomingAssets(remote: Remote, root: string, operationId: string, signal?: AbortSignal): Promise<string | null> {
  if (!remote.facts.assets.length) return null
  const stageRoot = join(root, 'storage', 'synced-incoming-v1'), directory = join(stageRoot, operationId, randomUUID())
  let owned = false
  try {
    assertSafe(stageRoot, root); await mkdir(join(stageRoot, operationId), { recursive: true, mode: 0o700 }); assertSafe(join(stageRoot, operationId), stageRoot)
    await mkdir(directory, { mode: 0o700 }); owned = true; assertSafe(directory, stageRoot)
    for (const item of remote.facts.assets) {
      incomingAborted(signal)
      const bytes = remote.assets.get(item.hash)
      if (!bytes || bytes.length !== item.bytes || publicationHash(bytes) !== item.hash) return publicationInvalid('私有接收 stage 缺原资产 bytes。')
      await durableFile(join(directory, item.hash), bytes)
    }
    await syncDirectory(directory)
    for (const item of remote.facts.assets) for (const name of item.names) {
      incomingAborted(signal)
      const destination = incomingAssetPath(root, item.hash, name), parent = join(root, 'storage', 'assets', 'attachments', item.hash.slice(0, 2), item.hash)
      assertSafe(parent, root); mkdirSync(parent, { recursive: true, mode: 0o700 }); assertSafe(destination, root)
      try { linkSync(join(directory, item.hash), destination) }
      catch (cause) { if (!cause || typeof cause !== 'object' || !('code' in cause) || cause.code !== 'EEXIST') throw cause }
      const info = lstatSync(destination)
      if (!info.isFile() || info.size !== item.bytes || publicationHash(readFileSync(destination)) !== item.hash) throw new Error('不覆盖发布遇到不同 bytes 或非 regular alias。')
    }
    verifyIncomingAliases(remote, root); return directory
  } catch (cause) {
    // Only our fresh job stage is private. Published content-addressed aliases may already be consumed elsewhere.
    try { if (owned) { assertSafe(directory, stageRoot); await rm(directory, { recursive: true, force: true }) } }
    catch (cleanup) { throw new SyncedPublicationError(cause instanceof SyncedPublicationError ? cause.code : 'asset', '接收失败且独占 stage 清理失败；保留原 cause 与 stage 证据。', { cause, cleanup, directory }) }
    if (cause instanceof SyncedPublicationError && cause.code !== 'spool') throw cause
    throw new SyncedPublicationError('asset', '接收私有 stage/无覆盖 hardlink 发布失败；未写知识。', cause)
  }
}
function installIncomingKnowledge(db: Database.Database, plan: IncomingPlan, now: string): void {
  const documents = plan.records.filter(record => record.kind === 'document'), groups = plan.records.filter(record => record.kind === 'synced-group')
  const positions = new Map<string, { groupId: string; documentId: string; bindingVersion: string; parentBlockId: string | null; depth: number }>()
  for (const doc of documents) for (const block of doc.content.blocks) if (block.type === 'synced-block') positions.set(block.id, {
    groupId: parseSyncedBlockPayload(block.content).groupId, documentId: doc.id, bindingVersion: randomUUID(), parentBlockId: block.parentBlockId, depth: block.depth })
  const insertDocument = db.prepare('INSERT INTO documents(id,title,slug,parent_id,path,summary,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
  // Validated parent chains are installed in parent-first order; no cycle healer is involved.
  for (const doc of [...documents].sort((a, b) => plan.documentPaths.get(a.id)!.split('/').length - plan.documentPaths.get(b.id)!.split('/').length || publicationCompare(a.id, b.id))) {
    insertDocument.run(doc.id, doc.content.title, 'doc-' + doc.id, doc.parentId, plan.documentPaths.get(doc.id), doc.content.summary, doc.sortOrder, doc.createdAt, now)
    db.prepare('INSERT INTO synced_host_history_state(document_id,cursor,position) VALUES(?,?,0)').run(doc.id, randomUUID())
  }
  const insertGroup = db.prepare('INSERT INTO synced_groups(id,creation_id,created_at,origin_json,bindings_json,revision,topology_revision,history_cursor,history_position) VALUES(?,?,?,?,?,?,?,?,0)')
  const insertLife = db.prepare("INSERT INTO synced_group_lifecycle(group_id,creation_id,state,state_version,exposure_state,create_history_id,activation_revision,activation_topology_revision,activation_hash,activation_instances_json,created_at,updated_at) VALUES(?,?,'active',1,'unknown',NULL,?,?,?,?,?,?)")
  const byGroup = new Map<string, Array<{ instanceId: string; hostDocumentId: string; bindingVersion: string }>>()
  for (const [id, item] of positions) { const list = byGroup.get(item.groupId) ?? []; list.push({ instanceId: id, hostDocumentId: item.documentId, bindingVersion: item.bindingVersion }); byGroup.set(item.groupId, list) }
  for (const group of groups) {
    const revision = randomUUID(), topology = randomUUID()
    insertGroup.run(group.id, group.creationId, group.createdAt, publicationJson(group.origin), publicationJson(group.bindings), revision, topology, randomUUID())
    const instances = (byGroup.get(group.id) ?? []).sort((a, b) => publicationCompare(a.instanceId, b.instanceId))
    insertLife.run(group.id, group.creationId, revision, topology, syncedLifecycleSemanticHash(group), publicationJson(instances), now, now)
  }
  const insertCanonical = db.prepare('INSERT INTO synced_group_blocks(id,group_id,parent_block_id,sort_order,type,content,checked,depth,tags_json,language,list_start,markdown_format_json,highlight,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  for (const group of groups) group.blocks.forEach((block, index) => insertCanonical.run(block.id, group.id, block.parentBlockId, index, block.type, block.content,
    block.checked ? 1 : 0, block.depth, block.tags === undefined ? null : publicationJson(block.tags), block.language ?? null, block.listStart ?? null,
    block.markdownFormat === undefined ? null : publicationJson(block.markdownFormat), block.highlight ?? null, block.createdAt))
  const insertBlock = db.prepare('INSERT INTO blocks(id,document_id,parent_block_id,sort_order,type,content,checked,depth,tags_json,language,list_start,markdown_format_json,highlight,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  const insertInstance = db.prepare('INSERT INTO synced_instances(instance_id,group_id,host_document_id,binding_version,parent_block_id,depth) VALUES(?,?,?,?,?,?)')
  for (const doc of documents) {
    doc.content.blocks.forEach((block, index) => insertBlock.run(block.id, doc.id, block.parentBlockId, index, block.type, block.content, block.checked ? 1 : 0,
      block.depth, publicationJson(block.tags ?? []), block.language ?? null, block.listStart ?? null, block.markdownFormat === undefined ? null : publicationJson(block.markdownFormat), block.highlight ?? null, now, now))
    for (const block of doc.content.blocks) {
      db.prepare('INSERT INTO document_block_routes(document_path,block_id) VALUES(?,?)').run(plan.documentPaths.get(doc.id), block.id)
      const item = positions.get(block.id)
      if (item) insertInstance.run(block.id, item.groupId, item.documentId, item.bindingVersion, item.parentBlockId, item.depth)
    }
  }
  const reserve = db.prepare("INSERT INTO block_identities(id,last_owner_kind,last_owner_id,state,created_at) VALUES(?,'reserved',?,'retained',NULL)")
  for (const id of plan.reservedIds) reserve.run(id, plan.reservationSourceKey)
  const catalog = plan.records.find((record): record is SyncDatabases => record.kind === 'databases')!
  for (const table of SYNC_TABLES) {
    const columns: readonly string[] = SYNC_TABLE_COLUMNS[table], updated = [...columns, 'updated_at']
    const insert = db.prepare('INSERT INTO ' + table + '(' + updated.join(',') + ') VALUES(' + updated.map(() => '?').join(',') + ')')
    for (const row of catalog.tables[table]) {
      if (table === 'databases' && row.id === plan.local.snapshot.catalogId) {
        if (db.prepare('UPDATE databases SET name=?,description=?,updated_at=? WHERE id=? AND created_at=?').run(row.name, row.description, now, row.id, row.created_at).changes !== 1) return publicationInvalid('默认 catalog 原 birth 在提交中已变。')
      } else insert.run(...columns.map(column => row[column]), now)
    }
  }
  const ids = documents.map(doc => doc.id), index = new MarkdownLinkIndex(db)
  for (const id of ids) index.syncDocument(id)
  db.prepare('DELETE FROM links WHERE source_document_id IN (SELECT value FROM json_each(?))').run(JSON.stringify(ids))
  const links = db.prepare(`SELECT DISTINCT source.source_document_id,target.id AS target_id,source.url
    FROM markdown_link_sources source JOIN documents target ON target.path=source.target_path
    WHERE (source.kind IN ('wiki','wiki-heading') OR target.id<>source.source_document_id)
      AND source.source_document_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids)) as Array<{ source_document_id: string; target_id: string; url: string }>
  const insertLink = db.prepare('INSERT INTO links(id,source_document_id,target_document_id,label,created_at) VALUES(?,?,?,?,?)')
  for (const row of links) insertLink.run(randomUUID(), row.source_document_id, row.target_id, row.url, now)
  const stats = db.prepare(`SELECT 1 FROM documents d WHERE d.id IN (SELECT value FROM json_each(?)) AND (
    d.block_count<>(SELECT count(*) FROM blocks WHERE document_id=d.id) OR d.link_count<>(SELECT count(*) FROM links WHERE source_document_id=d.id)
    OR d.child_count<>(SELECT count(*) FROM documents WHERE parent_id=d.id)) LIMIT 1`).get(JSON.stringify(ids))
  if (stats) return publicationInvalid('接收 commit 前实际 stats 不完整；不会依赖 Store 重开 repair。')
  if (db.prepare(`SELECT 1 FROM blocks b LEFT JOIN block_search_ids i ON i.block_id=b.id LEFT JOIN block_search s ON s.rowid=i.search_rowid
    WHERE b.document_id IN (SELECT value FROM json_each(?)) AND (i.block_id IS NULL OR s.block_id IS NOT b.id OR s.document_id IS NOT b.document_id OR s.content IS NOT b.content) LIMIT 1`).get(JSON.stringify(ids))
    || db.prepare(`SELECT 1 FROM documents d LEFT JOIN document_search_ids i ON i.document_id=d.id LEFT JOIN document_search s ON s.rowid=i.search_rowid
      WHERE d.id IN (SELECT value FROM json_each(?)) AND (i.document_id IS NULL OR s.document_id IS NOT d.id OR s.title IS NOT d.title OR s.path IS NOT d.path OR s.summary IS NOT d.summary) LIMIT 1`).get(JSON.stringify(ids))) return publicationInvalid('接收 commit 前实际 FTS 闭集缺失。')
}

/** Initial introduction/exact-noop only. All incoming authority stays inside this real HTTP consumer. */
export async function receiveInitialSyncedSnapshot(db: Database.Database, input: SyncedInitialIncomingInput, options: SyncedPublicationRuntime): Promise<SyncedInitialIncomingResult> {
  return publicBoundary(async (): Promise<SyncedInitialIncomingResult> => {
    assertSyncedShape(input, ['operationId', 'userDataRoot', 'target'])
    const operationId = input.operationId
    if (!isSyncedUuid(operationId)) return publicationInvalid('incoming operation UUID 无效。')
    const environment = observationEnvironment(db, { userDataRoot: input.userDataRoot, target: input.target }), credentials = runtime(options)
    const version = db.pragma('user_version', { simple: true })
    if (version === 26) { assertSyncedBlockSchema(db); return Object.freeze({ status: 'unsupported', reason: 'schema-27-required' }) }
    if (version !== 27) return publicationInvalid('incoming 不迁移或修复未知/未来 schema。')
    const context = db.transaction(() => { assertSyncedBlockSchema(db); assertSyncedLifecycleSchema(db); return observationContext(db) })()
    const data: Observation = { db, ...environment, context, targetFingerprint: observationTargetFingerprint(environment.target), busy: false, closed: false }
    const request: InitialIncomingRequest = { method: 'receiveInitialSyncedSnapshot', operationId,
      databasePath: data.databasePath, targetFingerprint: initialIncomingTargetFingerprint(data.target) }
    const previous = db.transaction(() => { currentObservation(data); return readInitialIncomingReceipt(db, request) })()
    if (previous) return frozenPublicationFacts({ ...previous.result, replayed: true })
    incomingAborted(credentials.signal)
    const known = knownObservationIncarnations(data), client = new WebDavClient(data.target, credentials.password, credentials.signal)
    let original: Remote | undefined, proof: ObservationProof | undefined
    const received = await readPublishedSnapshot(client, remote => {
      // Same continuation: fully verified original bytes -> sticky proof -> durable observation. No abort can skip this.
      proof = completeObservedRemote(data, remote, known); original = remote
    })
    if (received.status !== 'ready') return Object.freeze(received)
    if (!original || !proof) return publicationInvalid('incoming 未经过同次真实闭包/观察完成点。')
    const remote = original, observed = proof
    databaseBoundary(db)
    const local = db.transaction(() => { currentObservation(data); return readInitialIncomingLocal(db, request) })()
    const plan = planInitialIncoming(db, remote, local, request, data.root)
    if (Array.isArray(plan)) return frozenPublicationFacts({ status: 'conflict', components: plan })
    incomingAborted(credentials.signal)
    let stage: string | null = null, primaryFailed = false, primaryFailure: unknown, acceptedReceipt: string | null = null
    try {
      stage = await publishIncomingAssets(remote, data.root, operationId, credentials.signal)
      incomingAborted(credentials.signal)
      let current: { bytes: Uint8Array; etag: string | null } | null
      try {
        current = await network(() => client.get('manifest.json', PUBLICATION_RECORD_MAX_BYTES, remote.manifestEtag))
        if (current && current.etag === null) current = await network(() => client.getVersioned('manifest.json', PUBLICATION_RECORD_MAX_BYTES))
      } catch (cause) {
        if (cause instanceof SyncedPublicationError && cause.cause instanceof WebDavHttpError && cause.cause.status === 412) return frozenPublicationFacts({ status: 'stale', side: 'remote' })
        throw cause
      }
      if (!current || current.etag !== remote.manifestEtag || !Buffer.from(current.bytes).equals(remote.manifest)) return frozenPublicationFacts({ status: 'stale', side: 'remote' })
      incomingAborted(credentials.signal)
      verifyIncomingAliases(remote, data.root) // Last external await has finished. Every alias is checked before synchronous SQLite work.
      databaseBoundary(db)
      const result = db.transaction((): SyncedInitialIncomingResult => {
        currentObservation(data)
        const replay = readInitialIncomingReceipt(db, request)
        if (replay) return frozenPublicationFacts({ ...replay.result, replayed: true })
        const actual = readInitialIncomingLocal(db, request)
        if (actual.fingerprint !== plan.local.fingerprint) return frozenPublicationFacts({ status: 'stale', side: 'local' })
        const now = new Date().toISOString()
        if (plan.mode === 'applied') installIncomingKnowledge(db, plan, now)
        // Real post-SQL rows, not the plan or baseline, must reproduce every portable entry/Key/dependency.
        const after = readSyncedPersistentPublicationSnapshot(db), portable = incomingPortableRecords(after, data.root)
        const validated = validateInitialSnapshot(remote.facts.manifest, portable.map(record => ({ key: publicationRecordKey(record), record })))
        if (publicationJson(incomingEntries(portable)) !== publicationJson(remote.facts.manifest.entries)
          || publicationJson(validated.manifest.syncedInstances) !== publicationJson(remote.facts.manifest.syncedInstances)) return publicationInvalid('接收实际 DB portable roundtrip 不等原 remote。')
        const result: SyncedInitialIncomingAccepted = { status: plan.mode, operationId, replayed: false, ...context,
          remoteWorkspaceId: remote.facts.manifest.workspaceId, manifestHash: observed.manifestHash, closureHash: observed.closureHash,
          identityDigest: readInitialIncomingIdentityDigest(db, [...plan.physicalIds, ...plan.reservedIds]), acceptedAt: now,
          counts: { documents: plan.records.filter(record => record.kind === 'document').length, groups: plan.records.filter(record => record.kind === 'synced-group').length,
            instances: remote.facts.manifest.syncedInstances.length, physicalBlocks: plan.physicalIds.length, reservations: plan.reservedIds.length,
            assets: remote.facts.assets.reduce((count, asset) => count + asset.names.length, 0) } }
        const provenance = { manifestEtag: remote.manifestEtag, portableDigest: plan.portableDigest, reservationSourceKey: plan.reservationSourceKey,
          reservedIds: plan.reservedIds, reservationSources: plan.reservationSources, reservationDigest: plan.reservationDigest }
        const receipt: InitialIncomingReceipt = validateInitialIncomingReceipt({ kind: 'synced-initial-incoming-operation', version: 1, request, result, provenance })
        const baseline: InitialIncomingBaseline = validateInitialIncomingBaseline({ kind: 'synced-initial-incoming-baseline', version: 1,
          databasePath: request.databasePath, targetFingerprint: request.targetFingerprint, manifest: remote.facts.manifest, result, provenance, lastReceivedAt: now })
        db.prepare('INSERT INTO synced_operations(client_operation_id,request_hash,result_json,created_at) VALUES(?,?,?,?)')
          .run(operationId, initialIncomingRequestHash(request), publicationJson(receipt), now)
        db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
          .run(initialIncomingBaselineKey(request.targetFingerprint), publicationJson(baseline), now)
        if (publicationJson(readInitialIncomingReceipt(db, request)) !== publicationJson(receipt)) return publicationInvalid('接收提交前原 receipt 未闭合。')
        if (publicationJson(readInitialIncomingBaseline(db, request)?.value) !== publicationJson(baseline)) return publicationInvalid('接收提交前来源 baseline 未闭合。')
        return frozenPublicationFacts(result)
      }).immediate()
      if (result.status === 'applied' || result.status === 'noop') acceptedReceipt = result.operationId
      return result
    } catch (cause) {
      primaryFailed = true; primaryFailure = cause; throw cause
    } finally {
      if (stage) {
        try { assertSafe(stage, join(data.root, 'storage', 'synced-incoming-v1')); await rm(stage, { recursive: true, force: true }) }
        catch (cleanup) {
          const sql = primaryFailure && typeof primaryFailure === 'object' && 'code' in primaryFailure
            && typeof primaryFailure.code === 'string' && primaryFailure.code.startsWith('SQLITE')
          const code = primaryFailed ? primaryFailure instanceof SyncedPublicationError ? primaryFailure.code : sql ? 'database' : 'invalid' : 'asset'
          throw new SyncedPublicationError(code, acceptedReceipt
            ? '知识收据已经提交/存在；仅独占 stage 清理失败，可按原 operation 历史重放，不撤已提交事实。'
            : '独占 incoming stage 清理失败；原失败及清理错误均保留，已发布内容寻址文件不自动删除。',
          { ...(primaryFailed ? { cause: primaryFailure } : {}), cleanup, stage, receiptOperationId: acceptedReceipt })
        }
      }
    }
  })
}

/** Internal Main read capabilities. Neither handle is accepted by a public mutation API. */
export interface SyncedExchangeRemoteSource { readonly kind: 'synced-exchange-remote-source' }
export interface SyncedExchangeLocalMaterial { readonly kind: 'synced-exchange-local-material' }
export interface SyncedExchangeRemoteFacts {
  workspaceScope: string; recoveryEpoch: string; databasePath: string; root: string
  manifest: SyncedInitialManifest5; manifestEtag: string; manifestHash: string; closureHash: string
  records: Array<{ key: string; hash: string; bytes: number; record: SyncedProtocol5Record }>
  assets: PublicationAssetDescriptor[]
}
export interface SyncedExchangeMaterialFacts {
  databasePath: string; root: string; snapshot: SyncedPublicationLocalSnapshot; records: InitialPublicationRecord[]
}
type ExchangeRemote = { data: Observation; remote: ObservedClosure & {
  manifestEtag: string; objects: Map<string, Buffer>; assets: Map<string, Buffer> }; proof: ObservationProof }
type ExchangeMaterial = { data: Observation; snapshot: SyncedPublicationLocalSnapshot;
  records: InitialPublicationRecord[]; assets: Map<string, Buffer> }
const exchangeRemoteSources = new WeakMap<SyncedExchangeRemoteSource, ExchangeRemote>()
const exchangeLocalMaterials = new WeakMap<SyncedExchangeLocalMaterial, ExchangeMaterial>()
function exchangeObservation(db: Database.Database, input: { userDataRoot: string; target: WebDavSyncConfig }): Observation {
  const environment = observationEnvironment(db, input)
  if (db.pragma('user_version', { simple: true }) !== 27) return unavailable('增量读取只接受原 schema27。')
  const context = db.transaction(() => { assertSyncedLifecycleSchema(db); return observationContext(db) })()
  return { db, ...environment, context, targetFingerprint: observationTargetFingerprint(environment.target), busy: false, closed: false }
}
/** Real client -> complete protocol5 closure -> synchronous original observer completion. */
export async function readObservedSyncedProtocol5(db: Database.Database, input: { userDataRoot: string; target: WebDavSyncConfig },
  options: SyncedPublicationRuntime): Promise<{ status: 'missing' } | { status: 'unsupported'; reason: 'protocol5-required' }
  | { status: 'ready'; source: SyncedExchangeRemoteSource }> {
  return publicBoundary(async () => {
    const data = exchangeObservation(db, input), credentials = runtime(options), known = knownObservationIncarnations(data)
    const client = new WebDavClient(data.target, credentials.password, credentials.signal)
    const response = await network(() => client.getVersioned('manifest.json', PUBLICATION_RECORD_MAX_BYTES))
    if (!response) return Object.freeze({ status: 'missing' as const })
    const raw = parseStrictJson(Buffer.from(response.bytes).toString('utf8'), { maxBytes: PUBLICATION_RECORD_MAX_BYTES, maxDepth: 32 })
    if (!raw || typeof raw !== 'object' || !('version' in raw)) return publicationInvalid('增量清单版本缺失。')
    if (raw.version !== 5) return Object.freeze({ status: 'unsupported' as const, reason: 'protocol5-required' as const })
    const manifest = validateInitialManifest5(decodePublicationJson(response.bytes))
    const values: Array<{ key: string; record: unknown }> = [], objects = new Map<string, Buffer>()
    for (const [key, hash] of Object.entries(manifest.entries)) {
      const object = await network(() => client.get('objects/' + hash + '.json', PUBLICATION_RECORD_MAX_BYTES))
      if (!object || publicationHash(object.bytes) !== hash) return publicationInvalid('增量对象原 bytes/hash 缺失或损坏。')
      const record = validateSyncedProtocol5Record(decodePublicationJson(object.bytes), key)
      objects.set(key, Buffer.from(object.bytes)); values.push({ key, record })
    }
    const checked = validateSyncedProtocol5Snapshot(manifest, values), assets = new Map<string, Buffer>()
    const assetFacts: PublicationAssetDescriptor[] = []
    for (const [hash, names] of checked.assetNames) {
      const object = await network(() => client.get('assets/' + hash, ATTACHMENT_MAX_FILE_BYTES))
      if (!object || publicationHash(object.bytes) !== hash) return publicationInvalid('增量资产原 bytes/hash 缺失或损坏。')
      assets.set(hash, Buffer.from(object.bytes))
      assetFacts.push({ path: 'assets/' + hash, hash, bytes: object.bytes.length, names: [...names].sort(publicationCompare) })
    }
    const remote: ExchangeRemote['remote'] = { manifest: Buffer.from(response.bytes), manifestEtag: response.etag, objects, assets,
      facts: frozenPublicationFacts({ manifest: checked.manifest,
        records: checked.records.map(item => ({ ...item, bytes: objects.get(item.key)!.length })),
        assets: assetFacts.sort((a, b) => publicationCompare(a.path, b.path)) }) }
    // No await or cancellation check can interpose between verified closure and its sticky/durable observation.
    const proof = completeObservedRemote(data, remote, known)
    const source = Object.freeze({ kind: 'synced-exchange-remote-source' as const })
    exchangeRemoteSources.set(source, { data, remote, proof })
    return Object.freeze({ status: 'ready' as const, source })
  })
}
export function readObservedSyncedProtocol5Facts(source: SyncedExchangeRemoteSource): Readonly<SyncedExchangeRemoteFacts> | null {
  const saved = exchangeRemoteSources.get(source)
  return saved ? frozenPublicationFacts({ ...saved.data.context, databasePath: saved.data.databasePath, root: saved.data.root,
    ...saved.remote.facts, manifestEtag: saved.remote.manifestEtag, manifestHash: saved.proof.manifestHash, closureHash: saved.proof.closureHash }) : null
}
export function readObservedSyncedProtocol5Object(source: SyncedExchangeRemoteSource, key: string, hash: string): Uint8Array | null {
  const saved = exchangeRemoteSources.get(source), bytes = saved?.remote.objects.get(key)
  return bytes && saved?.remote.facts.manifest.entries[key] === hash && publicationHash(bytes) === hash ? Buffer.from(bytes) : null
}
export function readObservedSyncedProtocol5Asset(source: SyncedExchangeRemoteSource, hash: string): Uint8Array | null {
  const bytes = exchangeRemoteSources.get(source)?.remote.assets.get(hash)
  return bytes && publicationHash(bytes) === hash ? Buffer.from(bytes) : null
}
export function assertObservedSyncedProtocol5Current(db: Database.Database, source: SyncedExchangeRemoteSource): void {
  const saved = exchangeRemoteSources.get(source)
  if (!saved || saved.data.db !== db) return unavailable('增量 source 不属于原真实 connection。')
  currentObservation(saved.data)
}
/** The local side is always freshly captured from real SQLite; no caller snapshot can be substituted. */
export async function materializeSyncedExchangeLocal(db: Database.Database, input: { userDataRoot: string; target: WebDavSyncConfig }): Promise<SyncedExchangeLocalMaterial> {
  return publicBoundary(async () => {
    const data = exchangeObservation(db, input)
    const snapshot = db.transaction(() => { currentObservation(data); return readSyncedPersistentPublicationSnapshot(db) })()
    const paths: Paths = { root: data.root, databasePath: data.databasePath, assetRoot: join(data.root, 'storage', 'assets'),
      spoolRoot: join(data.root, 'storage', 'synced-exchanges-v1'), directory: '' }
    const material = await portable(snapshot, paths)
    const handle = Object.freeze({ kind: 'synced-exchange-local-material' as const })
    exchangeLocalMaterials.set(handle, { data, snapshot, ...material })
    return handle
  })
}
export function readSyncedExchangeLocalMaterial(handle: SyncedExchangeLocalMaterial): Readonly<SyncedExchangeMaterialFacts> | null {
  const saved = exchangeLocalMaterials.get(handle)
  return saved ? frozenPublicationFacts({ databasePath: saved.data.databasePath, root: saved.data.root, snapshot: saved.snapshot, records: saved.records }) : null
}
export function readSyncedExchangeLocalAsset(handle: SyncedExchangeLocalMaterial, hash: string): Uint8Array | null {
  const bytes = exchangeLocalMaterials.get(handle)?.assets.get(hash)
  return bytes && publicationHash(bytes) === hash ? Buffer.from(bytes) : null
}
/** Exact historical confirmed publications, authenticated by durable rows and original private spools.
 * No timestamp selection and no supplied snapshot can become a common ancestor. */
export async function readConfirmedSyncedPublicationSeeds(db: Database.Database, input: { userDataRoot: string; target: WebDavSyncConfig }): Promise<Array<{
  operationId: string; manifest: SyncedInitialManifest5; records: Array<{ key: string; hash: string; record: InitialPublicationRecord }>
}>> {
  return publicBoundary(async () => {
    const data = exchangeObservation(db, input), originalTarget = targetFingerprint(data.target)
    const rows = db.transaction(() => {
      currentObservation(data)
      return db.prepare("SELECT id,request_hash,publication_hash FROM synced_exposure_attempts WHERE channel='webdav-manifest5' AND target_fingerprint=? AND state='confirmed' ORDER BY id")
        .all(originalTarget) as Array<{ id: string; request_hash: string; publication_hash: string }>
    })()
    const result: Array<{ operationId: string; manifest: SyncedInitialManifest5; records: Array<{ key: string; hash: string; record: InitialPublicationRecord }> }> = []
    for (const row of rows) {
      if (!isSyncedUuid(row.id)) return publicationInvalid('原 confirmed publication UUID 损坏。')
      const paths: Paths = { root: data.root, databasePath: data.databasePath, assetRoot: join(data.root, 'storage', 'assets'),
        spoolRoot: join(data.root, 'storage', 'synced-publications-v1'), directory: join(data.root, 'storage', 'synced-publications-v1', row.id) }
      const loaded = await loadSpool(paths), state = loaded.state
      if (state.attemptId !== row.id || state.publicationHash !== row.publication_hash || state.requestHash !== row.request_hash
        || state.descriptor.targetFingerprint !== originalTarget || publicationJson(state.target) !== publicationJson(storedTarget(data.target))) return publicationInvalid('原 confirmed source/target/descriptor 不闭合。')
      if (state.descriptor.workspaceScope !== data.context.workspaceScope || state.descriptor.recoveryEpoch !== data.context.recoveryEpoch) continue
      const manifest = validateInitialManifest5(decodePublicationJson(loaded.manifest))
      const records = state.descriptor.objects.map(item => ({ key: item.key, hash: item.hash,
        record: validateInitialRecord(decodePublicationJson(loaded.objects.get(item.key)!), item.key) }))
      result.push(frozenPublicationFacts({ operationId: row.id, manifest, records }))
    }
    db.transaction(() => currentObservation(data))()
    return result
  })
}
