import { randomUUID } from 'node:crypto'
import type { KnowbookStore } from '../database/store'
import type { AttachmentStore } from '../attachments'
import { protectCredential, revealCredential, type SecureStringStorage } from '../credential-storage'
import { DEFAULT_WEBDAV_SYNC_CONFIG, type ResolveWebDavSyncConflict, type SaveWebDavSyncConfig, type WebDavSyncConfig, type WebDavSyncStatus, type WebDavSyncProgress } from '../../shared/webdav-sync'
import { SyncAssets, syncAssetReferences, type SyncAssetProgress } from './assets'
import { canonicalJson, conflictPreview, emptySyncState, hashBytes, parseManifest, recordHash, recordKey, validateRecord, type SyncManifest, type SyncRecord, type SyncState, type SyncDocument } from './model'
import { normalizeWebDavConfig, WebDavClient, WebDavHttpError, type WebDavCapabilities } from './webdav-client'

const CONFIG_KEY = 'sync.webdav.config'
const PASSWORD_KEY = 'sync.webdav.password'
const MAX_RECORD_BYTES = 16 * 1024 * 1024

function targetKey(config: WebDavSyncConfig): string {
  return 'sync.webdav.state.' + hashBytes(canonicalJson([config.url, config.username, config.directory]))
}

function emptyDatabases(record: SyncRecord | undefined): boolean {
  return record?.kind === 'databases' && record.tables.databases.length === 1
    && record.tables.databases[0].name === 'Default' && record.tables.databases[0].description === 'Default database'
    && Object.entries(record.tables).every(([table, rows]) => table === 'databases' || rows.length === 0)
}

function documentCopy(record: SyncDocument, salt: string): SyncDocument {
  const id = hashBytes(`conflict:${record.id}:${salt}`).slice(0, 32)
  const ids = new Map(record.content.blocks.map(block => [block.id!, hashBytes(`${id}:${block.id}`).slice(0, 32)]))
  return { ...record, id, parentId: null, content: { ...record.content, title: `${record.content.title.slice(0, 450)}（同步冲突副本）`,
    blocks: record.content.blocks.map(block => ({ ...block, id: ids.get(block.id!)!,
      parentBlockId: block.parentBlockId ? ids.get(block.parentBlockId) ?? null : null })) } }
}

export class WebDavSyncService {
  private config: WebDavSyncConfig
  private phase: WebDavSyncStatus['phase'] = 'idle'
  private message = ''
  private uploaded = 0
  private downloaded = 0
  private progress: WebDavSyncProgress | null = null
  private busy: Promise<void> | null = null
  private abort: AbortController | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private stopped = false
  private verifiedTarget: string | null = null
  private capabilities: WebDavCapabilities | undefined
  private readonly assets: SyncAssets
  private readonly uploadedObjects = new Set<string>()
  private readonly uploadedAssets = new Set<string>()
  private readonly remoteObjects = new Map<string, SyncRecord>()
  private remoteObjectBytes = 0

  constructor(private readonly store: KnowbookStore, attachments: AttachmentStore,
    private readonly credentials: SecureStringStorage, private readonly onChanged: () => void = () => {},
    private readonly workspaceBusy: () => boolean = () => false) {
    this.config = { ...DEFAULT_WEBDAV_SYNC_CONFIG }
    const stored = store.getSettingPublic(CONFIG_KEY)
    if (stored) { try { this.config = normalizeWebDavConfig(JSON.parse(stored)) } catch { this.message = '保存的同步设置无效，请重新配置。' } }
    this.assets = new SyncAssets(attachments)
  }

  private state(): SyncState {
    const value = this.store.getSettingPublic(targetKey(this.config))
    return value ? JSON.parse(value) as SyncState : emptySyncState()
  }
  private saveState(state: SyncState): void { this.store.saveSetting(targetKey(this.config), JSON.stringify(state)) }

