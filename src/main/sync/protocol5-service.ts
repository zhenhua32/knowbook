import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import type { KnowbookStore } from '../database/store'
import type { ResolveWebDavProtocol5Conflict, ResolveWebDavProtocol5Deletion, WebDavProtocol5ConflictPreview, WebDavProtocol5DeletionPreview, WebDavSyncConfig } from '../../shared/webdav-sync'
import { parseStrictJson } from '../../shared/strictJson'
import { assertSyncedShape, isSyncedUuid } from '../../shared/syncedBlockValidation'
import type { EditorRecoveryWorkspace } from '../../shared/editor-recovery-drafts'
import { validateInitialManifest5 } from './synced-publication-model'
import { exchangeJobHeadKey, exchangeTargetFingerprint } from './synced-exchange-model'
import { normalizeWebDavConfig, WebDavClient } from './webdav-client'
import { SYNC_RECEIVER_PROFILE_KEY } from './receiver-bootstrap'
import {
  disposePreparedSyncedPublication, prepareInitialSyncedPublication, publishInitialSyncedPublication, readPreparedSyncedPublication,
  receiveInitialSyncedSnapshot, recoverInitialSyncedPublication, type SyncedPublicationRuntime
} from './synced-publication'
import { exchangeSyncedSnapshot, previewSyncedExchangeConflicts, previewSyncedExchangeDeletionDetails,
  resolveSyncedExchangeConflicts, resolveSyncedExchangeDeletions } from './synced-exchange'

const MAX_MANIFEST_BYTES = 16 * 1024 * 1024
// Device settings are separate from the strict sync.webdav.protocol5 evidence families.
const CLIENT_SETTINGS_PREFIX = 'sync.webdav.client.protocol5.'
type PendingExchange = { kind: 'exchange'; operationId: string }
  | { kind: 'resolve'; operationId: string; selection: ResolveWebDavProtocol5Conflict; originalTarget: WebDavSyncConfig }
  | { kind: 'resolve-deletion'; operationId: string; selection: ResolveWebDavProtocol5Deletion; originalTarget: WebDavSyncConfig }
type Pending = { kind: 'publish' | 'receive'; operationId: string } | PendingExchange
type Route = { workspace: EditorRecoveryWorkspace; lastSyncAt: string | null; pending: Pending | null }
type Outcome = { uploaded: number; downloaded: number; message: string }
type Remote = 'missing' | 'protocol5'
const sha256 = /^[a-f0-9]{64}$/

function readSelectionFields(value: unknown) {
  assertSyncedShape(value, ['previewId', 'previewHash', 'componentId', 'choice'])
  const { previewId, previewHash, componentId, choice } = value
  if (!isSyncedUuid(previewId) || typeof previewHash !== 'string' || !sha256.test(previewHash)
    || typeof componentId !== 'string' || !sha256.test(componentId)) {
    throw new Error('同步块冲突选择无效，请刷新预览。')
  }
  return { previewId, previewHash, componentId, choice }
}
export function readProtocol5Selection(value: unknown): ResolveWebDavProtocol5Conflict {
  const fields = readSelectionFields(value), { choice } = fields
  if (choice !== 'local' && choice !== 'remote') throw new Error('同步块冲突选择无效，请刷新预览。')
  return { ...fields, choice }
}
export function readProtocol5DeletionSelection(value: unknown): ResolveWebDavProtocol5Deletion {
  const fields = readSelectionFields(value), { choice } = fields
  if (choice !== 'keep-live' && choice !== 'keep-delete') throw new Error('同步块删除冲突选择无效，请刷新预览。')
  return { ...fields, choice }
}

export function protocol5ModeKey(target: WebDavSyncConfig): string {
  return CLIENT_SETTINGS_PREFIX + 'opt-in.v1.' + exchangeTargetFingerprint(target)
}
function routeKey(target: WebDavSyncConfig): string {
  return CLIENT_SETTINGS_PREFIX + 'route.v1.' + exchangeTargetFingerprint(target)
}

