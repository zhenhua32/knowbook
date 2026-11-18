import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import type { KnowbookStore } from '../database/store'
import { hasInitialSyncedPublicationAttempt } from '../database/synced-publication'
import { canJoinSyncedProtocol5Workspace } from '../database/synced-initial-incoming-read'
import { readSyncedExchangeReceiptById } from '../database/synced-exchange-receipt'
import type { ResolveWebDavProtocol5Conflict, ResolveWebDavProtocol5Deletion, WebDavProtocol5ConflictPreview, WebDavProtocol5DeletionPreview, WebDavSyncConfig } from '../../shared/webdav-sync'
import { parseStrictJson } from '../../shared/strictJson'
import { assertSyncedShape, isSyncedUuid } from '../../shared/syncedBlockValidation'
import { publicationCompare, publicationJson, PUBLICATION_RECORD_MAX_BYTES, validateInitialManifest5 } from './synced-publication-model'
import { assertConflictData, validateConflictDecisions } from './synced-exchange-conflict-model'
import { validateBothDecisions } from './synced-exchange-both-model'
import type { SyncedExchangeBothDecision, SyncedExchangeBothPreviewComponent } from './synced-exchange-both-types'
import { exchangeJobHeadKey, exchangeKeys, exchangeTargetFingerprint } from './synced-exchange-model'
import { normalizeWebDavConfig, WebDavClient } from './webdav-client'
import { SYNC_RECEIVER_PROFILE_KEY } from './receiver-bootstrap'
import {
  disposePreparedSyncedPublication, prepareInitialSyncedPublication, publishInitialSyncedPublication, readPreparedSyncedPublication,
  receiveInitialSyncedSnapshot, recoverInitialSyncedPublication, type SyncedPublicationRuntime
} from './synced-publication'
import { exchangeSyncedSnapshot, previewSyncedExchangeBoth, previewSyncedExchangeConflicts, previewSyncedExchangeDeletionDetails,
  resolveSyncedExchangeBoth, resolveSyncedExchangeConflicts, resolveSyncedExchangeDeletions } from './synced-exchange'

const MAX_MANIFEST_BYTES = 16 * 1024 * 1024
// Device settings are separate from the strict sync.webdav.protocol5 evidence families.
const CLIENT_SETTINGS_PREFIX = 'sync.webdav.client.protocol5.'
type BothSelection = { previewId: string; previewHash: string; decision: SyncedExchangeBothDecision }
const bothSelections = new WeakMap<WebDavProtocol5ConflictPreview, Map<string, BothSelection>>()
type PendingExchange = { kind: 'exchange'; operationId: string }
  | { kind: 'resolve'; operationId: string; selection: ResolveWebDavProtocol5Conflict; selectionKeys: string[]; originalTarget: WebDavSyncConfig }
  | { kind: 'resolve-both'; operationId: string; selection: BothSelection; originalTarget: WebDavSyncConfig }
  | { kind: 'resolve-deletion'; operationId: string; selection: ResolveWebDavProtocol5Deletion; originalTarget: WebDavSyncConfig }
type Pending = { kind: 'publish' | 'receive'; operationId: string } | PendingExchange
type Route = { workspace: ReturnType<KnowbookStore['getEditorRecoveryWorkspace']>; lastSyncAt: string | null; pending: Pending | null }
type Outcome = { uploaded: number; downloaded: number; merged?: number; message: string; selectionDeferred?: true }
type Remote = 'missing' | 'protocol5'
const sha256 = /^[a-f0-9]{64}$/

