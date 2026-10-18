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
import { captureSyncedExchangeDocumentLinks, collectSyncedBindingOccurrences, assertSyncedStoredBindings } from '../database/synced-block-links'
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
import * as K from './synced-exchange-knowledge-model'
import * as DC from './synced-exchange-deletion-choice-model'
import { planSyncedDeletionChoices, planSyncedDeletionChoicesFromSource } from './synced-exchange-deletion-choice-plan'
import { validateSyncedLogicalDeletionChoiceProof, logicalDeletionChoiceRequestHash, logicalDeletionChoiceProofReference, type DeletionChoiceIntent } from './synced-logical-deletion-choice-model'
import { readDeletionChoicePreviewIndex, validateDeletionChoicePreviewIndex, deletionChoicePreviewKey, type DeletionChoicePreviewIndex } from '../database/synced-exchange-deletion-choice-read'
import { planSyncedKnowledgeConflicts, planSyncedKnowledgeForks, deriveKnowledgeBothComponents } from './synced-exchange-knowledge-plan'
import { readKnowledgePreviewIndex, validateKnowledgePreviewIndex, knowledgePreviewKey, type KnowledgePreviewIndex, type KnowledgePreviewMode } from '../database/synced-exchange-knowledge-read'
import { planSyncedExchange, planSyncedExchangeV1, deriveSyncedExchangeDependencyFacts, type ExchangePlan, type ExchangePlanInput } from './synced-exchange-plan'
import * as C from './synced-exchange-conflict-model'
import * as B from './synced-exchange-both-model'
import type * as T from './synced-exchange-both-types'
import { deriveBothComponents, planSyncedBothExchange, type BothExchangePlan } from './synced-exchange-both-plan'
import { describeSyncedBothComponent, planSyncedBothFork } from './synced-exchange-fork'
import { captureSyncedCreateSourceFacts } from '../database/synced-host-create-plan'
import { readSyncedBothPreviewIndex, readSyncedBothIdentityCollisions } from '../database/synced-exchange-both-read'
import { planSyncedTombstoneExchange } from './synced-exchange-tombstone-plan'
import type { TombstoneExchangePlan, TombstoneExchangeState, TombstonePlanInput } from './synced-exchange-tombstone-types'
import { assertSyncedLogicalDeletionRecords } from '../database/synced-logical-deletion-read'
import { LOGICAL_DELETION_CHANNEL, validateSyncedLogicalDeletionProof, logicalDeletionAnchorId, logicalDeletionRequestHash,
  logicalDeletionProofReference, type SyncedLogicalDeletionProof } from './synced-logical-deletion-model'

export type { SyncedExchangeBothPreviewInput, SyncedExchangeBothResolveInput, SyncedExchangeBothPreviewResult, SyncedExchangeBothResult } from './synced-exchange-both-types'
export type { SyncedExchangeResult } from './synced-exchange-model'
export interface SyncedExchangeInput { operationId: string; userDataRoot: string; target: WebDavSyncConfig }
export interface SyncedExchangeRuntime { password: string; signal?: AbortSignal }
export interface SyncedExchangeConflictPreviewInput { previewId: string; userDataRoot: string; target: WebDavSyncConfig }
export interface SyncedExchangeConflictResolveInput extends SyncedExchangeInput { previewId: string; decisions: C.SyncedExchangeConflictDecision[] }
export type { SyncedExchangeConflictPreviewResult, SyncedExchangeConflictDecision } from './synced-exchange-conflict-model'
type TombstoneRuntimePlan = TombstoneExchangePlan & { localFinal: SyncedProtocol5Snapshot }
type KnowledgeRuntimePlan = (K.KnowledgeConflictPlan | K.KnowledgeForkPlan) & { localFinal: SyncedProtocol5Snapshot }
type DeletionChoiceRuntimePlan = DC.DeletionChoicePlan & { localFinal: SyncedProtocol5Snapshot }
type RuntimePlan = ExchangePlan | BothExchangePlan | TombstoneRuntimePlan | KnowledgeRuntimePlan | DeletionChoiceRuntimePlan
type Engine = 1 | 2 | 3 | 4 | 5 | 6 | 7
type BothSource = { resolution: B.BothResolution; selections: B.BothPrivateSelection[] }
type Context = { root: string; databasePath: string; target: WebDavSyncConfig; request: M.ExchangeRequest;
  workspaceScope: string; recoveryEpoch: string; initialTargetFingerprint: string;
  resolution: C.ExchangeResolutionBinding | null; selections: NonNullable<ExchangePlanInput['conflictSelections']>; both: BothSource | null; knowledgeMode: 5 | 6 | null;
  deletionChoice: {resolution:DC.DeletionChoiceResolution;selections:NonNullable<DC.DeletionChoicePlanInput['selections']>} | null }
type Prepared = { context: Context; local: SyncedExchangeLocal; localMaterial: SyncedExchangeLocalMaterial;
  localWire: SyncedProtocol5Snapshot; source: SyncedExchangeRemoteSource; remote: SyncedExchangeRemoteFacts;
  state: M.AnyExchangeState; baseRecords: SyncedProtocol5Snapshot['records']; plan: RuntimePlan; planningAuthority: ReturnType<typeof authority> | ReturnType<typeof knowledgeAuthority>; engine: Engine; bothLinks: T.SyncedBothOwnerSourceLinks[];
  localPhysical?: SyncedProtocol5Snapshot }