function loadRoute(store: KnowbookStore, target: WebDavSyncConfig): Route | null {
  const raw = store.getSettingPublic(routeKey(target))
  if (raw === null) return null
  const value = parseStrictJson(raw, { maxBytes: 16 * 1024, maxDepth: 4 })
  assertSyncedShape(value, ['workspace', 'lastSyncAt', 'pending'])
  assertSyncedShape(value.workspace, ['workspaceScope', 'recoveryEpoch'])
  if (!isSyncedUuid(value.workspace.workspaceScope) || !isSyncedUuid(value.workspace.recoveryEpoch)
    || (value.lastSyncAt !== null && (typeof value.lastSyncAt !== 'string' || !Number.isFinite(Date.parse(value.lastSyncAt))))) {
    throw new Error('同步块本地同步记录不完整，已暂停。')
  }
  if (value.pending !== null) {
    assertSyncedShape(value.pending, ['kind', 'operationId'], ['selection', 'originalTarget'])
    const { kind } = value.pending, resolving = kind === 'resolve' || kind === 'resolve-deletion'
    if (!isSyncedUuid(value.pending.operationId)
      || typeof kind !== 'string' || !['publish', 'receive', 'exchange', 'resolve', 'resolve-deletion'].includes(kind)
      || (kind === 'exchange' || resolving) !== Boolean(value.lastSyncAt)) {
      throw new Error('同步块本地同步任务不完整，已暂停。')
    }
    if (resolving) {
      if (kind === 'resolve') readProtocol5Selection(value.pending.selection)
      else readProtocol5DeletionSelection(value.pending.selection)
      assertSyncedShape(value.pending.originalTarget, ['enabled', 'url', 'username', 'directory', 'intervalMinutes', 'allowInsecureHttp'])
      if (exchangeTargetFingerprint(normalizeWebDavConfig(value.pending.originalTarget as unknown as WebDavSyncConfig)) !== exchangeTargetFingerprint(target)) {
        throw new Error('待恢复的冲突决定不属于当前同步目标。')
      }
    } else if ('selection' in value.pending || 'originalTarget' in value.pending) throw new Error('原同步任务字段无效。')
  }
  return value as unknown as Route
}

/** Read-only discriminator. Kernel operations verify the exact full closure again. */
export async function peekProtocol5Remote(client: WebDavClient): Promise<Remote> {
  const response = await client.getVersioned('manifest.json', MAX_MANIFEST_BYTES)
  if (!response) return 'missing'
  const manifest = parseStrictJson(Buffer.from(response.bytes).toString('utf8'), { maxBytes: MAX_MANIFEST_BYTES, maxDepth: 32 })
  if (manifest && typeof manifest === 'object' && 'version' in manifest && [1, 2, 3, 4].includes(manifest.version as number)) {
    throw new Error('远端目录已有旧版 KnowBook 同步。请保留原目录并为同步块选用独立目录。')
  }
  validateInitialManifest5(manifest)
  return 'protocol5'
}

export function protocol5LastSyncAt(store: KnowbookStore, target: WebDavSyncConfig): string | null {
  // Configuration remains accessible if the selected target's private route is
  // damaged. The execution path still refuses it before contacting WebDAV.
  try { return loadRoute(store, target)?.lastSyncAt ?? null } catch { return null }
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
    store.saveSetting(routeKey(target), JSON.stringify({ ...route, pending, lastSyncAt }))
  }
  assertCurrent()
  return { route, assertCurrent, persist }
}

async function settleExchange(store: KnowbookStore, userDataRoot: string, target: WebDavSyncConfig,
  runtime: SyncedPublicationRuntime, pending: PendingExchange, binding: ReturnType<typeof bindRoute>): Promise<Outcome> {
  const db = store.getUnsafeDatabaseHandle(), { operationId } = pending
  binding.persist(pending)
  try {
    const result = pending.kind === 'exchange' ? await exchangeSyncedSnapshot(db, { operationId, userDataRoot, target }, runtime)
      : pending.kind === 'resolve-deletion' ? await resolveSyncedExchangeDeletions(db, {
        operationId, userDataRoot, target: pending.originalTarget, previewId: pending.selection.previewId, expectedPreviewHash: pending.selection.previewHash,
        decisions: [{ componentId: pending.selection.componentId, choice: pending.selection.choice }]
      }, runtime) : await resolveSyncedExchangeConflicts(db, { operationId, userDataRoot, target: pending.originalTarget,
        previewId: pending.selection.previewId, decisions: [{ componentId: pending.selection.componentId, choice: pending.selection.choice }] }, runtime)
    if (result.status !== 'applied' && result.status !== 'noop' && result.status !== 'deferred') {
      throw new Error('远端或本地同步版本已变化，请重新查看冲突。')
    }
    binding.persist(null, result.acceptedAt)
    return { uploaded: result.publishedKeys.length, downloaded: result.appliedKeys.length,
      message: result.deferred.length ? `已同步可安全提交的内容，${result.deferred.length} 项冲突仍保留。` : '同步块工作区同步完成。' }
  } catch (error) {
    // A rejected selector with no kernel job has no durable publication to
    // recover. Once a job exists, only its original exact operation may retry.
    if (pending.kind !== 'exchange' && !store.getSettingPublic(exchangeJobHeadKey(operationId))) binding.persist(null)
    throw error
  }
}

export async function previewProtocol5WebDavConflicts(store: KnowbookStore, profile: string, target: WebDavSyncConfig,
  runtime: SyncedPublicationRuntime): Promise<WebDavProtocol5ConflictPreview> {
  const binding = bindRoute(store, target)
  if (!binding.route.lastSyncAt || binding.route.pending) throw new Error('请先完成此工作区的同步。')
  const result = await previewSyncedExchangeConflicts(store.getUnsafeDatabaseHandle(),
    { previewId: randomUUID(), userDataRoot: realpathSync(profile), target }, runtime)
  binding.assertCurrent()
  if (result.status !== 'ready') throw new Error('当前冲突版本不可用，请重新同步后再查看。')
  const { previewId, previewHash, components } = result.preview
  return { previewId, previewHash, components: components.map(component => {
    const records = component.records.filter(row => row.localHash !== row.remoteHash).map(row => ({ key: row.key,
      baseHash: row.baseHash, localHash: row.localHash, remoteHash: row.remoteHash, parts: row.merge?.conflicts ?? [] }))
    const comparable = records.length > 0 && records.every(row => row.baseHash && row.localHash && row.remoteHash && row.parts.length)
    return { componentId: component.componentId, records,
      choices: comparable ? component.choices.filter(choice => choice === 'local' || choice === 'remote') : [] }
  }) }
}