function readSelectionFields(value: unknown, extras: string[] = []) {
  assertConflictData(value)
  assertSyncedShape(value, ['previewId', 'previewHash', 'componentId', 'choice', ...extras])
  const { previewId, previewHash, componentId, choice } = value
  if (!isSyncedUuid(previewId) || typeof previewHash !== 'string' || !sha256.test(previewHash)
    || typeof componentId !== 'string' || !sha256.test(componentId)) {
    throw new Error('同步块冲突选择无效，请刷新预览。')
  }
  return { previewId, previewHash, componentId, choice }
}
export function readProtocol5Selection(value: unknown): ResolveWebDavProtocol5Conflict {
  const merge = Boolean(value && typeof value === 'object' && Object.getOwnPropertyDescriptor(value, 'choice')?.value === 'merge')
  const fields = readSelectionFields(value, merge ? ['records'] : []), { choice } = fields
  if (choice === 'merge') {
    const [decision] = validateConflictDecisions([{ componentId: fields.componentId, choice, records: (value as { records: unknown }).records }])
    if (decision.choice !== 'merge') throw new Error('逐项合并选择无效。')
    return { ...fields, choice, records: decision.records }
  }
  if (choice !== 'local' && choice !== 'remote' && choice !== 'both') throw new Error('同步块冲突选择无效，请刷新预览。')
  return { ...fields, choice }
}
function readBothSelection(value: unknown): BothSelection {
  assertConflictData(value)
  assertSyncedShape(value, ['previewId', 'previewHash', 'decision'])
  if (!isSyncedUuid(value.previewId) || typeof value.previewHash !== 'string' || !sha256.test(value.previewHash)) {
    throw new Error('保留双方的预览已失效，请重新读取。')
  }
  return { previewId: value.previewId, previewHash: value.previewHash, decision: validateBothDecisions([value.decision])[0] }
}
export function readProtocol5DeletionSelection(value: unknown): ResolveWebDavProtocol5Deletion {
  const fields = readSelectionFields(value), { choice } = fields
  if (choice !== 'keep-live' && choice !== 'keep-delete') throw new Error('同步块删除冲突选择无效，请刷新预览。')
  return { ...fields, choice }
}

export function protocol5RouteKey(target: WebDavSyncConfig): string {
  return CLIENT_SETTINGS_PREFIX + 'route.v1.' + exchangeTargetFingerprint(target)
}

function loadRoute(store: KnowbookStore, target: WebDavSyncConfig): Route | null {
  const raw = store.getSettingPublic(protocol5RouteKey(target))
  return decodeProtocol5Route(raw, target)
}

export function decodeProtocol5Route(raw: string | null, target: WebDavSyncConfig): Route | null {
  if (raw === null) return null
  const value = parseStrictJson(raw, { maxBytes: PUBLICATION_RECORD_MAX_BYTES, maxDepth: 12 })
  assertSyncedShape(value, ['workspace', 'lastSyncAt', 'pending'])
  assertSyncedShape(value.workspace, ['workspaceScope', 'recoveryEpoch'])
  if (!isSyncedUuid(value.workspace.workspaceScope) || !isSyncedUuid(value.workspace.recoveryEpoch)
    || (value.lastSyncAt !== null && (typeof value.lastSyncAt !== 'string' || !Number.isFinite(Date.parse(value.lastSyncAt))))) {
    throw new Error('同步块本地同步记录不完整，已暂停。')
  }
  if (value.pending !== null) {
    assertSyncedShape(value.pending, ['kind', 'operationId'], ['selection', 'selectionKeys', 'originalTarget'])
    const { kind } = value.pending, resolving = kind === 'resolve' || kind === 'resolve-both' || kind === 'resolve-deletion'
    if (!isSyncedUuid(value.pending.operationId)
      || typeof kind !== 'string' || !['publish', 'receive', 'exchange', 'resolve', 'resolve-both', 'resolve-deletion'].includes(kind)
      || (kind === 'exchange' || resolving) !== Boolean(value.lastSyncAt)) {
      throw new Error('同步块本地同步任务不完整，已暂停。')
    }
    if (resolving) {
      if (kind === 'resolve') {
        if (readProtocol5Selection(value.pending.selection).choice === 'both') throw new Error('保留双方任务缺少原选择。')
        if (!exchangeKeys(value.pending.selectionKeys).length) throw new Error('待恢复的冲突决定缺少原记录。')
      } else if (kind === 'resolve-both') readBothSelection(value.pending.selection)
      else readProtocol5DeletionSelection(value.pending.selection)
      assertSyncedShape(value.pending.originalTarget, ['enabled', 'url', 'username', 'directory', 'intervalMinutes', 'allowInsecureHttp'])
      if (exchangeTargetFingerprint(normalizeWebDavConfig(value.pending.originalTarget as unknown as WebDavSyncConfig)) !== exchangeTargetFingerprint(target)) {
        throw new Error('待恢复的冲突决定不属于当前同步目标。')
      }
    } else if ('selection' in value.pending || 'originalTarget' in value.pending) throw new Error('原同步任务字段无效。')
    if (kind !== 'resolve' && 'selectionKeys' in value.pending) throw new Error('原同步任务字段无效。')
  }
  return value as unknown as Route
}

