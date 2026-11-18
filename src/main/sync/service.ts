import type { KnowbookStore } from '../database/store'
import { protectCredential, revealCredential, type SecureStringStorage } from '../credential-storage'
import {
  DEFAULT_WEBDAV_SYNC_CONFIG, type SaveWebDavSyncConfig, type WebDavProtocol5ConflictPreview,
  type WebDavProtocol5DeletionPreview, type WebDavSyncConfig, type WebDavSyncProgress, type WebDavSyncStatus
} from '../../shared/webdav-sync'
import { exchangeTargetFingerprint } from './synced-exchange-model'
import {
  peekProtocol5Remote, previewProtocol5WebDavConflicts, previewProtocol5WebDavDeletions, protocol5LastSyncAt,
  protocol5NeedsRestoreRejoin, readProtocol5DeletionSelection, readProtocol5Selection,
  resolveProtocol5WebDavConflict, resolveProtocol5WebDavDeletion, runProtocol5WebDav
} from './protocol5-service'
import { confirmProtocol5RestoreRejoin, prepareProtocol5RestoreRejoin } from './protocol5-restore-rejoin-read'
import { normalizeWebDavConfig, observeWebDavProgress, WebDavClient } from './webdav-client'

const CONFIG_KEY = 'sync.webdav.config'
const PASSWORD_KEY = 'sync.webdav.password'

export class WebDavSyncService {
  private config = { ...DEFAULT_WEBDAV_SYNC_CONFIG }
  private phase: WebDavSyncStatus['phase'] = 'idle'
  private message = ''
  private uploaded = 0
  private downloaded = 0
  private merged = 0
  private progress: WebDavSyncProgress | null = null
  private busy: Promise<void> | null = null
  private abort: AbortController | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private stopped = false
  private conflictPreview?: WebDavProtocol5ConflictPreview
  private deletionPreview?: WebDavProtocol5DeletionPreview

  constructor(private readonly store: KnowbookStore, private readonly profile: string,
    private readonly credentials: SecureStringStorage, private readonly onChanged: () => void = () => {},
    private readonly workspaceBusy: () => boolean = () => false) {
    const stored = store.getSettingPublic(CONFIG_KEY)
    if (stored) {
      try { this.config = normalizeWebDavConfig(JSON.parse(stored)) }
      catch { this.message = '保存的同步设置无效，请重新配置。' }
    }
  }

  getStatus(): WebDavSyncStatus {
    return {
      config: { ...this.config }, hasPassword: Boolean(this.store.getSettingPublic(PASSWORD_KEY)),
      phase: this.phase, message: this.message, uploaded: this.uploaded, downloaded: this.downloaded,
      merged: this.merged, progress: this.progress ? { ...this.progress } : null,
      lastSyncAt: protocol5LastSyncAt(this.store, this.config),
      ...(this.conflictPreview ? { protocol5Preview: this.conflictPreview } : {}),
      ...(this.deletionPreview ? { protocol5DeletionPreview: this.deletionPreview } : {}),
      ...(protocol5NeedsRestoreRejoin(this.store, this.config) ? { protocol5RestoreRejoin: true as const } : {})
    }
  }

  saveConfig(input: SaveWebDavSyncConfig): WebDavSyncStatus {
    if (this.busy) throw new Error('请等待当前同步或连接测试结束后修改设置。')
    const next = normalizeWebDavConfig(input)
    if (input.password !== undefined && (typeof input.password !== 'string' || input.password.length > 4096)) {
      throw new Error('应用密码无效。')
    }
    if (exchangeTargetFingerprint(next) !== exchangeTargetFingerprint(this.config) && !input.password) {
      throw new Error('更换同步地址、目录或账号时，请重新填写应用密码。')
    }
    let encrypted: string | null = null
    try { if (input.password) encrypted = protectCredential(input.password, this.credentials) }
    catch { throw new Error('无法安全保存 WebDAV 应用密码，请检查系统凭据存储是否可用。') }
    if (next.enabled && (input.password === '' || (!encrypted && !this.store.getSettingPublic(PASSWORD_KEY)))) {
      throw new Error('启用同步前请填写应用密码。')
    }
    this.store.runInTransaction(() => {
      this.store.saveSetting(CONFIG_KEY, JSON.stringify(next))
      if (encrypted) this.store.saveSetting(PASSWORD_KEY, encrypted)
      else if (input.password === '') this.store.deleteSetting(PASSWORD_KEY)
    })
    this.config = next
    this.clearPreviews()
    this.phase = 'idle'
    this.message = '同步设置已保存。'
    this.schedule()
    return this.getStatus()
  }

