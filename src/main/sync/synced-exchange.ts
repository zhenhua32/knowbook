import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { lstatSync, realpathSync, readFileSync, mkdirSync, linkSync } from 'node:fs'
import { mkdir, open, readFile, rename, rm, readdir } from 'node:fs/promises'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { WebDavSyncConfig } from '../../shared/webdav-sync'
import type { SyncedGroupWire, SyncedStableBlockDraft } from '../../shared/synced-blocks'
import { assertSyncedShape, isSyncedUuid, parseSyncedBlockPayload } from '../../shared/syncedBlockValidation'
import { localizeSyncedPortableGroupAssets, localizeSyncedPortableHostAssets, rewriteSyncedGroupAssets,
  rewriteSyncedPortableHostAssets, buildSyncedPortableAssetUri, parseSyncedPortableAssetUri } from '../../shared/syncedBlockPortable'
import { parseDatabaseViewPayload } from '../../shared/databaseViewBlock'
import { AttachmentStore } from '../attachments'
import { MarkdownLinkIndex } from '../database/markdown-link-index'
import { assertSyncedBlockSchema } from '../database/synced-schema'
import { assertSyncedLifecycleSchema } from '../database/synced-lifecycle-schema'
import { readSyncedGroupLifecycles, syncedLifecycleSemanticHash } from '../database/synced-lifecycle-state'
import { assertSyncedStoredBindings } from '../database/synced-block-links'
import { readSyncedPersistentPublicationSnapshot } from '../database/synced-publication'
import { observationDatabasePath } from '../database/synced-remote-observation-pending'
import { readSyncedExchangeCutJournal } from '../database/synced-exchange-host-cut'
import { readSyncedExchangeLocal, readSyncedExchangeReceipt, type SyncedExchangeLocal } from '../database/synced-exchange-read'
import { readSyncedExchangeConflictPreviewIndex } from '../database/synced-exchange-conflict-read'
import { WebDavClient, WebDavHttpError, normalizeWebDavConfig } from './webdav-client'
import { SYNC_TABLE_COLUMNS, SYNC_TABLES, type SyncDatabases } from './model'
import { initialIncomingTargetFingerprint, inverseInitialIncomingCatalog, initialIncomingPortableDigest } from './synced-initial-incoming-model'
import { PUBLICATION_RECORD_MAX_BYTES, publicationCompare, publicationHash, publicationJson, publicationInvalid,
  frozenPublicationFacts, decodePublicationJson, mapPublicationCatalog, SyncedPublicationError,
  type InitialPublicationRecord, type SyncedInitialManifest5, type PublicationAssetDescriptor } from './synced-publication-model'
import { ATTACHMENT_MAX_FILE_BYTES } from '../../shared/attachments'
import { validateSyncedProtocol5Record, validateSyncedProtocol5Snapshot, syncedProtocol5RecordKey,
  type SyncedProtocol5Record, type SyncedProtocol5Snapshot } from './synced-protocol5-model'
import { readObservedSyncedProtocol5, readObservedSyncedProtocol5Facts, readObservedSyncedProtocol5Object,
  readObservedSyncedProtocol5Asset, assertObservedSyncedProtocol5Current, materializeSyncedExchangeLocal,
  readSyncedExchangeLocalMaterial, readSyncedExchangeLocalAsset, readConfirmedSyncedPublicationSeeds,
  type SyncedExchangeRemoteSource, type SyncedExchangeLocalMaterial, type SyncedExchangeRemoteFacts } from './synced-publication'
import * as M from './synced-exchange-model'
import { planSyncedExchange, planSyncedExchangeV1, deriveSyncedExchangeDependencyFacts, type ExchangePlan, type ExchangePlanInput } from './synced-exchange-plan'
import * as C from './synced-exchange-conflict-model'

export type { SyncedExchangeResult } from './synced-exchange-model'
export interface SyncedExchangeInput { operationId: string; userDataRoot: string; target: WebDavSyncConfig }
export interface SyncedExchangeRuntime { password: string; signal?: AbortSignal }
export interface SyncedExchangeConflictPreviewInput { previewId: string; userDataRoot: string; target: WebDavSyncConfig }
export interface SyncedExchangeConflictResolveInput extends SyncedExchangeInput { previewId: string; decisions: C.SyncedExchangeConflictDecision[] }
export type { SyncedExchangeConflictPreviewResult, SyncedExchangeConflictDecision } from './synced-exchange-conflict-model'
type Context = { root: string; databasePath: string; target: WebDavSyncConfig; request: M.ExchangeRequest;
  workspaceScope: string; recoveryEpoch: string; initialTargetFingerprint: string;
  resolution: C.ExchangeResolutionBinding | null; selections: NonNullable<ExchangePlanInput['conflictSelections']> }
type Prepared = { context: Context; local: SyncedExchangeLocal; localMaterial: SyncedExchangeLocalMaterial;
  localWire: SyncedProtocol5Snapshot; source: SyncedExchangeRemoteSource; remote: SyncedExchangeRemoteFacts;
  state: M.ExchangeState; baseRecords: SyncedProtocol5Snapshot['records']; plan: ExchangePlan; planningAuthority: ReturnType<typeof authority>; engine: 1 | 2 }
type Spool = { directory: string; job: M.ExchangeJob; plan: ExchangePlan; state: M.ExchangeState;
  localFingerprint: string; manifest: Buffer; records: SyncedProtocol5Snapshot['records']; objects: Map<string, Buffer>; assets: Map<string, Buffer>;
  planning: { local: SyncedProtocol5Snapshot; remote: SyncedProtocol5Snapshot; baseRecords: SyncedProtocol5Snapshot['records'];
    authority: ReturnType<typeof authority>; keyGuards: Record<string, string>; stateRaw: string | null;
    engine: 1 | 2; conflictSelections: NonNullable<ExchangePlanInput['conflictSelections']> } }
type Head = { kind: 'synced-exchange-job-head'; version: 1; operationId: string; requestHash: string;
  attemptId: string; attemptIndex: number; jobHash: string }