/** Read-only discriminator. Kernel operations verify the exact full closure again. */
export async function peekProtocol5Remote(client: WebDavClient): Promise<Remote> {
  const response = await client.getVersioned('manifest.json', MAX_MANIFEST_BYTES)
  if (!response) return 'missing'
  const manifest = parseStrictJson(Buffer.from(response.bytes).toString('utf8'), { maxBytes: MAX_MANIFEST_BYTES, maxDepth: 32 })
  if (manifest && typeof manifest === 'object' && 'version' in manifest && manifest.version !== 5) {
    throw new Error('远端目录的 KnowBook 同步协议不受支持。请选择使用当前协议的目录或空目录。')
  }
  if (!validateInitialManifest5(manifest).history) throw new Error('远端目录缺少当前同步协议的版本历史。')
  return 'protocol5'
}

export function protocol5LastSyncAt(store: KnowbookStore, target: WebDavSyncConfig): string | null {
  // Configuration remains accessible if the selected target's private route is
  // damaged. The execution path still refuses it before contacting WebDAV.
  try { return loadRoute(store, target)?.lastSyncAt ?? null } catch { return null }
}

export function protocol5NeedsRestoreRejoin(store: KnowbookStore, target: WebDavSyncConfig): boolean {
  try {
    const route = loadRoute(store, target), current = store.getEditorRecoveryWorkspace()
    return !!route?.lastSyncAt && !route.pending && current.workspaceScope === route.workspace.workspaceScope
      && current.recoveryEpoch !== route.workspace.recoveryEpoch
  } catch { return false }
}

function bindRoute(store: KnowbookStore, target: WebDavSyncConfig) {
  const workspace = store.getEditorRecoveryWorkspace()
  const route = loadRoute(store, target) ?? { workspace, lastSyncAt: null, pending: null }
  const assertCurrent = () => {
    const actual = store.getEditorRecoveryWorkspace()
    if (actual.workspaceScope !== route.workspace.workspaceScope || actual.recoveryEpoch !== route.workspace.recoveryEpoch) {
      throw new Error('工作区已恢复或替换。旧的同步块任务已暂停，原远端目录和本地资料保留。')
    }
  }
  const persist = (pending: Pending | null, lastSyncAt = route.lastSyncAt) => {
    assertCurrent()
    const stored = JSON.stringify({ ...route, pending, lastSyncAt })
    if (Buffer.byteLength(stored) > PUBLICATION_RECORD_MAX_BYTES) throw new Error('本次冲突选择超过同步大小限制。')
    store.saveSetting(protocol5RouteKey(target), stored)
  }
  assertCurrent()
  return { route, assertCurrent, persist }
}