  start(): void {
    this.schedule()
    if (this.config.enabled) void this.sync().catch(() => {})
  }

  private schedule(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (!this.stopped && this.config.enabled) {
      this.timer = setInterval(() => { if (!this.busy) void this.sync().catch(() => {}) }, this.config.intervalMinutes * 60_000)
      this.timer.unref()
    }
  }

  private runtime() {
    const stored = this.store.getSettingPublic(PASSWORD_KEY)
    if (!stored) throw new Error('请先保存 WebDAV 地址、用户名和应用密码。')
    try { return { password: revealCredential(stored, this.credentials).value, signal: this.abort?.signal } }
    catch { throw new Error('无法解密 WebDAV 应用密码，请重新填写并保存。') }
  }

  private clearPreviews(): void {
    this.conflictPreview = undefined
    this.deletionPreview = undefined
  }

  private async operation(phase: 'testing' | 'syncing', run: () => Promise<void>): Promise<WebDavSyncStatus> {
    if (this.stopped) throw new Error('同步服务已关闭。')
    if (this.workspaceBusy()) throw new Error('正在恢复工作区，请稍后再同步。')
    if (this.busy) throw new Error('已有同步或连接测试正在进行。')
    this.abort = new AbortController()
    this.phase = phase
    this.uploaded = 0
    this.downloaded = 0
    this.merged = 0
    this.progress = { stage: phase === 'testing' ? 'checking' : 'comparing', total: null, completed: 0,
      attachmentsTotal: 0, attachmentsCompleted: 0, currentItem: null, currentAttachment: null,
      startedAt: new Date().toISOString(), requestsCompleted: 0, waitingUntil: null }
    this.message = phase === 'testing' ? '正在验证连接和条件写入能力…' : '正在同步…'
    const stopObserving = observeWebDavProgress(this.abort.signal, {
      request: activity => {
        if (!this.progress) return
        this.progress.waitingUntil = activity.waitingUntil
        if (activity.completed) this.progress.requestsCompleted++
      },
      transfer: activity => {
        if (!this.progress) return
        this.progress = { ...this.progress, stage: activity.stage, currentAttachment: activity.name,
          attachmentsCompleted: activity.completed, attachmentsTotal: activity.total }
      }
    })
    const work = Promise.resolve().then(run)
    this.busy = work
    try { await work; this.phase = 'idle' }
    catch (error) {
      this.phase = 'error'
      this.message = error instanceof Error ? error.message : '同步失败，下次将自动重试。'
      throw new Error(this.message, { cause: error })
    } finally { stopObserving(); this.busy = null; this.abort = null; this.progress = null }
    return this.getStatus()
  }

  testConnection(): Promise<WebDavSyncStatus> {
    return this.operation('testing', async () => {
      const { password, signal } = this.runtime()
      const client = new WebDavClient(this.config, password, signal)
      await peekProtocol5Remote(client)
      await client.test()
      this.message = '连接成功，读写与并发保护检查通过。'
    })
  }

  sync(): Promise<WebDavSyncStatus> {
    return this.operation('syncing', async () => {
      this.clearPreviews()
      this.applyOutcome(await runProtocol5WebDav(this.store, this.profile, this.config, this.runtime()))
    })
  }

