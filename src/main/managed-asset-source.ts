import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type Stats } from 'node:fs'
import { open } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AttachmentStore } from './attachments'
import { ATTACHMENT_MAX_FILE_BYTES } from '../shared/attachments'
import { buildSyncedPortableAssetUri, parseSyncedPortableAssetUri } from '../shared/syncedBlockPortable'

export interface ManagedAssetSource { uri: string; path: string; hash: string; name: string; bytes: Buffer }
type Located = Omit<ManagedAssetSource, 'bytes'> & { store: AttachmentStore; localUrl: string; info: Stats }
const bad = (): never => { throw new Error('附件原路径、25MiB边界、文件身份或managed hash在读取期间无效。') }
function locate(root: string, uri: string): Located {
  const store = new AttachmentStore(root)
  let path: string, hash: string, name: string, localUrl = uri
  if (/^file:/i.test(uri)) {
    path = store.resolve(uri); name = store.get(uri).name
    const parts = relative(root, path).split(sep)
    if (parts.length !== 4 || parts[0] !== 'attachments' || !/^[a-f0-9]{64}$/.test(parts[2])
      || parts[1] !== parts[2].slice(0, 2) || parts[3] !== name) return bad()
    hash = parts[2]
    buildSyncedPortableAssetUri({ hash, name })
  } else {
    const asset = parseSyncedPortableAssetUri(uri); hash = asset.hash; name = asset.name
    localUrl = pathToFileURL(join(root, 'attachments', hash.slice(0, 2), hash, name)).href
    path = store.resolve(localUrl)
  }
  const info = lstatSync(path)
  if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size < 0 || info.size > ATTACHMENT_MAX_FILE_BYTES) return bad()
  return { uri, path, hash, name, store, localUrl, info }
}
function same(a: Stats, b: Stats, pathStat = false): boolean {
  return (a.dev === b.dev || pathStat && process.platform === 'win32' && a.dev === 0)
    && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.nlink === b.nlink
}
function buffer(source: Located, before: Stats): Buffer {
  if (!before.isFile() || !same(source.info, before, true)) return bad()
  // The path preflight bounds this allocation even if the file grows before open.
  return Buffer.alloc(before.size + 1)
}
function finish(source: Located, before: Stats, after: Stats, buffer: Buffer, length: number): ManagedAssetSource {
  if (length !== before.size || !same(before, after)) return bad()
  // Real incoming publication uses multiple hardlinks for retained stage/name
  // aliases. Keep that legitimate source meaning; the complete read must still
  // have stable identity/link count, a safe current path and exact hash bytes.
  if (source.store.resolve(source.localUrl) !== source.path || !same(lstatSync(source.path), after, true)) return bad()
  const bytes = buffer.subarray(0, length)
  if (createHash('sha256').update(bytes).digest('hex') !== source.hash) return bad()
  return { uri: source.uri, path: source.path, hash: source.hash, name: source.name, bytes }
}
/** Byte source only. Existing Main callers authenticate their root/capture;
 * this does not mint file ownership, certification or an installation permit. */
export function readManagedAssetSourceSync(root: string, uri: string): ManagedAssetSource {
  const source = locate(root, uri), fd = openSync(source.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = fstatSync(fd), bytes = buffer(source, before)
    let length = 0
    while (length < bytes.length) { const count = readSync(fd, bytes, length, bytes.length - length, null); if (!count) break; length += count }
    return finish(source, before, fstatSync(fd), bytes, length)
  } finally { closeSync(fd) }
}
/** Async publication keeps native reads off the Main event loop. Same complete
 * locator/descriptor/byte checks as the synchronous V3 export path. */
export async function readManagedAssetSource(root: string, uri: string): Promise<ManagedAssetSource> {
  const source = locate(root, uri), fd = await open(source.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = await fd.stat(), bytes = buffer(source, before)
    let length = 0
    while (length < bytes.length) { const { bytesRead } = await fd.read(bytes, length, bytes.length - length, null); if (!bytesRead) break; length += bytesRead }
    return finish(source, before, await fd.stat(), bytes, length)
  } finally { await fd.close() }
}