const running = new Set<string>()
const sort = (values: Iterable<string>): string[] => [...new Set(values)].sort(publicationCompare)
const same = (a: unknown, b: unknown): boolean => publicationJson(a) === publicationJson(b)
function unavailable(message: string): never { throw new SyncedPublicationError('unavailable', message) }
function aborted(signal?: AbortSignal): void { if (signal?.aborted) throw new SyncedPublicationError('transport', '增量exchange已取消；原possible/observer事实保持。', signal.reason) }
function spelling(file: string): string { return process.platform === 'win32' ? resolve(file).toLowerCase() : resolve(file) }
function safe(file: string, root?: string): void {
  const absolute = resolve(file)
  if (root) { const child = relative(resolve(root), absolute); if (child === '..' || child.startsWith('..' + sep) || isAbsolute(child)) throw new SyncedPublicationError('spool', '增量路径越过原私有根。') }
  let current = parse(absolute).root
  for (const part of relative(current, absolute).split(sep).filter(Boolean)) { current = join(current, part); if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new SyncedPublicationError('spool', '增量路径含符号链接。') }
}
function outside(db: Database.Database): void {
  if (!db.open || db.readonly) return unavailable('exchange需要原真实writable connection。')
  if (db.inTransaction) return publicationInvalid('exchange不接受调用方事务。')
  if (db.pragma('foreign_keys', { simple: true }) !== 1) return publicationInvalid('exchange要求FK保护。')
}
function identity(db: Database.Database): { workspaceScope: string; recoveryEpoch: string } {
  const row = db.prepare('SELECT workspace_scope,recovery_epoch FROM synced_workspace_state WHERE singleton=1').get() as { workspace_scope: unknown; recovery_epoch: unknown } | undefined
  if (!row || !isSyncedUuid(row.workspace_scope) || !isSyncedUuid(row.recovery_epoch)) return publicationInvalid('exchange真实scope/epoch损坏。')
  return { workspaceScope: row.workspace_scope, recoveryEpoch: row.recovery_epoch }
}
function context(db: Database.Database, input: SyncedExchangeInput): Context {
  outside(db); M.assertExchangeData(input); assertSyncedShape(input, ['operationId', 'userDataRoot', 'target'])
  if (!isSyncedUuid(input.operationId) || typeof input.userDataRoot !== 'string' || !isAbsolute(input.userDataRoot)) return publicationInvalid('exchange operation/root无效。')
  assertSyncedShape(input.target, ['enabled', 'url', 'username', 'directory', 'intervalMinutes', 'allowInsecureHttp'])
  const target = Object.freeze(normalizeWebDavConfig(input.target)), root = resolve(input.userDataRoot), file = join(root, 'storage', 'knowbook.db')
  safe(root); safe(file)
  if (typeof db.name !== 'string' || spelling(db.name) !== spelling(file) || !lstatSync(file).isFile()
    || spelling(realpathSync(file)) !== spelling(file) || spelling(realpathSync(root)) !== spelling(root)) return unavailable('exchange connection/root不是Main真实knowbook.db。')
  const databasePath = observationDatabasePath(file), request = M.validateExchangeRequest({ method: 'exchangeSyncedSnapshot', operationId: input.operationId,
    databasePath, targetFingerprint: M.exchangeTargetFingerprint(target) })
  return { root, databasePath, target, request, ...identity(db), initialTargetFingerprint: initialIncomingTargetFingerprint(target), resolution: null, selections: [] }
}
function current(db: Database.Database, c: Context): void {
  if (!db.open || db.readonly) return unavailable('exchange原writable connection已失效。')
  if (db.pragma('foreign_keys', { simple: true }) !== 1) return publicationInvalid('exchange FK失效。')
  safe(c.root); safe(c.databasePath)
  if (spelling(realpathSync(db.name)) !== spelling(c.databasePath) || !same(identity(db), { workspaceScope: c.workspaceScope, recoveryEpoch: c.recoveryEpoch })
    || db.pragma('user_version', { simple: true }) !== 27) return unavailable('exchange原path/scope/recovery epoch失效。')
  assertSyncedBlockSchema(db); assertSyncedLifecycleSchema(db)
}
function credentials(value: SyncedExchangeRuntime): SyncedExchangeRuntime {
  assertSyncedShape(value, ['password'], ['signal'])
  if (typeof value.password !== 'string' || value.signal !== undefined && !(value.signal instanceof AbortSignal)) return publicationInvalid('exchange credentials/signal无效。')
  return value
}
async function network<T>(run: () => Promise<T>): Promise<T> {
  try { return await run() } catch (cause) {
    if (cause instanceof SyncedPublicationError) throw cause
    throw new SyncedPublicationError(cause instanceof Error && cause.message === '远端同步文件超过大小限制。' ? 'invalid' : 'transport', 'exchange真实WebDAV请求失败；原possible/bytes保留。', cause)
  }
}
function capture(db: Database.Database, c: Context): SyncedExchangeLocal {
  return db.transaction(() => { current(db, c); return readSyncedExchangeLocal(db, { request: c.request, initialTargetFingerprint: c.initialTargetFingerprint }) })()
}
function wire(records: readonly SyncedProtocol5Record[], workspaceId: string): SyncedProtocol5Snapshot {
  const entries = Object.fromEntries(records.map(record => [syncedProtocol5RecordKey(record), publicationHash(publicationJson(record))]).sort(([a], [b]) => publicationCompare(a, b)))
  const syncedInstances = records.flatMap(record => record.kind === 'document' ? record.content.blocks.flatMap(block => {
    if (block.type !== 'synced-block') return []
    const payload = parseSyncedBlockPayload(block.content)
    return [{ documentId: record.id, instanceId: block.id, groupId: payload.groupId, groupHash: entries['group:' + payload.groupId] }]
  }) : []).sort((a, b) => publicationCompare(a.documentId, b.documentId) || publicationCompare(a.instanceId, b.instanceId))
  return validateSyncedProtocol5Snapshot({ version: 5, workspaceId, entries, syncedInstances }, records.map(record => ({ key: syncedProtocol5RecordKey(record), record })))
}
function fromRemote(remote: SyncedExchangeRemoteFacts): SyncedProtocol5Snapshot {
  return validateSyncedProtocol5Snapshot(remote.manifest, remote.records.map(item => ({ key: item.key, record: item.record })))
}
function putImmutable(db: Database.Database, key: string, value: unknown, now: string): void {
  const text = publicationJson(value), old = db.prepare('SELECT value,updated_at FROM app_settings WHERE key=?').get(key) as { value: string; updated_at: string } | undefined
  if (old) { if (old.value !== text) return publicationInvalid('exchange原immutable metadata发生冲突；不会覆盖。'); return }
  db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)').run(key, text, now)
}
function initialEdges(snapshot: SyncedProtocol5Snapshot): Map<string, string[]> {
  const edges = new Map(snapshot.records.map(item => [item.key, new Set<string>()]))
  const connect = (a: string, b: string) => { if (a === b || !edges.has(a) || !edges.has(b)) return; edges.get(a)!.add(b); edges.get(b)!.add(a) }
  for (const item of snapshot.records) {
    const r = item.record
    if (r.kind === 'document') {
      if (r.parentId !== null) connect(item.key, 'doc:' + r.parentId)
      for (const block of r.content.blocks) {
        if (block.type === 'synced-block') connect(item.key, 'group:' + parseSyncedBlockPayload(block.content).groupId)
        if (block.type === 'database-view') connect(item.key, 'databases')
      }
    } else if (r.kind === 'synced-group') {
      for (const block of r.blocks) if (block.type === 'database-view') connect(item.key, 'databases')
    } else if (r.kind === 'databases') {
      for (const table of SYNC_TABLES) for (const row of r.tables[table]) if (typeof row.document_id === 'string') connect('databases', 'doc:' + row.document_id)
    }
  }
  return new Map([...edges].map(([key, next]) => [key, sort(next)]))
}
function seedState(c: Context, source: M.ExchangeSeedProof, base: SyncedProtocol5Snapshot): M.ExchangeState {
  const edges = new Map(deriveSyncedExchangeDependencyFacts(base).map(row => [row.key, row])), now = new Date().toISOString()
  return M.validateExchangeState({ kind: 'synced-exchange-state', version: 1, databasePath: c.databasePath, targetFingerprint: c.request.targetFingerprint,
    workspaceScope: c.workspaceScope, recoveryEpoch: c.recoveryEpoch, remoteWorkspaceId: base.manifest.workspaceId, generation: randomUUID(), currentOperationId: null, source,
    baseline: base.records.map(item => ({ key: item.key, localHash: item.hash, remoteHash: item.hash, commonHash: item.hash,
      dependencyKeys: edges.get(item.key)!.dependencyKeys, dependencySignature: edges.get(item.key)!.dependencySignature,
      acceptedOperationId: source.operationId ?? c.request.operationId })).sort((a, b) => publicationCompare(a.key, b.key)), deferred: [], lastSyncAt: now })
}
async function bases(c: Context, state: M.ExchangeState, local: SyncedProtocol5Snapshot, remote: SyncedProtocol5Snapshot,
  client: WebDavClient, original?: SyncedProtocol5Snapshot): Promise<{ records: SyncedProtocol5Snapshot['records']; missing: string[] }> {
  const records: SyncedProtocol5Snapshot['records'] = [], missing: string[] = []
  const available = new Map([...(original?.records ?? []), ...local.records, ...remote.records].map(item => [publicationJson([item.key, item.hash]), item.record]))
  for (const entry of state.baseline) {
    const hash = entry.commonHash ?? entry.remoteHash
    let record = available.get(publicationJson([entry.key, hash]))
    if (!record) {
      const object = await network(() => client.get('objects/' + hash + '.json', PUBLICATION_RECORD_MAX_BYTES))
      if (!object) { missing.push(entry.key); continue }
      if (publicationHash(object.bytes) !== hash) return publicationInvalid('exchange原B对象bytes hash损坏。')
      record = validateSyncedProtocol5Record(decodePublicationJson(object.bytes), entry.key)
    }
    if (publicationHash(publicationJson(record)) !== hash) return publicationInvalid('exchange原B对象hash不闭合。')
    records.push({ key: entry.key, hash, record })
  }
  return { records, missing }
}
async function initialState(c: Context, local: SyncedExchangeLocal, localWire: SyncedProtocol5Snapshot,
  remote: SyncedProtocol5Snapshot): Promise<{ state: M.ExchangeState; original?: SyncedProtocol5Snapshot }> {
  if (local.state) return { state: local.state }
  if (local.initialBaseline) {
    const original = local.initialBaseline
    if (original.result.workspaceScope !== c.workspaceScope || original.result.recoveryEpoch !== c.recoveryEpoch
      || original.manifest.workspaceId !== remote.manifest.workspaceId) return unavailable('初始接收共同来源不属于原scope/epoch/remote。')
    // The exact bodies are fetched by bases before the planner consumes this authenticated manifest.
    const edges = new Map<string, string[]>()
    for (const key of Object.keys(original.manifest.entries)) edges.set(key, [])
    for (const instance of original.manifest.syncedInstances) {
      const a = 'doc:' + instance.documentId, b = 'group:' + instance.groupId
      edges.set(a, sort([...(edges.get(a) ?? []), b])); edges.set(b, sort([...(edges.get(b) ?? []), a]))
    }
    const source: M.ExchangeSeedProof = { kind: 'initial-receipt', operationId: original.result.operationId,
      manifestHash: original.result.manifestHash, portableDigest: original.provenance.portableDigest }
    return { state: M.validateExchangeState({ kind: 'synced-exchange-state', version: 1, databasePath: c.databasePath, targetFingerprint: c.request.targetFingerprint,
      workspaceScope: c.workspaceScope, recoveryEpoch: c.recoveryEpoch, remoteWorkspaceId: remote.manifest.workspaceId, generation: randomUUID(), currentOperationId: null, source,
      baseline: Object.entries(original.manifest.entries).map(([key, hash]) => ({ key, localHash: hash, remoteHash: hash, commonHash: hash,
        dependencyKeys: edges.get(key) ?? [], dependencySignature: publicationHash(publicationJson({ key, hash, edges: edges.get(key) ?? [] })), acceptedOperationId: source.operationId })),
      deferred: [], lastSyncAt: original.lastReceivedAt }) }
  }
  const seeds = await readConfirmedSyncedPublicationSeeds(captureConnection(c), { userDataRoot: c.root, target: c.target })
  const distinct = new Map(seeds.filter(item => item.manifest.workspaceId === remote.manifest.workspaceId).map(item => [publicationHash(publicationJson(item.manifest)), item]))
  const selected = distinct.get(publicationHash(publicationJson(remote.manifest))) ?? (distinct.size === 1 ? [...distinct.values()][0] : undefined)
  if (selected) {
    const original = validateSyncedProtocol5Snapshot(selected.manifest, selected.records.map(item => ({ key: item.key, record: item.record })))
    return { state: seedState(c, { kind: 'confirmed-publication', operationId: selected.operationId,
      manifestHash: publicationHash(publicationJson(selected.manifest)), portableDigest: initialIncomingPortableDigest(selected.manifest.entries, selected.manifest.syncedInstances) }, original), original }
  }
  if (same(localWire.manifest.entries, remote.manifest.entries) && same(localWire.manifest.syncedInstances, remote.manifest.syncedInstances))
    return { state: seedState(c, { kind: 'current-equality', operationId: null, manifestHash: publicationHash(publicationJson(remote.manifest)),
      portableDigest: initialIncomingPortableDigest(remote.manifest.entries, remote.manifest.syncedInstances) }, remote), original: remote }
  return unavailable('没有可认证的共同baseline；不按今日L/R、时间或同文猜来源。')
}
// The connection never enters a persisted object/DTO. Only live invocation contexts are registered.
const connections = new WeakMap<Context, Database.Database>()
function captureConnection(c: Context): Database.Database { return connections.get(c) ?? unavailable('exchange原connection不可用。') }