async function settleExchange(store: KnowbookStore, userDataRoot: string, target: WebDavSyncConfig,
  runtime: SyncedPublicationRuntime, pending: PendingExchange, binding: ReturnType<typeof bindRoute>): Promise<Outcome> {
  const db = store.getUnsafeDatabaseHandle(), { operationId } = pending
  binding.persist(pending)
  let settled = false
  try {
    const result = pending.kind === 'exchange' ? await exchangeSyncedSnapshot(db, { operationId, userDataRoot, target }, runtime)
      : pending.kind === 'resolve-both' ? await resolveSyncedExchangeBoth(db, {
        operationId, userDataRoot, target: pending.originalTarget, previewId: pending.selection.previewId, expectedPreviewHash: pending.selection.previewHash,
        decisions: [pending.selection.decision]
      }, runtime)
      : pending.kind === 'resolve-deletion' ? await resolveSyncedExchangeDeletions(db, {
        operationId, userDataRoot, target: pending.originalTarget, previewId: pending.selection.previewId, expectedPreviewHash: pending.selection.previewHash,
        decisions: [{ componentId: pending.selection.componentId, choice: pending.selection.choice }]
      }, runtime) : await resolveSyncedExchangeConflicts(db, { operationId, userDataRoot, target: pending.originalTarget,
        previewId: pending.selection.previewId, expectedPreviewHash: pending.selection.previewHash,
        decisions: validateConflictDecisions([pending.selection.choice === 'merge'
          ? { componentId: pending.selection.componentId, choice: 'merge', records: pending.selection.records }
          : { componentId: pending.selection.componentId, choice: pending.selection.choice }]) }, runtime)
    if (result.status === 'blocked') throw new Error('双方版本已发布，但本机状态发生变化。原任务已保留，请重新同步。')
    if (result.status !== 'applied' && result.status !== 'noop' && result.status !== 'deferred') {
      throw new Error('远端或本地同步版本已变化，请重新查看冲突。')
    }
    binding.persist(null, result.acceptedAt)
    settled = true
    let selectionDeferred = false
    if (pending.kind === 'resolve') {
      const accepted = new Set(result.acceptedKeys)
      selectionDeferred = pending.selectionKeys.some(key => !accepted.has(key))
    } else if (pending.kind === 'resolve-both') {
      selectionDeferred = !result.forks?.some(fork => fork.componentId === pending.selection.decision.componentId)
    }
    const receipt = db.transaction(() => readSyncedExchangeReceiptById(db, operationId))()
    return { uploaded: result.publishedKeys.length, downloaded: result.appliedKeys.length, merged: receipt?.provenance.merges?.length ?? 0,
      ...(selectionDeferred ? { selectionDeferred: true as const, message: '远端或本地同步版本已变化，请重新查看冲突。' }
        : { message: result.deferred.length ? `已同步可安全提交的内容，${result.deferred.length} 项冲突仍保留。` : '同步块工作区同步完成。' }) }
  } catch (error) {
    // A rejected selector with no kernel job has no durable publication to
    // recover. Once a job exists, only its original exact operation may retry.
    if (!settled && pending.kind !== 'exchange' && !store.getSettingPublic(exchangeJobHeadKey(operationId))) binding.persist(null)
    throw error
  }
}

function bothDecision(component: SyncedExchangeBothPreviewComponent): SyncedExchangeBothDecision | undefined {
  const documents = new Map(component.copyDocuments.map(row => [row.sourceDocumentId, row]))
  const copies = new Set(component.copyDocuments.filter(row => row.required).map(row => row.sourceDocumentId))
  const groups = new Set(component.groups.filter(row => row.required).map(row => row.sourceGroupId))
  for (const id of copies) {
    const row = documents.get(id)
    if (!row) return undefined
    for (const id of row.requiredCopyDocumentIds) copies.add(id)
    for (const id of row.requiredGroupIds) groups.add(id)
  }
  const decision = { componentId: component.componentId, copyDocumentIds: [...copies].sort(publicationCompare),
    groups: component.groups.filter(row => groups.has(row.sourceGroupId)).map(row => ({ groupId: row.sourceGroupId,
      hosts: row.hosts.filter(host => host.required || host.destination === 'copied' && copies.has(host.sourceDocumentId))
        .map(({ sourceDocumentId, sourceInstanceId, destination }) => ({ sourceDocumentId, sourceInstanceId, destination })) })) }
  if (!copies.size && !groups.size || decision.groups.length !== groups.size) return undefined
  return validateBothDecisions([decision])[0]
}