type Spool = { directory: string; job: M.ExchangeJob; plan: RuntimePlan; state: M.AnyExchangeState;
  localFingerprint: string; manifest: Buffer; records: SyncedProtocol5Snapshot['records']; objects: Map<string, Buffer>; assets: Map<string, Buffer>;
  planning: { local: SyncedProtocol5Snapshot; remote: SyncedProtocol5Snapshot; baseRecords: SyncedProtocol5Snapshot['records'];
    authority: ReturnType<typeof authority>; keyGuards: Record<string, string>; stateRaw: string | null;
    engine: Engine; conflictSelections: NonNullable<ExchangePlanInput['conflictSelections']>; bothSelections: B.BothPrivateSelection[]; bothLinks: T.SyncedBothOwnerSourceLinks[];
    localPhysical?: SyncedProtocol5Snapshot; remoteClosureHash?: string; deletionSelections?: NonNullable<DC.DeletionChoicePlanInput['selections']> } }
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
  return { root, databasePath, target, request, ...identity(db), initialTargetFingerprint: initialIncomingTargetFingerprint(target), resolution: null, selections: [], both: null, knowledgeMode: null, deletionChoice:null }
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
function legacyState(state: M.AnyExchangeState): M.ExchangeState {
  if (state.version === 1) return state
  return M.validateExchangeState({ ...state, version: 1, baseline: state.baseline.map(row => {
    if (row.local.kind !== 'live') return unavailable('旧冲突/分叉格式不能重解释已接受删除知识；不授复活写权。')
    return { key: row.key, localHash: row.local.hash, remoteHash: row.remoteHash, commonHash: row.commonHash,
      dependencyKeys: row.dependencyKeys, dependencySignature: row.dependencySignature, acceptedOperationId: row.acceptedOperationId }
  }) })
}
function knowledge(physical: SyncedProtocol5Snapshot, local: SyncedExchangeLocal): SyncedProtocol5Snapshot {
  return wire([...physical.records.map(row => row.record), ...(local.snapshot.deletions ?? []).map(proof => proof.deletion)], physical.manifest.workspaceId)
}
function makeTombstonePlan(input: TombstonePlanInput): TombstoneRuntimePlan {
  const plan = planSyncedTombstoneExchange(input)
  // Private execution view only; the pure planner's own planHash is unchanged.
  return { ...plan, localFinal: plan.localPhysicalFinal }
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
async function bases(c: Context, state: M.AnyExchangeState, local: SyncedProtocol5Snapshot, remote: SyncedProtocol5Snapshot,
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
  if (local.state) return { state: legacyState(local.state) }
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
function deletionAuthority(local: SyncedExchangeLocal, missingBaseKeys: string[], deferredKeys: string[] = []) {
  return { ...authority(local, missingBaseKeys, deferredKeys), pins: local.deletionPins,
    deletedFacts: (local.snapshot.deletions ?? []).map(proof => ({ key: proof.key, tombstoneHash: proof.tombstoneHash,
      deletionOperationId: proof.application.operationId, intentHash: proof.intentHash })) }
}
function makePlan(input: ExchangePlanInput, engine: 1 | 2 | 3, selections: B.BothPrivateSelection[] = [], links: T.SyncedBothOwnerSourceLinks[] = []): RuntimePlan {
  return engine === 1 ? planSyncedExchangeV1(input) : engine === 2 ? planSyncedExchange(input) : planSyncedBothExchange(input, selections, links)
}
type PrivatePreparedRead = { source: SyncedExchangeRemoteSource; localMaterial: SyncedExchangeLocalMaterial; local: SyncedExchangeLocal }
async function prepare(db: Database.Database, c: Context, runtime: SyncedExchangeRuntime, deferredKeys: string[] = [], engine: Engine = 2, captured?: PrivatePreparedRead): Promise<Prepared | M.SyncedExchangeResult> {
  if (engine === 7) return prepareDeletionChoices(db,c,runtime,deferredKeys)
  if (engine === 5 || engine === 6) return prepareKnowledge(db,c,runtime,deferredKeys,engine)
  if (engine === 4) return prepareTombstone(db, c, runtime, deferredKeys)
  let source = captured?.source
  if (!source) {
    const loaded = await readObservedSyncedProtocol5(db, { userDataRoot: c.root, target: c.target }, runtime)
    if (loaded.status !== 'ready') return loaded
    source = loaded.source
  }
  const remote = readObservedSyncedProtocol5Facts(source)
  if (!remote) return unavailable('真实remote source已经失效。')
  const localMaterial = captured?.localMaterial ?? await materializeSyncedExchangeLocal(db, { userDataRoot: c.root, target: c.target })
  const material = readSyncedExchangeLocalMaterial(localMaterial), local = captured?.local ?? capture(db, c)
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
  const bothLinks = engine === 3 ? captureBothSources(db, c, localWire) : []
  const plan = makePlan({ operationId: c.request.operationId, local: localWire, remote: remoteWire,
    baseRecords: common.records, state, localFingerprint: local.fingerprint, authority: planningAuthority,
    ...(engine === 2 ? {conflictSelections:c.selections} : {}) },engine,c.both?.selections??[],bothLinks)
  return { context: c, local, localMaterial, localWire, source, remote, state, baseRecords: common.records, plan, planningAuthority, engine, bothLinks }
}
async function prepareTombstone(db: Database.Database, c: Context, runtime: SyncedExchangeRuntime, deferredKeys: string[], selectLegacyLive = false): Promise<Prepared | M.SyncedExchangeResult> {
  const loaded = await readObservedSyncedProtocol5(db, { userDataRoot: c.root, target: c.target }, runtime)
  if (loaded.status !== 'ready') return loaded
  const source = loaded.source, remote = readObservedSyncedProtocol5Facts(source)
  if (!remote) return unavailable('真实remote source已经失效。')
  const localMaterial = await materializeSyncedExchangeLocal(db, { userDataRoot: c.root, target: c.target }), material = readSyncedExchangeLocalMaterial(localMaterial), local = capture(db, c)
  if (!material || material.snapshot.localFingerprint !== local.snapshot.localFingerprint) return { status: 'stale', side: 'local' }
  const localPhysical = wire(material.records, c.workspaceScope), localWire = knowledge(localPhysical, local), remoteWire = fromRemote(remote)
  // Only a new, unregistered automatic operation may select its original live
  // format. Reuse the very same private reader/material handles: no second GET,
  // observer completion or new race window is introduced by this dispatch.
  const needsTombstones = local.state?.version === 2 || Boolean(local.snapshot.deletions?.length) || !local.snapshot.groups.length
    || remoteWire.records.some(row => row.record.kind === 'deleted' || row.record.kind === 'synced-group-deleted')
  if (selectLegacyLive && !needsTombstones) return prepare(db,c,runtime,deferredKeys,2,{source,localMaterial,local})
  const initialized = local.state ? { state: local.state, original: undefined } : await initialState(c, local, localPhysical, remoteWire)
  let state = initialized.state.version === 2 ? initialized.state : M.liftTombstoneExchangeState(initialized.state)
  const common = await bases(c, state, localWire, remoteWire, new WebDavClient(c.target, runtime.password, runtime.signal), initialized.original)
  if (!local.state && state.source.kind === 'initial-receipt') {
    if (common.missing.length) { const all = state.baseline.map(row => row.key)
      state = M.validateTombstoneExchangeState({ ...state, baseline: state.baseline.map(row => ({ ...row, dependencyKeys: all.filter(key => key !== row.key),
        dependencySignature: publicationHash(publicationJson({ unknownOriginalClosure: state.source.manifestHash, key: row.key, all })) })) })
    } else {
      const original = validateSyncedProtocol5Snapshot(local.initialBaseline!.manifest, common.records.map(item => ({ key: item.key, record: item.record })))
      state = M.liftTombstoneExchangeState(seedState(c, state.source, original))
    }
  }
  if (local.state && state.source.kind !== 'current-equality') {
    let original: SyncedProtocol5Snapshot | undefined
    if (state.source.kind === 'confirmed-publication') {
      const seeds = await readConfirmedSyncedPublicationSeeds(db, { userDataRoot: c.root, target: c.target }), seed = seeds.find(row => row.operationId === state.source.operationId)
      if (!seed || publicationHash(publicationJson(seed.manifest)) !== state.source.manifestHash) return publicationInvalid('删除planner原confirmed seed缺失/被改。')
      original = validateSyncedProtocol5Snapshot(seed.manifest, seed.records.map(row => ({ key: row.key, record: row.record })))
    } else if (!local.initialBaseline || local.initialBaseline.result.operationId !== state.source.operationId || local.initialBaseline.result.manifestHash !== state.source.manifestHash)
      return publicationInvalid('删除planner原initial seed缺失/被改。')
    else {
      const values = common.records.filter(row => local.initialBaseline!.manifest.entries[row.key] === row.hash)
      if (values.length === Object.keys(local.initialBaseline.manifest.entries).length) original = validateSyncedProtocol5Snapshot(local.initialBaseline.manifest, values.map(row => ({ key: row.key, record: row.record })))
    }
    if (original) {
      const expected = new Map(M.liftTombstoneExchangeState(seedState(c, state.source, original)).baseline.map(row => [row.key, row]))
      for (const row of state.baseline) if (row.acceptedOperationId === state.source.operationId && !same(row, expected.get(row.key))) return publicationInvalid('删除baseline冒借/修改原seed事实。')
    } else if (state.baseline.some(row => row.acceptedOperationId === state.source.operationId)) common.missing.push(...state.baseline.map(row => row.key))
  }
  if (capture(db, c).fingerprint !== local.fingerprint) return { status: 'stale', side: 'local' }
  const planningAuthority = deletionAuthority(local, sort(common.missing), deferredKeys)
  const plan = makeTombstonePlan({ operationId: c.request.operationId, localPhysical, localKnowledge: localWire, remote: remoteWire, baseRecords: common.records,
    state, localFingerprint: local.fingerprint, authority: planningAuthority })
  return { context: c, local, localMaterial, localWire, localPhysical, source, remote, state, baseRecords: common.records, plan, planningAuthority, engine: 4, bothLinks: [] }
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
      || fact.version !== ((job.version === 3 || job.version === 6) ? 2 : 1) || fact.requestHash !== job.requestHash || fact.jobHash !== M.exchangeJobHash(job) || fact.operationId !== job.request.operationId || fact.attemptId !== job.attemptId) return publicationInvalid('exchange原phase不属于实际job。')
    return fact }).sort((a, b) => a.sequence - b.sequence)
  let previous: string | null = null
  for (const [index, fact] of facts.entries()) { if (fact.sequence !== index || fact.previousFactHash !== previous) return publicationInvalid('exchange phase追加链不连续。'); previous = publicationHash(publicationJson(fact)) }
  if (!facts.length) return publicationInvalid('exchange job缺prepared事实。')
  return facts
}
function phase(db: Database.Database, job: M.ExchangeJob, value: M.ExchangeJobPhase, remoteEtag: string | null, blocked: T.SyncedExchangeBothPublishedBlock | null = null): void {
  const previous = phases(db, job), last = previous.at(-1)!
  if (last.phase === value && last.remoteEtag === remoteEtag) return
  const fact = M.validateExchangeJobPhase({ kind: 'synced-exchange-job-phase', version: (job.version === 3 || job.version === 6) ? 2 : 1, operationId: job.request.operationId,
    requestHash: job.requestHash, jobHash: M.exchangeJobHash(job), attemptId: job.attemptId, sequence: previous.length,
    previousFactHash: publicationHash(publicationJson(last)), phase: value, remoteEtag, recordedAt: new Date().toISOString(), ...((job.version === 3 || job.version === 6) ? { blocked } : {}) })
  putImmutable(db, M.exchangeJobPhaseKey(job.request.operationId, job.attemptId, fact.sequence), fact, fact.recordedAt)
}
function storedRuntimePlan(plan: RuntimePlan): unknown {
  const snapshot = (value: SyncedProtocol5Snapshot) => ({ manifest: value.manifest, records: value.records })
  return { ...plan, nextRemote: snapshot(plan.nextRemote), localFinal: snapshot(plan.localFinal),
    ...('localKnowledgeFinal' in plan ? { localKnowledgeFinal: snapshot(plan.localKnowledgeFinal), localPhysicalFinal: snapshot(plan.localPhysicalFinal) } : {}) }
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
    ...(prepared.engine === 2 ? {plannerVersion:'conflicts-v1',resolution:c.resolution,conflictSelections:c.selections}: {}),
    ...(prepared.engine === 4 ? {plannerVersion:'tombstones-v1',localPhysical:prepared.localPhysical,remoteClosureHash:remote.closureHash}: {}),
    ...(prepared.engine === 7 ? {plannerVersion:'delete-choices-v1',localPhysical:prepared.localPhysical,remoteClosureHash:remote.closureHash,
      decisionSource:'decisionSource'in plan?plan.decisionSource:null,decisionSourceHash:'decisionSourceHash'in plan?plan.decisionSourceHash:null,
      resolution:c.deletionChoice?.resolution??null,deletionSelections:c.deletionChoice?.selections??[]}: {}),
    ...(prepared.engine === 5 || prepared.engine === 6 ? {plannerVersion:prepared.engine===5?'knowledge-conflicts-v1':'knowledge-forks-v1',
      localPhysical:prepared.localPhysical,knowledgeSource:'knowledgeSource'in plan?plan.knowledgeSource:null,knowledgeHash:'knowledgeHash'in plan?plan.knowledgeHash:null,
      resolution:prepared.engine===5?c.resolution:c.both!.resolution,...(prepared.engine===5?{conflictSelections:c.selections}:{bothSelections:storedBothSelections(c.both!.selections),bothLinks:prepared.bothLinks})}: {}),
    ...(prepared.engine === 3 ? {plannerVersion:'forks-v1',resolution:c.both!.resolution,bothSelections:storedBothSelections(c.both!.selections),bothLinks:prepared.bothLinks}: {}) }
  // assetNames is a Map and never crosses a JSON boundary. Full snapshots are reconstructed strictly on load.
  const storedInputs = { ...inputs, local: { manifest: inputs.local.manifest, records: inputs.local.records }, remote: { manifest: inputs.remote.manifest, records: inputs.remote.records },
    plan: storedRuntimePlan(plan), ...((prepared.engine === 4 || prepared.engine === 5 || prepared.engine === 6 || prepared.engine === 7) && prepared.localPhysical ? { localPhysical: { manifest: prepared.localPhysical.manifest, records: prepared.localPhysical.records } } : {}) }
  const inputBytes = Buffer.from(publicationJson(storedInputs)), spoolHash = publicationHash(publicationJson({ inputHash: publicationHash(inputBytes), descriptor }))
  const job = M.validateExchangeJob({ kind: 'synced-exchange-job', version: prepared.engine, request: c.request, requestHash: M.exchangeRequestHash(c.request),
    attemptId, parentAttemptId: parent?.attemptId ?? null, attemptIndex: parent ? parent.attemptIndex + 1 : 0, workspaceScope: c.workspaceScope,
    recoveryEpoch: c.recoveryEpoch, remoteWorkspaceId: remote.manifest.workspaceId, source: prepared.state.source, descriptor, components: plan.components, spoolHash, preparedAt: now,
    ...(prepared.engine === 2 ? {plannerVersion:'conflicts-v1',resolution:c.resolution,merges:plan.merges??[]}: {}),
    ...(prepared.engine === 4 ? {plannerVersion:'tombstones-v1',merges:plan.merges??[],deletions:'deletions'in plan?plan.deletions:[]}: {}),
    ...(prepared.engine === 7 ? {plannerVersion:'delete-choices-v1',merges:plan.merges??[],deletions:'deletions'in plan?plan.deletions:[],resolution:c.deletionChoice?.resolution??null,
      decisionSource:'decisionSource'in plan?plan.decisionSource:null,decisionSourceHash:'decisionSourceHash'in plan?plan.decisionSourceHash:null}: {}),
    ...(prepared.engine === 5 || prepared.engine === 6 ? {plannerVersion:prepared.engine===5?'knowledge-conflicts-v1':'knowledge-forks-v1',
      knowledgeSource:'knowledgeSource'in plan?plan.knowledgeSource:null,knowledgeHash:'knowledgeHash'in plan?plan.knowledgeHash:null,
      resolution:prepared.engine===5?c.resolution:c.both!.resolution,merges:plan.merges??[],...(prepared.engine===6?{forks:'forks'in plan?plan.forks:[]}: {})}: {}),
    ...(prepared.engine === 3 ? {plannerVersion:'forks-v1',resolution:c.both!.resolution,merges:plan.merges??[],forks:'forks' in plan ? plan.forks : []}: {}) })
  const dir = directory(c, attemptId); safe(dir, c.root); await mkdir(join(dir, 'objects'), { recursive: true, mode: 0o700 }); await mkdir(join(dir, 'assets'), { mode: 0o700 }); safe(dir, c.root)
  await durable(join(dir, 'inputs.json'), inputBytes); await durable(join(dir, 'manifest.json'), manifest)
  for (const item of descriptor.next.objects) { const file = join(dir, item.path); if (!lstatSync(file, { throwIfNoEntry: false })) await durable(file, objects.get(item.key)!) }
  for (const item of descriptor.next.assets) await durable(join(dir, item.path), assets.get(item.hash)!)
  await durable(join(dir, 'job.json'), Buffer.from(publicationJson(job))); await durable(join(dir, 'ready.json'), Buffer.from(publicationJson({ jobHash: M.exchangeJobHash(job), spoolHash }))); await syncDirectory(dir)
  return { directory: dir, job, plan, state: prepared.state, localFingerprint: local.fingerprint, manifest, records, objects, assets,
    planning: { local: prepared.localWire, remote: fromRemote(remote), baseRecords: prepared.baseRecords, authority: prepared.planningAuthority, keyGuards: local.keyGuards, stateRaw: local.stateRaw,
      engine:prepared.engine,conflictSelections:prepared.engine===2||prepared.engine===5?c.selections:[],bothSelections:prepared.engine===3||prepared.engine===6?c.both!.selections:[],bothLinks:prepared.bothLinks,
      ...((prepared.engine===4||prepared.engine===5||prepared.engine===6||prepared.engine===7)?{localPhysical:prepared.localPhysical,...(prepared.engine===4||prepared.engine===7?{remoteClosureHash:remote.closureHash}:{})}: {}),
      ...(prepared.engine===7?{deletionSelections:c.deletionChoice?.selections??[]}:{}) } }
}
function registerJob(db: Database.Database, c: Context, spool: Spool, parent: Head | null): boolean {
  return db.transaction(() => {
    current(db, c); if (capture(db, c).fingerprint !== spool.localFingerprint) return false
    if (!same(readHead(db, c), parent)) return false
    const job = spool.job, now = job.preparedAt
    putImmutable(db, M.exchangeJobKey(c.request.operationId, job.attemptId), job, now)
    const first = M.validateExchangeJobPhase({ kind: 'synced-exchange-job-phase', version: (job.version === 3 || job.version === 6) ? 2 : 1, operationId: c.request.operationId,
      requestHash: job.requestHash, jobHash: M.exchangeJobHash(job), attemptId: job.attemptId, sequence: 0, previousFactHash: null,
      phase: 'prepared', remoteEtag: null, recordedAt: now, ...((job.version === 3 || job.version === 6) ? { blocked: null } : {}) })
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
    ...(job.version===2?['plannerVersion','resolution','conflictSelections']:job.version===3?['plannerVersion','resolution','bothSelections','bothLinks']:job.version===4?['plannerVersion','localPhysical','remoteClosureHash']:job.version===5?['plannerVersion','localPhysical','knowledgeSource','knowledgeHash','resolution','conflictSelections']:job.version===6?['plannerVersion','localPhysical','knowledgeSource','knowledgeHash','resolution','bothSelections','bothLinks']:job.version===7?['plannerVersion','localPhysical','remoteClosureHash','decisionSource','decisionSourceHash','resolution','deletionSelections']:[])])
  if (input.kind !== 'synced-exchange-private-inputs' || input.version !== job.version || !same(input.request, c.request) || !same(input.target, c.target)
    || publicationHash(publicationJson({ inputHash: publicationHash(inputBytes), descriptor: job.descriptor })) !== job.spoolHash) return publicationInvalid('exchange原spoolinput认证失败。')
  const decodeSnapshot = (value: unknown): SyncedProtocol5Snapshot => {
    assertSyncedShape(value, ['manifest', 'records']); if (!Array.isArray(value.records)) return publicationInvalid('exchange原snapshot records无效。')
    return validateSyncedProtocol5Snapshot(value.manifest, value.records.map(raw => { assertSyncedShape(raw, ['key', 'hash', 'record'])
      if (typeof raw.key !== 'string' || typeof raw.hash !== 'string' || publicationHash(publicationJson(raw.record)) !== raw.hash) return publicationInvalid('exchange原snapshot hash不符。')
      return { key: raw.key, record: raw.record } }))
  }
  const local = decodeSnapshot(input.local), remote = decodeSnapshot(input.remote), state = M.validateAnyExchangeState(input.state)
  if (!Array.isArray(input.baseRecords)) return publicationInvalid('exchange原B records无效。')
  const baseRecords = input.baseRecords.map(raw => { assertSyncedShape(raw, ['key', 'hash', 'record'])
    if (typeof raw.key !== 'string' || typeof raw.hash !== 'string') return publicationInvalid('exchange原B key/hash无效。')
    return { key: raw.key, hash: raw.hash, record: validateSyncedProtocol5Record(raw.record, raw.key) } })
  assertSyncedShape(input.authority, ['catalogId', 'identities', 'occupiedDocumentIds', 'historyComponents', 'pinnedGroupIds', 'knownGroupIds', 'missingBaseKeys', 'deferredKeys', ...(job.version===4?['deletedFacts','pins']:job.version===5||job.version===6||job.version===7?['deletedFacts','pins','deletionProofReferences']:[])], ['keyGuards'])
  // The authority was minted only by this module's original real capture and is authenticated by both immutable DB job and private spool hash.
  const originalAuthority = input.authority as unknown as ReturnType<typeof authority>
  const conflictSelections=job.version===2||job.version===5?readSelections(input.conflictSelections,c.request):[]
  const bothSelections=job.version===3||job.version===6?readBothSelections(input.bothSelections,c.request):[],bothLinks=job.version===3||job.version===6?B.validateBothSourceLinks(input.bothLinks):[]
  if(job.version===3&&(input.plannerVersion!=='forks-v1'||!same(B.validateBothResolution(input.resolution),job.resolution)))return publicationInvalid('both原job来源/算法损坏。')
  if(job.version===2&&(input.plannerVersion!=='conflicts-v1'||!same(C.validateExchangeResolutionBinding(input.resolution),job.resolution))) return publicationInvalid('原job决定来源/算法损坏。')
  const localPhysical = job.version === 4 || job.version === 5 || job.version === 6 || job.version === 7 ? decodeSnapshot(input.localPhysical) : undefined
  if (job.version === 4 && (input.plannerVersion !== 'tombstones-v1' || typeof input.remoteClosureHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.remoteClosureHash))) return publicationInvalid('原删除job4私有来源版本/闭包hash损坏。')
  let plan: RuntimePlan
  const deletionSelections=job.version===7?readDeletionSelections(input.deletionSelections,c.request):[]
  if (job.version === 7) {
    if(!localPhysical||input.plannerVersion!==job.plannerVersion||!same(input.resolution,job.resolution)||!same(DC.validateDeletionDecisionSource(input.decisionSource),job.decisionSource)
      ||input.decisionSourceHash!==job.decisionSourceHash||input.remoteClosureHash!==job.decisionSource.remoteSource.closureHash)return publicationInvalid('删除选择原spool preimage/preview来源损坏。')
    plan=makeDeletionChoicePlan({operationId:c.request.operationId,localPhysical,localKnowledge:local,remote,baseRecords,state:M.validateTombstoneExchangeState(state),localFingerprint:job.descriptor.localFingerprint,
      authority:input.authority as unknown as K.KnowledgeAuthority,remoteSource:job.decisionSource.remoteSource,resolution:job.resolution,selections:deletionSelections})
    if(!same(plan.decisionSource,job.decisionSource)||plan.decisionSourceHash!==job.decisionSourceHash)return publicationInvalid('删除选择原job/inputs/来源不闭合。')
  } else if (job.version === 4) {
    if (!localPhysical) return publicationInvalid('删除原job4缺真实physical snapshot。')
    plan = makeTombstonePlan({ operationId: c.request.operationId, localKnowledge: local, localPhysical, remote, baseRecords,
      state: M.validateTombstoneExchangeState(state), localFingerprint: job.descriptor.localFingerprint,
      authority: input.authority as unknown as TombstonePlanInput['authority'] })
  } else if (job.version===5 || job.version===6) {
    if (!localPhysical || input.plannerVersion!==job.plannerVersion || !same(K.validateKnowledgeSource(input.knowledgeSource),job.knowledgeSource)
      || input.knowledgeHash!==job.knowledgeHash || !same(input.resolution,job.resolution)) return publicationInvalid('knowledge原job preimage/决定/两图缺失或损坏。')
    plan=makeKnowledgePlan({operationId:c.request.operationId,localPhysical,localKnowledge:local,remote,baseRecords,state:M.validateTombstoneExchangeState(state),
      localFingerprint:job.descriptor.localFingerprint,authority:input.authority as unknown as K.KnowledgeAuthority,conflictSelections},job.version,bothSelections,bothLinks)
    if (!same(plan.knowledgeSource,job.knowledgeSource) || plan.knowledgeHash!==job.knowledgeHash) return publicationInvalid('knowledge job原来源与私有inputs/plan不符。')
  } else plan = makePlan({ operationId: c.request.operationId, local, remote, baseRecords, state: legacyState(state),
    localFingerprint: job.descriptor.localFingerprint, authority: originalAuthority,
    ...(job.version===2?{conflictSelections}: {}) },job.version,bothSelections,bothLinks)
  const normalized = storedRuntimePlan(plan)
  if (!same(input.plan, normalized) || plan.planHash !== job.descriptor.planHash) return publicationInvalid('exchange原planner结果与不可变job不符。')
  if((job.version===3||job.version===6)&&(!('forks'in plan)||!same(plan.forks,job.forks)))return publicationInvalid('both原job fork/projection与原inputs不闭合。')
  if((job.version===4||job.version===7)&&(!('deletions'in plan)||!same(plan.deletions,job.deletions)))return publicationInvalid('删除job intent与真实原inputs/plan不闭合。')
  if(job.version>=2&&!same(plan.merges??[],job.merges))return publicationInvalid('原job merge来源与原inputs/plan不闭合。')
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
    planning: { local, remote, baseRecords, authority: originalAuthority, keyGuards, stateRaw: input.stateRaw, engine:job.version,conflictSelections,bothSelections,bothLinks,
      ...((job.version===4||job.version===5||job.version===6||job.version===7)?{localPhysical,...(job.version===4||job.version===7?{remoteClosureHash:input.remoteClosureHash as string}:{})}: {}),
      ...(job.version===7?{deletionSelections}:{}) } }
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
type HistoryBoundaryEffects = { historyArchives: Array<{ groupId: string; indexHash: string }>; hostHistoryCuts: Array<{ historyToken: string; cutHash: string }>; deletions?: ReturnType<typeof logicalDeletionProofReference>[] }
function historyBoundary(db: Database.Database, c: Context, plan: RuntimePlan, now: string): HistoryBoundaryEffects {
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
  const deletionIntents: Array<import('./synced-exchange-tombstone-types').TombstoneDeletionIntent | DeletionChoiceIntent> = saved.job.version === 4 || saved.job.version === 7 ? saved.job.deletions : []
  const originalGroups = new Map(original.snapshot.groups.map(group => [group.wire.id,group])), remoteRecords = new Map(saved.planning.remote.records.map(row=>[row.key,row.record]))
  const deletionBefore = new Map<string, SyncedLogicalDeletionProof['localBefore']>()
  for (const intent of deletionIntents) {
    if (intent.before.kind === 'document') {
      const row = db.prepare('SELECT id,created_at,path,updated_at FROM documents WHERE id=?').get(intent.before.id) as { id:string;created_at:string;path:string;updated_at:string } | undefined
      if (!row || row.created_at !== intent.before.createdAt || !original.keyGuards[intent.key]) return publicationInvalid('删除doc原birth/keyguard已失效。')
      deletionBefore.set(intent.key, { kind:'document',documentId:row.id,createdAt:row.created_at,path:row.path,updatedAt:row.updated_at,keyGuard:original.keyGuards[intent.key] })
    } else {
      const row = db.prepare('SELECT creation_id,created_at,origin_json,revision,topology_revision,history_cursor,history_position FROM synced_groups WHERE id=?').get(intent.before.id) as
        {creation_id:string;created_at:string;origin_json:string;revision:string;topology_revision:string;history_cursor:string;history_position:number}|undefined
      const actual = originalGroups.get(intent.before.id)
      if (!row || !actual || row.creation_id !== intent.before.creationId || row.created_at !== intent.before.createdAt || !same(M.parseExchangeStored(row.origin_json), intent.before.origin)) return publicationInvalid('删除group原tuple不符。')
      deletionBefore.set(intent.key,{kind:'group',groupId:intent.before.id,creationId:row.creation_id,createdAt:row.created_at,origin:intent.before.origin,
        revision:row.revision,topologyRevision:row.topology_revision,historyCursor:row.history_cursor,historyPosition:row.history_position,semanticHash:actual.semanticHash,keyGuard:original.keyGuards[intent.key]})
    }
  }
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
  for (const intent of deletionIntents) {
    if (intent.before.kind === 'document') {
      db.prepare('DELETE FROM synced_instances WHERE host_document_id=?').run(intent.before.id)
      db.prepare('DELETE FROM blocks WHERE document_id=?').run(intent.before.id)
    } else {
      if (db.prepare('SELECT 1 FROM synced_instances WHERE group_id=? LIMIT 1').get(intent.before.id)
        || db.prepare('SELECT 1 FROM synced_group_pins WHERE group_id=? LIMIT 1').get(intent.before.id)) return publicationInvalid('删除group写前仍有真实ref/pin。')
      db.prepare('DELETE FROM synced_group_blocks WHERE group_id=?').run(intent.before.id)
    }
  }
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
  for (const intent of deletionIntents) if (intent.before.kind === 'document') {
    // The strict final catalog/parent graph was chosen before this statement;
    // FK side effects are not used to invent that choice.
    if (db.prepare('DELETE FROM documents WHERE id=?').run(intent.before.id).changes !== 1) return publicationInvalid('删除doc实际SQL闭集失效。')
  }
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
        block.markdownFormat === undefined ? null : publicationJson(block.markdownFormat), block.highlight ?? null, old?.created_at ?? allocatedPhysicalBirth(saved, block.id, now), now)
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
  if (saved.job.version === 3 || saved.job.version === 6) for (const row of usedBothAllocation(saved)?.missing ?? []) {
    if (!db.prepare('SELECT 1 FROM block_identities WHERE id=?').get(row.id))
      db.prepare("INSERT INTO block_identities(id,last_owner_kind,last_owner_id,state,created_at) VALUES(?,'reserved',?,'retained',NULL)")
        .run(row.id, 'sync.webdav.protocol5.exchange-reservation.v1.' + c.request.operationId)
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
  if (saved.job.version === 4 || saved.job.version === 7) {
    const refs: ReturnType<typeof logicalDeletionProofReference>[] = []
    for (const intent of deletionIntents) {
      const before = deletionBefore.get(intent.key)
      const deletion = remoteRecords.get(intent.key)
      if (!before || !deletion || (deletion.kind !== 'deleted' && deletion.kind !== 'synced-group-deleted') || !saved.planning.remoteClosureHash) return publicationInvalid('删除缺同次真实remote墓碑/原physical来源。')
      let after: SyncedLogicalDeletionProof['localAfter']
      if (intent.before.kind === 'synced-group') {
        after = {kind:'group',groupId:intent.before.id,revision:randomUUID(),topologyRevision:randomUUID(),historyCursor:randomUUID(),historyPosition:0}
        if (db.prepare('UPDATE synced_groups SET revision=?,topology_revision=?,history_cursor=?,history_position=0 WHERE id=?').run(after.revision,after.topologyRevision,after.historyCursor,after.groupId).changes !== 1) return publicationInvalid('删除group freshCAS屏障未准确落库。')
      } else after = {kind:'document',documentId:intent.before.id}
      for (const effect of intent.identities) {
        const row = db.prepare('SELECT last_owner_kind,last_owner_id,state,created_at FROM block_identities WHERE id=?').get(effect.before.id) as
          {last_owner_kind:string;last_owner_id:string;state:string;created_at:string|null}|undefined
        const expected = effect.after.kind === 'retained' ? {last_owner_kind:effect.before.last_owner_kind,last_owner_id:effect.before.last_owner_id,state:'retained',created_at:effect.before.created_at}
          : {last_owner_kind:effect.after.ownerKind,last_owner_id:effect.after.ownerId,state:'live',created_at:effect.after.createdAt}
        if (!row || !same(row,expected)) return publicationInvalid('删除identity实际retained/transfer后果未闭合。')
      }
      const anchorId = logicalDeletionAnchorId(intent.before)
      if (intent.before.kind === 'document') for (const groupId of sort(intent.before.content.blocks.flatMap(block => block.type === 'synced-block' ? [parseSyncedBlockPayload(block.content).groupId] : [])))
        db.prepare('INSERT INTO synced_group_pins(group_id,kind,pin_id,created_at) VALUES(?,?,?,?)').run(groupId,'logical-deletion-document-archive',anchorId,now)
      const proofInput={kind:'synced-logical-deletion-proof',version:saved.job.version===7?2:1,key:intent.key,intentHash:intent.intentHash,baseLiveHash:intent.baseLiveHash,tombstoneHash:intent.tombstoneHash,
        deletion,before:intent.before,identities:intent.identities,localBefore:before,localAfter:after,
        source:{targetFingerprint:c.request.targetFingerprint,workspaceId:saved.job.remoteWorkspaceId,manifestHash:saved.job.descriptor.expectedRemote.manifestHash,closureHash:saved.planning.remoteClosureHash},
        scopeAtApply:{workspaceScope:c.workspaceScope,recoveryEpoch:c.recoveryEpoch},application:{operationId:c.request.operationId,requestHash:M.exchangeRequestHash(c.request),acceptedAt:now},
        persistence:{kind:'logical-deletion-denial',anchorId},...('base'in intent?{base:intent.base,localBeforeHash:intent.localBeforeHash,decision:intent.decision}:{})}
      const proof=saved.job.version===7?validateSyncedLogicalDeletionChoiceProof(proofInput):validateSyncedLogicalDeletionProof(proofInput)
      const requestHash = proof.version===2?logicalDeletionChoiceRequestHash(proof):logicalDeletionRequestHash(proof)
      db.prepare('INSERT INTO synced_operations(client_operation_id,request_hash,result_json,created_at) VALUES(?,?,?,?)').run(anchorId,requestHash,publicationJson(proof),now)
      db.prepare("INSERT INTO synced_exposure_attempts(id,request_hash,channel,target_fingerprint,publication_hash,state,created_at,confirmed_at) VALUES(?,?,?,?,?,'possible',?,NULL)")
        .run(anchorId,requestHash,LOGICAL_DELETION_CHANNEL,c.request.targetFingerprint,intent.tombstoneHash,now)
      refs.push(proof.version===2?logicalDeletionChoiceProofReference(proof):logicalDeletionProofReference(proof))
    }
    return {...archives,deletions:refs}
  }
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
    if((saved.job.version===3||saved.job.version===6)&&bothCollisions(db,c,saved).length)return null
    const checked = saved.job.version === 7 ? makeDeletionChoicePlan({operationId:c.request.operationId,localPhysical:actualLocal,localKnowledge:knowledge(actualLocal,local),remote:saved.planning.remote,
      baseRecords:saved.planning.baseRecords,state:M.validateTombstoneExchangeState(saved.state),localFingerprint:local.fingerprint,authority:knowledgeAuthority(local,saved.planning.authority.missingBaseKeys,saved.planning.authority.deferredKeys),
      remoteSource:saved.job.decisionSource.remoteSource,resolution:saved.job.resolution,selections:saved.planning.deletionSelections??[]}) : saved.job.version === 5 || saved.job.version === 6 ? makeKnowledgePlan({operationId:c.request.operationId,
      localPhysical:actualLocal,localKnowledge:knowledge(actualLocal,local),remote:saved.planning.remote,baseRecords:saved.planning.baseRecords,
      state:M.validateTombstoneExchangeState(saved.state),localFingerprint:local.fingerprint,
      authority:knowledgeAuthority(local,saved.planning.authority.missingBaseKeys,saved.planning.authority.deferredKeys),conflictSelections:saved.planning.conflictSelections},
      saved.job.version,saved.planning.bothSelections,saved.job.version===6?captureBothSources(db,c,actualLocal):[]) : saved.job.version === 4 ? makeTombstonePlan({operationId:c.request.operationId,localPhysical:actualLocal,localKnowledge:knowledge(actualLocal,local),remote:saved.planning.remote,
      baseRecords:saved.planning.baseRecords,state:M.validateTombstoneExchangeState(saved.state),localFingerprint:local.fingerprint,
      authority:deletionAuthority(local,saved.planning.authority.missingBaseKeys,saved.planning.authority.deferredKeys)}) : makePlan({ operationId: c.request.operationId, local: actualLocal, remote: saved.planning.remote,
      baseRecords: saved.planning.baseRecords, state: legacyState(saved.state), localFingerprint: local.fingerprint,
      authority: authority(local, saved.planning.authority.missingBaseKeys, saved.planning.authority.deferredKeys),
      ...(saved.job.version===2?{conflictSelections:saved.planning.conflictSelections}: {}) },saved.job.version,saved.planning.bothSelections,saved.job.version===3?captureBothSources(db,c,actualLocal):[])
    if (checked.planHash !== saved.plan.planHash || !same(checked.localFinal.manifest.entries, saved.plan.localFinal.manifest.entries)
      || !same(checked.nextRemote.manifest.entries, saved.plan.nextRemote.manifest.entries)) return publicationInvalid('exchange最后owned SQL全图planner复核不闭合。')
    const now = new Date().toISOString(), historyEffects = checked.incoming.length ? install(db, c, saved, local, now) : { historyArchives: [], hostHistoryCuts: [] }
    const resultBase = M.validateExchangeAccepted({ status: checked.writes.length || checked.incoming.length ? 'applied' : checked.deferred.length ? 'deferred' : 'noop',
      operationId: c.request.operationId, replayed: false, workspaceScope: c.workspaceScope, recoveryEpoch: c.recoveryEpoch,
      remoteWorkspaceId: saved.job.remoteWorkspaceId, beforeManifestHash: checked.beforeManifestHash, afterManifestHash: checked.afterManifestHash,
      publishedKeys: checked.writes, appliedKeys: checked.incoming, acceptedKeys: checked.accepted, deferred: checked.deferred, acceptedAt: now })
    const result = saved.job.version===3||saved.job.version===6 ? {...resultBase,forks:('forks'in checked?checked.forks:[]).map(row=>row.summary)} : resultBase
    const state = saved.job.version===4||saved.job.version===5||saved.job.version===6||saved.job.version===7 ? M.validateTombstoneExchangeState({...saved.state,version:2,currentOperationId:c.request.operationId,generation:randomUUID(),baseline:checked.nextBaseline,deferred:checked.deferred,lastSyncAt:now})
      : M.validateExchangeState({ ...legacyState(saved.state), currentOperationId: c.request.operationId, generation: randomUUID(), baseline: checked.nextBaseline, deferred: checked.deferred, lastSyncAt: now })
    const receipt = M.validateExchangeReceipt({ kind: 'synced-exchange-operation', version: saved.job.version, request: c.request, result, provenance: {
      beforeManifestHash: result.beforeManifestHash, afterManifestHash: result.afterManifestHash, beforeManifestEtag: saved.job.descriptor.expectedRemote.etag,
      afterManifestEtag: etag, planHash: checked.planHash, source: saved.state.source, accepted: checked.acceptedSides, transfers: checked.transfers, historyArchives: historyEffects.historyArchives,
      hostHistoryCuts: historyEffects.hostHistoryCuts,
      afterStateHash: publicationHash(publicationJson(state)),
      ...(saved.job.version===4?{plannerVersion:'tombstones-v1',merges:checked.merges??[],attemptId:saved.job.attemptId,deletions:historyEffects.deletions??[]}: {}),
      ...(saved.job.version===7?{plannerVersion:'delete-choices-v1',merges:checked.merges??[],attemptId:saved.job.attemptId,deletions:historyEffects.deletions??[],resolution:saved.job.resolution,decisionSourceHash:saved.job.decisionSourceHash}: {}),
      ...(saved.job.version===5||saved.job.version===6?{plannerVersion:saved.job.plannerVersion,knowledgeHash:saved.job.knowledgeHash,
        resolution:saved.job.resolution,merges:checked.merges??[],attemptId:saved.job.attemptId,...(saved.job.version===6?{forks:'forks'in checked?checked.forks:[]}: {})}: {}),
      ...(saved.job.version===2?{plannerVersion:'conflicts-v1',resolution:saved.job.resolution,merges:checked.merges??[],attemptId:saved.job.attemptId}: {}),
      ...(saved.job.version===3?{plannerVersion:'forks-v1',resolution:saved.job.resolution,merges:checked.merges??[],forks:'forks'in checked?checked.forks:[],attemptId:saved.job.attemptId}: {}) } })
    db.prepare('INSERT INTO synced_operations(client_operation_id,request_hash,result_json,created_at) VALUES(?,?,?,?)')
      .run(c.request.operationId, M.exchangeRequestHash(c.request), publicationJson(receipt), now)
    // Baseline is the last knowledge write, in the very same transaction as actual graph/owner/history and exact receipt.
    db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
      .run(M.exchangeStateKey(c.request.targetFingerprint), publicationJson(state), now)
    phase(db, saved.job, 'settled', etag)
    const final = readSyncedExchangeLocal(db, { request: c.request, initialTargetFingerprint: c.initialTargetFingerprint })
    if (saved.job.version === 4 || saved.job.version === 5 || saved.job.version === 6 || saved.job.version === 7) {
      if (!('localKnowledgeFinal' in checked)) return publicationInvalid('删除settle缺准确planner4两图。')
      const physical = wire(portableRecords(final.snapshot,c),c.workspaceScope), known = knowledge(physical,final)
      if (!same(physical.manifest.entries,checked.localPhysicalFinal.manifest.entries) || !same(physical.manifest.syncedInstances,checked.localPhysicalFinal.manifest.syncedInstances)
        || !same(known.manifest.entries,checked.localKnowledgeFinal.manifest.entries) || !same(known.manifest.syncedInstances,checked.localKnowledgeFinal.manifest.syncedInstances))
        return publicationInvalid('删除 actual SQL physical/knowledge 两图/hash/Key未精确闭合。')
    }
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
  if(request.method!=='resolveSyncedExchangeConflicts' ? decisions.length!==0 : !same(decisions,request.decisions)) return publicationInvalid('原inputs selectors与完整request不闭合。')
  return selections
}
function previewDirectory(c: Context, previewId: string): string { return join(c.root,'storage','synced-exchange-previews-v1',previewId) }
type StoredPreview = {index:C.ConflictPreviewIndex|KnowledgePreviewIndex;facts:C.SyncedExchangeConflictPreview}
async function loadPreview(db:Database.Database,c:Context,previewId:string):Promise<StoredPreview|null> {
  const knowledgeIndex=db.transaction(()=>{current(db,c);return readKnowledgePreviewIndex(db,'conflicts',previewId,c.request)})()
  if(knowledgeIndex)return loadKnowledgeConflictPreview(db,c,knowledgeIndex)
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
  c.knowledgeMode=loaded.index.version===2?5:null
  c.resolution={previewId:request.previewId,previewHash:loaded.index.previewHash,decisionsHash:C.conflictDecisionsHash(request.decisions)}
}
async function createPreview(db:Database.Database,c:Context,previewId:string,runtime:SyncedExchangeRuntime):Promise<C.SyncedExchangeConflictPreviewResult> {
  if(db.pragma('user_version',{simple:true})===26)return Object.freeze({status:'unsupported',reason:'schema-27-required'})
  if(db.pragma('user_version',{simple:true})!==27)return publicationInvalid('preview不接受未知/未来schema。')
  const existing=await loadPreview(db,c,previewId)
  if(existing)return frozenPublicationFacts({status:'ready',preview:existing.facts})
  if(manualKnowledge(capture(db,c)))return createKnowledgePreview(db,c,previewId,runtime,'conflicts')
  const prepared=await prepare(db,c,runtime)
  if(!('plan'in prepared)) {
    if(prepared.status==='missing'||prepared.status==='unsupported'||prepared.status==='stale')return frozenPublicationFacts(prepared)
    return publicationInvalid('preview不接受exchange结果冒充读取结果。')
  }
  if (!('conflictPreviews' in prepared.plan)) return publicationInvalid('旧手工preview必须来自准确live conflict planner。')
  const now=new Date().toISOString(),dir=previewDirectory(c,previewId)
  const payload={kind:'synced-exchange-conflict-preview-inputs',version:1,previewId,databasePath:c.databasePath,target:c.target,
    workspaceScope:c.workspaceScope,recoveryEpoch:c.recoveryEpoch,remoteWorkspaceId:prepared.remote.manifest.workspaceId,stateGeneration:prepared.state.generation,
    remoteManifestHash:prepared.remote.manifestHash,remoteEtag:prepared.remote.manifestEtag,createdAt:now,
    local:{manifest:prepared.localWire.manifest,records:prepared.localWire.records},remote:{manifest:prepared.remote.manifest,records:fromRemote(prepared.remote).records},
    baseRecords:prepared.baseRecords,state:legacyState(prepared.state),authority:prepared.planningAuthority,keyGuards:prepared.local.keyGuards,stateRaw:prepared.local.stateRaw,localFingerprint:prepared.local.fingerprint,
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
  let engine: Engine=saved?.job.version??(c.request.method==='exchangeSyncedSnapshot'?4:2)
  if(saved&&(engine===2||engine===5)) {c.resolution=C.validateExchangeResolutionBinding(saved.job.resolution??null);c.selections=saved.planning.conflictSelections;c.knowledgeMode=engine===5?5:null}
  else if(c.request.method==='resolveSyncedExchangeConflicts') {await attachPreview(db,c,c.request);if(c.knowledgeMode===5)engine=5}
  // A bounded set of real competing snapshots; each retry gets a new immutable attempt and fresh original ETag.
  for (let turn = 0; turn < 8; turn++) {
    aborted(runtime.signal)
    if (!saved) {
      const prepared = engine === 4 && !head ? await prepareTombstone(db,c,runtime,deferredKeys,true) : await prepare(db, c, runtime, deferredKeys,engine)
      if (!('plan' in prepared)) {
        if (prepared.status === 'stale' && prepared.side === 'local') { deferredKeys = sort([...deferredKeys, ...changedKeys(originalGuards, capture(db, c).keyGuards)]); continue }
        return frozenPublicationFacts(prepared)
      }
      const raced = changedKeys(originalGuards, prepared.local.keyGuards)
      if (raced.some(key => !deferredKeys.includes(key))) { deferredKeys = sort([...deferredKeys, ...raced]); continue }
      saved = await spool(prepared, head)
      if (!registerJob(db, c, saved, head)) { saved = null; deferredKeys = sort([...deferredKeys, ...changedKeys(originalGuards, capture(db, c).keyGuards)]); head = db.transaction(() => readHead(db, c))(); continue }
      engine = saved.job.version
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

function captureBothSources(db: Database.Database, c: Context, local: SyncedProtocol5Snapshot): T.SyncedBothOwnerSourceLinks[] {
  return db.transaction(() => {
    current(db,c)
    const paths=new Map((db.prepare('SELECT id,path FROM documents').all() as Array<{id:string;path:string}>).map(row=>[row.id,row.path]))
    const result:T.SyncedBothOwnerSourceLinks[]=[]
    for(const {key,hash,record} of local.records) {
      if(record.kind==='document') {
        const path=paths.get(record.id);if(path===undefined)return publicationInvalid('both真实portable宿主缺原SQL path。')
        result.push(captureSyncedExchangeDocumentLinks(db,{id:record.id,path},record.content.blocks,record.content.summary,hash))
      } else if(record.kind==='synced-group') {
        const bindings=new Map(record.bindings.map(binding=>[publicationJson([binding.blockId,binding.from,binding.to,binding.raw,binding.syntax]),binding]))
        const links=collectSyncedBindingOccurrences(record.origin,record.blocks).map(item=>{
          const binding=bindings.get(publicationJson([item.blockId,item.from,item.to,item.raw,item.syntax]))
          if(!binding)return publicationInvalid('both原portable canonical物理Key缺binding。')
          return {key:{field:'block' as const,blockId:item.blockId,from:item.from,to:item.to,raw:item.raw,syntax:item.syntax},url:item.url,target:binding.target}
        })
        if(links.length!==record.bindings.length)return publicationInvalid('both原portable canonical Key并非闭集。')
        const images=captureSyncedCreateSourceFacts(record.blocks.map(({createdAt:_createdAt,...block})=>block)).links.filter(item=>item.image).map(item=>({key:{field:'block' as const,...item.key},url:item.url}))
        links.sort((a,b)=>publicationCompare(B.bothSourceKey(a.key),B.bothSourceKey(b.key)));images.sort((a,b)=>publicationCompare(B.bothSourceKey(a.key),B.bothSourceKey(b.key)))
        result.push({ownerKey:key,recordHash:hash,path:null,complete:true,links,images})
      }
    }
    return B.validateBothSourceLinks(result.sort((a,b)=>publicationCompare(a.ownerKey,b.ownerKey)))
  })()
}
function planInput(prepared:Prepared):ExchangePlanInput {
  return {operationId:prepared.context.request.operationId,local:prepared.localWire,remote:fromRemote(prepared.remote),baseRecords:prepared.baseRecords,
    state:legacyState(prepared.state),localFingerprint:prepared.local.fingerprint,authority:prepared.planningAuthority}
}
function snapshotData(value:SyncedProtocol5Snapshot):unknown{return {manifest:value.manifest,records:value.records}}
function strictBothSnapshot(value:unknown):SyncedProtocol5Snapshot {
  assertSyncedShape(value,['manifest','records']);if(!Array.isArray(value.records))return publicationInvalid('both原snapshot records损坏。')
  return validateSyncedProtocol5Snapshot(value.manifest,value.records.map(row=>{assertSyncedShape(row,['key','hash','record'])
    if(typeof row.key!=='string'||row.hash!==publicationHash(publicationJson(row.record)))return publicationInvalid('both原snapshot hash不符。')
    return {key:row.key,record:row.record}}))
}
function bothDirectory(c:Context,previewId:string):string{return join(c.root,'storage','synced-exchange-both-previews-v1',previewId)}
type BothStoredPreview={index:B.BothPreviewIndex|KnowledgePreviewIndex;facts:T.SyncedExchangeBothPreview;allocation:T.SyncedBothAllocation;selections:B.BothPrivateSelection[]}
function buildBothPreview(prepared:Prepared,previewId:string,now:string):{components:T.SyncedExchangeBothPreviewComponent[];allocation:T.SyncedBothAllocation;selections:B.BothPrivateSelection[]} {
  const ki=prepared.engine===6?knowledgeInput(prepared):null,legacy=ki?null:planInput(prepared)
  const input=ki?{local:ki.localKnowledge,remote:ki.remote}:legacy!,sourceLinks=captureBothSources(captureConnection(prepared.context),prepared.context,prepared.localPhysical??prepared.localWire)
  const facts=ki?deriveKnowledgeBothComponents(ki,sourceLinks):deriveBothComponents(legacy!,sourceLinks),local=new Map(prepared.localWire.records.map(row=>[row.key,row]))
  const descriptions=new Map(facts.filter(row=>row.conflictedKeys.length&&row.selectedOriginal&&!row.reason).map(row=>[row.component.componentId,describeSyncedBothComponent({
    local:input.local,remote:input.remote,selectedOriginal:row.selectedOriginal!,conflictedKeys:row.conflictedKeys,component:bothMutableComponent(row),sourceLinks})]))
  const allocation:T.SyncedBothAllocation={kind:'synced-exchange-both-allocation',version:1,previewId,allocatedAt:now,documents:[],groups:[],blocks:[],instances:[],entities:[],missing:[]}
  // No reservation or physical row is created. These UUIDs are merely stable private candidates.
  const offeredDocs=new Map<string,Extract<ReturnType<typeof describeSyncedBothComponent>,{status:'eligible'}>['copyDocuments'][number]>(),offeredGroups=new Map<string,Extract<ReturnType<typeof describeSyncedBothComponent>,{status:'eligible'}>['groups'][number]>()
  for(const description of descriptions.values())if(description.status==='eligible') {for(const row of description.copyDocuments)offeredDocs.set(row.sourceDocumentId,row);for(const row of description.groups)offeredGroups.set(row.sourceGroupId,row)}
  const docIds=new Map(sort(offeredDocs.keys()).map(id=>[id,randomUUID()])),groupIds=new Map(sort(offeredGroups.keys()).map(id=>[id,randomUUID()]))
  const used=new Set<string>()
  for(const {record} of input.local.records)if(record.kind==='document')used.add(publicationJson([record.parentId,record.content.title.replace(/[A-Z]/g,v=>v.toLowerCase())]))
  for(const {record} of input.remote.records)if(record.kind==='document')used.add(publicationJson([record.parentId,record.content.title.replace(/[A-Z]/g,v=>v.toLowerCase())]))
  const documents=new Map<string,T.SyncedBothAllocation['documents'][number]>()
  function allocateDoc(id:string):T.SyncedBothAllocation['documents'][number] {
    const old=documents.get(id);if(old)return old
    const record=local.get('doc:'+id)?.record;if(record?.kind!=='document')return publicationInvalid('both copy来源缺实际L。')
    const documentId=docIds.get(id)!,parentId=record.parentId===null?null:offeredDocs.has(record.parentId)?allocateDoc(record.parentId).documentId:record.parentId
    const suffix='（本机分叉）',base=record.content.title.length+suffix.length<=500?record.content.title+suffix:'本机分叉 '+documentId
    let title=base,index=0
    while(used.has(publicationJson([parentId,title.replace(/[A-Z]/g,v=>v.toLowerCase())]))) {index++;title=base+' '+index;if(title.length>500)title='本机分叉 '+documentId+' '+index}
    used.add(publicationJson([parentId,title.replace(/[A-Z]/g,v=>v.toLowerCase())]))
    const row={sourceDocumentId:id,documentId,createdAt:now,title,parentId,path:''};documents.set(id,row);return row
  }
  for(const id of docIds.keys())allocateDoc(id)
  const originalPaths=documentPaths(input.remote.records.map(row=>row.record))
  const byNewId=new Map([...documents.values()].map(row=>[row.documentId,row]))
  function copyPath(row:T.SyncedBothAllocation['documents'][number]):string {if(row.path)return row.path
    const parent=row.parentId===null?'':byNewId.has(row.parentId)?copyPath(byNewId.get(row.parentId)!):originalPaths.get(row.parentId)
    if(parent===undefined)return publicationInvalid('both copy parent没有真实最终path。')
    return row.path=parent?parent+'/'+row.title:row.title}
  for(const row of documents.values())copyPath(row)
  allocation.documents=[...documents.values()].sort((a,b)=>publicationCompare(a.sourceDocumentId,b.sourceDocumentId))
  const missing=new Map<string,string>(),missingId=(id:string):string=>{let value=missing.get(id);if(!value){value=randomUUID();missing.set(id,value)}return value}
  for(const id of sort(groupIds.keys())) {const group=local.get('group:'+id)?.record;if(group?.kind!=='synced-group')return publicationInvalid('both group来源缺L。')
    allocation.groups.push({sourceGroupId:id,groupId:groupIds.get(id)!,creationId:randomUUID(),createdAt:now,firstInstanceId:missingId(group.origin.firstInstanceId)})
    for(const block of group.blocks)allocation.blocks.push({sourceOwnerKey:'group:'+id,sourceBlockId:block.id,ownerKey:'group:'+groupIds.get(id)!,blockId:randomUUID(),createdAt:now})
    for(const binding of group.bindings)if(binding.target.kind==='block'&&binding.target.state==='missing')missingId(binding.target.id)
  }
  for(const owner of sourceLinks)for(const link of owner.links)if(link.target.kind==='block'&&link.target.state==='missing')missingId(link.target.id)
  const instances=new Map<string,T.SyncedBothAllocation['instances'][number]>()
  function addInstance(id:string,child:{id:string;content:string},destination:'existing'|'copied'):void {
    const sourceGroupId=parseSyncedBlockPayload(child.content).groupId,groupId=groupIds.get(sourceGroupId)??sourceGroupId
    const selector={sourceDocumentId:id,sourceInstanceId:child.id,destination},key=B.bothHostSelectorKey(selector)
    if(instances.has(key))return
    instances.set(key,{...selector,documentId:destination==='copied'?docIds.get(id)!:id,instanceId:randomUUID(),groupId,createdAt:now})
  }
  for(const [id,copy]of documents){const record=local.get('doc:'+id)!.record;if(record.kind!=='document')return publicationInvalid('both doc来源kind改变。')
    for(const block of record.content.blocks)if(block.type==='synced-block')addInstance(id,block,'copied')
    else allocation.blocks.push({sourceOwnerKey:'doc:'+id,sourceBlockId:block.id,ownerKey:'doc:'+copy.documentId,blockId:randomUUID(),createdAt:now})}
  for(const group of offeredGroups.values())for(const host of group.hosts)if(host.destination==='existing'){const doc=local.get('doc:'+host.sourceDocumentId)?.record
    if(doc?.kind!=='document')return publicationInvalid('both occurrence来源宿主缺失。')
    const child=doc.content.blocks.find(row=>row.id===host.sourceInstanceId);if(!child||child.type!=='synced-block')return publicationInvalid('both occurrence来源不真实。')
    addInstance(doc.id,child,'existing')}
  allocation.instances=[...instances.values()].sort((a,b)=>publicationCompare(B.bothHostSelectorKey(a),B.bothHostSelectorKey(b)))
  const catalog=local.get('databases')?.record
  if(catalog?.kind!=='databases')return publicationInvalid('both缺完整实际catalog。')
  for(const row of catalog.tables.database_entities)if(typeof row.document_id==='string'&&documents.has(row.document_id)) {
    if(typeof row.id!=='string')return publicationInvalid('both entity源ID损坏。')
    allocation.entities.push({sourceEntityId:row.id,entityId:randomUUID(),createdAt:now})}
  allocation.entities.sort((a,b)=>publicationCompare(a.sourceEntityId,b.sourceEntityId));allocation.blocks.sort((a,b)=>publicationCompare(publicationJson([a.sourceOwnerKey,a.sourceBlockId]),publicationJson([b.sourceOwnerKey,b.sourceBlockId])))
  allocation.missing=[...missing].map(([sourceId,id])=>({sourceId,id})).sort((a,b)=>publicationCompare(a.sourceId,b.sourceId))
  const checked=B.validateBothAllocation(allocation),entityMaps=new Map(checked.entities.map(row=>[row.sourceEntityId,row])),groupMaps=new Map(checked.groups.map(row=>[row.sourceGroupId,row]))
  const components:T.SyncedExchangeBothPreviewComponent[]=[],selections:B.BothPrivateSelection[]=[]
  for(const fact of facts) {
    if(!fact.conflictedKeys.length&&!fact.reason)continue
    const description=descriptions.get(fact.component.componentId),eligible=description?.status==='eligible'
    const component:T.SyncedExchangeBothPreviewComponent={...fact.component,records:fact.records.map(({key,baseHash,localHash,remoteHash})=>({key,baseHash,localHash,remoteHash})),reason:fact.reason??(description?.status==='blocked'?description.reason:null),choices:eligible?['both']:[],copyDocuments:[],groups:[],entities:[]}
    if(eligible){
      for(const source of description.copyDocuments){const copy=documents.get(source.sourceDocumentId)!,doc=local.get('doc:'+source.sourceDocumentId)!.record
        if(doc.kind!=='document')return publicationInvalid('both copy来源不真实。')
        const requiredCopyDocumentIds=sort([...source.requiredCopyDocumentIds,...(doc.parentId!==null&&offeredDocs.has(doc.parentId)?[doc.parentId]:[])])
        component.copyDocuments.push({...source,...copy,sourceTitle:doc.content.title,requiredCopyDocumentIds})
      }
      for(const source of description.groups){const group=groupMaps.get(source.sourceGroupId)!
        component.groups.push({...source,...group,hosts:source.hosts.map(host=>{const mapped=instances.get(B.bothHostSelectorKey(host))!
          return {...host,documentId:mapped.documentId,instanceId:mapped.instanceId}})})}
      const copied=new Set(component.copyDocuments.map(row=>row.sourceDocumentId))
      component.entities=catalog.tables.database_entities.filter(row=>typeof row.document_id==='string'&&copied.has(row.document_id)).map(row=>{
        if(typeof row.id!=='string'||typeof row.document_id!=='string'||typeof row.database_id!=='string'||typeof row.title!=='string')return publicationInvalid('both display entity来源损坏。')
        return {sourceEntityId:row.id,entityId:entityMaps.get(row.id)!.entityId,sourceDocumentId:row.document_id,databaseId:row.database_id,title:row.title}}).sort((a,b)=>publicationCompare(a.sourceEntityId,b.sourceEntityId))
    }
    // The public destination fields are exact; private birth/Origin fields never leak into the DTO.
    component.copyDocuments=component.copyDocuments.map(row=>({sourceDocumentId:row.sourceDocumentId,sourceHash:row.sourceHash,sourceTitle:row.sourceTitle,documentId:row.documentId,title:row.title,parentId:row.parentId,path:row.path,required:row.required,requiredCopyDocumentIds:row.requiredCopyDocumentIds,requiredGroupIds:row.requiredGroupIds}))
    component.groups=component.groups.map(row=>({sourceGroupId:row.sourceGroupId,sourceHash:row.sourceHash,groupId:row.groupId,creationId:row.creationId,createdAt:row.createdAt,required:row.required,hosts:row.hosts}))
    // A required catalog copy is trialled through the actual typed transformer before it is advertised.
    if(eligible&&fact.selectedOriginal){
      const copies=new Set(component.copyDocuments.filter(row=>row.required).map(row=>row.sourceDocumentId));let expanded=true
      while(expanded){expanded=false;for(const copy of component.copyDocuments)if(copies.has(copy.sourceDocumentId))for(const id of copy.requiredCopyDocumentIds)if(!copies.has(id)){copies.add(id);expanded=true}}
      const needed=new Set(component.groups.filter(row=>row.required).map(row=>row.sourceGroupId))
      for(const doc of component.copyDocuments)if(copies.has(doc.sourceDocumentId))doc.requiredGroupIds.forEach(id=>needed.add(id))
      const decision:T.SyncedExchangeBothDecision={componentId:component.componentId,copyDocumentIds:sort(copies),groups:component.groups.filter(row=>needed.has(row.sourceGroupId)).map(row=>({groupId:row.sourceGroupId,hosts:row.hosts.filter(host=>host.destination==='copied'&&copies.has(host.sourceDocumentId)).map(({required:_required,documentId:_doc,instanceId:_instance,...host})=>host)}))}
      const trialSelection:B.BothPrivateSelection={preview:component,decision,component:fact.component,allocation:checked,poolAllocation:checked,sourceLinks,conflictedKeys:fact.conflictedKeys}
      const trialAllocation=effectiveBothAllocation([trialSelection])
      const trial=planSyncedBothFork({local:input.local,remote:input.remote,component:bothMutableComponent(fact),selectedOriginal:fact.selectedOriginal,conflictedKeys:fact.conflictedKeys,sourceLinks,
        retainedLocal:input.local,retainedRemote:input.remote,decision,allocation:trialAllocation})
      if(trial.status==='blocked'){component.reason=trial.reason;component.choices=[]}
    }
    const final=B.validateBothPreviewComponent(component);components.push(final)
    if(final.choices.includes('both'))selections.push({preview:final,decision:{componentId:final.componentId,copyDocumentIds:[],groups:[]},component:fact.component,allocation:checked,poolAllocation:checked,sourceLinks,conflictedKeys:fact.conflictedKeys})
  }
  components.sort((a,b)=>publicationCompare(a.componentId,b.componentId));selections.sort((a,b)=>publicationCompare(a.component.componentId,b.component.componentId))
  return {components,allocation:checked,selections}
}
function validateBothSelector(preview:T.SyncedExchangeBothPreviewComponent,decision:T.SyncedExchangeBothDecision):void {
  if(!preview.choices.includes('both')||preview.componentId!==decision.componentId)return publicationInvalid('both决定不属于原可执行组件。')
  const docs=new Map(preview.copyDocuments.map(row=>[row.sourceDocumentId,row])),copied=new Set(decision.copyDocumentIds),groups=new Map(preview.groups.map(row=>[row.sourceGroupId,row])),selectedGroups=new Map(decision.groups.map(row=>[row.groupId,row]))
  if(decision.copyDocumentIds.some(id=>!docs.has(id))||preview.copyDocuments.some(row=>row.required&&!copied.has(row.sourceDocumentId)))return publicationInvalid('both copy selectors遗漏/超出原展示。')
  for(const id of copied){const row=docs.get(id)!
    if(row.requiredCopyDocumentIds.some(id=>!copied.has(id))||row.requiredGroupIds.some(id=>!selectedGroups.has(id)))return publicationInvalid('both copy closure未显式完整选择。')}
  if(decision.groups.some(row=>!groups.has(row.groupId))||preview.groups.some(row=>row.required&&!selectedGroups.has(row.sourceGroupId)))return publicationInvalid('both group selectors遗漏/超出原展示。')
  for(const selected of decision.groups){const shown=groups.get(selected.groupId)!,hosts=new Map(shown.hosts.map(row=>[B.bothHostSelectorKey(row),row])),keys=new Set(selected.hosts.map(B.bothHostSelectorKey))
    if(selected.hosts.some(row=>!hosts.has(B.bothHostSelectorKey(row))||row.destination==='copied'&&!copied.has(row.sourceDocumentId))||shown.hosts.some(row=>row.required&&!keys.has(B.bothHostSelectorKey(row))))return publicationInvalid('both宿主selectors不在准确闭合集合。')
    for(const doc of copied)for(const row of shown.hosts)if(row.sourceDocumentId===doc&&row.destination==='copied'&&!keys.has(B.bothHostSelectorKey(row)))return publicationInvalid('both复制宿主的fork occurrence未显式选择。')
  }
}
function readBothSelections(value:unknown,request:M.ExchangeRequest):B.BothPrivateSelection[] {
  M.assertExchangeData(value);assertSyncedShape(value,['allocation','poolAllocation','sourceLinks','selections'])
  if(!Array.isArray(value.selections)||request.method!=='resolveSyncedExchangeBoth')return publicationInvalid('both私有selector来源不符。')
  const allocation=B.validateBothAllocation(value.allocation),poolAllocation=B.validateBothAllocation(value.poolAllocation),sourceLinks=B.validateBothSourceLinks(value.sourceLinks)
  const result=value.selections.map(raw=>{assertSyncedShape(raw,['preview','decision','component','conflictedKeys'])
    const preview=B.validateBothPreviewComponent(raw.preview),decision=B.validateBothDecisions([raw.decision])[0],componentRaw=raw.component
    assertSyncedShape(componentRaw,['keys','localSignature','remoteSignature','dependencySignature','componentId'])
    const component={...M.validateExchangeComponent({keys:componentRaw.keys,localSignature:componentRaw.localSignature,remoteSignature:componentRaw.remoteSignature,dependencySignature:componentRaw.dependencySignature}),componentId:preview.componentId}
    if(componentRaw.componentId!==preview.componentId||!same(component.keys,preview.keys))return publicationInvalid('both原component身份不闭合。')
    validateBothSelector(preview,decision)
    return {preview,decision,component,allocation,poolAllocation,sourceLinks,conflictedKeys:M.exchangeKeys(raw.conflictedKeys)}})
  if(!same(B.validateBothDecisions(result.map(row=>row.decision)),request.decisions))return publicationInvalid('both原request selectors与inputs不等。')
  const effective=effectiveBothAllocation(result)
  if(result.some(row=>!same(row.allocation,effective)))return publicationInvalid('both effective Origin不是原候选池与selectors的唯一派生。')
  return result
}
function storedBothSelections(selections:B.BothPrivateSelection[]):unknown {
  const first=selections[0];if(!first)return publicationInvalid('both缺原已接受selector。')
  if(selections.some(row=>row.allocation!==first.allocation&&!same(row.allocation,first.allocation)||row.poolAllocation!==first.poolAllocation&&!same(row.poolAllocation,first.poolAllocation)||row.sourceLinks!==first.sourceLinks&&!same(row.sourceLinks,first.sourceLinks)))return publicationInvalid('both多个组件混用私有候选来源。')
  return {allocation:first.allocation,poolAllocation:first.poolAllocation,sourceLinks:first.sourceLinks,selections:selections.map(({preview,decision,component,conflictedKeys})=>({preview,decision,component,conflictedKeys}))}
}
function effectiveBothAllocation(selections:B.BothPrivateSelection[]):T.SyncedBothAllocation {
  const pool=selections[0]?.poolAllocation;if(!pool)return publicationInvalid('both无真实候选池。')
  if(selections.some(row=>!same(row.poolAllocation,pool)))return publicationInvalid('both不同selector混用候选池。')
  const groups=pool.groups.map(group=>{
    const chosen=selections.flatMap(row=>row.decision.groups.filter(row=>row.groupId===group.sourceGroupId).flatMap(row=>row.hosts))
    const sourceFirst=pool.missing.find(row=>row.id===group.firstInstanceId)?.sourceId
    if(sourceFirst===undefined)return publicationInvalid('both原first fallback缺真实来源。')
    const candidates=pool.instances.filter(row=>row.groupId===group.groupId&&row.sourceInstanceId===sourceFirst&&chosen.some(host=>B.bothHostSelectorKey(host)===B.bothHostSelectorKey(row)))
    candidates.sort((a,b)=>(a.destination==='copied'?0:1)-(b.destination==='copied'?0:1)||publicationCompare(B.bothHostSelectorKey(a),B.bothHostSelectorKey(b)))
    return {...group,firstInstanceId:candidates[0]?.instanceId??group.firstInstanceId}
  })
  return B.validateBothAllocation({...pool,groups})
}
async function loadBothPreview(db:Database.Database,c:Context,previewId:string):Promise<BothStoredPreview|null> {
  const knowledgeIndex=db.transaction(()=>{current(db,c);return readKnowledgePreviewIndex(db,'both',previewId,c.request)})()
  if(knowledgeIndex)return loadKnowledgeBothPreview(db,c,knowledgeIndex)
  const index=db.transaction(()=>{current(db,c);return readSyncedBothPreviewIndex(db,previewId,c.request)})()
  if(!index)return null
  if(index.workspaceScope!==c.workspaceScope||index.recoveryEpoch!==c.recoveryEpoch)return unavailable('both原preview属于其它scope/epoch。')
  const dir=bothDirectory(c,previewId),file=join(dir,'preview.json');safe(file,c.root)
  if(!lstatSync(file).isFile())return publicationInvalid('both原preview不是regular文件。')
  const bytes=await readFile(file);if(publicationHash(bytes)!==index.previewHash)return publicationInvalid('both原preview bytes/index不闭合。')
  const value=M.parseExchangeStored(bytes.toString('utf8'))
  assertSyncedShape(value,['kind','version','previewId','databasePath','target','workspaceScope','recoveryEpoch','createdAt','local','remote','baseRecords','state','authority','keyGuards','stateRaw','localFingerprint','components','allocation','sourceLinks','componentFacts'])
  if(value.kind!=='synced-exchange-both-preview-inputs'||value.version!==1||value.previewId!==previewId||value.databasePath!==c.databasePath||!same(value.target,c.target)
    ||value.workspaceScope!==index.workspaceScope||value.recoveryEpoch!==index.recoveryEpoch||value.createdAt!==index.createdAt)return publicationInvalid('both原preview来源损坏。')
  const allocation=B.validateBothAllocation(value.allocation),sourceLinks=B.validateBothSourceLinks(value.sourceLinks),local=strictBothSnapshot(value.local),remote=strictBothSnapshot(value.remote),state=M.validateExchangeState(value.state)
  if(B.bothAllocationHash(allocation)!==index.allocationHash||!Array.isArray(value.baseRecords)||typeof value.localFingerprint!=='string')return publicationInvalid('both原allocation/B损坏。')
  const baseRecords=value.baseRecords.map(row=>{assertSyncedShape(row,['key','hash','record']);if(typeof row.key!=='string'||typeof row.hash!=='string'||publicationHash(publicationJson(row.record))!==row.hash)return publicationInvalid('both原B对象损坏。');return {key:row.key,hash:row.hash,record:validateSyncedProtocol5Record(row.record,row.key)}})
  assertSyncedShape(value.authority,['catalogId','identities','occupiedDocumentIds','historyComponents','pinnedGroupIds','knownGroupIds','missingBaseKeys','deferredKeys'],['keyGuards'])
  const authorityData=value.authority as unknown as ReturnType<typeof authority>,componentFacts=deriveBothComponents({operationId:previewId,local,remote,baseRecords,state,localFingerprint:value.localFingerprint,authority:authorityData},sourceLinks)
  if(!same(value.componentFacts,componentFacts.map(row=>({component:row.component,records:row.records,conflictedKeys:row.conflictedKeys,reason:row.reason}))))return publicationInvalid('both原组件/真实B来源不符。')
  if(!Array.isArray(value.components))return publicationInvalid('both原展示缺失。')
  const components=value.components.map(B.validateBothPreviewComponent).sort((a,b)=>publicationCompare(a.componentId,b.componentId))
  const byComponent=new Map(componentFacts.map(row=>[row.component.componentId,row]))
  const selections:B.BothPrivateSelection[]=components.filter(row=>row.choices.includes('both')).map(preview=>{
    const facts=byComponent.get(preview.componentId);if(!facts?.selectedOriginal||facts.reason)return publicationInvalid('both原展示无合法来源。')
    const described=describeSyncedBothComponent({local,remote,component:facts.component,selectedOriginal:facts.selectedOriginal,conflictedKeys:facts.conflictedKeys,sourceLinks})
    if(described.status!=='eligible')return publicationInvalid('both原展示不再可重现。')
    if(!same(described.groups.map(row=>[row.sourceGroupId,row.sourceHash,row.required,row.hosts]),preview.groups.map(row=>[row.sourceGroupId,row.sourceHash,row.required,row.hosts.map(({documentId:_doc,instanceId:_instance,...row})=>row)])))return publicationInvalid('both原宿主闭集展示损坏。')
    return {preview,decision:{componentId:preview.componentId,copyDocumentIds:[],groups:[]},component:facts.component,allocation,poolAllocation:allocation,sourceLinks,conflictedKeys:facts.conflictedKeys}})
  const facts=B.validateBothPreview({kind:'synced-exchange-both-preview',version:1,previewId,previewHash:index.previewHash,workspaceScope:index.workspaceScope,recoveryEpoch:index.recoveryEpoch,
    remoteWorkspaceId:remote.manifest.workspaceId,targetFingerprint:index.targetFingerprint,stateGeneration:state.generation,remoteManifestHash:publicationHash(publicationJson(remote.manifest)),createdAt:index.createdAt,components})
  const final=db.transaction(()=>{current(db,c);return readSyncedBothPreviewIndex(db,previewId,c.request)})()
  if(!same(final,index))return publicationInvalid('both读取期间原index变更。')
  return {index,facts,allocation,selections}
}
async function attachBothPreview(db:Database.Database,c:Context,request:B.BothRequest):Promise<void> {
  const loaded=await loadBothPreview(db,c,request.previewId);if(!loaded)return unavailable('both缺真实Main私有preview。')
  const byId=new Map(loaded.selections.map(row=>[row.component.componentId,row]))
  const selections=request.decisions.map(decision=>{const source=byId.get(decision.componentId);if(!source)return publicationInvalid('both selector不在原可执行preview。');validateBothSelector(source.preview,decision);return {...source,decision}})
  const allocation=effectiveBothAllocation(selections)
  c.knowledgeMode=loaded.index.version===2?6:null
  c.both={resolution:B.validateBothResolution({previewId:request.previewId,previewHash:loaded.index.previewHash,decisionsHash:publicationHash(publicationJson(request.decisions)),allocationHash:B.bothAllocationHash(allocation)}),selections:selections.map(row=>({...row,allocation}))}
}
async function createBothPreview(db:Database.Database,c:Context,previewId:string,runtime:SyncedExchangeRuntime):Promise<T.SyncedExchangeBothPreviewResult> {
  if(db.pragma('user_version',{simple:true})===26)return Object.freeze({status:'unsupported',reason:'schema-27-required'})
  if(db.pragma('user_version',{simple:true})!==27)return publicationInvalid('both preview schema无效。')
  const existing=await loadBothPreview(db,c,previewId);if(existing)return frozenPublicationFacts({status:'ready',preview:existing.facts})
  if(manualKnowledge(capture(db,c)))return createKnowledgeBothPreview(db,c,previewId,runtime)
  const prepared=await prepare(db,c,runtime);if(!('plan'in prepared)) {
    if(prepared.status==='missing'||prepared.status==='unsupported'||prepared.status==='stale')return frozenPublicationFacts(prepared)
    return publicationInvalid('both preview不接受已有结算结果。')}
  const now=new Date().toISOString(),built=buildBothPreview(prepared,previewId,now),sourceLinks=captureBothSources(db,c,prepared.localWire),input=planInput(prepared),dir=bothDirectory(c,previewId)
  const payload={kind:'synced-exchange-both-preview-inputs',version:1,previewId,databasePath:c.databasePath,target:c.target,workspaceScope:c.workspaceScope,recoveryEpoch:c.recoveryEpoch,createdAt:now,
    local:snapshotData(input.local),remote:snapshotData(input.remote),baseRecords:input.baseRecords,state:input.state,authority:input.authority,keyGuards:prepared.local.keyGuards,stateRaw:prepared.local.stateRaw,localFingerprint:prepared.local.fingerprint,
    components:built.components,allocation:built.allocation,sourceLinks,componentFacts:deriveBothComponents(input,sourceLinks).map(row=>({component:row.component,records:row.records,conflictedKeys:row.conflictedKeys,reason:row.reason}))}
  const bytes=Buffer.from(publicationJson(payload)),previewHash=publicationHash(bytes),index=B.validateBothPreviewIndex({kind:'synced-exchange-both-preview-index',version:1,previewId,databasePath:c.databasePath,
    targetFingerprint:c.request.targetFingerprint,workspaceScope:c.workspaceScope,recoveryEpoch:c.recoveryEpoch,previewHash,allocationHash:B.bothAllocationHash(built.allocation),createdAt:now})
  const facts=B.validateBothPreview({kind:'synced-exchange-both-preview',version:1,previewId,previewHash,workspaceScope:c.workspaceScope,recoveryEpoch:c.recoveryEpoch,remoteWorkspaceId:prepared.remote.manifest.workspaceId,
    targetFingerprint:c.request.targetFingerprint,stateGeneration:prepared.state.generation,remoteManifestHash:prepared.remote.manifestHash,createdAt:now,components:built.components})
  safe(dir,c.root);await mkdir(join(c.root,'storage','synced-exchange-both-previews-v1'),{recursive:true,mode:0o700});await mkdir(dir,{mode:0o700});safe(dir,c.root)
  await durable(join(dir,'preview.json'),bytes);await syncDirectory(dir)
  const installed=db.transaction(()=>{current(db,c);if(capture(db,c).fingerprint!==prepared.local.fingerprint)return false;putImmutable(db,B.bothPreviewKey(previewId),index,now);return true}).immediate()
  return installed?frozenPublicationFacts({status:'ready',preview:facts}):Object.freeze({status:'stale',side:'local'})
}
function usedBothAllocation(saved:Spool):T.SyncedBothAllocation|null {
  if(saved.job.version!==3&&saved.job.version!==6)return null
  const allocation=saved.planning.bothSelections[0]?.allocation;if(!allocation)return publicationInvalid('both原job缺固定map。')
  const summaries=saved.job.forks?.map(row=>row.summary)??[],docs=new Set(summaries.flatMap(row=>row.documents.map(row=>row.documentId))),groups=new Set(summaries.flatMap(row=>row.groups.map(row=>row.groupId))),instances=new Set(summaries.flatMap(row=>row.instances.map(row=>row.instanceId))),entities=new Set(summaries.flatMap(row=>row.entities.map(row=>row.entityId)))
  const used=new Set<string>()
  for(const {record}of saved.plan.localFinal.records)if(record.kind==='synced-group'&&groups.has(record.id)) {used.add(record.origin.firstInstanceId);for(const binding of record.bindings)if(binding.target.kind==='block'&&binding.target.state==='missing')used.add(binding.target.id)}
  return {...allocation,documents:allocation.documents.filter(row=>docs.has(row.documentId)),groups:allocation.groups.filter(row=>groups.has(row.groupId)),
    blocks:allocation.blocks.filter(row=>row.ownerKey.startsWith('doc:')?docs.has(row.ownerKey.slice(4)):groups.has(row.ownerKey.slice(6))),instances:allocation.instances.filter(row=>instances.has(row.instanceId)),entities:allocation.entities.filter(row=>entities.has(row.entityId)),missing:allocation.missing.filter(row=>used.has(row.id))}
}
const bothBirths=new WeakMap<Spool,Map<string,string>>()
function allocatedPhysicalBirth(saved:Spool,id:string,fallback:string):string {
  if(saved.job.version!==3&&saved.job.version!==6)return fallback
  let births=bothBirths.get(saved)
  if(!births){const allocation=saved.planning.bothSelections[0]?.allocation;births=new Map([...(allocation?.blocks??[]).map(row=>[row.blockId,row.createdAt] as const),...(allocation?.instances??[]).map(row=>[row.instanceId,row.createdAt] as const)]);bothBirths.set(saved,births)}
  // Only truly new fork IDs require a fixed birth. Unrelated ordinary incoming IDs retain the old bounded behavior.
  return births.get(id)??fallback
}
function bothCollisions(db:Database.Database,c:Context,saved:Spool):T.SyncedExchangeBothPublishedBlock['collisions'] {
  const allocation=usedBothAllocation(saved);if(!allocation)return []
  return db.transaction(()=>{current(db,c);const local=capture(db,c),result=readSyncedBothIdentityCollisions(db,allocation,local.occupiedDocumentIds)
    const finalPaths=documentPaths(saved.plan.localFinal.records.map(row=>row.record)),incoming=new Set(saved.plan.incoming)
    const wanted=new Map(allocation.documents.map(row=>[row.path,row]))
    for(const row of db.prepare('SELECT id,path FROM documents').all() as Array<{id:string;path:string}>){const target=wanted.get(row.path)
      if(target&&row.id!==target.documentId&&!(incoming.has('doc:'+row.id)&&finalPaths.get(row.id)!==row.path))result.push({kind:'path',id:target.path})}
    return [...new Map(result.map(row=>[publicationJson([row.kind,row.id]),row])).values()].sort((a,b)=>publicationCompare(publicationJson([a.kind,a.id]),publicationJson([b.kind,b.id])))})()
}
function blockPublishedBoth(db:Database.Database,c:Context,saved:Spool,etag:string,collisions:T.SyncedExchangeBothPublishedBlock['collisions']):T.SyncedExchangeBothPublishedBlock {
  if((saved.job.version!==3&&saved.job.version!==6)||!saved.job.resolution)return publicationInvalid('旧job不能伪both blocker。')
  const resolution=B.validateBothResolution(saved.job.resolution),reason=collisions.some(row=>row.kind==='path')?'path-collision':collisions.some(row=>row.kind==='entity')?'catalog-collision':collisions.length?'identity-collision':'source-stale'
  const result=B.validateBothPublishedBlock({status:'blocked',stage:'published-local',reason,operationId:c.request.operationId,attemptId:saved.job.attemptId,allocationHash:resolution.allocationHash,
    publishedManifestHash:saved.job.descriptor.next.manifestHash,publishedManifestETag:etag,componentIds:sort(saved.job.forks?.map(row=>row.componentId)??[]),collisions})
  db.transaction(()=>{current(db,c);phase(db,saved.job,'blocked',etag,result)}).immediate()
  return frozenPublicationFacts(result)
}
async function historicalBothPublication(db:Database.Database,c:Context,saved:Spool,runtime:SyncedExchangeRuntime):Promise<{etag:string;blocked:T.SyncedExchangeBothPublishedBlock|null}|null> {
  const facts=db.transaction(()=>{current(db,c);return phases(db,saved.job)})()
  const confirmed=[...facts].reverse().find(row=>['remote-confirmed','published-local-deferred','blocked','settled'].includes(row.phase)&&row.remoteEtag!==null)
  if(confirmed)return {etag:confirmed.remoteEtag!,blocked:confirmed.phase==='blocked'?confirmed.blocked??null:null}
  if(facts.at(-1)!.phase==='prepared')return null
  const client=new WebDavClient(c.target,runtime.password,runtime.signal),actual=await network(()=>client.getVersioned('manifest.json',PUBLICATION_RECORD_MAX_BYTES))
  if(actual&&publicationHash(actual.bytes)===saved.job.descriptor.next.manifestHash){confirm(db,c,saved,actual.etag);return {etag:actual.etag,blocked:null}}
  return null
}
async function runBoth(db:Database.Database,c:Context,runtime:SyncedExchangeRuntime):Promise<T.SyncedExchangeBothResult> {
  const replay=db.transaction(()=>readSyncedExchangeReceipt(db,c.request))()
  if(replay){if((replay.version!==3&&replay.version!==6)||!replay.result.forks)return publicationInvalid('both原收据不能跨版本授票。');return frozenPublicationFacts({...replay.result,replayed:true,forks:replay.result.forks})}
  if(db.pragma('user_version',{simple:true})===26)return Object.freeze({status:'unsupported',reason:'schema-27-required'})
  if(db.pragma('user_version',{simple:true})!==27)return publicationInvalid('both未知schema。')
  const first=capture(db,c),originalGuards=first.keyGuards
  let head=db.transaction(()=>readHead(db,c))(),saved=head?await loadSpool(db,c,head):null,deferredKeys:string[]=[]
  if(saved){if((saved.job.version!==3&&saved.job.version!==6)||!saved.job.resolution)return publicationInvalid('both不能继承旧版本job。');c.knowledgeMode=saved.job.version===6?6:null;c.both={resolution:B.validateBothResolution(saved.job.resolution),selections:saved.planning.bothSelections}}
  else {if(c.request.method!=='resolveSyncedExchangeBoth')return publicationInvalid('both方法不一致。');await attachBothPreview(db,c,c.request)}
  for(let turn=0;turn<8;turn++) {
    aborted(runtime.signal)
    if(!saved){const prepared=await prepare(db,c,runtime,deferredKeys,c.knowledgeMode===6?6:3)
      if(!('plan'in prepared)){if(prepared.status==='stale'&&prepared.side==='local'){deferredKeys=sort([...deferredKeys,...changedKeys(originalGuards,capture(db,c).keyGuards)]);continue}
        if(prepared.status==='missing'||prepared.status==='unsupported'||prepared.status==='stale')return frozenPublicationFacts(prepared)
        return publicationInvalid('both prepare返回非读取结果。')}
      const raced=changedKeys(originalGuards,prepared.local.keyGuards)
      if(raced.some(key=>!deferredKeys.includes(key))){deferredKeys=sort([...deferredKeys,...raced]);continue}
      saved=await spool(prepared,head)
      if(!registerJob(db,c,saved,head)){saved=null;deferredKeys=sort([...deferredKeys,...changedKeys(originalGuards,capture(db,c).keyGuards)]);head=db.transaction(()=>readHead(db,c))();continue}
      head=db.transaction(()=>readHead(db,c))()
    }
    // Historical confirmation precedes any temptation to discard the fixed allocation after local drift.
    const historical=await historicalBothPublication(db,c,saved,runtime)
    if(historical?.blocked)return frozenPublicationFacts(historical.blocked)
    const now=capture(db,c),collisions=bothCollisions(db,c,saved)
    if(historical&&(now.fingerprint!==saved.localFingerprint||collisions.length))return blockPublishedBoth(db,c,saved,historical.etag,collisions)
    if(!historical&&now.fingerprint!==saved.localFingerprint){deferredKeys=sort([...deferredKeys,...changedKeys(saved.planning.keyGuards,now.keyGuards)]);saved=null;continue}
    let remote:{status:'confirmed';etag:string}|{status:'retry'}|{status:'stale'}
    if(historical)remote={status:'confirmed',etag:historical.etag}
    else if(!saved.plan.writes.length){const client=new WebDavClient(c.target,runtime.password,runtime.signal),actual=await network(()=>client.getVersioned('manifest.json',PUBLICATION_RECORD_MAX_BYTES))
      remote=actual&&publicationHash(actual.bytes)===saved.job.descriptor.expectedRemote.manifestHash&&actual.etag===saved.job.descriptor.expectedRemote.etag?{status:'confirmed',etag:actual.etag}:{status:'retry'}}
    else remote=await publish(db,c,saved,runtime)
    if(remote.status!=='confirmed'){if(remote.status==='stale')deferredKeys=sort([...deferredKeys,...changedKeys(saved.planning.keyGuards,capture(db,c).keyGuards)]);saved=null;continue}
    aborted(runtime.signal)
    const finalCollisions=bothCollisions(db,c,saved),final=capture(db,c)
    if(finalCollisions.length||final.fingerprint!==saved.localFingerprint)return blockPublishedBoth(db,c,saved,remote.etag,finalCollisions)
    publishAliases(c,saved);verifyAliases(c,saved.job.descriptor.next.assets)
    let settled:M.SyncedExchangeAccepted|null
    try{settled=settle(db,c,saved,remote.etag)}catch(cause){
      try{db.transaction(()=>{current(db,c);phase(db,saved!.job,'published-local-deferred',remote.etag)}).immediate()}
      catch(recording){throw new SyncedPublicationError('database','both远端已发布；本机SQL与失败记录均失败，固定原job保持。',{cause,recording})}
      throw cause instanceof SyncedPublicationError?cause:new SyncedPublicationError('database','both远端已发布但本机SQL回滚；固定map可原operation重开。',cause)}
    if(settled){if(!settled.forks)return publicationInvalid('both真实结算缺fork摘要。');return frozenPublicationFacts({...settled,forks:settled.forks})}
    return blockPublishedBoth(db,c,saved,remote.etag,bothCollisions(db,c,saved))
  }
  return Object.freeze({status:'stale',side:'remote'})
}
export async function previewSyncedExchangeBoth(db:Database.Database,input:T.SyncedExchangeBothPreviewInput,options:SyncedExchangeRuntime):Promise<T.SyncedExchangeBothPreviewResult> {
  let c:Context|null=null,key:string|null=null,owns=false
  try{M.assertExchangeData(input);assertSyncedShape(input,['previewId','userDataRoot','target']);if(!isSyncedUuid(input.previewId))return publicationInvalid('both previewId无效。')
    c=context(db,{operationId:input.previewId,userDataRoot:input.userDataRoot,target:input.target});const runtime=credentials(options);connections.set(c,db)
    key=publicationJson([c.databasePath,c.workspaceScope,c.recoveryEpoch,c.request.targetFingerprint]);if(running.has(key))return unavailable('原本机/target已有真实exchange在途。');running.add(key);owns=true
    return await createBothPreview(db,c,input.previewId,runtime)
  }catch(cause){if(cause instanceof SyncedPublicationError)throw cause;throw new SyncedPublicationError(cause instanceof Error&&/SQLITE|sqlite|database|constraint|trigger/i.test(cause.message)?'database':'invalid','both真实预览失败；已完成观察事实不撤回。',cause)}
  finally{if(key&&owns)running.delete(key);if(c)connections.delete(c)}
}
export async function resolveSyncedExchangeBoth(db:Database.Database,input:T.SyncedExchangeBothResolveInput,options:SyncedExchangeRuntime):Promise<T.SyncedExchangeBothResult> {
  let c:Context|null=null,key:string|null=null,owns=false
  try{M.assertExchangeData(input);assertSyncedShape(input,['operationId','userDataRoot','target','previewId','decisions']);const decisions=B.validateBothDecisions(input.decisions)
    c=context(db,{operationId:input.operationId,userDataRoot:input.userDataRoot,target:input.target});c.request=M.validateExchangeRequest({...c.request,method:'resolveSyncedExchangeBoth',previewId:input.previewId,decisions})
    const runtime=credentials(options);connections.set(c,db);key=publicationJson([c.databasePath,c.workspaceScope,c.recoveryEpoch,c.request.targetFingerprint])
    if(running.has(key))return unavailable('原本机/target已有真实both/exchange在途。');running.add(key);owns=true
    return await runBoth(db,c,runtime)
  }catch(cause){if(cause instanceof SyncedPublicationError)throw cause;throw new SyncedPublicationError(cause instanceof Error&&/SQLITE|sqlite|database|constraint|trigger|exchange exact late receipt/i.test(cause.message)?'database':'invalid','both真实发布/安装失败；原固定job和曝光事实保持。',cause)}
  finally{if(key&&owns)running.delete(key);if(c)connections.delete(c)}
}

// New knowledge-selection formats never reinterpret saved jobs1--4.
function manualKnowledge(local:SyncedExchangeLocal):boolean {
  return Boolean(local.snapshot.deletions?.length || local.state?.version===2&&local.state.baseline.some(row=>row.local.kind==='absent'))
}
function knowledgeAuthority(local:SyncedExchangeLocal,missingBaseKeys:string[],deferredKeys:string[]=[]):ReturnType<typeof deletionAuthority>&{deletionProofReferences:K.KnowledgeDeletionReference[]} {
  return {...deletionAuthority(local,missingBaseKeys,deferredKeys),deletionProofReferences:(local.snapshot.deletions??[]).map(proof=>({
    key:proof.key,tombstoneHash:proof.tombstoneHash,deletionOperationId:proof.application.operationId,intentHash:proof.intentHash,
    proofHash:publicationHash(publicationJson(proof)),anchorId:proof.persistence.anchorId})).sort((a,b)=>publicationCompare(a.key,b.key))}
}
function knowledgeInput(prepared:Prepared):K.KnowledgePlanInput {
  if(!prepared.localPhysical)return publicationInvalid('knowledge规划缺真实physical图。')
  const planningAuthority=prepared.planningAuthority
  if(!('deletionProofReferences'in planningAuthority)||!('deletedFacts'in planningAuthority)||!('pins'in planningAuthority))
    return publicationInvalid('knowledge规划缺实际capture的proof/pins/denial authority。')
  return {operationId:prepared.context.request.operationId,localPhysical:prepared.localPhysical,localKnowledge:prepared.localWire,remote:fromRemote(prepared.remote),
    baseRecords:prepared.baseRecords,state:M.validateTombstoneExchangeState(prepared.state),localFingerprint:prepared.local.fingerprint,
    authority:planningAuthority,conflictSelections:prepared.context.selections}
}
function makeKnowledgePlan(input:K.KnowledgePlanInput,engine:5|6,selections:B.BothPrivateSelection[]=[],links:T.SyncedBothOwnerSourceLinks[]=[]):KnowledgeRuntimePlan {
  const plan=engine===5?planSyncedKnowledgeConflicts(input):planSyncedKnowledgeForks(input,selections,links)
  return {...plan,localFinal:plan.localPhysicalFinal}
}
async function prepareKnowledge(db:Database.Database,c:Context,runtime:SyncedExchangeRuntime,deferredKeys:string[],engine:5|6):Promise<Prepared|M.SyncedExchangeResult> {
  // One real reader/materialization. The old pure4 result is not installed or registered.
  const base=await prepareTombstone(db,c,runtime,deferredKeys)
  if(!('plan'in base))return base
  const planningAuthority=knowledgeAuthority(base.local,base.planningAuthority.missingBaseKeys,deferredKeys)
  const prepared:Prepared={...base,planningAuthority,engine,bothLinks:engine===6?captureBothSources(db,c,base.localPhysical!):[]}
  const plan=makeKnowledgePlan(knowledgeInput(prepared),engine,c.both?.selections??[],prepared.bothLinks)
  return {...prepared,plan}
}
function bothMutableComponent(fact:{component:T.SyncedBothSourceComponent;fence?:K.KnowledgeComponentFence}):T.SyncedBothSourceComponent {
  return fact.fence?{...fact.component,keys:fact.fence.mutableKeys}:fact.component
}
function knowledgePreviewDirectory(c:Context,mode:KnowledgePreviewMode,previewId:string):string {
  return join(c.root,'storage',mode==='both'?'synced-exchange-both-previews-v2':'synced-exchange-previews-v2',previewId)
}
type KnowledgePreviewData={index:KnowledgePreviewIndex;input:K.KnowledgePlanInput;plan:KnowledgeRuntimePlan;value:Record<string,unknown>;sourceLinks:T.SyncedBothOwnerSourceLinks[]}
async function loadKnowledgePreviewData(db:Database.Database,c:Context,index:KnowledgePreviewIndex,mode:KnowledgePreviewMode):Promise<KnowledgePreviewData> {
  if(index.workspaceScope!==c.workspaceScope||index.recoveryEpoch!==c.recoveryEpoch)return unavailable('knowledge预览属于另一真实scope/recovery世代。')
  const dir=knowledgePreviewDirectory(c,mode,index.previewId),file=join(dir,'preview.json');safe(dir,c.root);safe(file,dir)
  if(!lstatSync(file).isFile())return publicationInvalid('knowledge preview原文件不是regular。')
  const bytes=await readFile(file)
  if(publicationHash(bytes)!==index.previewHash)return publicationInvalid('knowledge preview原bytes/index不闭合。')
  const value=M.parseExchangeStored(bytes.toString('utf8'))
  assertSyncedShape(value,['kind','version','previewId','databasePath','target','workspaceScope','recoveryEpoch','createdAt','local','localPhysical','remote','baseRecords','state',
    'authority','keyGuards','stateRaw','localFingerprint','plannerVersion','knowledgeSource','knowledgeHash','componentFences','components',...(mode==='both'?['allocation','sourceLinks','componentFacts']:[])])
  if(value.kind!==(mode==='both'?'synced-exchange-both-preview-inputs':'synced-exchange-conflict-preview-inputs')||value.version!==2||value.previewId!==index.previewId
    ||value.databasePath!==c.databasePath||!same(value.target,c.target)||value.workspaceScope!==index.workspaceScope||value.recoveryEpoch!==index.recoveryEpoch
    ||value.createdAt!==index.createdAt||value.plannerVersion!==index.plannerVersion||value.knowledgeHash!==index.knowledgeHash)return publicationInvalid('knowledge preview私有来源/闭形损坏。')
  const localKnowledge=strictBothSnapshot(value.local),localPhysical=strictBothSnapshot(value.localPhysical),remote=strictBothSnapshot(value.remote),state=M.validateTombstoneExchangeState(value.state)
  if(typeof value.localFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(value.localFingerprint)||!Array.isArray(value.baseRecords)
    ||state.workspaceScope!==c.workspaceScope||state.recoveryEpoch!==c.recoveryEpoch)return publicationInvalid('knowledge preview原state/B/fingerprint缺失。')
  const baseRecords=value.baseRecords.map(row=>{assertSyncedShape(row,['key','hash','record'])
    if(typeof row.key!=='string'||typeof row.hash!=='string'||publicationHash(publicationJson(row.record))!==row.hash)return publicationInvalid('knowledge preview原B hash不符。')
    return {key:row.key,hash:row.hash,record:validateSyncedProtocol5Record(row.record,row.key)}})
  assertSyncedShape(value.authority,['catalogId','identities','occupiedDocumentIds','historyComponents','pinnedGroupIds','knownGroupIds','missingBaseKeys','deferredKeys','deletedFacts','pins','deletionProofReferences'],['keyGuards'])
  const sourceLinks=mode==='both'?B.validateBothSourceLinks(value.sourceLinks):[]
  const input:K.KnowledgePlanInput={operationId:index.previewId,localPhysical,localKnowledge,remote,baseRecords,state,localFingerprint:value.localFingerprint,authority:value.authority as unknown as K.KnowledgeAuthority}
  const plan=makeKnowledgePlan(input,mode==='both'?6:5,[],sourceLinks)
  if(!same(plan.knowledgeSource,K.validateKnowledgeSource(value.knowledgeSource))||plan.knowledgeHash!==index.knowledgeHash
    ||!same(plan.componentFences,value.componentFences))return publicationInvalid('knowledge preview来源原像/组件完整fence未可重现。')
  if(value.stateRaw!==null&&typeof value.stateRaw!=='string')return publicationInvalid('knowledge preview原stateRaw无效。')
  const expectedGuards=Object.fromEntries((input.authority.keyGuards??[]).map(row=>[row.key,row.fingerprint]))
  if(!same(value.keyGuards,expectedGuards))return publicationInvalid('knowledge preview原keyguards两处来源不一致。')
  const final=db.transaction(()=>{current(db,c);return readKnowledgePreviewIndex(db,mode,index.previewId,c.request)})()
  if(!same(final,index))return publicationInvalid('读取knowledge preview期间原index改变。')
  return {index,input,plan,value,sourceLinks}
}
function knowledgeConflictFacts(c:Context,index:KnowledgePreviewIndex,input:K.KnowledgePlanInput,components:C.ConflictPreviewComponent[]):C.SyncedExchangeConflictPreview {
  return C.validateConflictPreview({kind:'synced-exchange-conflict-preview',version:1,previewId:index.previewId,previewHash:index.previewHash,
    workspaceScope:index.workspaceScope,recoveryEpoch:index.recoveryEpoch,remoteWorkspaceId:input.remote.manifest.workspaceId,targetFingerprint:c.request.targetFingerprint,
    stateGeneration:input.state.generation,remoteManifestHash:publicationHash(publicationJson(input.remote.manifest)),createdAt:index.createdAt,components})
}
async function loadKnowledgeConflictPreview(db:Database.Database,c:Context,index:KnowledgePreviewIndex):Promise<StoredPreview> {
  const loaded=await loadKnowledgePreviewData(db,c,index,'conflicts')
  if(!same(loaded.plan.conflictPreviews,loaded.value.components))return publicationInvalid('knowledge conflict展示与完整原plan不符。')
  return {index,facts:knowledgeConflictFacts(c,index,loaded.input,loaded.plan.conflictPreviews)}
}
function knowledgeBothFacts(c:Context,index:KnowledgePreviewIndex,input:K.KnowledgePlanInput,components:T.SyncedExchangeBothPreviewComponent[]):T.SyncedExchangeBothPreview {
  return B.validateBothPreview({kind:'synced-exchange-both-preview',version:1,previewId:index.previewId,previewHash:index.previewHash,workspaceScope:index.workspaceScope,
    recoveryEpoch:index.recoveryEpoch,remoteWorkspaceId:input.remote.manifest.workspaceId,targetFingerprint:c.request.targetFingerprint,stateGeneration:input.state.generation,
    remoteManifestHash:publicationHash(publicationJson(input.remote.manifest)),createdAt:index.createdAt,components})
}
function storedKnowledgeBothFacts(input:K.KnowledgePlanInput,links:T.SyncedBothOwnerSourceLinks[]):unknown {
  return deriveKnowledgeBothComponents(input,links).map(row=>({component:row.component,records:row.records,conflictedKeys:row.conflictedKeys,reason:row.reason,fence:row.fence}))
}
async function loadKnowledgeBothPreview(db:Database.Database,c:Context,index:KnowledgePreviewIndex):Promise<BothStoredPreview> {
  const loaded=await loadKnowledgePreviewData(db,c,index,'both'),{input,value,sourceLinks}=loaded
  const allocation=B.validateBothAllocation(value.allocation)
  if(B.bothAllocationHash(allocation)!==index.allocationHash||!same(value.componentFacts,storedKnowledgeBothFacts(input,sourceLinks))||!Array.isArray(value.components))return publicationInvalid('knowledge both原pool/完整组件来源损坏。')
  const components=value.components.map(B.validateBothPreviewComponent).sort((a,b)=>publicationCompare(a.componentId,b.componentId))
  const byId=new Map(deriveKnowledgeBothComponents(input,sourceLinks).map(row=>[row.component.componentId,row]))
  const selections:B.BothPrivateSelection[]=components.filter(row=>row.choices.includes('both')).map(preview=>{
    const fact=byId.get(preview.componentId)
    if(!fact||fact.reason||!fact.selectedOriginal||!same(preview.keys,fact.component.keys)||preview.localSignature!==fact.component.localSignature
      ||preview.remoteSignature!==fact.component.remoteSignature||preview.dependencySignature!==fact.component.dependencySignature)return publicationInvalid('knowledge both展示没有准确完整组件fence。')
    const described=describeSyncedBothComponent({local:input.localKnowledge,remote:input.remote,component:bothMutableComponent(fact),selectedOriginal:fact.selectedOriginal,
      conflictedKeys:fact.conflictedKeys,sourceLinks})
    if(described.status!=='eligible'||!same(described.groups.map(row=>[row.sourceGroupId,row.sourceHash,row.required,row.hosts]),preview.groups.map(row=>[row.sourceGroupId,row.sourceHash,row.required,row.hosts.map(({documentId:_documentId,instanceId:_instanceId,...host})=>host)])))return publicationInvalid('knowledge both展示与原live来源闭集不符。')
    return {preview,decision:{componentId:preview.componentId,copyDocumentIds:[],groups:[]},component:fact.component,allocation,poolAllocation:allocation,sourceLinks,conflictedKeys:fact.conflictedKeys}
  })
  return {index,facts:knowledgeBothFacts(c,index,input,components),allocation,selections}
}
async function saveKnowledgePreview(db:Database.Database,c:Context,prepared:Prepared,mode:KnowledgePreviewMode,previewId:string,components:unknown,
  both?:{allocation:T.SyncedBothAllocation;sourceLinks:T.SyncedBothOwnerSourceLinks[]}):Promise<KnowledgePreviewIndex|null> {
  if(!('knowledgeSource'in prepared.plan))return publicationInvalid('新预览缺knowledge原像。')
  const input=knowledgeInput(prepared),now=new Date().toISOString(),plan=prepared.plan
  const payload={kind:mode==='both'?'synced-exchange-both-preview-inputs':'synced-exchange-conflict-preview-inputs',version:2,previewId,databasePath:c.databasePath,
    target:c.target,workspaceScope:c.workspaceScope,recoveryEpoch:c.recoveryEpoch,createdAt:now,local:snapshotData(input.localKnowledge),localPhysical:snapshotData(input.localPhysical),
    remote:snapshotData(input.remote),baseRecords:input.baseRecords,state:input.state,authority:input.authority,keyGuards:prepared.local.keyGuards,stateRaw:prepared.local.stateRaw,
    localFingerprint:prepared.local.fingerprint,plannerVersion:mode==='both'?'knowledge-forks-v1':'knowledge-conflicts-v1',knowledgeSource:plan.knowledgeSource,
    knowledgeHash:plan.knowledgeHash,componentFences:plan.componentFences,components,...(both?{allocation:both.allocation,sourceLinks:both.sourceLinks,componentFacts:storedKnowledgeBothFacts(input,both.sourceLinks)}:{})}
  const bytes=Buffer.from(publicationJson(payload)),index=validateKnowledgePreviewIndex({kind:mode==='both'?'synced-exchange-both-preview-index':'synced-exchange-conflict-preview-index',version:2,
    previewId,databasePath:c.databasePath,targetFingerprint:c.request.targetFingerprint,workspaceScope:c.workspaceScope,recoveryEpoch:c.recoveryEpoch,
    previewHash:publicationHash(bytes),createdAt:now,plannerVersion:payload.plannerVersion,knowledgeHash:plan.knowledgeHash,...(both?{allocationHash:B.bothAllocationHash(both.allocation)}:{})},mode)
  const dir=knowledgePreviewDirectory(c,mode,previewId);safe(dir,c.root);await mkdir(join(c.root,'storage',mode==='both'?'synced-exchange-both-previews-v2':'synced-exchange-previews-v2'),{recursive:true,mode:0o700})
  await mkdir(dir,{mode:0o700});safe(dir,c.root);await durable(join(dir,'preview.json'),bytes);await syncDirectory(dir)
  const installed=db.transaction(()=>{current(db,c)
    if(capture(db,c).fingerprint!==prepared.local.fingerprint)return false
    const legacy=mode==='both'?readSyncedBothPreviewIndex(db,previewId,c.request):readSyncedExchangeConflictPreviewIndex(db,previewId,c.request)
    if(legacy||readKnowledgePreviewIndex(db,mode,previewId,c.request))return publicationInvalid('knowledge previewId已有不可覆盖的原来源。')
    putImmutable(db,knowledgePreviewKey(mode,previewId),index,now);return true}).immediate()
  return installed?index:null
}
async function createKnowledgePreview(db:Database.Database,c:Context,previewId:string,runtime:SyncedExchangeRuntime,mode:'conflicts'):Promise<C.SyncedExchangeConflictPreviewResult> {
  const prepared=await prepareKnowledge(db,c,runtime,[],5)
  if(!('plan'in prepared)){if(prepared.status==='missing'||prepared.status==='unsupported'||prepared.status==='stale')return frozenPublicationFacts(prepared);return publicationInvalid('knowledge preview不接受历史操作结果。')}
  const components='conflictPreviews'in prepared.plan?prepared.plan.conflictPreviews:undefined
  if(!components)return publicationInvalid('knowledge conflict preview缺真实plan。')
  const index=await saveKnowledgePreview(db,c,prepared,mode,previewId,components)
  return index?frozenPublicationFacts({status:'ready',preview:knowledgeConflictFacts(c,index,knowledgeInput(prepared),components)}):Object.freeze({status:'stale',side:'local'})
}
async function createKnowledgeBothPreview(db:Database.Database,c:Context,previewId:string,runtime:SyncedExchangeRuntime):Promise<T.SyncedExchangeBothPreviewResult> {
  const prepared=await prepareKnowledge(db,c,runtime,[],6)
  if(!('plan'in prepared)){if(prepared.status==='missing'||prepared.status==='unsupported'||prepared.status==='stale')return frozenPublicationFacts(prepared);return publicationInvalid('knowledge both preview不接受历史操作结果。')}
  const built=buildBothPreview(prepared,previewId,new Date().toISOString()),input=knowledgeInput(prepared)
  const index=await saveKnowledgePreview(db,c,prepared,'both',previewId,built.components,{allocation:built.allocation,sourceLinks:prepared.bothLinks})
  return index?frozenPublicationFacts({status:'ready',preview:knowledgeBothFacts(c,index,input,built.components)}):Object.freeze({status:'stale',side:'local'})
}

function makeDeletionChoicePlan(input:DC.DeletionChoicePlanInput):DeletionChoiceRuntimePlan {
  const plan=planSyncedDeletionChoices(input)
  return {...plan,localFinal:plan.localPhysicalFinal}
}
async function prepareDeletionChoices(db:Database.Database,c:Context,runtime:SyncedExchangeRuntime,deferredKeys:string[]):Promise<Prepared|M.SyncedExchangeResult> {
  const base=await prepareTombstone(db,c,runtime,deferredKeys)
  if(!('plan'in base))return base
  if(!base.localPhysical)return publicationInvalid('删除选择缺真实physical capture。')
  const planningAuthority=knowledgeAuthority(base.local,base.planningAuthority.missingBaseKeys,deferredKeys)
  const input:DC.DeletionChoicePlanInput={operationId:c.request.operationId,localPhysical:base.localPhysical,localKnowledge:base.localWire,remote:fromRemote(base.remote),
    baseRecords:base.baseRecords,state:M.validateTombstoneExchangeState(base.state),localFingerprint:base.local.fingerprint,authority:planningAuthority,
    remoteSource:{manifestHash:base.remote.manifestHash,closureHash:base.remote.closureHash,etag:base.remote.manifestEtag},resolution:c.deletionChoice?.resolution??null,selections:c.deletionChoice?.selections??[]}
  return {...base,engine:7,planningAuthority,plan:makeDeletionChoicePlan(input)}
}
function readDeletionSelections(value:unknown,request:M.ExchangeRequest):NonNullable<DC.DeletionChoicePlanInput['selections']> {
  M.assertExchangeData(value)
  if(request.method!=='resolveSyncedExchangeDeletions'||!Array.isArray(value))return publicationInvalid('删除选择私有selector方法不符。')
  const selections=value.map(raw=>{assertSyncedShape(raw,['preview','decision']);return {preview:DC.validateDeletionChoicePreviewComponent(raw.preview),decision:DC.validateDeletionDecisions([raw.decision])[0]}})
  if(!same(selections.map(row=>row.decision),request.decisions)||selections.some(row=>row.preview.componentId!==row.decision.componentId||!row.preview.choices.includes(row.decision.choice)))return publicationInvalid('删除选择私有决定不属于原preview闭集。')
  return selections
}
function deletionPreviewDirectory(c:Context,id:string):string{return join(c.root,'storage','synced-exchange-deletion-previews-v1',id)}
function deletionPreviewFacts(c:Context,index:DeletionChoicePreviewIndex,source:DC.DeletionDecisionSource,components:DC.DeletionChoicePreviewComponent[]):DC.SyncedExchangeDeletionPreview {
  return DC.validateDeletionChoicePreview({kind:'synced-exchange-deletion-preview',version:1,previewId:index.previewId,previewHash:index.previewHash,workspaceScope:index.workspaceScope,
    recoveryEpoch:index.recoveryEpoch,remoteWorkspaceId:source.remoteWorkspaceId,targetFingerprint:c.request.targetFingerprint,stateGeneration:source.state.generation,
    remoteManifestHash:source.remoteSource.manifestHash,createdAt:index.createdAt,components})
}
async function loadDeletionPreview(db:Database.Database,c:Context,id:string):Promise<{index:DeletionChoicePreviewIndex;facts:DC.SyncedExchangeDeletionPreview}|null> {
  const index=db.transaction(()=>{current(db,c);return readDeletionChoicePreviewIndex(db,id,c.request)})()
  if(!index)return null
  if(index.workspaceScope!==c.workspaceScope||index.recoveryEpoch!==c.recoveryEpoch)return unavailable('删除预览属于其它scope/epoch。')
  const dir=deletionPreviewDirectory(c,id),file=join(dir,'preview.json');safe(dir,c.root);safe(file,dir)
  if(!lstatSync(file).isFile())return publicationInvalid('删除预览不是私有regular file。')
  const bytes=await readFile(file)
  if(publicationHash(bytes)!==index.previewHash)return publicationInvalid('删除预览原bytes/index不闭合。')
  const value=M.parseExchangeStored(bytes.toString('utf8'))
  assertSyncedShape(value,['kind','version','previewId','databasePath','target','workspaceScope','recoveryEpoch','createdAt','decisionSource','decisionSourceHash','keyGuards','stateRaw','components'])
  if(value.kind!=='synced-exchange-deletion-preview-inputs'||value.version!==1||value.previewId!==id||value.databasePath!==c.databasePath||!same(value.target,c.target)
    ||value.workspaceScope!==index.workspaceScope||value.recoveryEpoch!==index.recoveryEpoch||value.createdAt!==index.createdAt||value.decisionSourceHash!==index.decisionSourceHash)return publicationInvalid('删除预览私有来源损坏。')
  const source=DC.validateDeletionDecisionSource(value.decisionSource)
  if(source.databasePath!==c.databasePath||source.targetFingerprint!==c.request.targetFingerprint||source.workspaceScope!==c.workspaceScope||source.recoveryEpoch!==c.recoveryEpoch
    ||source.resolution!==null||source.decisions.length||DC.deletionDecisionSourceHash(source)!==index.decisionSourceHash)return publicationInvalid('删除预览原source范围/原像hash不符。')
  const plan=planSyncedDeletionChoicesFromSource(source,id)
  if(!same(plan.deletionPreviews,value.components)||!same(value.keyGuards,Object.fromEntries((source.authority.keyGuards??[]).map(row=>[row.key,row.fingerprint])))
    ||value.stateRaw!==null&&typeof value.stateRaw!=='string')return publicationInvalid('删除预览原全图展示/guards不可重现。')
  const final=db.transaction(()=>{current(db,c);return readDeletionChoicePreviewIndex(db,id,c.request)})()
  if(!same(final,index))return publicationInvalid('读取删除预览期间原index变化。')
  return {index,facts:deletionPreviewFacts(c,index,source,plan.deletionPreviews)}
}
async function attachDeletionPreview(db:Database.Database,c:Context,request:M.ExchangeDeletionRequest):Promise<void> {
  const loaded=await loadDeletionPreview(db,c,request.previewId)
  if(!loaded)return unavailable('删除resolve缺真实Main原preview。')
  const byId=new Map(loaded.facts.components.map(row=>[row.componentId,row]))
  const selections=request.decisions.map(decision=>{const preview=byId.get(decision.componentId)
    if(!preview||!preview.choices.includes(decision.choice))return publicationInvalid('删除决定不属于原可执行preview。')
    return {preview,decision}})
  c.deletionChoice={resolution:{previewId:request.previewId,previewHash:loaded.index.previewHash,decisionsHash:DC.deletionDecisionsHash(request.decisions)},selections}
}
async function createDeletionPreview(db:Database.Database,c:Context,id:string,runtime:SyncedExchangeRuntime):Promise<DC.SyncedExchangeDeletionPreviewResult> {
  if(db.pragma('user_version',{simple:true})===26)return Object.freeze({status:'unsupported',reason:'schema-27-required'})
  if(db.pragma('user_version',{simple:true})!==27)return publicationInvalid('删除预览不接受未知schema。')
  const existing=await loadDeletionPreview(db,c,id)
  if(existing)return frozenPublicationFacts({status:'ready',preview:existing.facts})
  const prepared=await prepareDeletionChoices(db,c,runtime,[])
  if(!('plan'in prepared)){if(prepared.status==='missing'||prepared.status==='unsupported'||prepared.status==='stale')return frozenPublicationFacts(prepared);return publicationInvalid('删除预览不接受写入结果冒充source。')}
  if(!('decisionSource'in prepared.plan))return publicationInvalid('删除预览缺真实source。')
  const now=new Date().toISOString(),plan=prepared.plan
  const payload={kind:'synced-exchange-deletion-preview-inputs',version:1,previewId:id,databasePath:c.databasePath,target:c.target,workspaceScope:c.workspaceScope,recoveryEpoch:c.recoveryEpoch,createdAt:now,
    decisionSource:plan.decisionSource,decisionSourceHash:plan.decisionSourceHash,keyGuards:prepared.local.keyGuards,stateRaw:prepared.local.stateRaw,components:plan.deletionPreviews}
  const bytes=Buffer.from(publicationJson(payload)),index=validateDeletionChoicePreviewIndex({kind:'synced-exchange-deletion-preview-index',version:1,previewId:id,databasePath:c.databasePath,targetFingerprint:c.request.targetFingerprint,
    workspaceScope:c.workspaceScope,recoveryEpoch:c.recoveryEpoch,previewHash:publicationHash(bytes),decisionSourceHash:plan.decisionSourceHash,createdAt:now})
  const dir=deletionPreviewDirectory(c,id);safe(dir,c.root);await mkdir(join(c.root,'storage','synced-exchange-deletion-previews-v1'),{recursive:true,mode:0o700});await mkdir(dir,{mode:0o700});safe(dir,c.root)
  await durable(join(dir,'preview.json'),bytes);await syncDirectory(dir)
  const installed=db.transaction(()=>{current(db,c);if(capture(db,c).fingerprint!==prepared.local.fingerprint)return false
    putImmutable(db,deletionChoicePreviewKey(id),index,now);return true}).immediate()
  return installed?frozenPublicationFacts({status:'ready',preview:deletionPreviewFacts(c,index,plan.decisionSource,plan.deletionPreviews)}):Object.freeze({status:'stale',side:'local'})
}
async function historicalDeletionPublication(db:Database.Database,c:Context,saved:Spool,runtime:SyncedExchangeRuntime):Promise<{etag:string}|null> {
  const facts=db.transaction(()=>{current(db,c);return phases(db,saved.job)})(),confirmed=[...facts].reverse().find(row=>['remote-confirmed','published-local-deferred','settled'].includes(row.phase)&&row.remoteEtag!==null)
  if(confirmed)return {etag:confirmed.remoteEtag!}
  if(facts.at(-1)!.phase==='prepared')return null
  const client=new WebDavClient(c.target,runtime.password,runtime.signal),actual=await network(()=>client.getVersioned('manifest.json',PUBLICATION_RECORD_MAX_BYTES))
  if(actual&&publicationHash(actual.bytes)===saved.job.descriptor.next.manifestHash){confirm(db,c,saved,actual.etag);return {etag:actual.etag}}
  return null
}
async function runDeletionChoices(db:Database.Database,c:Context,runtime:SyncedExchangeRuntime):Promise<M.SyncedExchangeResult> {
  const replay=db.transaction(()=>readSyncedExchangeReceipt(db,c.request))()
  if(replay){if(replay.version!==7)return publicationInvalid('删除选择不能继承其它版本ACK。');return frozenPublicationFacts({...replay.result,replayed:true})}
  if(db.pragma('user_version',{simple:true})===26)return Object.freeze({status:'unsupported',reason:'schema-27-required'})
  if(db.pragma('user_version',{simple:true})!==27)return publicationInvalid('删除选择未知schema。')
  const first=capture(db,c),originalGuards=first.keyGuards
  let head=db.transaction(()=>readHead(db,c))(),saved=head?await loadSpool(db,c,head):null,deferredKeys:string[]=[]
  if(saved){if(saved.job.version!==7)return publicationInvalid('删除选择不能重解释旧job。');c.deletionChoice={resolution:saved.job.resolution,selections:saved.planning.deletionSelections??[]}}
  else {if(c.request.method!=='resolveSyncedExchangeDeletions')return publicationInvalid('删除选择方法不符。');await attachDeletionPreview(db,c,c.request)}
  for(let turn=0;turn<8;turn++){
    aborted(runtime.signal)
    if(!saved){const prepared=await prepareDeletionChoices(db,c,runtime,deferredKeys)
      if(!('plan'in prepared)){if(prepared.status==='stale'&&prepared.side==='local'){deferredKeys=sort([...deferredKeys,...changedKeys(originalGuards,capture(db,c).keyGuards)]);continue}return frozenPublicationFacts(prepared)}
      const raced=changedKeys(originalGuards,prepared.local.keyGuards)
      if(raced.some(key=>!deferredKeys.includes(key))){deferredKeys=sort([...deferredKeys,...raced]);continue}
      saved=await spool(prepared,head)
      if(!registerJob(db,c,saved,head)){saved=null;deferredKeys=sort([...deferredKeys,...changedKeys(originalGuards,capture(db,c).keyGuards)]);head=db.transaction(()=>readHead(db,c))();continue}
      head=db.transaction(()=>readHead(db,c))()
    }
    // An accepted remote effect remains attached to this exact job. Local
    // drift can defer installation, never mint a replacement deletion proof.
    const historical=await historicalDeletionPublication(db,c,saved,runtime),now=capture(db,c)
    if(historical&&now.fingerprint!==saved.localFingerprint){db.transaction(()=>{current(db,c);phase(db,saved!.job,'published-local-deferred',historical.etag)}).immediate();return Object.freeze({status:'stale',side:'local'})}
    if(!historical&&now.fingerprint!==saved.localFingerprint){deferredKeys=sort([...deferredKeys,...changedKeys(saved.planning.keyGuards,now.keyGuards)]);saved=null;continue}
    let remote:{status:'confirmed';etag:string}|{status:'retry'}|{status:'stale'}
    if(historical)remote={status:'confirmed',etag:historical.etag}
    else if(!saved.plan.writes.length){const client=new WebDavClient(c.target,runtime.password,runtime.signal),actual=await network(()=>client.getVersioned('manifest.json',PUBLICATION_RECORD_MAX_BYTES))
      remote=actual&&publicationHash(actual.bytes)===saved.job.descriptor.expectedRemote.manifestHash&&actual.etag===saved.job.descriptor.expectedRemote.etag?{status:'confirmed',etag:actual.etag}:{status:'retry'}}
    else remote=await publish(db,c,saved,runtime)
    if(remote.status!=='confirmed'){if(remote.status==='stale')deferredKeys=sort([...deferredKeys,...changedKeys(saved.planning.keyGuards,capture(db,c).keyGuards)]);saved=null;continue}
    aborted(runtime.signal)
    if(capture(db,c).fingerprint!==saved.localFingerprint){db.transaction(()=>{current(db,c);phase(db,saved!.job,'published-local-deferred',remote.etag)}).immediate();return Object.freeze({status:'stale',side:'local'})}
    publishAliases(c,saved);verifyAliases(c,saved.job.descriptor.next.assets)
    let settled:M.SyncedExchangeAccepted|null
    try{settled=settle(db,c,saved,remote.etag)}catch(cause){
      try{db.transaction(()=>{current(db,c);phase(db,saved!.job,'published-local-deferred',remote.etag)}).immediate()}
      catch(recording){throw new SyncedPublicationError('database','删除选择远端事实已存在；本机SQL与失败记录失败，原job保持。',{cause,recording})}
      throw cause instanceof SyncedPublicationError?cause:new SyncedPublicationError('database','删除选择本机SQL已回滚；原任务可重开收敛。',cause)}
    if(settled)return frozenPublicationFacts(settled)
    db.transaction(()=>{current(db,c);phase(db,saved!.job,'published-local-deferred',remote.etag)}).immediate()
    return Object.freeze({status:'stale',side:'local'})
  }
  return Object.freeze({status:'stale',side:'remote'})
}
/** Main-only explicit deletion choices. Callers provide selectors, never records, pins or raw authority. */
export async function previewSyncedExchangeDeletions(db:Database.Database,input:DC.SyncedExchangeDeletionPreviewInput,options:SyncedExchangeRuntime):Promise<DC.SyncedExchangeDeletionPreviewResult> {
  let c:Context|null=null,key:string|null=null,owns=false
  try{M.assertExchangeData(input);assertSyncedShape(input,['previewId','userDataRoot','target']);if(!isSyncedUuid(input.previewId))return publicationInvalid('删除previewId无效。')
    c=context(db,{operationId:input.previewId,userDataRoot:input.userDataRoot,target:input.target});const runtime=credentials(options);connections.set(c,db)
    key=publicationJson([c.databasePath,c.workspaceScope,c.recoveryEpoch,c.request.targetFingerprint]);if(running.has(key))return unavailable('同一真实target已有exchange在途。');running.add(key);owns=true
    return await createDeletionPreview(db,c,input.previewId,runtime)
  }catch(cause){if(cause instanceof SyncedPublicationError)throw cause;throw new SyncedPublicationError(cause instanceof Error&&/SQLITE|sqlite|database|constraint|trigger/i.test(cause.message)?'database':'invalid','真实删除预览失败；原事实保持。',cause)}
  finally{if(key&&owns)running.delete(key);if(c)connections.delete(c)}
}
export async function resolveSyncedExchangeDeletions(db:Database.Database,input:DC.SyncedExchangeDeletionResolveInput,options:SyncedExchangeRuntime):Promise<M.SyncedExchangeResult> {
  let c:Context|null=null,key:string|null=null,owns=false
  try{M.assertExchangeData(input);assertSyncedShape(input,['operationId','userDataRoot','target','previewId','decisions']);const decisions=DC.validateDeletionDecisions(input.decisions)
    c=context(db,{operationId:input.operationId,userDataRoot:input.userDataRoot,target:input.target});c.request=M.validateExchangeRequest({...c.request,method:'resolveSyncedExchangeDeletions',previewId:input.previewId,decisions})
    const runtime=credentials(options);connections.set(c,db);key=publicationJson([c.databasePath,c.workspaceScope,c.recoveryEpoch,c.request.targetFingerprint]);if(running.has(key))return unavailable('同一真实target已有exchange在途。');running.add(key);owns=true
    return await runDeletionChoices(db,c,runtime)
  }catch(cause){if(cause instanceof SyncedPublicationError)throw cause;throw new SyncedPublicationError(cause instanceof Error&&/SQLITE|sqlite|database|constraint|trigger|exchange exact late receipt/i.test(cause.message)?'database':'invalid','真实删除选择失败；原job/possible保持。',cause)}
  finally{if(key&&owns)running.delete(key);if(c)connections.delete(c)}
}