  private applyOutcome(result: Awaited<ReturnType<typeof runProtocol5WebDav>>): void {
    this.uploaded = result.uploaded
    this.downloaded = result.downloaded
    this.merged = result.merged ?? 0
    this.message = result.message
    if (this.downloaded) this.onChanged()
    if (result.selectionDeferred) throw new Error(result.message)
  }

  rejoinProtocol5AfterRestore(confirm: (baselineCount: number, remoteAdvanced: boolean) => Promise<boolean>): Promise<WebDavSyncStatus> {
    if (!protocol5NeedsRestoreRejoin(this.store, this.config)) throw new Error('当前目录没有等待续接的工作区。')
    return this.operation('syncing', async () => {
      this.clearPreviews()
      const db = this.store.getUnsafeDatabaseHandle(), runtime = this.runtime()
      const preview = await prepareProtocol5RestoreRejoin(db, this.profile, this.config, runtime)
      if (!await confirm(preview.baseline.length, preview.manifestHash !== preview.originalManifestHash)) {
        this.message = '已取消续接，工作区保持暂停。'
        return
      }
      await confirmProtocol5RestoreRejoin(db, this.profile, this.config, runtime, preview.owner)
      this.message = '已续接原同步目录，可以开始同步。'
    })
  }

  previewProtocol5Conflicts(): Promise<WebDavSyncStatus> {
    return this.operation('syncing', async () => {
      const preview = await previewProtocol5WebDavConflicts(this.store, this.profile, this.config, this.runtime())
      this.clearPreviews()
      this.conflictPreview = preview
      const count = preview.components.length
      this.message = count ? `已读取 ${count} 组同步冲突。` : '当前没有待处理的同步冲突。'
    })
  }

  resolveProtocol5Conflict(value: unknown): Promise<WebDavSyncStatus> {
    const input = readProtocol5Selection(value), preview = this.conflictPreview
    if (!preview || preview.previewId !== input.previewId || preview.previewHash !== input.previewHash
      || !preview.components.some(component => component.componentId === input.componentId && component.choices.includes(input.choice))) {
      throw new Error('冲突预览已失效，请重新读取后再选择。')
    }
    return this.operation('syncing', async () => {
      const result = await resolveProtocol5WebDavConflict(this.store, this.profile, this.config, input, this.runtime(), preview)
      this.applyOutcome(result)
      this.clearPreviews()
    })
  }

  previewProtocol5Deletions(): Promise<WebDavSyncStatus> {
    return this.operation('syncing', async () => {
      this.clearPreviews()
      this.deletionPreview = await previewProtocol5WebDavDeletions(this.store, this.profile, this.config, this.runtime())
      const count = this.deletionPreview.components.length
      this.message = count ? `已读取 ${count} 组删除冲突。` : '当前没有待处理的删除冲突。'
    })
  }

  resolveProtocol5Deletion(value: unknown): Promise<WebDavSyncStatus> {
    const input = readProtocol5DeletionSelection(value), preview = this.deletionPreview
    if (!preview || preview.previewId !== input.previewId || preview.previewHash !== input.previewHash
      || !preview.components.some(component => component.componentId === input.componentId && component.choices.includes(input.choice))) {
      throw new Error('删除冲突预览已失效，请重新读取后再选择。')
    }
    return this.operation('syncing', async () => {
      this.clearPreviews()
      this.applyOutcome(await resolveProtocol5WebDavDeletion(this.store, this.profile, this.config, input, this.runtime()))
    })
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.abort?.abort()
    await this.waitForIdle()
  }

  async waitForIdle(): Promise<void> { await this.busy?.catch(() => {}) }

  async cancel(): Promise<WebDavSyncStatus> {
    this.abort?.abort()
    await this.waitForIdle()
    this.phase = 'idle'
    this.message = '本次同步已停止。自动同步将按设置的间隔重试。'
    return this.getStatus()
  }
}