  getStatus(): WebDavSyncStatus {
    const state = this.state()
    return { config: { ...this.config }, hasPassword: Boolean(this.store.getSettingPublic(PASSWORD_KEY)), phase: this.phase,
      lastSyncAt: state.lastSyncAt, message: this.message, uploaded: this.uploaded, downloaded: this.downloaded,
      progress: this.progress ? { ...this.progress } : null,
      conflicts: Object.entries(state.conflicts).map(([key, conflict]) => ({ key,
        title: conflict.local.kind === 'document' ? conflict.local.content.title : conflict.remote.kind === 'document' ? conflict.remote.content.title : '数据库、属性和视图',
        localPreview: conflictPreview(conflict.local), remotePreview: conflictPreview(conflict.remote), canKeepBoth: conflict.local.kind === 'document' })) }
  }

  private stage(stage: WebDavSyncProgress['stage'], total: number | null = null, attachmentsTotal = 0): void {
    if (!this.progress) return
    this.progress = { ...this.progress, stage, total, completed: 0, attachmentsTotal, attachmentsCompleted: 0,
      currentItem: null, currentAttachment: null }
  }

  private itemName(record: SyncRecord | undefined): string | null {
    return record?.kind === 'document' ? record.content.title.slice(0, 160) : null
  }

  private assetProgress(): SyncAssetProgress {
    const completed = new Set<string>()
    return asset => {
      if (!this.progress) return
      this.progress.currentAttachment = asset.completed ? null : asset.name
      if (asset.completed) completed.add(asset.key)
      this.progress.attachmentsCompleted = completed.size
    }
  }

  saveConfig(input: SaveWebDavSyncConfig): WebDavSyncStatus {
    if (this.busy) throw new Error('请等待当前同步或连接测试结束后修改设置。')
    const next = normalizeWebDavConfig(input)
    if (input.password !== undefined && (typeof input.password !== 'string' || input.password.length > 4096)) throw new Error('应用密码无效。')
    const targetChanged = targetKey(next) !== targetKey(this.config)
    if (targetChanged && !input.password) throw new Error('更换同步地址、目录或账号时，请重新填写应用密码。')
    let encrypted: string | null = null
    try { if (input.password) encrypted = protectCredential(input.password, this.credentials) }
    catch { throw new Error('无法安全保存 WebDAV 应用密码，请检查系统凭据存储是否可用。') }
    if (next.enabled && input.password === '') throw new Error('启用同步前请填写应用密码。')
    if (next.enabled && !encrypted && !this.store.getSettingPublic(PASSWORD_KEY)) throw new Error('启用同步前请填写应用密码。')
    this.store.runInTransaction(() => {
      this.store.saveSetting(CONFIG_KEY, JSON.stringify(next))
      if (encrypted) this.store.saveSetting(PASSWORD_KEY, encrypted)
      else if (input.password === '') this.store.deleteSetting(PASSWORD_KEY)
    })
    this.config = next
    if (targetChanged) { this.uploadedObjects.clear(); this.uploadedAssets.clear(); this.remoteObjects.clear(); this.remoteObjectBytes = 0 }
    this.verifiedTarget = null
    this.capabilities = undefined
    this.message = '设置已保存。首次同步会合并两端已有内容。'
    this.phase = 'idle'
    this.schedule()
    return this.getStatus()
  }

  start(): void { this.schedule(); if (this.config.enabled) void this.sync().catch(() => {}) }
  private schedule(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (!this.stopped && this.config.enabled) {
      this.timer = setInterval(() => { if (!this.busy) void this.sync().catch(() => {}) }, this.config.intervalMinutes * 60_000)
      this.timer.unref()
    }
  }

