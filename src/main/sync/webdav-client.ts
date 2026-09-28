import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { WebDavSyncConfig } from '../../shared/webdav-sync'

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
  constructor(private readonly config: WebDavSyncConfig, password: string, private readonly signal?: AbortSignal) {
    this.root = config.url + config.directory.split('/').map(encodeURIComponent).join('/') + '/'
    this.authorization = `Basic ${Buffer.from(`${config.username}:${password}`).toString('base64')}`
  }

  private async request(url: string, method: string, body?: Uint8Array, headers?: Record<string, string>): Promise<Response> {
    try {
      // Nutstore's free DAV tier allows 600 requests per 30 minutes.
      if (new URL(this.root).hostname === 'dav.jianguoyun.com') {
        const remaining = 3100 - (Date.now() - this.lastRequestAt)
        if (remaining > 0) await delay(remaining, undefined, { signal: this.signal })
      }
      this.lastRequestAt = Date.now()
      return await fetch(url, {
        method, redirect: 'manual', signal: AbortSignal.any([AbortSignal.timeout(45_000), ...(this.signal ? [this.signal] : [])]),
        headers: { Authorization: this.authorization, ...headers }, body: body ? new Uint8Array(body) : undefined
      })
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
  async get(path: string, maxBytes = 16 * 1024 * 1024): Promise<{ bytes: Uint8Array; etag: string | null } | null> {
    const response = await this.request(this.path(path), 'GET')
    if (response.status === 404) { await this.discard(response); return null }
    if (response.status !== 200) { await this.discard(response); throw new WebDavHttpError(response.status) }
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
    return { bytes: Buffer.concat(chunks), etag: response.headers.get('etag') }
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

  async test(): Promise<void> {
    await this.initialize()
    const path = `.probe-${randomUUID()}`
    try {
      await this.put(path, Buffer.from('knowbook-webdav-probe'), { create: true })
      const original = await this.get(path, 1024)
      if (!original || Buffer.from(original.bytes).toString() !== 'knowbook-webdav-probe') throw new Error('WebDAV 读写校验失败。')
      requireStrongEtag(original.etag)
      for (const condition of [{ etag: '"knowbook-nonmatching-etag"' }, { create: true as const }]) {
        let rejected = false
        try { await this.put(path, Buffer.from('must-not-overwrite'), condition) }
        catch (error) { if (error instanceof WebDavHttpError && error.status === 412) rejected = true; else throw error }
        if (!rejected) throw new Error('该 WebDAV 服务不支持条件写入，无法安全处理多设备并发同步。')
      }
      await this.put(path, Buffer.from('knowbook-probe-updated'), { etag: original.etag! })
      const updated = await this.get(path, 1024)
      if (!updated || Buffer.from(updated.bytes).toString() !== 'knowbook-probe-updated') throw new Error('WebDAV 条件写入校验失败。')
    } finally {
      const response = await this.request(this.path(path), 'DELETE').catch(() => null)
      if (response) await this.discard(response)
    }
  }
}

export function requireStrongEtag(etag: string | null): asserts etag is string {
  if (!etag || !/^"[^"\r\n]+"$/.test(etag)) throw new Error('WebDAV 未返回有效的强 ETag，无法安全进行并发同步。')
}