function authority(local: SyncedExchangeLocal, missingBaseKeys: string[], deferredKeys: string[] = []) {
  return { catalogId: local.snapshot.catalogId, identities: local.identities, occupiedDocumentIds: local.occupiedDocumentIds,
    historyComponents: local.historyComponents, pinnedGroupIds: local.pinnedGroupIds, knownGroupIds: local.knownGroupIds, missingBaseKeys, deferredKeys,
    keyGuards: Object.entries(local.keyGuards).map(([key, fingerprint]) => ({ key, fingerprint })) }
}
function makePlan(input: ExchangePlanInput, engine: 1 | 2): ExchangePlan {
  return engine === 1 ? planSyncedExchangeV1(input) : planSyncedExchange(input)
}
async function prepare(db: Database.Database, c: Context, runtime: SyncedExchangeRuntime, deferredKeys: string[] = [], engine: 1 | 2 = 2): Promise<Prepared | M.SyncedExchangeResult> {
  const loaded = await readObservedSyncedProtocol5(db, { userDataRoot: c.root, target: c.target }, runtime)
  if (loaded.status !== 'ready') return loaded
  const source = loaded.source, remote = readObservedSyncedProtocol5Facts(source)
  if (!remote) return unavailable('真实remote source已经失效。')
  const localMaterial = await materializeSyncedExchangeLocal(db, { userDataRoot: c.root, target: c.target })
  const material = readSyncedExchangeLocalMaterial(localMaterial), local = capture(db, c)
  if (!material || material.snapshot.localFingerprint !== local.snapshot.localFingerprint) return { status: 'stale', side: 'local' }
  const localWire = wire(material.records, c.workspaceScope), remoteWire = fromRemote(remote)
  const initialized = await initialState(c, local, localWire, remoteWire)
  const client = new WebDavClient(c.target, runtime.password, runtime.signal)
  const common = await bases(c, initialized.state, localWire, remoteWire, client, initialized.original)
  let state = initialized.state
  if (!local.state && state.source.kind === 'initial-receipt') {
    // A seed is one complete original graph. Missing any old object means its unobserved edges are unknown.
    // Join the entire old key set conservatively rather than certify a partial manifest as an empty dependency graph.
    if (common.missing.length) {
      const all = state.baseline.map(row => row.key)
      state = M.validateExchangeState({ ...state, baseline: state.baseline.map(row => ({ ...row, dependencyKeys: all.filter(key => key !== row.key),
        dependencySignature: publicationHash(publicationJson({ unknownOriginalClosure: state.source.manifestHash, key: row.key, all })) })) })
    } else {
      const original = validateSyncedProtocol5Snapshot(local.initialBaseline!.manifest, common.records.map(item => ({ key: item.key, record: item.record })))
      state = seedState(c, state.source, original)
    }
  }
  // Re-authenticate every baseline row that still claims the seed, not merely the seed's manifest digest.
  if (local.state && state.source.kind !== 'current-equality') {
    let original: SyncedProtocol5Snapshot | undefined
    if (state.source.kind === 'confirmed-publication') {
      const seeds = await readConfirmedSyncedPublicationSeeds(db, { userDataRoot: c.root, target: c.target })
      const seed = seeds.find(row => row.operationId === state.source.operationId)
      if (!seed || publicationHash(publicationJson(seed.manifest)) !== state.source.manifestHash) return publicationInvalid('exchange seed原confirmed spool缺失/变更。')
      original = validateSyncedProtocol5Snapshot(seed.manifest, seed.records.map(row => ({ key: row.key, record: row.record })))
    } else if (!local.initialBaseline || local.initialBaseline.result.operationId !== state.source.operationId
      || local.initialBaseline.result.manifestHash !== state.source.manifestHash) return publicationInvalid('exchange seed原initial receipt缺失/不符。')
    else {
      const values = common.records.filter(row => local.initialBaseline!.manifest.entries[row.key] === row.hash)
      if (values.length === Object.keys(local.initialBaseline.manifest.entries).length) original = validateSyncedProtocol5Snapshot(local.initialBaseline.manifest, values.map(row => ({ key: row.key, record: row.record })))
    }
    if (original) {
      const expected = new Map(seedState(c, state.source, original).baseline.map(row => [row.key, row]))
      for (const row of state.baseline) if (row.acceptedOperationId === state.source.operationId && !same(row, expected.get(row.key))) return publicationInvalid('exchange baseline冒借或修改原seed事实。')
    } else if (state.baseline.some(row => row.acceptedOperationId === state.source.operationId)) {
      // The original full graph cannot be proven independently. Persist no invented narrower edges.
      common.missing.push(...state.baseline.map(row => row.key))
    }
  }
  const now = capture(db, c)
  if (now.fingerprint !== local.fingerprint) return { status: 'stale', side: 'local' }
  const planningAuthority = authority(local, sort(common.missing), deferredKeys)
  const plan = makePlan({ operationId: c.request.operationId, local: localWire, remote: remoteWire,
    baseRecords: common.records, state, localFingerprint: local.fingerprint, authority: planningAuthority,
    ...(engine === 2 ? {conflictSelections:c.selections} : {}) },engine)
  return { context: c, local, localMaterial, localWire, source, remote, state, baseRecords: common.records, plan, planningAuthority, engine }
}
function directory(c: Context, attemptId: string): string { return join(c.root, 'storage', 'synced-exchanges-v1', c.request.operationId, attemptId) }
async function durable(file: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(file, 'wx', 0o600)
  try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
}
async function syncDirectory(file: string): Promise<void> {
  try { const handle = await open(file, 'r'); try { await handle.sync() } finally { await handle.close() } }
  catch (cause) { if (process.platform !== 'win32') throw cause }
}
function metadata(db: Database.Database, key: string): { value: string; updated_at: string } | undefined {
  return db.prepare('SELECT value,updated_at FROM app_settings WHERE key=?').get(key) as { value: string; updated_at: string } | undefined
}
function readHead(db: Database.Database, c: Context): Head | null {
  const row = metadata(db, M.exchangeJobHeadKey(c.request.operationId)); if (!row) return null
  const value = M.parseExchangeStored(row.value)
  assertSyncedShape(value, ['kind', 'version', 'operationId', 'requestHash', 'attemptId', 'attemptIndex', 'jobHash'])
  if (value.kind !== 'synced-exchange-job-head' || value.version !== 1 || value.operationId !== c.request.operationId
    || value.requestHash !== M.exchangeRequestHash(c.request) || !isSyncedUuid(value.attemptId) || typeof value.attemptIndex !== 'number'
    || !Number.isSafeInteger(value.attemptIndex) || value.attemptIndex < 0 || typeof value.jobHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.jobHash)) return publicationInvalid('exchange原head损坏/operation复用。')
  const head: Head = { kind: 'synced-exchange-job-head', version: 1, operationId: value.operationId, requestHash: value.requestHash,
    attemptId: value.attemptId, attemptIndex: value.attemptIndex, jobHash: value.jobHash }
  const prefix = M.exchangeJobPrefix(c.request.operationId)
  const rows = db.prepare('SELECT key,value FROM app_settings WHERE substr(key,1,?)=? ORDER BY key').all(prefix.length, prefix) as Array<{ key: string; value: string }>
  const byId = new Map(rows.map(source => { const job = M.validateExchangeJob(M.parseExchangeStored(source.value));
    if (source.key !== M.exchangeJobKey(c.request.operationId, job.attemptId) || !same(job.request, c.request)) return publicationInvalid('exchange job原namespace/request损坏。')
    return [job.attemptId, job] as const }))
  let id: string | null = head.attemptId, count = 0, expected = head.attemptIndex
  const seen = new Set<string>()
  while (id !== null) {
    const job = byId.get(id)
    if (!job || seen.has(id) || job.attemptIndex !== expected || count === 0 && M.exchangeJobHash(job) !== head.jobHash) return publicationInvalid('exchange job父链缺失/循环/头错位。')
    seen.add(id); count++; expected--; id = job.parentAttemptId
  }
  if (expected !== -1 || count !== byId.size) return publicationInvalid('exchange原job链存在孤立或被删除的attempt。')
  return head
}
function phases(db: Database.Database, job: M.ExchangeJob): M.ExchangeJobPhaseFact[] {
  const prefix = 'sync.webdav.protocol5.exchange-job-phase.v1.' + job.request.operationId + '.' + job.attemptId + '.'
  const rows = db.prepare('SELECT key,value,updated_at FROM app_settings WHERE substr(key,1,?)=?').all(prefix.length, prefix) as Array<{ key: string; value: string; updated_at: string }>
  const facts = rows.map(row => { const fact = M.validateExchangeJobPhase(M.parseExchangeStored(row.value))
    if (row.key !== M.exchangeJobPhaseKey(job.request.operationId, job.attemptId, fact.sequence) || row.updated_at !== fact.recordedAt
      || fact.requestHash !== job.requestHash || fact.jobHash !== M.exchangeJobHash(job) || fact.operationId !== job.request.operationId || fact.attemptId !== job.attemptId) return publicationInvalid('exchange原phase不属于实际job。')
    return fact }).sort((a, b) => a.sequence - b.sequence)
  let previous: string | null = null
  for (const [index, fact] of facts.entries()) { if (fact.sequence !== index || fact.previousFactHash !== previous) return publicationInvalid('exchange phase追加链不连续。'); previous = publicationHash(publicationJson(fact)) }
  if (!facts.length) return publicationInvalid('exchange job缺prepared事实。')
  return facts
}
function phase(db: Database.Database, job: M.ExchangeJob, value: M.ExchangeJobPhase, remoteEtag: string | null): void {
  const previous = phases(db, job), last = previous.at(-1)!
  if (last.phase === value && last.remoteEtag === remoteEtag) return
  const fact = M.validateExchangeJobPhase({ kind: 'synced-exchange-job-phase', version: 1, operationId: job.request.operationId,
    requestHash: job.requestHash, jobHash: M.exchangeJobHash(job), attemptId: job.attemptId, sequence: previous.length,
    previousFactHash: publicationHash(publicationJson(last)), phase: value, remoteEtag, recordedAt: new Date().toISOString() })
  putImmutable(db, M.exchangeJobPhaseKey(job.request.operationId, job.attemptId, fact.sequence), fact, fact.recordedAt)
}
async function spool(prepared: Prepared, parent: Head | null): Promise<Spool> {
  const { context: c, plan, local, remote } = prepared, attemptId = randomUUID(), now = new Date().toISOString()
  const records = plan.nextRemote.records, manifest = Buffer.from(publicationJson(plan.nextRemote.manifest)), objects = new Map<string, Buffer>(), assets = new Map<string, Buffer>()
  const objectFacts = records.map(item => { const bytes = Buffer.from(publicationJson(item.record)); objects.set(item.key, bytes)
    return { key: item.key, hash: item.hash, path: 'objects/' + item.hash + '.json', bytes: bytes.length } })
  const assetFacts: PublicationAssetDescriptor[] = []
  for (const [hash, names] of plan.nextRemote.assetNames) {
    const value = readSyncedExchangeLocalAsset(prepared.localMaterial, hash) ?? readObservedSyncedProtocol5Asset(prepared.source, hash)
    if (!value || publicationHash(value) !== hash) return publicationInvalid('exchange next候选缺真实原asset bytes。')
    const bytes = Buffer.from(value); assets.set(hash, bytes); assetFacts.push({ path: 'assets/' + hash, hash, bytes: bytes.length, names: sort(names) })
  }
  assetFacts.sort((a, b) => publicationCompare(a.path, b.path))
  const nextGroups = new Map(records.flatMap(item => item.record.kind === 'synced-group' ? [[item.record.id, item] as const] : []))
  const members = local.snapshot.groups.flatMap(group => {
    const next = nextGroups.get(group.wire.id)
    if (!next || next.record.kind !== 'synced-group' || next.record.creationId !== group.wire.creationId || next.record.createdAt !== group.wire.createdAt || !same(next.record.origin, group.wire.origin)) return []
    return [{ groupId: group.wire.id, creationId: group.wire.creationId, revision: group.revision, topologyRevision: group.topologyRevision,
      semanticHash: group.semanticHash, nextPortableHash: next.hash }]
  }).sort((a, b) => publicationCompare(a.groupId, b.groupId))
  const descriptor = M.validateExchangeDescriptor({ kind: 'synced-exchange-publication', version: 1, attemptId,
    workspaceScope: c.workspaceScope, recoveryEpoch: c.recoveryEpoch, targetFingerprint: c.request.targetFingerprint, localFingerprint: local.fingerprint,
    planHash: plan.planHash, expectedRemote: { etag: remote.manifestEtag, manifestHash: remote.manifestHash }, next: { manifestHash: plan.afterManifestHash, objects: objectFacts, assets: assetFacts }, members })
  const inputs = { kind: 'synced-exchange-private-inputs', version: prepared.engine, request: c.request, target: c.target, local: prepared.localWire,
    remote: fromRemote(remote), state: prepared.state, baseRecords: prepared.baseRecords, authority: prepared.planningAuthority,
    keyGuards: local.keyGuards, stateRaw: local.stateRaw, plan,
    ...(prepared.engine === 2 ? {plannerVersion:'conflicts-v1',resolution:c.resolution,conflictSelections:c.selections}: {}) }
  // assetNames is a Map and never crosses a JSON boundary. Full snapshots are reconstructed strictly on load.
  const storedInputs = { ...inputs, local: { manifest: inputs.local.manifest, records: inputs.local.records }, remote: { manifest: inputs.remote.manifest, records: inputs.remote.records },
    plan: { ...plan, nextRemote: { manifest: plan.nextRemote.manifest, records: plan.nextRemote.records }, localFinal: { manifest: plan.localFinal.manifest, records: plan.localFinal.records } } }
  const inputBytes = Buffer.from(publicationJson(storedInputs)), spoolHash = publicationHash(publicationJson({ inputHash: publicationHash(inputBytes), descriptor }))
  const job = M.validateExchangeJob({ kind: 'synced-exchange-job', version: prepared.engine, request: c.request, requestHash: M.exchangeRequestHash(c.request),
    attemptId, parentAttemptId: parent?.attemptId ?? null, attemptIndex: parent ? parent.attemptIndex + 1 : 0, workspaceScope: c.workspaceScope,
    recoveryEpoch: c.recoveryEpoch, remoteWorkspaceId: remote.manifest.workspaceId, source: prepared.state.source, descriptor, components: plan.components, spoolHash, preparedAt: now,
    ...(prepared.engine === 2 ? {plannerVersion:'conflicts-v1',resolution:c.resolution,merges:plan.merges??[]}: {}) })
  const dir = directory(c, attemptId); safe(dir, c.root); await mkdir(join(dir, 'objects'), { recursive: true, mode: 0o700 }); await mkdir(join(dir, 'assets'), { mode: 0o700 }); safe(dir, c.root)
  await durable(join(dir, 'inputs.json'), inputBytes); await durable(join(dir, 'manifest.json'), manifest)
  for (const item of descriptor.next.objects) { const file = join(dir, item.path); if (!lstatSync(file, { throwIfNoEntry: false })) await durable(file, objects.get(item.key)!) }
  for (const item of descriptor.next.assets) await durable(join(dir, item.path), assets.get(item.hash)!)
  await durable(join(dir, 'job.json'), Buffer.from(publicationJson(job))); await durable(join(dir, 'ready.json'), Buffer.from(publicationJson({ jobHash: M.exchangeJobHash(job), spoolHash }))); await syncDirectory(dir)
  return { directory: dir, job, plan, state: prepared.state, localFingerprint: local.fingerprint, manifest, records, objects, assets,
    planning: { local: prepared.localWire, remote: fromRemote(remote), baseRecords: prepared.baseRecords, authority: prepared.planningAuthority, keyGuards: local.keyGuards, stateRaw: local.stateRaw,
      engine:prepared.engine,conflictSelections:prepared.engine===2?c.selections:[] } }
}
function registerJob(db: Database.Database, c: Context, spool: Spool, parent: Head | null): boolean {
  return db.transaction(() => {
    current(db, c); if (capture(db, c).fingerprint !== spool.localFingerprint) return false
    if (!same(readHead(db, c), parent)) return false
    const job = spool.job, now = job.preparedAt
    putImmutable(db, M.exchangeJobKey(c.request.operationId, job.attemptId), job, now)
    const first = M.validateExchangeJobPhase({ kind: 'synced-exchange-job-phase', version: 1, operationId: c.request.operationId,
      requestHash: job.requestHash, jobHash: M.exchangeJobHash(job), attemptId: job.attemptId, sequence: 0, previousFactHash: null,
      phase: 'prepared', remoteEtag: null, recordedAt: now })
    putImmutable(db, M.exchangeJobPhaseKey(c.request.operationId, job.attemptId, 0), first, now)
    const head: Head = { kind: 'synced-exchange-job-head', version: 1, operationId: c.request.operationId, requestHash: job.requestHash,
      attemptId: job.attemptId, attemptIndex: job.attemptIndex, jobHash: M.exchangeJobHash(job) }
    db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
      .run(M.exchangeJobHeadKey(c.request.operationId), publicationJson(head), now)
    return true
  }).immediate()
}
async function loadSpool(db: Database.Database, c: Context, head: Head): Promise<Spool> {
  const dir = directory(c, head.attemptId); safe(dir, c.root)
  const row = metadata(db, M.exchangeJobKey(c.request.operationId, head.attemptId))
  if (!row) return publicationInvalid('exchange原job缺失。')
  const job = M.validateExchangeJob(M.parseExchangeStored(row.value))
  if (M.exchangeJobHash(job) !== head.jobHash || job.requestHash !== M.exchangeRequestHash(c.request) || !same(job.request, c.request)
    || job.workspaceScope !== c.workspaceScope || job.recoveryEpoch !== c.recoveryEpoch) return unavailable('exchange原job不属于真实path/scope/epoch。')
  const read = async (name: string): Promise<Buffer> => { const file = join(dir, name); safe(file, dir); const info = lstatSync(file)
    if (!info.isFile()) return publicationInvalid('exchange原spool不是regular file。'); return readFile(file) }
  const savedJob = M.validateExchangeJob(M.parseExchangeStored((await read('job.json')).toString('utf8')))
  const ready = M.parseExchangeStored((await read('ready.json')).toString('utf8')); assertSyncedShape(ready, ['jobHash', 'spoolHash'])
  if (!same(savedJob, job) || ready.jobHash !== head.jobHash || ready.spoolHash !== job.spoolHash) return publicationInvalid('exchange原spool/job原bytes已变。')
  const inputBytes = await read('inputs.json'), input = M.parseExchangeStored(inputBytes.toString('utf8'))
  assertSyncedShape(input, ['kind', 'version', 'request', 'target', 'local', 'remote', 'state', 'baseRecords', 'authority', 'keyGuards', 'stateRaw', 'plan',
    ...(job.version===2?['plannerVersion','resolution','conflictSelections']:[])])
  if (input.kind !== 'synced-exchange-private-inputs' || input.version !== job.version || !same(input.request, c.request) || !same(input.target, c.target)
    || publicationHash(publicationJson({ inputHash: publicationHash(inputBytes), descriptor: job.descriptor })) !== job.spoolHash) return publicationInvalid('exchange原spoolinput认证失败。')
  const decodeSnapshot = (value: unknown): SyncedProtocol5Snapshot => {
    assertSyncedShape(value, ['manifest', 'records']); if (!Array.isArray(value.records)) return publicationInvalid('exchange原snapshot records无效。')
    return validateSyncedProtocol5Snapshot(value.manifest, value.records.map(raw => { assertSyncedShape(raw, ['key', 'hash', 'record'])
      if (typeof raw.key !== 'string' || typeof raw.hash !== 'string' || publicationHash(publicationJson(raw.record)) !== raw.hash) return publicationInvalid('exchange原snapshot hash不符。')
      return { key: raw.key, record: raw.record } }))
  }
  const local = decodeSnapshot(input.local), remote = decodeSnapshot(input.remote), state = M.validateExchangeState(input.state)
  if (!Array.isArray(input.baseRecords)) return publicationInvalid('exchange原B records无效。')
  const baseRecords = input.baseRecords.map(raw => { assertSyncedShape(raw, ['key', 'hash', 'record'])
    if (typeof raw.key !== 'string' || typeof raw.hash !== 'string') return publicationInvalid('exchange原B key/hash无效。')
    return { key: raw.key, hash: raw.hash, record: validateSyncedProtocol5Record(raw.record, raw.key) } })
  assertSyncedShape(input.authority, ['catalogId', 'identities', 'occupiedDocumentIds', 'historyComponents', 'pinnedGroupIds', 'knownGroupIds', 'missingBaseKeys', 'deferredKeys'], ['keyGuards'])
  // The authority was minted only by this module's original real capture and is authenticated by both immutable DB job and private spool hash.
  const originalAuthority = input.authority as unknown as ReturnType<typeof authority>
  const conflictSelections=job.version===2?readSelections(input.conflictSelections,c.request):[]
  if(job.version===2&&(input.plannerVersion!=='conflicts-v1'||!same(C.validateExchangeResolutionBinding(input.resolution),job.resolution))) return publicationInvalid('原job决定来源/算法损坏。')
  const plan = makePlan({ operationId: c.request.operationId, local, remote, baseRecords, state,
    localFingerprint: job.descriptor.localFingerprint, authority: originalAuthority,
    ...(job.version===2?{conflictSelections}: {}) },job.version)
  const normalized = { ...plan, nextRemote: { manifest: plan.nextRemote.manifest, records: plan.nextRemote.records }, localFinal: { manifest: plan.localFinal.manifest, records: plan.localFinal.records } }
  if (!same(input.plan, normalized) || plan.planHash !== job.descriptor.planHash) return publicationInvalid('exchange原planner结果与不可变job不符。')
  if(job.version===2&&!same(plan.merges??[],job.merges))return publicationInvalid('原job merge来源与原inputs/plan不闭合。')
  const manifest = await read('manifest.json'), objects = new Map<string, Buffer>(), assets = new Map<string, Buffer>()
  if (publicationHash(manifest) !== job.descriptor.next.manifestHash || !same(decodePublicationJson(manifest), plan.nextRemote.manifest)) return publicationInvalid('exchange原Manifest bytes已变。')
  const objectNames = new Set<string>(), assetNames = new Set<string>()
  for (const item of job.descriptor.next.objects) { const bytes = await read(item.path); objectNames.add(item.hash + '.json')
    if (bytes.length !== item.bytes || publicationHash(bytes) !== item.hash) return publicationInvalid('exchange原object bytes已变。'); objects.set(item.key, bytes) }
  for (const item of job.descriptor.next.assets) { const bytes = await read(item.path); assetNames.add(item.hash)
    if (bytes.length !== item.bytes || publicationHash(bytes) !== item.hash) return publicationInvalid('exchange原asset bytes已变。'); assets.set(item.hash, bytes) }
  if (!same(sort(await readdir(join(dir, 'objects'))), sort(objectNames)) || !same(sort(await readdir(join(dir, 'assets'))), sort(assetNames))
    || !same(sort(await readdir(dir)), ['assets', 'inputs.json', 'job.json', 'manifest.json', 'objects', 'ready.json'].sort(publicationCompare))) return publicationInvalid('exchange原spool文件闭集不符。')
  phases(db, job)
  assertSyncedShape(input.keyGuards, Object.keys(originalAuthority.keyGuards ? Object.fromEntries(originalAuthority.keyGuards.map(row => [row.key, row.fingerprint])) : {}))
  const keyGuards: Record<string, string> = Object.create(null) as Record<string, string>
  for (const [key, value] of Object.entries(input.keyGuards)) { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) return publicationInvalid('exchange原key guard损坏。'); keyGuards[key] = value }
  if (input.stateRaw !== null && typeof input.stateRaw !== 'string') return publicationInvalid('exchange原state raw损坏。')
  return { directory: dir, job, plan, state, localFingerprint: job.descriptor.localFingerprint, manifest, records: plan.nextRemote.records, objects, assets,
    planning: { local, remote, baseRecords, authority: originalAuthority, keyGuards, stateRaw: input.stateRaw, engine:job.version,conflictSelections } }
}
function claim(db: Database.Database, c: Context, saved: Spool): boolean {
  return db.transaction(() => {
    current(db, c); const local = capture(db, c), d = saved.job.descriptor
    if (local.fingerprint !== saved.localFingerprint) return false
    const actual = new Map(local.snapshot.groups.map(group => [group.wire.id, group]))
    for (const member of d.members) { const group = actual.get(member.groupId)
      if (!group || group.wire.creationId !== member.creationId || group.revision !== member.revision || group.topologyRevision !== member.topologyRevision
        || group.semanticHash !== member.semanticHash || saved.plan.nextRemote.manifest.entries['group:' + member.groupId] !== member.nextPortableHash) return false }
    const digest = publicationHash(publicationJson(d)), requestHash = publicationHash(publicationJson({ method: 'exchangeSyncedSnapshot.publish', request: c.request, descriptor: d }))
    const old = db.prepare('SELECT request_hash,channel,target_fingerprint,publication_hash FROM synced_exposure_attempts WHERE id=?').get(saved.job.attemptId) as
      { request_hash: string; channel: string; target_fingerprint: string; publication_hash: string } | undefined
    if (old && (old.request_hash !== requestHash || old.channel !== 'webdav-manifest5-exchange' || old.target_fingerprint !== c.request.targetFingerprint || old.publication_hash !== digest)) return publicationInvalid('exchange原attempt事实冲突。')
    if (!old && d.members.length) {
      const now = new Date().toISOString()
      db.prepare("INSERT INTO synced_exposure_attempts(id,request_hash,channel,target_fingerprint,publication_hash,state,created_at,confirmed_at) VALUES(?,?,'webdav-manifest5-exchange',?,?,'possible',?,NULL)")
        .run(saved.job.attemptId, requestHash, c.request.targetFingerprint, digest, now)
      const insert = db.prepare('INSERT INTO synced_group_exposure_members(attempt_id,group_id,creation_id,revision,topology_revision,semantic_hash) VALUES(?,?,?,?,?,?)')
      for (const item of d.members) insert.run(saved.job.attemptId, item.groupId, item.creationId, item.revision, item.topologyRevision, item.semanticHash)
    }
    // With zero real local members only the private job has a possible phase. No ordinary empty exposure attempt is minted.
    if (old || d.members.length) {
      const members = db.prepare('SELECT group_id,creation_id,revision,topology_revision,semantic_hash FROM synced_group_exposure_members WHERE attempt_id=? ORDER BY group_id').all(saved.job.attemptId)
      if (!same(members, d.members.map(item => ({ group_id: item.groupId, creation_id: item.creationId, revision: item.revision, topology_revision: item.topologyRevision, semantic_hash: item.semanticHash })))) return publicationInvalid('exchange原attempt成员闭集不符。')
    }
    phase(db, saved.job, 'possible', null); return true
  }).immediate()
}
function confirm(db: Database.Database, c: Context, saved: Spool, etag: string): void {
  db.transaction(() => { current(db, c)
    const row = db.prepare('SELECT state FROM synced_exposure_attempts WHERE id=?').get(saved.job.attemptId) as { state: string } | undefined
    if (saved.job.descriptor.members.length && !row) return publicationInvalid('exchange确认缺原possible。')
    if (row?.state === 'possible') db.prepare("UPDATE synced_exposure_attempts SET state='confirmed',confirmed_at=? WHERE id=? AND state='possible'").run(new Date().toISOString(), saved.job.attemptId)
    phase(db, saved.job, 'remote-confirmed', etag)
  }).immediate()
}
function assetPath(c: Context, hash: string, name: string): string { return join(c.root, 'storage', 'assets', 'attachments', hash.slice(0, 2), hash, name) }
function fileUri(file: string): string { return pathToFileURL(file).href.replace(/[!'()*]/g, value => '%' + value.charCodeAt(0).toString(16).toUpperCase()) }
function verifyAliases(c: Context, assets: readonly PublicationAssetDescriptor[]): void {
  try { const attachments = new AttachmentStore(join(c.root, 'storage', 'assets'))
    for (const asset of assets) for (const name of asset.names) { const file = assetPath(c, asset.hash, name); safe(file, c.root)
      const checked = attachments.resolve(fileUri(file)), info = lstatSync(checked)
      if (!info.isFile() || info.size !== asset.bytes || publicationHash(readFileSync(checked)) !== asset.hash) throw new Error('exchange真实alias bytes缺失/改变。') }
  } catch (cause) { throw new SyncedPublicationError('asset', 'exchange逐alias原路径/bytes证明失败。', cause) }
}
function publishAliases(c: Context, saved: Spool): void {
  try {
    for (const asset of saved.job.descriptor.next.assets) for (const name of asset.names) { const destination = assetPath(c, asset.hash, name), parent = join(c.root, 'storage', 'assets', 'attachments', asset.hash.slice(0, 2), asset.hash)
      safe(parent, c.root); mkdirSync(parent, { recursive: true, mode: 0o700 }); safe(destination, c.root)
      try { linkSync(join(saved.directory, 'assets', asset.hash), destination) }
      catch (cause) { if (!cause || typeof cause !== 'object' || !('code' in cause) || cause.code !== 'EEXIST') throw cause }
    }
    verifyAliases(c, saved.job.descriptor.next.assets)
  } catch (cause) { if (cause instanceof SyncedPublicationError) throw cause; throw new SyncedPublicationError('asset', 'exchange无覆盖alias发布失败；安全orphan不删除。', cause) }
}
async function verifyLocalMaterial(db: Database.Database, c: Context, saved: Spool): Promise<boolean> {
  const handle = await materializeSyncedExchangeLocal(db, { userDataRoot: c.root, target: c.target }), value = readSyncedExchangeLocalMaterial(handle)
  if (!value) return false
  return capture(db, c).fingerprint === saved.localFingerprint && value.snapshot.localFingerprint === capture(db, c).snapshot.localFingerprint
}
async function publish(db: Database.Database, c: Context, saved: Spool, runtime: SyncedExchangeRuntime): Promise<{ status: 'confirmed'; etag: string } | { status: 'retry' } | { status: 'stale' }> {
  const client = new WebDavClient(c.target, runtime.password, runtime.signal), original = await network(() => client.getVersioned('manifest.json', PUBLICATION_RECORD_MAX_BYTES))
  if (original && publicationHash(original.bytes) === saved.job.descriptor.next.manifestHash) {
    // GET-only historical confirmation never becomes permission to send old bytes against new local state.
    const last = db.transaction(() => { current(db, c); return phases(db, saved.job).at(-1)! })()
    if (last.phase !== 'prepared') { confirm(db, c, saved, original.etag); return { status: 'confirmed', etag: original.etag } }
  }
  if (!original || publicationHash(original.bytes) !== saved.job.descriptor.expectedRemote.manifestHash || original.etag !== saved.job.descriptor.expectedRemote.etag) return { status: 'retry' }
  await network(() => client.test())
  if (!await verifyLocalMaterial(db, c, saved) || !claim(db, c, saved)) return { status: 'stale' }
  // A committed possible transition precedes every content HEAD/PUT, including temporary manifest paths.
  for (const asset of saved.job.descriptor.next.assets) {
    if (await network(() => client.exists(asset.path))) { const old = await network(() => client.get(asset.path, ATTACHMENT_MAX_FILE_BYTES))
      if (!old || old.bytes.length !== asset.bytes || publicationHash(old.bytes) !== asset.hash) return publicationInvalid('exchange远端asset缓存坏hash。') }
    else await network(() => client.put(asset.path, saved.assets.get(asset.hash)!))
  }
  for (const object of saved.job.descriptor.next.objects) {
    if (await network(() => client.exists(object.path))) { const old = await network(() => client.get(object.path, PUBLICATION_RECORD_MAX_BYTES))
      if (!old || old.bytes.length !== object.bytes || publicationHash(old.bytes) !== object.hash) return publicationInvalid('exchange远端object缓存坏hash。') }
    else await network(() => client.put(object.path, saved.objects.get(object.key)!))
  }
  if (!await verifyLocalMaterial(db, c, saved)) return { status: 'stale' }
  try { await client.put('manifest.json', saved.manifest, { etag: saved.job.descriptor.expectedRemote.etag }) }
  catch (cause) {
    db.transaction(() => { current(db, c); phase(db, saved.job, 'remote-uncertain', null) }).immediate()
    if (cause instanceof WebDavHttpError && cause.status === 412) return { status: 'retry' }
    try {
      const original = await network(() => client.getVersioned('manifest.json', PUBLICATION_RECORD_MAX_BYTES))
      if (original && publicationHash(original.bytes) === saved.job.descriptor.next.manifestHash) { confirm(db, c, saved, original.etag); return { status: 'confirmed', etag: original.etag } }
    } catch (queryFailure) { throw new SyncedPublicationError('transport', 'exchange落盘响应和原bytes只读确认都失败；原possible保留。', { cause, queryFailure }) }
    throw new SyncedPublicationError('transport', 'exchange Manifest响应不确定；原possible/job/spool保持，可原operation GET确认。', cause)
  }
  const readback = await network(() => client.getVersioned('manifest.json', PUBLICATION_RECORD_MAX_BYTES))
  if (!readback || publicationHash(readback.bytes) !== saved.job.descriptor.next.manifestHash) return { status: 'retry' }
  confirm(db, c, saved, readback.etag); return { status: 'confirmed', etag: readback.etag }
}
function documentPaths(records: readonly SyncedProtocol5Record[]): Map<string, string> {
  const docs = new Map(records.flatMap(record => record.kind === 'document' ? [[record.id, record] as const] : [])), result = new Map<string, string>(), used = new Set<string>(), siblings = new Set<string>()
  for (const doc of docs.values()) {
    if (doc.content.title !== doc.content.title.trim()) return publicationInvalid('exchange title不能被隐藏normalize。')
    const sibling = publicationJson([doc.parentId, doc.content.title.replace(/[A-Z]/g, value => value.toLowerCase())])
    if (siblings.has(sibling)) return publicationInvalid('exchange actual同parent NOCASE title冲突。'); siblings.add(sibling)
    if (result.has(doc.id)) continue
    const chain: string[] = [], seen = new Set<string>(); let next: string | null = doc.id
    while (next !== null && !result.has(next)) { if (seen.has(next) || !docs.has(next)) return publicationInvalid('exchange actual document graph不闭合。'); seen.add(next); chain.push(next); next = docs.get(next)!.parentId }
    let path = next === null ? '' : result.get(next)!
    for (let index = chain.length - 1; index >= 0; index--) { const item = docs.get(chain[index])!; path = path ? path + '/' + item.content.title : item.content.title
      if (used.has(path)) return publicationInvalid('exchange actual path重复。'); used.add(path); result.set(item.id, path) }
  }
  return result
}
function localRecords(saved: Spool, c: Context, local: SyncedExchangeLocal): InitialPublicationRecord[] {
  const catalog = local.snapshot.records.find((record): record is SyncDatabases => record.kind === 'databases'), row = catalog?.tables.databases.find(row => row.id === local.snapshot.catalogId)
  if (!row || typeof row.created_at !== 'string') return publicationInvalid('exchange本机default birth缺失。')
  const mapped: InitialPublicationRecord[] = saved.plan.localFinal.records.map(({ record }) => {
    if (record.kind === 'deleted' || record.kind === 'synced-group-deleted') return publicationInvalid('deferred tombstone不得流入本机应用。')
    const localize = (uri: string) => { const asset = parseSyncedPortableAssetUri(uri); return fileUri(assetPath(c, asset.hash, asset.name)) }
    return record.kind === 'synced-group' ? localizeSyncedPortableGroupAssets(record, localize) : record.kind === 'document' ? localizeSyncedPortableHostAssets(record, localize) : record
  })
  return inverseInitialIncomingCatalog(mapped, local.snapshot.catalogId, row.created_at)
}
function portableRecords(snapshot: ReturnType<typeof readSyncedPersistentPublicationSnapshot>, c: Context): InitialPublicationRecord[] {
  const toPortable = (uri: string): string => {
    if (!/^file:/i.test(uri)) { parseSyncedPortableAssetUri(uri); return uri }
    const file = resolve(fileURLToPath(uri)), parts = relative(join(c.root, 'storage', 'assets'), file).split(sep)
    if (parts.length !== 4 || parts[0] !== 'attachments' || !/^[a-f0-9]{64}$/.test(parts[2]) || parts[1] !== parts[2].slice(0, 2)
      || fileUri(file) !== uri || spelling(file) !== spelling(assetPath(c, parts[2], parts[3]))) return publicationInvalid('exchange actual file URI不属于规范managed mapping。')
    return buildSyncedPortableAssetUri({ hash: parts[2], name: parts[3] })
  }
  return mapPublicationCatalog(snapshot.records, snapshot.catalogId).map(record => record.kind === 'synced-group' ? rewriteSyncedGroupAssets(record, toPortable)
    : record.kind === 'document' ? rewriteSyncedPortableHostAssets(record, toPortable) : record)
}
type HistoryBoundaryEffects = { historyArchives: Array<{ groupId: string; indexHash: string }>; hostHistoryCuts: Array<{ historyToken: string; cutHash: string }> }
function historyBoundary(db: Database.Database, c: Context, plan: ExchangePlan, now: string): HistoryBoundaryEffects {
  const docs = new Set(plan.historyBoundaryKeys.filter(key => key.startsWith('doc:')).map(key => key.slice(4))), groups = plan.historyBoundaryKeys.filter(key => key.startsWith('group:')).map(key => key.slice(6))
  // Follow all mappings (executed and Redo) to a fixed point. Never strand the other half of AB/BC.
  const mappings = db.prepare('SELECT history_id,document_id,position FROM synced_host_history_documents').all() as Array<{ history_id: string; document_id: string; position: number }>
  const byDoc = new Map<string, string[]>(), byHistory = new Map<string, typeof mappings>()
  for (const row of mappings) { const a = byDoc.get(row.document_id) ?? []; a.push(row.history_id); byDoc.set(row.document_id, a)
    const b = byHistory.get(row.history_id) ?? []; b.push(row); byHistory.set(row.history_id, b) }
  const queue = [...docs], histories = new Set<string>()
  for (let offset = 0; offset < queue.length; offset++) for (const id of byDoc.get(queue[offset]) ?? []) if (!histories.has(id)) {
    histories.add(id); for (const participant of byHistory.get(id) ?? []) if (!docs.has(participant.document_id)) { docs.add(participant.document_id); queue.push(participant.document_id) }
  }
  const hostHistoryCuts: HistoryBoundaryEffects['hostHistoryCuts'] = []
  for (const id of [...histories].sort(publicationCompare)) {
    const journal = readSyncedExchangeCutJournal(db, id)
    const participants = (byHistory.get(id) ?? []).map(row => ({ documentId: row.document_id, position: row.position })).sort((a, b) => publicationCompare(a.documentId, b.documentId))
    if (!same(participants.map(item => item.documentId), journal.documentIds)) return publicationInvalid('exchange history cut原journal/实际完整mappings不闭合。')
    const cut = M.validateExchangeHostCut({ kind: 'synced-exchange-host-cut', version: 1, operationId: c.request.operationId,
      historyToken: id, journalHash: journal.journalHash, participants, cutAt: now })
    putImmutable(db, M.exchangeHostCutKey(id), cut, now)
    const removed = db.prepare('DELETE FROM synced_host_history_documents WHERE history_id=?').run(id)
    if (removed.changes !== participants.length) return publicationInvalid('exchange history cut未撤准确原映射闭集。')
    hostHistoryCuts.push({ historyToken: id, cutHash: publicationHash(publicationJson(cut)) })
  }
  for (const id of docs) db.prepare('INSERT INTO synced_host_history_state(document_id,cursor,position) VALUES(?,?,0) ON CONFLICT(document_id) DO UPDATE SET cursor=excluded.cursor,position=0').run(id, randomUUID())
  const result: Array<{ groupId: string; indexHash: string }> = []
  for (const groupId of groups) {
    const rows = db.prepare('SELECT id,group_id,position,before_json,after_json,before_hash,after_hash,created_at FROM synced_group_history WHERE group_id=? ORDER BY position').all(groupId) as Array<Record<string, unknown>>
    if (rows.length) {
      const indexRows: Array<{ id: string; hash: string }> = []
      for (const [index, row] of rows.entries()) {
        if (!isSyncedUuid(row.id) || row.position !== index + 1) return publicationInvalid('exchange不可归档损坏执行链。')
        const envelope = { kind: 'synced-exchange-history-row', version: 1, operationId: c.request.operationId, groupId, row, archivedAt: now }
        const hash = publicationHash(publicationJson(envelope)); indexRows.push({ id: row.id, hash })
        putImmutable(db, 'sync.webdav.protocol5.exchange-history-row.v1.' + c.request.operationId + '.' + groupId + '.' + row.id, envelope, now)
      }
      const index = { kind: 'synced-exchange-history-index', version: 1, operationId: c.request.operationId, groupId, rows: indexRows, archivedAt: now }
      const indexHash = publicationHash(publicationJson(index))
      putImmutable(db, 'sync.webdav.protocol5.exchange-history-index.v1.' + c.request.operationId + '.' + groupId, index, now); result.push({ groupId, indexHash })
      db.prepare('DELETE FROM synced_group_history WHERE group_id=?').run(groupId)
    }
    db.prepare('UPDATE synced_groups SET history_cursor=?,history_position=0 WHERE id=?').run(randomUUID(), groupId)
  }
  return { historyArchives: result.sort((a, b) => publicationCompare(a.groupId, b.groupId)), hostHistoryCuts }
}
function writeCatalog(db: Database.Database, record: SyncDatabases, catalogId: string, now: string): void {
  // Exact inverse of the typed sentinel projection. Query/config strings remain opaque.
  for (const table of [...SYNC_TABLES].reverse()) if (table !== 'databases') db.prepare('DELETE FROM ' + table).run()
  db.prepare('DELETE FROM databases WHERE id<>?').run(catalogId)
  for (const table of SYNC_TABLES) {
    const columns: readonly string[] = SYNC_TABLE_COLUMNS[table], updated = [...columns, 'updated_at']
    const insert = db.prepare('INSERT INTO ' + table + '(' + updated.join(',') + ') VALUES(' + updated.map(() => '?').join(',') + ')')
    for (const row of record.tables[table]) {
      if (table === 'databases' && row.id === catalogId) {
        if (db.prepare('UPDATE databases SET name=?,description=?,updated_at=? WHERE id=? AND created_at=?').run(row.name, row.description, now, row.id, row.created_at).changes !== 1) return publicationInvalid('exchange本机default identity/birth改变。')
      } else insert.run(...columns.map(column => row[column]), now)
    }
  }
}
function install(db: Database.Database, c: Context, saved: Spool, original: SyncedExchangeLocal, now: string): HistoryBoundaryEffects {
  const plan = saved.plan, records = localRecords(saved, c, original), paths = documentPaths(records), incoming = new Set(plan.incoming)
  const docs = records.filter(record => record.kind === 'document'), groups = records.filter(record => record.kind === 'synced-group')
  const changedDocs = docs.filter(doc => incoming.has('doc:' + doc.id)), changedGroups = groups.filter(group => incoming.has('group:' + group.id))
  const originalPaths = new Map((db.prepare('SELECT id,path FROM documents ORDER BY id').all() as Array<{ id: string; path: string }>).map(row => [row.id, row.path]))
  const accepted = new Set(plan.accepted)
  const routeDocs = docs.filter(doc => accepted.has('doc:' + doc.id) && (incoming.has('doc:' + doc.id) || originalPaths.get(doc.id) !== paths.get(doc.id)))
  const oldInstances = new Map((db.prepare('SELECT instance_id,group_id,host_document_id,binding_version,parent_block_id,depth FROM synced_instances ORDER BY instance_id').all() as
    Array<{ instance_id: string; group_id: string; host_document_id: string; binding_version: string; parent_block_id: string | null; depth: number }>).map(row => [row.instance_id, row]))
  const positions = new Map<string, { groupId: string; documentId: string; bindingVersion: string; parentBlockId: string | null; depth: number }>()
  for (const doc of docs) for (const block of doc.content.blocks) if (block.type === 'synced-block') {
    const groupId = parseSyncedBlockPayload(block.content).groupId, old = oldInstances.get(block.id)
    positions.set(block.id, { groupId, documentId: doc.id, parentBlockId: block.parentBlockId, depth: block.depth,
      bindingVersion: old && old.group_id === groupId && old.host_document_id === doc.id && old.parent_block_id === block.parentBlockId && old.depth === block.depth ? old.binding_version : randomUUID() })
  }
  const groupInstances = new Map<string, Array<{ instanceId: string; hostDocumentId: string; bindingVersion: string }>>()
  for (const [id, position] of positions) { const list = groupInstances.get(position.groupId) ?? []; list.push({ instanceId: id, hostDocumentId: position.documentId, bindingVersion: position.bindingVersion }); groupInstances.set(position.groupId, list) }
  for (const list of groupInstances.values()) list.sort((a, b) => publicationCompare(a.instanceId, b.instanceId))
  const oldGroups = new Map(original.snapshot.groups.map(group => [group.wire.id, group])), revisions = new Map<string, { revision: string; topology: string }>()
  const previousInstances = new Map<string, Array<{ instanceId: string; hostDocumentId: string; bindingVersion: string }>>()
  for (const row of oldInstances.values()) { const list = previousInstances.get(row.group_id) ?? []; list.push({ instanceId: row.instance_id, hostDocumentId: row.host_document_id, bindingVersion: row.binding_version }); previousInstances.set(row.group_id, list) }
  for (const list of previousInstances.values()) list.sort((a, b) => publicationCompare(a.instanceId, b.instanceId))
  for (const group of groups) {
    const old = oldGroups.get(group.id), before = previousInstances.get(group.id) ?? []
    revisions.set(group.id, { revision: incoming.has('group:' + group.id) ? randomUUID() : old?.revision ?? randomUUID(),
      topology: old && same(before, groupInstances.get(group.id) ?? []) ? old.topologyRevision : randomUUID() })
  }
  const archives = historyBoundary(db, c, plan, now)
  // Release every selected physical source before the private ledger owner/birth transition. FK/identity guards stay enabled.
  for (const doc of changedDocs) { db.prepare('DELETE FROM synced_instances WHERE host_document_id=?').run(doc.id); db.prepare('DELETE FROM blocks WHERE document_id=?').run(doc.id) }
  for (const group of changedGroups) db.prepare('DELETE FROM synced_group_blocks WHERE group_id=?').run(group.id)
  for (const transfer of plan.transfers) {
    const row = db.prepare('SELECT last_owner_kind,last_owner_id,state,created_at FROM block_identities WHERE id=?').get(transfer.id) as
      { last_owner_kind: string; last_owner_id: string; state: string; created_at: string | null } | undefined
    if (!row || row.state !== 'retained' || row.last_owner_kind !== transfer.fromKind || row.last_owner_id !== transfer.fromId || row.created_at !== transfer.fromCreatedAt
      || db.prepare('SELECT 1 FROM blocks WHERE id=? UNION ALL SELECT 1 FROM synced_group_blocks WHERE id=?').get(transfer.id, transfer.id)) return publicationInvalid('exchange成对来源未完全释放/原birth改变。')
    if (db.prepare("UPDATE block_identities SET last_owner_kind=?,last_owner_id=?,created_at=? WHERE id=? AND state='retained'").run(transfer.toKind, transfer.toId, transfer.toCreatedAt, transfer.id).changes !== 1) return publicationInvalid('exchange私有ledger转域未原子闭合。')
  }
  for (const doc of [...changedDocs].sort((a, b) => paths.get(a.id)!.split('/').length - paths.get(b.id)!.split('/').length || publicationCompare(a.id, b.id))) {
    const old = db.prepare('SELECT id FROM documents WHERE id=?').get(doc.id)
    if (old) db.prepare('UPDATE documents SET title=?,parent_id=?,path=?,summary=?,sort_order=?,created_at=?,updated_at=? WHERE id=?').run(doc.content.title, doc.parentId, paths.get(doc.id), doc.content.summary, doc.sortOrder, doc.createdAt, now, doc.id)
    else { db.prepare('INSERT INTO documents(id,title,slug,parent_id,path,summary,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(doc.id, doc.content.title, 'doc-' + doc.id, doc.parentId, paths.get(doc.id), doc.content.summary, doc.sortOrder, doc.createdAt, now)
      db.prepare('INSERT OR IGNORE INTO synced_host_history_state(document_id,cursor,position) VALUES(?,?,0)').run(doc.id, randomUUID()) }
  }
  // Parent rename paths affect descendants even when their portable content is unchanged.
  for (const doc of docs) db.prepare('UPDATE documents SET path=? WHERE id=? AND path<>?').run(paths.get(doc.id), doc.id, paths.get(doc.id))
  for (const group of groups) {
    const version = revisions.get(group.id)!, old = oldGroups.get(group.id)
    if (!old) {
      db.prepare('INSERT INTO synced_groups(id,creation_id,created_at,origin_json,bindings_json,revision,topology_revision,history_cursor,history_position) VALUES(?,?,?,?,?,?,?,?,0)')
        .run(group.id, group.creationId, group.createdAt, publicationJson(group.origin), publicationJson(group.bindings), version.revision, version.topology, randomUUID())
      db.prepare("INSERT INTO synced_group_lifecycle(group_id,creation_id,state,state_version,exposure_state,create_history_id,activation_revision,activation_topology_revision,activation_hash,activation_instances_json,created_at,updated_at) VALUES(?,?,'active',1,'unknown',NULL,?,?,?,?,?,?)")
        .run(group.id, group.creationId, version.revision, version.topology, syncedLifecycleSemanticHash(group), publicationJson(groupInstances.get(group.id) ?? []), now, now)
    } else if (incoming.has('group:' + group.id) || old.topologyRevision !== version.topology) db.prepare('UPDATE synced_groups SET bindings_json=?,revision=?,topology_revision=? WHERE id=?').run(publicationJson(group.bindings), version.revision, version.topology, group.id)
  }
  const insertCanonical = db.prepare('INSERT INTO synced_group_blocks(id,group_id,parent_block_id,sort_order,type,content,checked,depth,tags_json,language,list_start,markdown_format_json,highlight,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  for (const group of changedGroups) group.blocks.forEach((block, index) => insertCanonical.run(block.id, group.id, block.parentBlockId, index, block.type, block.content, block.checked ? 1 : 0, block.depth,
    block.tags === undefined ? null : publicationJson(block.tags), block.language ?? null, block.listStart ?? null, block.markdownFormat === undefined ? null : publicationJson(block.markdownFormat), block.highlight ?? null, block.createdAt))
  const insertBlock = db.prepare('INSERT INTO blocks(id,document_id,parent_block_id,sort_order,type,content,checked,depth,tags_json,language,list_start,markdown_format_json,highlight,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  for (const doc of changedDocs) {
    for (const [index, block] of doc.content.blocks.entries()) {
      const old = db.prepare('SELECT last_owner_kind,last_owner_id,created_at,state FROM block_identities WHERE id=?').get(block.id) as { last_owner_kind: string; last_owner_id: string; created_at: string | null; state: string } | undefined
      if (old && (old.last_owner_kind !== 'document' || old.last_owner_id !== doc.id || !old.created_at || old.state !== 'retained')) return publicationInvalid('exchange普通块旧owner/birth不能猜。')
      insertBlock.run(block.id, doc.id, block.parentBlockId, index, block.type, block.content, block.checked ? 1 : 0, block.depth, publicationJson(block.tags ?? []), block.language ?? null, block.listStart ?? null,
        block.markdownFormat === undefined ? null : publicationJson(block.markdownFormat), block.highlight ?? null, old?.created_at ?? now, now)
      const p = positions.get(block.id)
      if (p) db.prepare('INSERT INTO synced_instances(instance_id,group_id,host_document_id,binding_version,parent_block_id,depth) VALUES(?,?,?,?,?,?)').run(block.id, p.groupId, p.documentId, p.bindingVersion, p.parentBlockId, p.depth)
    }
  }
  // Register only real accepted incoming writes or accepted path transitions; a deferred host is not a route repair target.
  // Read back the actual final SQL host/path/physical IDs rather than using planner facts as persistence authority.
  const routeIds = JSON.stringify(routeDocs.map(doc => doc.id))
  const actualRoutePaths = new Map((db.prepare('SELECT id,path FROM documents WHERE id IN (SELECT value FROM json_each(?))').all(routeIds) as Array<{ id: string; path: string }>).map(row => [row.id, row.path]))
  const actualRouteBlocks = new Map<string, string[]>()
  for (const row of db.prepare('SELECT id,document_id FROM blocks WHERE document_id IN (SELECT value FROM json_each(?)) ORDER BY document_id,sort_order').all(routeIds) as Array<{ id: string; document_id: string }>) {
    const ids = actualRouteBlocks.get(row.document_id) ?? []; ids.push(row.id); actualRouteBlocks.set(row.document_id, ids)
  }
  if (actualRoutePaths.size !== routeDocs.length) return publicationInvalid('exchange route 目标缺实际最终宿主。')
  for (const doc of routeDocs) {
    const actualPath = actualRoutePaths.get(doc.id), actualIds = actualRouteBlocks.get(doc.id) ?? []
    if (actualPath !== paths.get(doc.id) || !same(actualIds, doc.content.blocks.map(block => block.id))) return publicationInvalid('exchange route 最终 SQL path/物理块闭集不符。')
    for (const id of actualIds) db.prepare('INSERT OR IGNORE INTO document_block_routes(document_path,block_id) VALUES(?,?)').run(actualPath, id)
  }
  // Missing typed block targets reserve their stable IDs; this is denial-only and cannot be used to create a physical block.
  for (const group of changedGroups) for (const binding of group.bindings) if (binding.target.kind === 'block'
    && !db.prepare('SELECT 1 FROM block_identities WHERE id=?').get(binding.target.id)) {
    const sourceKey = 'sync.webdav.protocol5.exchange-reservation.v1.' + c.request.operationId
    db.prepare("INSERT INTO block_identities(id,last_owner_kind,last_owner_id,state,created_at) VALUES(?,'reserved',?,'retained',NULL)").run(binding.target.id, sourceKey)
  }
  if (incoming.has('databases')) writeCatalog(db, records.find((record): record is SyncDatabases => record.kind === 'databases')!, original.snapshot.catalogId, now)
  for (const group of groups) assertSyncedStoredBindings(db, group.origin, group.blocks, group.bindings)
  const index = new MarkdownLinkIndex(db)
  for (const doc of docs) index.syncDocument(doc.id)
  // Derived links are rebuilt from the same real parser index; no Store healer or rewritten title/URL authority is used.
  db.prepare('DELETE FROM links').run()
  const links = db.prepare(`SELECT DISTINCT source.source_document_id,target.id AS target_id,source.url FROM markdown_link_sources source JOIN documents target ON target.path=source.target_path
    WHERE source.kind IN ('wiki','wiki-heading') OR target.id<>source.source_document_id`).all() as Array<{ source_document_id: string; target_id: string; url: string }>
  for (const link of links) db.prepare('INSERT INTO links(id,source_document_id,target_document_id,label,created_at) VALUES(?,?,?,?,?)').run(randomUUID(), link.source_document_id, link.target_id, link.url, now)
  if (db.prepare(`SELECT 1 FROM documents d WHERE d.block_count<>(SELECT count(*) FROM blocks WHERE document_id=d.id)
    OR d.link_count<>(SELECT count(*) FROM links WHERE source_document_id=d.id) OR d.child_count<>(SELECT count(*) FROM documents WHERE parent_id=d.id) LIMIT 1`).get()) return publicationInvalid('exchange实际stats不完整。')
  const actual = wire(portableRecords(readSyncedPersistentPublicationSnapshot(db), c), c.workspaceScope)
  if (!same(actual.manifest.entries, plan.localFinal.manifest.entries) || !same(actual.manifest.syncedInstances, plan.localFinal.manifest.syncedInstances)) return publicationInvalid('exchange actual SQL→portable全图/hash/Key未精确闭合。')
  return archives
}
function settle(db: Database.Database, c: Context, saved: Spool, etag: string): M.SyncedExchangeAccepted | null {
  return db.transaction(() => {
    current(db, c)
    const replay = readSyncedExchangeReceipt(db, c.request); if (replay) return { ...replay.result, replayed: true }
    const local = capture(db, c)
    if (local.fingerprint !== saved.localFingerprint || local.stateRaw !== saved.planning.stateRaw) return null
    const actualLocal = wire(portableRecords(local.snapshot, c), c.workspaceScope)
    const checked = makePlan({ operationId: c.request.operationId, local: actualLocal, remote: saved.planning.remote,
      baseRecords: saved.planning.baseRecords, state: saved.state, localFingerprint: local.fingerprint,
      authority: authority(local, saved.planning.authority.missingBaseKeys, saved.planning.authority.deferredKeys),
      ...(saved.job.version===2?{conflictSelections:saved.planning.conflictSelections}: {}) },saved.job.version)
    if (checked.planHash !== saved.plan.planHash || !same(checked.localFinal.manifest.entries, saved.plan.localFinal.manifest.entries)
      || !same(checked.nextRemote.manifest.entries, saved.plan.nextRemote.manifest.entries)) return publicationInvalid('exchange最后owned SQL全图planner复核不闭合。')
    const now = new Date().toISOString(), historyEffects = checked.incoming.length ? install(db, c, saved, local, now) : { historyArchives: [], hostHistoryCuts: [] }
    const result = M.validateExchangeAccepted({ status: checked.writes.length || checked.incoming.length ? 'applied' : checked.deferred.length ? 'deferred' : 'noop',
      operationId: c.request.operationId, replayed: false, workspaceScope: c.workspaceScope, recoveryEpoch: c.recoveryEpoch,
      remoteWorkspaceId: saved.job.remoteWorkspaceId, beforeManifestHash: checked.beforeManifestHash, afterManifestHash: checked.afterManifestHash,
      publishedKeys: checked.writes, appliedKeys: checked.incoming, acceptedKeys: checked.accepted, deferred: checked.deferred, acceptedAt: now })
    const state = M.validateExchangeState({ ...saved.state, currentOperationId: c.request.operationId, generation: randomUUID(), baseline: checked.nextBaseline, deferred: checked.deferred, lastSyncAt: now })
    const receipt = M.validateExchangeReceipt({ kind: 'synced-exchange-operation', version: saved.job.version, request: c.request, result, provenance: {
      beforeManifestHash: result.beforeManifestHash, afterManifestHash: result.afterManifestHash, beforeManifestEtag: saved.job.descriptor.expectedRemote.etag,
      afterManifestEtag: etag, planHash: checked.planHash, source: saved.state.source, accepted: checked.acceptedSides, transfers: checked.transfers, historyArchives: historyEffects.historyArchives,
      hostHistoryCuts: historyEffects.hostHistoryCuts,
      afterStateHash: publicationHash(publicationJson(state)),
      ...(saved.job.version===2?{plannerVersion:'conflicts-v1',resolution:saved.job.resolution,merges:checked.merges??[],attemptId:saved.job.attemptId}: {}) } })
    db.prepare('INSERT INTO synced_operations(client_operation_id,request_hash,result_json,created_at) VALUES(?,?,?,?)')
      .run(c.request.operationId, M.exchangeRequestHash(c.request), publicationJson(receipt), now)
    // Baseline is the last knowledge write, in the very same transaction as actual graph/owner/history and exact receipt.
    db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
      .run(M.exchangeStateKey(c.request.targetFingerprint), publicationJson(state), now)
    phase(db, saved.job, 'settled', etag)
    readSyncedExchangeLocal(db, { request: c.request, initialTargetFingerprint: c.initialTargetFingerprint })
    return receipt.result
  }).immediate()
}
function changedKeys(before: Record<string, string>, after: Record<string, string>): string[] {
  return sort([...Object.keys(before), ...Object.keys(after)].filter(key => before[key] !== after[key]))
}
function readSelections(value: unknown, request: M.ExchangeRequest): NonNullable<ExchangePlanInput['conflictSelections']> {
  M.assertExchangeData(value)
  if(!Array.isArray(value))return publicationInvalid('原component selectors不是数组。')
  const selections=value.map(row=>{assertSyncedShape(row,['preview','decision'])
    const preview=C.validateConflictPreviewComponent(row.preview), decisions=C.validateConflictDecisions([row.decision])
    if(decisions[0].componentId!==preview.componentId)return publicationInvalid('selector与原component身份不等。')
    return {preview,decision:decisions[0]} })
  const decisions=C.validateConflictDecisions(selections.map(row=>row.decision))
  if(request.method==='exchangeSyncedSnapshot' ? decisions.length!==0 : !same(decisions,request.decisions)) return publicationInvalid('原inputs selectors与完整request不闭合。')
  return selections
}
function previewDirectory(c: Context, previewId: string): string { return join(c.root,'storage','synced-exchange-previews-v1',previewId) }
type StoredPreview = {index:C.ConflictPreviewIndex;facts:C.SyncedExchangeConflictPreview}
async function loadPreview(db:Database.Database,c:Context,previewId:string):Promise<StoredPreview|null> {
  const index=db.transaction(()=>{current(db,c);return readSyncedExchangeConflictPreviewIndex(db,previewId,c.request)})()
  if(!index)return null
  if(index.workspaceScope!==c.workspaceScope||index.recoveryEpoch!==c.recoveryEpoch)return unavailable('原preview属于另一scope/recovery世代。')
  const dir=previewDirectory(c,previewId),file=join(dir,'preview.json');safe(dir,c.root);safe(file,dir)
  if(!lstatSync(file).isFile())return publicationInvalid('原preview不是私有regular file。')
  const bytes=await readFile(file)
  if(publicationHash(bytes)!==index.previewHash)return publicationInvalid('原preview bytes/index hash不闭合。')
  const value=M.parseExchangeStored(bytes.toString('utf8'))
  assertSyncedShape(value,['kind','version','previewId','databasePath','target','workspaceScope','recoveryEpoch','remoteWorkspaceId','stateGeneration','remoteManifestHash','remoteEtag','createdAt','local','remote','baseRecords','state','authority','keyGuards','stateRaw','localFingerprint','components'])
  if(value.kind!=='synced-exchange-conflict-preview-inputs'||value.version!==1||value.previewId!==previewId
    ||value.databasePath!==c.databasePath||!same(value.target,c.target)||value.workspaceScope!==index.workspaceScope||value.recoveryEpoch!==index.recoveryEpoch
    ||value.createdAt!==index.createdAt||typeof value.remoteEtag!=='string') return publicationInvalid('原preview私有来源损坏。')
  const facts=C.validateConflictPreview({kind:'synced-exchange-conflict-preview',version:1,previewId,previewHash:index.previewHash,
    workspaceScope:value.workspaceScope,recoveryEpoch:value.recoveryEpoch,remoteWorkspaceId:value.remoteWorkspaceId,targetFingerprint:index.targetFingerprint,
    stateGeneration:value.stateGeneration,remoteManifestHash:value.remoteManifestHash,createdAt:value.createdAt,components:value.components})
  const strictSnapshot=(raw:unknown):SyncedProtocol5Snapshot=>{
    assertSyncedShape(raw,['manifest','records'])
    if(!Array.isArray(raw.records))return publicationInvalid('preview snapshot records无效。')
    return validateSyncedProtocol5Snapshot(raw.manifest,raw.records.map(row=>{assertSyncedShape(row,['key','hash','record'])
      if(typeof row.key!=='string'||row.hash!==publicationHash(publicationJson(row.record)))return publicationInvalid('preview原record hash损坏。')
      return {key:row.key,record:row.record}}))
  }
  const local=strictSnapshot(value.local),remote=strictSnapshot(value.remote),state=M.validateExchangeState(value.state)
  if(typeof value.localFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(value.localFingerprint)||!Array.isArray(value.baseRecords)
    ||state.workspaceScope!==c.workspaceScope||state.recoveryEpoch!==c.recoveryEpoch||state.generation!==facts.stateGeneration
    ||remote.manifest.workspaceId!==facts.remoteWorkspaceId||publicationHash(publicationJson(remote.manifest))!==facts.remoteManifestHash)
    return publicationInvalid('preview原B/scope/remote manifest来源损坏。')
  const baseRecords=value.baseRecords.map(raw=>{assertSyncedShape(raw,['key','hash','record'])
    if(typeof raw.key!=='string'||typeof raw.hash!=='string')return publicationInvalid('preview原B key/hash损坏。')
    return {key:raw.key,hash:raw.hash,record:validateSyncedProtocol5Record(raw.record,raw.key)}})
  assertSyncedShape(value.authority,['catalogId','identities','occupiedDocumentIds','historyComponents','pinnedGroupIds','knownGroupIds','missingBaseKeys','deferredKeys'],['keyGuards'])
  const originalAuthority=value.authority as unknown as ReturnType<typeof authority>
  const checked=planSyncedExchange({operationId:previewId,local,remote,baseRecords,state,localFingerprint:value.localFingerprint,authority:originalAuthority})
  if(!same(checked.conflictPreviews??[],facts.components))return publicationInvalid('preview原展示和真实原plan不闭合。')
  // Re-read the exact immutable DB index after file awaits; it is a denial guard, not new authority.
  const final=db.transaction(()=>{current(db,c);return readSyncedExchangeConflictPreviewIndex(db,previewId,c.request)})()
  if(!same(final,index))return publicationInvalid('读取preview期间原index被删除/改写。')
  return {index,facts}
}
async function attachPreview(db:Database.Database,c:Context,request:M.ExchangeResolveRequest):Promise<void> {
  const loaded=await loadPreview(db,c,request.previewId)
  if(!loaded)return unavailable('resolve缺真实Main原preview。')
  const components=new Map(loaded.facts.components.map(row=>[row.componentId,row]))
  c.selections=request.decisions.map(decision=>{
    const preview=components.get(decision.componentId)
    if(!preview||!preview.choices.includes(decision.choice))return publicationInvalid('决定不在真实preview的可执行闭集。')
    if(decision.choice==='merge') {
      const required=preview.records.filter(row=>row.merge&&row.merge.unresolved.length>0)
      if(!same(required.map(row=>row.key),decision.records.map(row=>row.key)))return publicationInvalid('merge records必须精确对应原unresolved。')
      for(let i=0;i<required.length;i++) {
        const parts=[...required[i].merge!.unresolved].sort((a,b)=>publicationCompare(a.id,b.id)),selected=decision.records[i].parts
        if(!same(parts.map(row=>row.id),selected.map(row=>row.id)))return publicationInvalid('merge parts未完整解决或有额外part。')
        for(let j=0;j<parts.length;j++)if(selected[j].value.choice==='custom'&&!parts[j].canEditText)return publicationInvalid('原part不允许custom。')
      }
    }
    return {preview,decision}
  })
  c.resolution={previewId:request.previewId,previewHash:loaded.index.previewHash,decisionsHash:C.conflictDecisionsHash(request.decisions)}
}
async function createPreview(db:Database.Database,c:Context,previewId:string,runtime:SyncedExchangeRuntime):Promise<C.SyncedExchangeConflictPreviewResult> {
  if(db.pragma('user_version',{simple:true})===26)return Object.freeze({status:'unsupported',reason:'schema-27-required'})
  if(db.pragma('user_version',{simple:true})!==27)return publicationInvalid('preview不接受未知/未来schema。')
  const existing=await loadPreview(db,c,previewId)
  if(existing)return frozenPublicationFacts({status:'ready',preview:existing.facts})
  const prepared=await prepare(db,c,runtime)
  if(!('plan'in prepared)) {
    if(prepared.status==='missing'||prepared.status==='unsupported'||prepared.status==='stale')return frozenPublicationFacts(prepared)
    return publicationInvalid('preview不接受exchange结果冒充读取结果。')
  }
  const now=new Date().toISOString(),dir=previewDirectory(c,previewId)
  const payload={kind:'synced-exchange-conflict-preview-inputs',version:1,previewId,databasePath:c.databasePath,target:c.target,
    workspaceScope:c.workspaceScope,recoveryEpoch:c.recoveryEpoch,remoteWorkspaceId:prepared.remote.manifest.workspaceId,stateGeneration:prepared.state.generation,
    remoteManifestHash:prepared.remote.manifestHash,remoteEtag:prepared.remote.manifestEtag,createdAt:now,
    local:{manifest:prepared.localWire.manifest,records:prepared.localWire.records},remote:{manifest:prepared.remote.manifest,records:fromRemote(prepared.remote).records},
    baseRecords:prepared.baseRecords,state:prepared.state,authority:prepared.planningAuthority,keyGuards:prepared.local.keyGuards,stateRaw:prepared.local.stateRaw,localFingerprint:prepared.local.fingerprint,
    components:prepared.plan.conflictPreviews??[]}
  const bytes=Buffer.from(publicationJson(payload)),previewHash=publicationHash(bytes)
  const index=C.validateConflictPreviewIndex({kind:'synced-exchange-conflict-preview-index',version:1,previewId,databasePath:c.databasePath,
    targetFingerprint:c.request.targetFingerprint,workspaceScope:c.workspaceScope,recoveryEpoch:c.recoveryEpoch,previewHash,createdAt:now})
  const facts=C.validateConflictPreview({kind:'synced-exchange-conflict-preview',version:1,previewId,previewHash,workspaceScope:c.workspaceScope,
    recoveryEpoch:c.recoveryEpoch,remoteWorkspaceId:prepared.remote.manifest.workspaceId,targetFingerprint:c.request.targetFingerprint,
    stateGeneration:prepared.state.generation,remoteManifestHash:prepared.remote.manifestHash,createdAt:now,components:payload.components})
  safe(dir,c.root);await mkdir(join(c.root,'storage','synced-exchange-previews-v1'),{recursive:true,mode:0o700});safe(dir,c.root)
  await mkdir(dir,{mode:0o700});safe(dir,c.root);await durable(join(dir,'preview.json'),bytes);await syncDirectory(dir)
  const installed=db.transaction(()=>{current(db,c)
    if(capture(db,c).fingerprint!==prepared.local.fingerprint)return false
    putImmutable(db,C.conflictPreviewKey(previewId),index,now);return true
  }).immediate()
  if(!installed)return Object.freeze({status:'stale',side:'local'})
  return frozenPublicationFacts({status:'ready',preview:facts})
}
async function run(db: Database.Database, c: Context, runtime: SyncedExchangeRuntime): Promise<M.SyncedExchangeResult> {
  const replay = db.transaction(() => readSyncedExchangeReceipt(db, c.request))()
  if (replay) return frozenPublicationFacts({ ...replay.result, replayed: true })
  if (db.pragma('user_version', { simple: true }) === 26) return Object.freeze({ status: 'unsupported', reason: 'schema-27-required' })
  if (db.pragma('user_version', { simple: true }) !== 27) return publicationInvalid('exchange未知/未来schema不是普通unsupported。')
  const first = capture(db, c), originalGuards = first.keyGuards
  let deferredKeys: string[] = [], head = db.transaction(() => readHead(db, c))(), saved: Spool | null = head ? await loadSpool(db, c, head) : null
  const engine=saved?.job.version??2
  if(saved&&engine===2) {c.resolution=saved.job.resolution??null;c.selections=saved.planning.conflictSelections}
  else if(c.request.method==='resolveSyncedExchangeConflicts') await attachPreview(db,c,c.request)
  // A bounded set of real competing snapshots; each retry gets a new immutable attempt and fresh original ETag.
  for (let turn = 0; turn < 8; turn++) {
    aborted(runtime.signal)
    if (!saved) {
      const prepared = await prepare(db, c, runtime, deferredKeys,engine)
      if (!('plan' in prepared)) {
        if (prepared.status === 'stale' && prepared.side === 'local') { deferredKeys = sort([...deferredKeys, ...changedKeys(originalGuards, capture(db, c).keyGuards)]); continue }
        return frozenPublicationFacts(prepared)
      }
      const raced = changedKeys(originalGuards, prepared.local.keyGuards)
      if (raced.some(key => !deferredKeys.includes(key))) { deferredKeys = sort([...deferredKeys, ...raced]); continue }
      saved = await spool(prepared, head)
      if (!registerJob(db, c, saved, head)) { saved = null; deferredKeys = sort([...deferredKeys, ...changedKeys(originalGuards, capture(db, c).keyGuards)]); head = db.transaction(() => readHead(db, c))(); continue }
      head = db.transaction(() => readHead(db, c))()
    }
    current(db, c)
    const now = capture(db, c)
    if (now.fingerprint !== saved.localFingerprint) {
      deferredKeys = sort([...deferredKeys, ...changedKeys(saved.planning.keyGuards, now.keyGuards)]); saved = null; continue
    }
    let remote: { status: 'confirmed'; etag: string } | { status: 'retry' } | { status: 'stale' }
    if (!saved.plan.writes.length) {
      const client = new WebDavClient(c.target, runtime.password, runtime.signal), actual = await network(() => client.getVersioned('manifest.json', PUBLICATION_RECORD_MAX_BYTES))
      if (!actual || publicationHash(actual.bytes) !== saved.job.descriptor.expectedRemote.manifestHash || actual.etag !== saved.job.descriptor.expectedRemote.etag) remote = { status: 'retry' }
      else remote = { status: 'confirmed', etag: actual.etag }
    } else remote = await publish(db, c, saved, runtime)
    if (remote.status !== 'confirmed') {
      if (remote.status === 'stale') deferredKeys = sort([...deferredKeys, ...changedKeys(saved.planning.keyGuards, capture(db, c).keyGuards)])
      saved = null; continue
    }
    aborted(runtime.signal)
    publishAliases(c, saved)
    // No await between final alias/current guard and the owned IMMEDIATE transaction.
    verifyAliases(c, saved.job.descriptor.next.assets)
    let settled: M.SyncedExchangeAccepted | null
    try { settled = settle(db, c, saved, remote.etag) }
    catch (cause) {
      try { db.transaction(() => { current(db, c); phase(db, saved!.job, 'published-local-deferred', remote.etag) }).immediate() }
      catch (recording) { throw new SyncedPublicationError('database', 'exchange远端事实已存在；本机事务和deferred记录失败，原job/bytes保持。', { cause, recording }) }
      throw cause instanceof SyncedPublicationError ? cause : new SyncedPublicationError('database', 'exchange远端已成功但本机SQL失败；baseline未推进，原job可重开收敛。', cause)
    }
    if (settled) return frozenPublicationFacts(settled)
    db.transaction(() => { current(db, c); phase(db, saved!.job, 'published-local-deferred', remote.etag) }).immediate()
    deferredKeys = sort([...deferredKeys, ...changedKeys(saved.planning.keyGuards, capture(db, c).keyGuards)]); saved = null
  }
  return Object.freeze({ status: 'stale', side: 'remote' })
}
/** Main-only real full5 exchange. No caller record/facts/transport or raw apply authority is accepted. */
export async function exchangeSyncedSnapshot(db: Database.Database, input: SyncedExchangeInput, options: SyncedExchangeRuntime): Promise<M.SyncedExchangeResult> {
  let c: Context | null = null, key: string | null = null, ownsRunning = false
  try {
    c = context(db, input); const runtime = credentials(options); connections.set(c, db)
    key = publicationJson([c.databasePath, c.workspaceScope, c.recoveryEpoch, c.request.targetFingerprint])
    if (running.has(key)) return unavailable('同一真实本机/target已有exchange在途。')
    running.add(key); ownsRunning = true
    return await run(db, c, runtime)
  } catch (cause) {
    if (cause instanceof SyncedPublicationError) throw cause
    const code = cause instanceof Error && /SQLITE|sqlite|database|constraint|trigger|exchange exact late receipt/i.test(cause.message) ? 'database' : 'invalid'
    throw new SyncedPublicationError(code, 'Main-only exchange失败；原possible/job与远端事实不会回滚。', cause)
  } finally { if (key && ownsRunning) running.delete(key); if (c) connections.delete(c) }
}
/** Main creates and retains the original preview; selectors are never a caller-supplied forest. */
export async function previewSyncedExchangeConflicts(db:Database.Database,input:SyncedExchangeConflictPreviewInput,options:SyncedExchangeRuntime):Promise<C.SyncedExchangeConflictPreviewResult> {
  let c:Context|null=null,key:string|null=null,owns=false
  try {
    M.assertExchangeData(input);assertSyncedShape(input,['previewId','userDataRoot','target'])
    if(!isSyncedUuid(input.previewId))return publicationInvalid('previewId不是UUID。')
    c=context(db,{operationId:input.previewId,userDataRoot:input.userDataRoot,target:input.target});const runtime=credentials(options);connections.set(c,db)
    key=publicationJson([c.databasePath,c.workspaceScope,c.recoveryEpoch,c.request.targetFingerprint])
    if(running.has(key))return unavailable('同一真实本机/target已有exchange/preview在途。')
    running.add(key);owns=true
    return await createPreview(db,c,input.previewId,runtime)
  }catch(cause){if(cause instanceof SyncedPublicationError)throw cause
    throw new SyncedPublicationError(cause instanceof Error&&/SQLITE|sqlite|database|constraint|trigger/i.test(cause.message)?'database':'invalid','真实冲突preview失败；曝光事实保持。',cause)}
  finally{if(key&&owns)running.delete(key);if(c)connections.delete(c)}
}
export async function resolveSyncedExchangeConflicts(db:Database.Database,input:SyncedExchangeConflictResolveInput,options:SyncedExchangeRuntime):Promise<M.SyncedExchangeResult> {
  let c:Context|null=null,key:string|null=null,owns=false
  try {
    M.assertExchangeData(input);assertSyncedShape(input,['operationId','userDataRoot','target','previewId','decisions'])
    const decisions=C.validateConflictDecisions(input.decisions)
    c=context(db,{operationId:input.operationId,userDataRoot:input.userDataRoot,target:input.target})
    c.request=M.validateExchangeRequest({...c.request,method:'resolveSyncedExchangeConflicts',previewId:input.previewId,decisions})
    const runtime=credentials(options);connections.set(c,db)
    key=publicationJson([c.databasePath,c.workspaceScope,c.recoveryEpoch,c.request.targetFingerprint])
    if(running.has(key))return unavailable('同一真实本机/target已有exchange/resolve在途。')
    running.add(key);owns=true
    return await run(db,c,runtime)
  }catch(cause){if(cause instanceof SyncedPublicationError)throw cause
    throw new SyncedPublicationError(cause instanceof Error&&/SQLITE|sqlite|database|constraint|trigger|exchange exact late receipt/i.test(cause.message)?'database':'invalid','真实冲突resolve失败；原job/possible保持。',cause)}
  finally{if(key&&owns)running.delete(key);if(c)connections.delete(c)}
}