  private client(): WebDavClient {
    const stored = this.store.getSettingPublic(PASSWORD_KEY)
    if (!stored) throw new Error('请先保存 WebDAV 地址、用户名和应用密码。')
    let password: string
    try { password = revealCredential(stored, this.credentials).value }
    catch { throw new Error('无法解密 WebDAV 应用密码，请重新填写并保存。') }
    return new WebDavClient(normalizeWebDavConfig(this.config), password, this.abort?.signal, this.capabilities, activity => {
      if (!this.progress) return
      this.progress.waitingUntil = activity.waitingUntil
      if (activity.completed) this.progress.requestsCompleted++
    })
  }

  private async operation(phase: 'testing' | 'syncing', run: () => Promise<void>): Promise<WebDavSyncStatus> {
    if (this.stopped) throw new Error('同步服务已关闭。')
    if (this.workspaceBusy()) throw new Error('正在恢复工作区，请稍后再同步。')
    if (this.busy) throw new Error('已有同步或连接测试正在进行。')
    this.abort = new AbortController()
    this.phase = phase
    this.uploaded = 0; this.downloaded = 0
    this.progress = { stage: 'checking', total: null, completed: 0, attachmentsTotal: 0, attachmentsCompleted: 0,
      currentItem: null, currentAttachment: null, startedAt: new Date().toISOString(), requestsCompleted: 0, waitingUntil: null }
    this.message = phase === 'testing' ? '正在验证连接和条件写入能力…' : '正在同步…'
    const work = Promise.resolve().then(run)
    this.busy = work
    try { await work; this.phase = 'idle' }
    catch (error) {
      this.phase = 'error'
      this.message = error instanceof Error ? error.message : '同步失败，下次将自动重试。'
      throw new Error(this.message)
    } finally { this.busy = null; this.abort = null; this.progress = null }
    return this.getStatus()
  }

  testConnection(): Promise<WebDavSyncStatus> {
    return this.operation('testing', async () => {
      this.verifiedTarget = null
      this.capabilities = undefined
      this.capabilities = await this.client().test()
      this.verifiedTarget = targetKey(this.config)
      this.message = '连接成功，读写与并发保护检查通过。'
    })
  }

  sync(): Promise<WebDavSyncStatus> {
    return this.operation('syncing', async () => {
      const client = this.client()
      if (this.verifiedTarget !== targetKey(this.config)) {
        this.capabilities = await client.test()
        this.verifiedTarget = targetKey(this.config)
      }
      this.uploaded = 0; this.downloaded = 0
      for (let attempt = 0; attempt < 3; attempt++) {
        try { await this.exchange(client); return }
        catch (error) { if (!(error instanceof WebDavHttpError && error.status === 412) || attempt === 2) throw error }
      }
    })
  }

