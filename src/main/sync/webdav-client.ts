import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { WebDavSyncConfig } from '../../shared/webdav-sync'

export interface WebDavCapabilities { createMode: 'conditional' | 'move' }
export interface WebDavRequestActivity { waitingUntil: string | null; completed: boolean }

function usableEtag(etag: string | null): etag is string {
  if (!etag || /^W\//i.test(etag)) return false
  // Some DAV implementations return an opaque tag without the HTTP quote wrapper.
  // Preserve it verbatim; the connection probe must still prove If-Match enforcement.
  return /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(etag) || /^[A-Za-z0-9._:+/=-]{1,512}$/.test(etag)
}

export class WebDavHttpError extends Error {
  constructor(readonly status: number) {
    super(status === 401 || status === 403 ? 'WebDAV 登录失败或无访问权限，请检查用户名和应用密码。'
      : status === 429 ? 'WebDAV 请求过于频繁，稍后将自动重试。'
      : status === 507 ? 'WebDAV 存储空间或流量额度不足。'
      : `WebDAV 请求失败（HTTP ${status}）。`)
  }
}

export function normalizeWebDavConfig(config: WebDavSyncConfig): WebDavSyncConfig {
  if (!config || typeof config.url !== 'string' || typeof config.username !== 'string' || typeof config.directory !== 'string'
    || typeof config.enabled !== 'boolean' || typeof config.allowInsecureHttp !== 'boolean'
    || !Number.isInteger(config.intervalMinutes) || config.intervalMinutes < 1 || config.intervalMinutes > 1440) {
    throw new Error('同步设置无效，自动同步间隔应为 1–1440 分钟。')
  }
  const url = new URL(config.url.trim())
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('请填写不含密码、查询参数或片段的 HTTP(S) WebDAV 地址。')
  }
  if (url.protocol !== 'https:' && !config.allowInsecureHttp) throw new Error('请使用 HTTPS，或明确开启 HTTP 选项。')
  const directory = config.directory.trim().replace(/^\/+|\/+$/g, '')
  const segments = directory.split('/')
  if (!directory || directory.length > 500 || segments.some(segment => !segment || ['.', '..'].includes(segment) || /[\\\x00-\x1f%?#]/.test(segment))) {
    throw new Error('请填写独立的同步目录，例如 KnowBook；不允许 .. 或特殊路径字符。')
  }
  const username = config.username.trim()
  if (!username || username.length > 500 || /[:\x00-\x1f]/.test(username)) throw new Error('WebDAV 用户名无效。')
  url.pathname = url.pathname.replace(/\/*$/, '/')
  return { enabled: config.enabled, url: url.href, username, directory, intervalMinutes: config.intervalMinutes, allowInsecureHttp: config.allowInsecureHttp }
}

export class WebDavClient {
  private lastRequestAt = 0
  private readonly root: string
  private readonly authorization: string
  private checkedConditionalGet = false
  constructor(private readonly config: WebDavSyncConfig, password: string, private readonly signal?: AbortSignal,
    private capabilities: WebDavCapabilities = { createMode: 'conditional' },
    private readonly onActivity?: (activity: WebDavRequestActivity) => void) {
    this.root = config.url + config.directory.split('/').map(encodeURIComponent).join('/') + '/'
    this.authorization = `Basic ${Buffer.from(`${config.username}:${password}`).toString('base64')}`
  }

  private async request(url: string, method: string, body?: Uint8Array, headers?: Record<string, string>): Promise<Response> {
    try {
      // Nutstore's free DAV tier allows 600 requests per 30 minutes.
      if (new URL(this.root).hostname === 'dav.jianguoyun.com') {
        const remaining = 3100 - (Date.now() - this.lastRequestAt)
        if (remaining > 0) {
          this.onActivity?.({ waitingUntil: new Date(Date.now() + remaining).toISOString(), completed: false })
          try { await delay(remaining, undefined, { signal: this.signal }) }
          finally { this.onActivity?.({ waitingUntil: null, completed: false }) }
        }
      }
      this.lastRequestAt = Date.now()
      const response = await fetch(url, {
        method, redirect: 'manual', signal: AbortSignal.any([AbortSignal.timeout(45_000), ...(this.signal ? [this.signal] : [])]),
        headers: { Authorization: this.authorization, ...headers }, body: body ? new Uint8Array(body) : undefined
      })
      this.onActivity?.({ waitingUntil: null, completed: true })
      const tag = headers?.['If-Match']
      if (response.status === 412 && tag && usableEtag(tag) && !tag.startsWith('"')) {
        await this.discard(response)
        // A provider may expose a bare tag but require the RFC quote wrapper in requests.
        // Retry the identical opaque value, never a different version or an unconditional write.
        return await this.request(url, method, body, { ...headers, 'If-Match': `"${tag}"` })
      }
      return response
    } catch {
      throw new Error(this.signal?.aborted ? '同步已停止。' : '无法连接 WebDAV 或请求超时，请检查网络、地址和证书。')
    }
  }

  private path(path: string): string {
    if (!/^[a-zA-Z0-9._/-]+$/.test(path) || path.split('/').some(part => ['.', '..', ''].includes(part))) throw new Error('Invalid sync object path')
    return this.root + path
  }

  private async discard(response: Response): Promise<void> { await response.body?.cancel() }
  async exists(path: string): Promise<boolean> {
    const response = await this.request(this.path(path), 'HEAD')
    await this.discard(response)
    if (response.status === 404) return false
    if (response.status !== 200) throw new WebDavHttpError(response.status)
    return true
  }
  async get(path: string, maxBytes = 16 * 1024 * 1024, etag?: string): Promise<{ bytes: Uint8Array; etag: string | null } | null> {
    const response = await this.request(this.path(path), 'GET', undefined, etag ? { 'If-Match': etag } : undefined)
    if (response.status === 404) { await this.discard(response); return null }
    if (response.status !== 200) { await this.discard(response); throw new WebDavHttpError(response.status) }
    return { bytes: await this.readBytes(response, maxBytes), etag: response.headers.get('etag')?.trim() || null }
  }

  private async readBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
    if (Number(response.headers.get('content-length')) > maxBytes) { await this.discard(response); throw new Error('远端同步文件超过大小限制。') }
    const reader = response.body?.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      if (reader) while (true) {
        const result = await reader.read()
        if (result.done) break
        size += result.value.byteLength
        if (size > maxBytes) throw new Error('远端同步文件超过大小限制。')
        chunks.push(result.value)
      }
    } catch (error) { await reader?.cancel(); throw error }
    return Buffer.concat(chunks)
  }

  /** A body and its version must describe the same server revision, even during a concurrent write. */
  async getVersioned(path: string, maxBytes = 16 * 1024 * 1024): Promise<{ bytes: Uint8Array; etag: string } | null> {
    const initial = await this.get(path, maxBytes)
    if (!initial) return null
    if (usableEtag(initial.etag)) return { ...initial, etag: initial.etag }
    const etag = await this.metadataEtag(path)
    requireStrongEtag(etag)
    if (!this.checkedConditionalGet) {
      const rejected = await this.request(this.path(path), 'GET', undefined, { 'If-Match': `"knowbook-missing-${randomUUID()}"` })
      await this.discard(rejected)
      if (rejected.status !== 412) {
        if (rejected.status !== 200) throw new WebDavHttpError(rejected.status)
        throw new Error('WebDAV 下载未提供 ETag，且不支持按版本读取，无法安全关联文件与版本。')
      }
      this.checkedConditionalGet = true
    }
    // Never pair the first GET's bytes with a later HEAD/PROPFIND tag: another device may have written between them.
    const current = await this.get(path, maxBytes, etag)
    if (!current) throw new WebDavHttpError(412)
    if (usableEtag(current.etag) && current.etag.replace(/^"|"$/g, '') !== etag.replace(/^"|"$/g, '')) throw new WebDavHttpError(412)
    return { bytes: current.bytes, etag }
  }

  private async metadataEtag(path: string): Promise<string | null> {
    const response = await this.request(this.path(path), 'HEAD')
    await this.discard(response)
    if (response.status === 404) throw new WebDavHttpError(412)
    if (![200, 405, 501].includes(response.status)) throw new WebDavHttpError(response.status)
    const header = response.status === 200 ? response.headers.get('etag')?.trim() || null : null
    if (usableEtag(header)) return header
    const properties = await this.request(this.path(path), 'PROPFIND', Buffer.from(
      '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>'
    ), { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' })
    if (properties.status === 404) { await this.discard(properties); throw new WebDavHttpError(412) }
    if ([405, 501].includes(properties.status)) { await this.discard(properties); return null }
    if (properties.status !== 207) { await this.discard(properties); throw new WebDavHttpError(properties.status) }
    const xml = Buffer.from(await this.readBytes(properties, 256 * 1024)).toString('utf8')
    const { readWebDavEtag } = await import('./webdav-properties')
    return readWebDavEtag(xml, this.path(path))
  }

  private async remove(path: string): Promise<void> {
    const response = await this.request(this.path(path), 'DELETE')
    await this.discard(response)
    if (![200, 204, 404].includes(response.status)) throw new WebDavHttpError(response.status)
  }

  private async moveNew(source: string, destination: string): Promise<void> {
    const response = await this.request(this.path(source), 'MOVE', undefined, { Destination: this.path(destination), Overwrite: 'F' })
    await this.discard(response)
    // Nutstore reports DuplicateName as 409 instead of 412. Only treat it as a
    // publication race when the target exists; missing parents and other 409s remain errors.
    if (response.status === 409 && await this.exists(destination)) throw new WebDavHttpError(412)
    if (![201, 204].includes(response.status)) throw new WebDavHttpError(response.status)
  }

  async create(path: string, bytes: Uint8Array): Promise<void> {
    if (this.capabilities.createMode === 'conditional') return this.put(path, bytes, { create: true })
    const temporary = `objects/.pending-${randomUUID()}.json`
    try { await this.put(temporary, bytes); await this.moveNew(temporary, path) }
    finally { await this.remove(temporary).catch(() => {}) }
  }

  async put(path: string, bytes: Uint8Array, condition?: { etag: string } | { create: true }): Promise<void> {
    const response = await this.request(this.path(path), 'PUT', bytes, {
      'Content-Type': 'application/octet-stream',
      ...(condition && ('etag' in condition ? { 'If-Match': condition.etag } : { 'If-None-Match': '*' }))
    })
    await this.discard(response)
    if (![200, 201, 204].includes(response.status)) throw new WebDavHttpError(response.status)
  }

  async initialize(): Promise<void> {
    let current = this.config.url
    for (const part of [...this.config.directory.split('/'), 'objects']) {
      current += encodeURIComponent(part) + '/'
      const response = await this.request(current, 'MKCOL')
      await this.discard(response)
      if (![201, 405].includes(response.status)) throw new WebDavHttpError(response.status)
    }
    const response = await this.request(this.root + 'assets/', 'MKCOL')
    await this.discard(response)
    if (![201, 405].includes(response.status)) throw new WebDavHttpError(response.status)
  }

  async test(): Promise<WebDavCapabilities> {
    await this.initialize()
    const path = `.probe-${randomUUID()}`
    const cleanup = [path]
    try {
      await this.put(path, Buffer.from('knowbook-webdav-probe'), { create: true })
      const original = await this.getVersioned(path, 1024)
      if (!original || Buffer.from(original.bytes).toString() !== 'knowbook-webdav-probe') throw new Error('WebDAV 读写校验失败。')
      requireStrongEtag(original.etag)
      const rejected = async (operation: () => Promise<unknown>): Promise<boolean> => {
        try { await operation(); return false }
        catch (error) { if (error instanceof WebDavHttpError && error.status === 412) return true; throw error }
      }
      if (!await rejected(() => this.put(path, Buffer.from('must-not-overwrite'), { etag: '"knowbook-nonmatching-etag"' }))) {
        throw new Error('该 WebDAV 服务不支持条件写入，无法安全处理多设备并发同步。')
      }
      await this.put(path, Buffer.from('knowbook-probe-updated'), { etag: original.etag })
      const updated = await this.getVersioned(path, 1024)
      if (!updated || Buffer.from(updated.bytes).toString() !== 'knowbook-probe-updated') throw new Error('WebDAV 条件写入校验失败。')
      if (updated.etag === original.etag || !await rejected(() => this.put(path, Buffer.from('must-not-overwrite'), { etag: original.etag }))) {
        throw new Error('WebDAV 未拒绝过期版本，无法安全进行并发同步。')
      }
      this.capabilities = { createMode: 'conditional' }
      if (!await rejected(() => this.put(path, Buffer.from('create-condition-probe'), { create: true }))) {
        // Some providers enforce If-Match but ignore If-None-Match. MOVE with Overwrite:F
        // can still provide atomic first publication; prove both the reject and success paths.
        cleanup.push(`${path}-source`, `${path}-destination`)
        await this.put(`${path}-source`, Buffer.from('knowbook-move-probe'))
        if (!await rejected(() => this.moveNew(`${path}-source`, path))) throw new Error('WebDAV 不支持安全的新建文件操作（条件写入和禁止覆盖移动均不可用）。')
        const unchanged = await this.get(path, 1024)
        if (!unchanged || Buffer.from(unchanged.bytes).toString() !== 'create-condition-probe') throw new Error('WebDAV 禁止覆盖移动未保护已有文件。')
        await this.moveNew(`${path}-source`, `${path}-destination`)
        const moved = await this.get(`${path}-destination`, 1024)
        if (!moved || Buffer.from(moved.bytes).toString() !== 'knowbook-move-probe') throw new Error('WebDAV 新建文件移动校验失败。')
        this.capabilities = { createMode: 'move' }
      }
      return { ...this.capabilities }
    } finally {
      for (const temporary of cleanup) await this.remove(temporary).catch(() => {})
    }
  }
}

export function requireStrongEtag(etag: string | null): asserts etag is string {
  if (!usableEtag(etag)) throw new Error('WebDAV 的 GET、HEAD 和文件属性均未提供可用的非弱 ETag，无法安全进行并发同步。')
}