export async function previewProtocol5WebDavConflicts(store: KnowbookStore, profile: string, target: WebDavSyncConfig,
  runtime: SyncedPublicationRuntime): Promise<WebDavProtocol5ConflictPreview> {
  const binding = bindRoute(store, target)
  if (!binding.route.lastSyncAt || binding.route.pending) throw new Error('请先完成此工作区的同步。')
  const db = store.getUnsafeDatabaseHandle(), userDataRoot = realpathSync(profile)
  const result = await previewSyncedExchangeConflicts(db, { previewId: randomUUID(), userDataRoot, target }, runtime)
  binding.assertCurrent()
  if (result.status !== 'ready') throw new Error('当前冲突版本不可用，请重新同步后再查看。')
  const { previewId, previewHash, components, remoteManifestHash, stateGeneration } = result.preview
  const fork = components.some(component => component.reason === 'diverged')
    ? await previewSyncedExchangeBoth(db, { previewId: randomUUID(), userDataRoot, target }, runtime) : null
  binding.assertCurrent()
  const both = fork?.status === 'ready' && fork.preview.remoteManifestHash === remoteManifestHash
    && fork.preview.stateGeneration === stateGeneration ? fork.preview : null
  const selections = new Map<string, BothSelection>()
  const preview: WebDavProtocol5ConflictPreview = { previewId, previewHash, components: components.map(component => {
    const records = component.records.filter(row => row.localHash !== row.remoteHash).map(row => ({ key: row.key,
      baseHash: row.baseHash, localHash: row.localHash, remoteHash: row.remoteHash, parts: row.merge?.conflicts ?? [],
      unresolvedPartIds: row.merge?.unresolved.map(part => part.id) ?? [] }))
    const comparable = records.length > 0 && records.every(row => row.baseHash && row.localHash && row.remoteHash && row.parts.length)
    const choices: ResolveWebDavProtocol5Conflict['choice'][] = comparable ? [...component.choices] : []
    // Copy planning independently accounts for link dependencies and therefore
    // has a different component identity. A choice here must cover exactly the
    // records and versions displayed in this conflict group.
    const source = publicationJson(component.records.map(({ merge: _merge, ...record }) => record))
    const copy = both?.components.find(item => item.choices.includes('both')
      && item.localSignature === component.localSignature && item.remoteSignature === component.remoteSignature
      && publicationJson(item.records) === source)
    const decision = copy && bothDecision(copy)
    if (!both || !copy || !decision) return { componentId: component.componentId, records, choices }
    selections.set(component.componentId, { previewId: both.previewId, previewHash: both.previewHash, decision })
    const documentPaths = decision.copyDocumentIds.map(id => copy.copyDocuments.find(row => row.sourceDocumentId === id)!.path)
    return { componentId: component.componentId, records, choices: [...choices, 'both'], copies: { documentPaths, groupCount: decision.groups.length } }
  }) }
  bothSelections.set(preview, selections)
  return preview
}

export async function resolveProtocol5WebDavConflict(store: KnowbookStore, profile: string, target: WebDavSyncConfig,
  selection: ResolveWebDavProtocol5Conflict, runtime: SyncedPublicationRuntime, preview: WebDavProtocol5ConflictPreview): Promise<Outcome> {
  const binding = bindRoute(store, target)
  if (!binding.route.lastSyncAt || binding.route.pending) throw new Error('请先完成此工作区的同步。')
  const userDataRoot = realpathSync(profile), operationId = randomUUID()
  if (selection.choice === 'both') {
    const both = bothSelections.get(preview)?.get(selection.componentId)
    if (!both) throw new Error('保留双方的预览已失效，请重新读取。')
    return settleExchange(store, userDataRoot, target, runtime, { kind: 'resolve-both', operationId, selection: both, originalTarget: target }, binding)
  }
  const component = preview.components.find(item => item.componentId === selection.componentId)
  const selectionKeys = exchangeKeys(component?.records.map(({ key }) => key).sort(publicationCompare) ?? [])
  if (!selectionKeys.length) throw new Error('冲突预览已失效，请重新读取后再选择。')
  return settleExchange(store, userDataRoot, target, runtime,
    { kind: 'resolve', operationId, selection, selectionKeys, originalTarget: target }, binding)
}

export async function previewProtocol5WebDavDeletions(store: KnowbookStore, profile: string, target: WebDavSyncConfig,
  runtime: SyncedPublicationRuntime): Promise<WebDavProtocol5DeletionPreview> {
  const binding = bindRoute(store, target)
  if (!binding.route.lastSyncAt || binding.route.pending) throw new Error('请先完成此工作区的同步。')
  const result = await previewSyncedExchangeDeletionDetails(store.getUnsafeDatabaseHandle(),
    { previewId: randomUUID(), userDataRoot: realpathSync(profile), target }, runtime)
  binding.assertCurrent()
  if (result.status !== 'ready') throw new Error('当前删除冲突版本不可用，请重新同步后再查看。')
  return result.preview
}

