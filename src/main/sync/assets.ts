import { readFile, stat } from 'node:fs/promises'
import { AttachmentStore, attachmentFileName } from '../attachments'
import { rewriteMarkdownDestinations } from '../../shared/markdownLinks'
import { ATTACHMENT_MAX_FILE_BYTES } from '../../shared/attachments'
import { hashBytes, validHash, type SyncRecord } from './model'
import type { WebDavClient } from './webdav-client'

const SCHEME = 'knowbook-asset://'

function mapStrings<T>(value: T, transform: (text: string) => string): T {
  if (typeof value === 'string') return transform(value) as T
  if (Array.isArray(value)) return value.map(item => mapStrings(item, transform)) as T
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, transform)])) as T
  return value
}

function rewriteRecord(record: SyncRecord, rewrite: (url: string) => string | undefined): SyncRecord {
  if (record.kind !== 'document') return record
  const transform = (text: string): string => {
    if (/^(file:\/\/\/|knowbook-asset:\/\/)[^\r\n]+$/.test(text)) return rewrite(text) ?? text
    return rewriteMarkdownDestinations(text, ({ url }) => rewrite(url))
  }
  return { ...record, content: { ...record.content, summary: transform(record.content.summary), blocks: record.content.blocks.map(block =>
    block.type === 'code' || block.type === 'code-block' ? block : { ...block, content: transform(block.content),
      ...(block.markdownFormat ? { markdownFormat: mapStrings(block.markdownFormat, transform) } : {}) }) } }
}

function assetIdentity(url: string): { hash: string; name: string } {
  const parsed = new URL(url)
  const name = decodeURIComponent(parsed.pathname.slice(1))
  if (parsed.protocol !== 'knowbook-asset:' || !validHash(parsed.hostname) || parsed.search || parsed.hash
    || !name || attachmentFileName(name) !== name) throw new Error('远端附件引用无效。')
  return { hash: parsed.hostname, name }
}

export function syncAssetReferences(record: SyncRecord): Array<{ url: string; hash: string; name: string }> {
  const urls = new Set<string>()
  rewriteRecord(record, url => {
    if (url.startsWith('file:')) throw new Error('远端数据包含不可移植的本机文件路径。')
    if (url.startsWith(SCHEME)) urls.add(url)
    return undefined
  })
  return [...urls].map(url => ({ url, ...assetIdentity(url) }))
}

export type SyncAssetProgress = (asset: { key: string; name: string; completed: boolean }) => void

export class SyncAssets {
  private readonly localCache = new Map<string, { signature: string; url: string }>()
  readonly uploads = new Map<string, string>()
  private readonly downloaded = new Map<string, string>()
  private readonly portableUrls = new Map<string, string>()
  constructor(private readonly attachments: AttachmentStore) {}

  async portable(record: SyncRecord): Promise<SyncRecord> {
    const urls = new Set<string>()
    rewriteRecord(record, url => { if (url.startsWith('file:')) urls.add(url); return undefined })
    const replacements = new Map<string, string>()
    for (const url of urls) {
      let path: string
      try { path = this.attachments.resolve(url) } catch { throw new Error('文档包含未导入或已丢失的本地附件，请重新导入附件后同步。') }
      const info = await stat(path)
      if (info.size > ATTACHMENT_MAX_FILE_BYTES) throw new Error('同步附件不能超过 25 MB。')
      const signature = `${info.size}:${info.mtimeMs}`
      let cached = this.localCache.get(path)
      if (!cached || cached.signature !== signature) {
        const hash = hashBytes(await readFile(path))
        cached = { signature, url: `${SCHEME}${hash}/${encodeURIComponent(this.attachments.get(url).name)}` }
        this.localCache.set(path, cached)
      }
      this.uploads.set(assetIdentity(cached.url).hash, path)
      replacements.set(url, cached.url)
      this.portableUrls.set(url, cached.url)
    }
    return rewriteRecord(record, url => replacements.get(url))
  }

  portableKnown(record: SyncRecord): SyncRecord {
    return rewriteRecord(record, url => {
      if (!url.startsWith('file:')) return undefined
      const portable = this.portableUrls.get(url)
      if (!portable) throw new Error('附件引用发生变化，请重试同步。')
      return portable
    })
  }

  async upload(record: SyncRecord, client: WebDavClient, uploaded: Set<string>, onProgress?: SyncAssetProgress): Promise<void> {
    const assets = new Map(syncAssetReferences(record).map(asset => [asset.hash, asset]))
    for (const [hash, { name }] of assets) {
      onProgress?.({ key: hash, name, completed: false })
      if (uploaded.has(hash)) { onProgress?.({ key: hash, name, completed: true }); continue }
      if (!await client.exists(`assets/${hash}`)) {
        const path = this.uploads.get(hash)
        if (!path) throw new Error('待同步附件不可用，请重试。')
        const bytes = await readFile(path)
        if (hashBytes(bytes) !== hash) throw new Error('附件在同步期间发生变化，请重试。')
        await client.put(`assets/${hash}`, bytes)
      }
      uploaded.add(hash)
      onProgress?.({ key: hash, name, completed: true })
    }
  }

  async local(record: SyncRecord, client: WebDavClient, onProgress?: SyncAssetProgress): Promise<SyncRecord> {
    const assets = syncAssetReferences(record)
    const replacements = new Map<string, string>()
    for (const { url, hash, name } of assets) {
      onProgress?.({ key: url, name, completed: false })
      let localUrl = this.downloaded.get(url)
      if (localUrl) {
        try { this.attachments.resolve(localUrl) } catch { localUrl = undefined }
      }
      if (!localUrl) {
        const response = await client.get(`assets/${hash}`, ATTACHMENT_MAX_FILE_BYTES)
        if (!response || hashBytes(response.bytes) !== hash) throw new Error('同步附件缺失或校验失败，未更新文档。')
        const [attachment] = await this.attachments.import([{ name, bytes: response.bytes }])
        localUrl = attachment.url
        this.downloaded.set(url, localUrl)
      }
      replacements.set(url, localUrl)
      this.portableUrls.set(localUrl, url)
      onProgress?.({ key: url, name, completed: true })
    }
    return rewriteRecord(record, url => replacements.get(url))
  }
}