  private async exchange(client: WebDavClient): Promise<void> {
    const state = this.state()
    const raw = this.store.getSyncRecords()
    const local = new Map<string, SyncRecord>()
    this.stage('preparing', raw.size)
    for (const [key, record] of raw) {
      this.progress!.currentItem = this.itemName(record)
      local.set(key, await this.assets.portable(record))
      this.progress!.completed++
    }
    this.stage('comparing')
    const response = await client.getVersioned('manifest.json')
    if (!response && state.workspaceId) throw new Error('远端同步清单丢失，已停止同步以保护本地数据。请恢复远端目录或改用新的同步目录。')
    const manifest: SyncManifest = response ? parseManifest(response.bytes) : { version: 1, workspaceId: randomUUID(), entries: {} }
    if (state.workspaceId && state.workspaceId !== manifest.workspaceId) throw new Error('远端工作区已被替换，请使用新的同步目录以免合并错误的数据。')
    const next: SyncManifest = { ...manifest, entries: { ...manifest.entries } }
    const incoming = new Map<string, SyncRecord>()
    const writes = new Map<string, SyncRecord>()
    const accepted = new Map<string, { localHash: string | null; remoteHash: string }>()
    const conflicts: SyncState['conflicts'] = {}
    const remoteRecord = async (key: string, hash: string): Promise<SyncRecord> => {
      if (this.remoteObjects.has(hash)) return validateRecord(this.remoteObjects.get(hash)!, key)
      const object = await client.get(`objects/${hash}.json`, MAX_RECORD_BYTES)
      if (!object || hashBytes(object.bytes) !== hash) throw new Error('远端文档版本缺失或校验失败，未更新本地数据。')
      const record = validateRecord(JSON.parse(Buffer.from(object.bytes).toString('utf8')), key)
      this.remoteObjects.set(hash, record)
      this.remoteObjectBytes += Buffer.byteLength(canonicalJson(record))
      while (this.remoteObjects.size > 256 || this.remoteObjectBytes > 32 * 1024 * 1024) {
        const oldest = this.remoteObjects.keys().next().value!
        this.remoteObjectBytes -= Buffer.byteLength(canonicalJson(this.remoteObjects.get(oldest)))
        this.remoteObjects.delete(oldest)
      }
      return record
    }
    const keys = [...new Set([...local.keys(), ...Object.keys(manifest.entries), ...Object.keys(state.baseline)])]
    this.stage('comparing', keys.length)
    for (const [index, key] of keys.entries()) {
      const current = local.get(key)
      this.progress!.completed = index
      this.progress!.currentItem = this.itemName(current)
      const localHash = current ? recordHash(current) : null
      const deletion: SyncRecord = { kind: 'deleted', id: key.slice(4) }
      const proposed = current ?? deletion
      const proposedHash = recordHash(proposed)
      const remoteHash = manifest.entries[key]
      const baseline = state.baseline[key]
      if (!remoteHash && baseline) throw new Error('远端清单缺少已同步的版本，请恢复远端清单后重试。')
      if (remoteHash === proposedHash) { accepted.set(key, { localHash, remoteHash }); continue }
      const localChanged = baseline ? localHash !== baseline.localHash : current !== undefined && !(key === 'databases' && emptyDatabases(current) && remoteHash)
      const remoteChanged = baseline ? remoteHash !== baseline.remoteHash : Boolean(remoteHash)
      if (localChanged && remoteChanged) {
        const remote = await remoteRecord(key, remoteHash)
        const resolution = state.resolutions[key]
        if (resolution?.localHash === proposedHash && resolution.remoteHash === remoteHash) {
          if (resolution.choice === 'local') writes.set(key, proposed)
          else {
            incoming.set(key, remote)
            if (resolution.choice === 'both' && proposed.kind === 'document') {
              const copy = documentCopy(proposed, `${proposedHash}:${remoteHash}`)
              writes.set(recordKey(copy), copy)
              incoming.set(recordKey(copy), copy)
            }
          }
        } else conflicts[key] = { local: proposed, remote, localHash: proposedHash, remoteHash }
      } else if (localChanged || !remoteHash && current) writes.set(key, proposed)
      else if (remoteChanged && remoteHash) incoming.set(key, await remoteRecord(key, remoteHash))
      else if (remoteHash) accepted.set(key, { localHash, remoteHash })
    }
    this.stage('uploading', writes.size, new Set([...writes.values()].flatMap(record => syncAssetReferences(record).map(asset => asset.hash))).size)
    const uploadProgress = this.assetProgress()
    for (const [key, record] of writes) {
      this.progress!.currentItem = this.itemName(record)
      const bytes = Buffer.from(canonicalJson(record))
      if (bytes.length > MAX_RECORD_BYTES) throw new Error('单篇文档或数据库同步数据超过 16 MB。')
      const hash = hashBytes(bytes)
      await this.assets.upload(record, client, this.uploadedAssets, uploadProgress)
      if (!this.uploadedObjects.has(hash)) {
        await client.put(`objects/${hash}.json`, bytes)
        this.uploadedObjects.add(hash)
      }
      next.entries[key] = hash
      accepted.set(key, { localHash: record.kind === 'deleted' ? null : hash, remoteHash: hash })
      this.progress!.completed++
    }
    // Assets must be verified and durable before any local document can reference them.
    const localized = new Map<string, SyncRecord>()
    this.stage('downloading', incoming.size, new Set([...incoming.values()].flatMap(record => syncAssetReferences(record).map(asset => asset.url))).size)
    const downloadProgress = this.assetProgress()
    for (const [key, record] of incoming) {
      this.progress!.currentItem = this.itemName(record)
      localized.set(key, await this.assets.local(record, client, downloadProgress))
      this.progress!.completed++
    }
    if (this.abort?.signal.aborted) throw new Error('同步已停止。')
    const changed = !response || canonicalJson(next) !== canonicalJson(manifest)
    if (changed) {
      this.stage('publishing')
      const manifestBytes = Buffer.from(canonicalJson(next))
      if (manifestBytes.length > MAX_RECORD_BYTES) throw new Error('同步清单超过 16 MB。')
      if (response) await client.put('manifest.json', manifestBytes, { etag: response.etag })
      else await client.create('manifest.json', manifestBytes)
    }
    // Network waits can overlap local editing. Defer all incoming mutations in that case.
    const latest = this.store.getSyncRecords()
    const localUnchanged = canonicalJson([...latest]) === canonicalJson([...raw])
    this.stage('applying')
    this.store.runInTransaction(() => {
      if (localUnchanged && localized.size) this.store.applySyncRecords([...localized.values()])
      const after = this.store.getSyncRecords()
      for (const [key, baseline] of accepted) {
        if (localUnchanged || !incoming.has(key)) state.baseline[key] = baseline
      }
      if (localUnchanged) {
        for (const key of localized.keys()) {
          const record = after.get(key)
          state.baseline[key] = { localHash: record ? recordHash(this.assets.portableKnown(record)) : null, remoteHash: next.entries[key] }
        }
      }
      state.workspaceId = manifest.workspaceId
      state.conflicts = conflicts
      // Keep resolutions until incoming changes were actually applied.
      if (localUnchanged) state.resolutions = {}
      state.lastSyncAt = new Date().toISOString()
      this.saveState(state)
    })
    this.uploaded = writes.size
    this.downloaded = localUnchanged ? localized.size : 0
    const count = Object.keys(conflicts).length
    this.message = count ? `已同步其他内容；${count} 项冲突已保留双方版本，请选择处理方式。`
      : !localUnchanged && localized.size ? '本地正在编辑，远端更新将在下次同步时应用。'
      : `同步完成：上传 ${this.uploaded} 项，下载 ${this.downloaded} 项。`
    if (this.downloaded) this.onChanged()
  }