export async function resolveProtocol5WebDavDeletion(store: KnowbookStore, profile: string, target: WebDavSyncConfig,
  selection: ResolveWebDavProtocol5Deletion, runtime: SyncedPublicationRuntime): Promise<Outcome> {
  const binding = bindRoute(store, target)
  if (!binding.route.lastSyncAt || binding.route.pending) throw new Error('请先完成此工作区的同步。')
  return settleExchange(store, realpathSync(profile), target, runtime,
    { kind: 'resolve-deletion', operationId: randomUUID(), selection, originalTarget: target }, binding)
}

/** The existing service owns mutual exclusion, credentials, cancellation and scheduling. */
export async function runProtocol5WebDav(
  store: KnowbookStore, profile: string, target: WebDavSyncConfig, runtime: SyncedPublicationRuntime
): Promise<Outcome> {
  const userDataRoot = realpathSync(profile), binding = bindRoute(store, target)
  const { route, assertCurrent, persist } = binding
  const receiver = store.getSettingPublic(SYNC_RECEIVER_PROFILE_KEY) === 'true'
  const db = store.getUnsafeDatabaseHandle()
  const pending = route.pending
  const resume = pending?.kind === 'publish' && hasInitialSyncedPublicationAttempt(db, pending.operationId)
  // Let a recorded kernel operation query its actual receipt first. A fresh
  // probe must not hide a committed local receipt when the server is offline.
  const recovering = resume || pending?.kind === 'receive' || pending?.kind === 'exchange' || pending?.kind === 'resolve'
    || pending?.kind === 'resolve-both' || pending?.kind === 'resolve-deletion'
  const remote = recovering ? null : await peekProtocol5Remote(new WebDavClient(target, runtime.password, runtime.signal))
  assertCurrent()
  if (route.lastSyncAt) {
    if (remote === 'missing') throw new Error('已同步的远端清单丢失，已暂停以保护本地资料。')
    const operation = pending?.kind === 'exchange' || pending?.kind === 'resolve' || pending?.kind === 'resolve-both' || pending?.kind === 'resolve-deletion'
      ? pending : { kind: 'exchange' as const, operationId: randomUUID() }
    return settleExchange(store, userDataRoot, target, runtime, operation, binding)
  }
  if (receiver || pending?.kind === 'receive' || (!pending && remote === 'protocol5' && canJoinSyncedProtocol5Workspace(db))) {
    if (pending?.kind === 'publish') throw new Error('接收端与已记录的首次发布任务不一致。')
    if (remote === 'missing') throw new Error('尚未找到同步块工作区。请先在原设备完成发布。')
    const operationId = pending?.operationId ?? randomUUID()
    persist({ kind: 'receive', operationId })
    const result = await receiveInitialSyncedSnapshot(db, { operationId, userDataRoot, target }, runtime)
    if (result.status !== 'applied' && result.status !== 'noop') {
      throw new Error('未能接收远端工作区。请核对本机空工作区及远端版本；本地文档和远端清单保留。')
    }
    persist(null, result.acceptedAt)
    return { uploaded: 0, downloaded: result.counts.documents + result.counts.groups, message: '已接收远端工作区。' }
  }
  if (remote !== 'missing' && !resume) {
    throw new Error('此目录已有 KnowBook 工作区。请从空白工作区加入，或选择一个空目录发布本机工作区。')
  }
  const attemptId = resume && pending ? pending.operationId : randomUUID()
  persist({ kind: 'publish', operationId: attemptId })
  const input = { attemptId, userDataRoot, target }
  const result = resume ? await recoverInitialSyncedPublication(db, input) : await prepareInitialSyncedPublication(db, input, true)
  if (result.status !== 'prepared') throw new Error('无法准备工作区的首次发布。')
  try {
    const prepared = readPreparedSyncedPublication(result.prepared)
    if (!prepared) throw new Error('首次发布的原准备记录不可用。')
    const published = await publishInitialSyncedPublication(db, result.prepared, runtime)
    if (published.status !== 'confirmed') throw new Error('首次发布未确认，原发布任务和远端资料保留。')
    persist(null, new Date().toISOString())
    return { uploaded: published.replayed ? 0 : prepared.descriptor.objects.length, downloaded: 0, message: '工作区首次发布完成。' }
  } finally {
    disposePreparedSyncedPublication(result.prepared)
  }
}