export async function resolveProtocol5WebDavConflict(store: KnowbookStore, profile: string, target: WebDavSyncConfig,
  selection: ResolveWebDavProtocol5Conflict, runtime: SyncedPublicationRuntime): Promise<Outcome> {
  const binding = bindRoute(store, target)
  if (!binding.route.lastSyncAt || binding.route.pending) throw new Error('请先完成此工作区的同步。')
  return settleExchange(store, realpathSync(profile), target, runtime,
    { kind: 'resolve', operationId: randomUUID(), selection, originalTarget: target }, binding)
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
  store: KnowbookStore, profile: string, target: WebDavSyncConfig, runtime: SyncedPublicationRuntime, hasLegacyBaseline: boolean
): Promise<Outcome> {
  const userDataRoot = realpathSync(profile), binding = bindRoute(store, target)
  const { route, assertCurrent, persist } = binding
  const receiver = store.getSettingPublic(SYNC_RECEIVER_PROFILE_KEY) === 'true'
  const db = store.getUnsafeDatabaseHandle()
  const exposure = (operationId: string) => db.prepare("SELECT 1 FROM synced_exposure_attempts WHERE id=? AND channel='webdav-manifest5'").get(operationId)
  const pending = route.pending
  const resume = pending?.kind === 'publish' && Boolean(exposure(pending.operationId))
  // Let a recorded kernel operation query its actual receipt first. A fresh
  // probe must not hide a committed local receipt when the server is offline.
  const recovering = resume || pending?.kind === 'receive' || pending?.kind === 'exchange' || pending?.kind === 'resolve' || pending?.kind === 'resolve-deletion'
  const remote = recovering ? null : await peekProtocol5Remote(new WebDavClient(target, runtime.password, runtime.signal))
  assertCurrent()
  if (route.lastSyncAt) {
    if (remote === 'missing') throw new Error('已同步的远端清单丢失，已暂停以保护本地资料。')
    const operation = pending?.kind === 'exchange' || pending?.kind === 'resolve' || pending?.kind === 'resolve-deletion'
      ? pending : { kind: 'exchange' as const, operationId: randomUUID() }
    return settleExchange(store, userDataRoot, target, runtime, operation, binding)
  }
  if (hasLegacyBaseline && !resume) throw new Error('此配置曾用于旧版 KnowBook 同步。原清单丢失时也不会重新发布，请使用新目录。')
  if (receiver || pending?.kind === 'receive') {
    if (pending?.kind === 'publish') throw new Error('接收端与已记录的首次发布任务不一致。')
    if (remote === 'missing') throw new Error('尚未找到同步块工作区。请先在原设备完成发布。')
    const operationId = pending?.operationId ?? randomUUID()
    persist({ kind: 'receive', operationId })
    const result = await receiveInitialSyncedSnapshot(db, { operationId, userDataRoot, target }, runtime)
    if (result.status !== 'applied' && result.status !== 'noop') {
      throw new Error('未能接收同步块初始快照。请核对本机空工作区及远端版本；本地文档和远端清单保留。')
    }
    persist(null, result.acceptedAt)
    return { uploaded: 0, downloaded: result.counts.documents + result.counts.groups, message: '已接收同步块工作区。' }
  }
  if (remote !== 'missing' && !resume) {
    throw new Error('此目录已有同步块工作区。首次发布需要空目录；加入已有工作区请使用新的接收端目录。')
  }
  const attemptId = resume && pending ? pending.operationId : randomUUID()
  persist({ kind: 'publish', operationId: attemptId })
  const input = { attemptId, userDataRoot, target }
  const result = resume ? await recoverInitialSyncedPublication(db, input) : await prepareInitialSyncedPublication(db, input, true)
  if (result.status !== 'prepared') throw new Error('首次发布前请先在此工作区创建同步块。')
  try {
    const prepared = readPreparedSyncedPublication(result.prepared)
    if (!prepared) throw new Error('首次发布的原准备记录不可用。')
    const published = await publishInitialSyncedPublication(db, result.prepared, runtime)
    if (published.status !== 'confirmed') throw new Error('首次发布未确认，原发布任务和远端资料保留。')
    persist(null, new Date().toISOString())
    return { uploaded: published.replayed ? 0 : prepared.descriptor.objects.length, downloaded: 0, message: '同步块工作区首次发布完成。' }
  } finally {
    disposePreparedSyncedPublication(result.prepared)
  }
}
