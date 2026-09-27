import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ATTACHMENT_MAX_BATCH_BYTES, ATTACHMENT_MAX_FILE_BYTES, ATTACHMENT_MAX_FILES, isAttachmentImage, type AttachmentInput, type ManagedAttachment } from '@shared/attachments'

export function attachmentFileName(name: string): string {
  const clean = name.replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '-').replace(/[. ]+$/g, '').trim()
  if (!clean || clean === '.' || clean === '..') return 'attachment'
  const bounded = clean.length > 120 ? clean.slice(0, 100) + clean.slice(-20) : clean
  return /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(bounded) ? `_${bounded}` : bounded
}

function inside(path: string, root: string): boolean {
  const normalize = (value: string) => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value)
  return normalize(path).startsWith(normalize(root) + sep)
}

/** One immutable, content-addressed copy shared by document, history and Trash references. */
export class AttachmentStore {
  private pending: Promise<unknown> = Promise.resolve()
  constructor(readonly root: string) {}

  resolve(url: string): string {
    if (typeof url !== 'string' || url.length > 8192) throw new Error('Invalid attachment URL.')
    const parsed = new URL(url)
    if (parsed.protocol !== 'file:' || parsed.hostname && parsed.hostname !== 'localhost') throw new Error('Only managed local attachments are allowed.')
    const path = resolve(fileURLToPath(parsed))
    if (!inside(path, this.root)) throw new Error('Attachment is outside the workspace.')
    this.assertSafePath(path)
    if (!lstatSync(path).isFile() || !inside(realpathSync(path), realpathSync(this.root))) throw new Error('Attachment is not a managed regular file.')
    return path
  }

  get(url: string): ManagedAttachment {
    const path = this.resolve(url), name = basename(path)
    const encodedUrl = pathToFileURL(path).href.replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    return { url: encodedUrl, name, size: lstatSync(path).size, kind: isAttachmentImage(name) ? 'image' : 'file' }
  }

  import(files: AttachmentInput[]): Promise<ManagedAttachment[]> {
    if (!Array.isArray(files) || !files.length || files.length > ATTACHMENT_MAX_FILES) return Promise.reject(new Error('一次请选择 1–20 个文件。Select 1–20 files at a time.'))
    let total = 0
    for (const file of files) {
      if (!file || typeof file.name !== 'string' || !file.name.trim() || file.name.length > 1024 || !(file.bytes instanceof Uint8Array)) return Promise.reject(new Error('Invalid attachment payload.'))
      if (file.bytes.byteLength > ATTACHMENT_MAX_FILE_BYTES) return Promise.reject(new Error('单个附件不能超过 25 MB。Each attachment must be at most 25 MB.'))
      total += file.bytes.byteLength
    }
    if (total > ATTACHMENT_MAX_BATCH_BYTES) return Promise.reject(new Error('附件总大小不能超过 100 MB。Attachments must total at most 100 MB.'))
    const run = this.pending.then(() => this.write(files))
    this.pending = run.catch(() => {})
    return run
  }

  private async write(files: AttachmentInput[]): Promise<ManagedAttachment[]> {
    const result: ManagedAttachment[] = []
    const created: string[] = []
    try {
      for (const file of files) {
        const hash = createHash('sha256').update(file.bytes).digest('hex')
        const path = join(this.root, 'attachments', hash.slice(0, 2), hash, attachmentFileName(file.name))
        this.assertSafePath(path)
        await mkdir(dirname(path), { recursive: true })
        this.assertSafePath(path)
        const existing = lstatSync(path, { throwIfNoEntry: false })
        if (existing) {
          if (!existing.isFile() || createHash('sha256').update(await readFile(path)).digest('hex') !== hash) throw new Error('Existing attachment is damaged; it was not overwritten.')
        } else {
          const temporary = join(dirname(path), `.${randomUUID()}.tmp`)
          try {
            await writeFile(temporary, file.bytes, { flag: 'wx' })
            await rename(temporary, path)
            created.push(path)
          } finally { await rm(temporary, { force: true }) }
        }
        result.push(this.get(pathToFileURL(path).href))
      }
      return result
    } catch (error) {
      // A failed batch creates no document references and keeps preexisting files intact.
      await Promise.allSettled(created.map(path => rm(path, { force: true })))
      throw error
    }
  }

  private assertSafePath(path: string): void {
    let current = resolve(this.root)
    const parts = relative(current, path).split(sep)
    for (let index = 0; index <= parts.length; index++) {
      const info = lstatSync(current, { throwIfNoEntry: false })
      if (info && (info.isSymbolicLink() || index < parts.length && !info.isDirectory())) throw new Error('Attachment path contains an unsafe file or symbolic link.')
      if (index < parts.length) current = join(current, parts[index])
    }
  }
}