  resolveConflict(input: ResolveWebDavSyncConflict): WebDavSyncStatus {
    if (this.busy) throw new Error('请等待同步结束后处理冲突。')
    if (!input || typeof input.key !== 'string' || !['local', 'remote', 'both'].includes(input.choice)) throw new Error('冲突处理参数无效。')
    const state = this.state(), conflict = state.conflicts[input.key]
    if (!conflict) throw new Error('该冲突已不存在，请刷新。')
    if (input.choice === 'both' && conflict.local.kind !== 'document') throw new Error('该冲突不支持创建文档副本。')
    state.resolutions[input.key] = { localHash: conflict.localHash, remoteHash: conflict.remoteHash, choice: input.choice }
    this.saveState(state)
    this.message = '处理方式已保存，点击立即同步以应用；若任一版本变化，将重新提示冲突。'
    return this.getStatus()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.abort?.abort()
    await this.busy?.catch(() => {})
  }

  async waitForIdle(): Promise<void> { await this.busy?.catch(() => {}) }

  async cancel(): Promise<WebDavSyncStatus> {
    this.abort?.abort()
    await this.waitForIdle()
    this.phase = 'idle'
    this.message = '本次同步已停止。已保存的本地数据仍在；自动同步将按设置的间隔重试。'
    return this.getStatus()
  }
}
