import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { assertRestorePath, canonicalRestoreRoot, restoreDirectory, syncRestoreDirectory } from './restore-safety-files'
import { capsuleJson, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { DURABLE_SQL_DAG_MAX_NODE_BYTES, durableSqlDagInvalid, durableSqlDagRootHash, durableSqlDagUuid,
  parseDurableSqlDagNode, validateDurableSqlDagNode, validateDurableSqlDagReference,
  type DurableSqlDagNode, type DurableSqlDagReference } from './restore-knowledge-dag-model'

/** Files are immutable prepared artifacts only. A model or file result is never
 * a SQL/DAG certificate; the read owner must independently recertify all SQL. */
export interface DurableSqlDagNodeFile {
  readonly ref: DurableSqlDagReference; readonly node: DurableSqlDagNode
  readonly path: string; readonly bytes: number
}
const samePath = (a: string, b: string): boolean => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
export async function canonicalDurableSqlDagProfileRoot(value: string): Promise<string> {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0') || !samePath(resolve(value), value))
    return durableSqlDagInvalid('profile不是准确绝对路径')
  return canonicalRestoreRoot(value)
}
async function directory(path: string, root: string): Promise<void> {
  await assertRestorePath(path, root)
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(path, await realpath(path)))
    return durableSqlDagInvalid('DAG目录不是准确Main目录或含重定向')
}
const standalone = (info: BigIntStats): boolean => info.isFile() && !info.isSymbolicLink() && info.nlink === 1n && info.ino !== 0n
function sameFd(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs
    && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink && standalone(a) && standalone(b)
}
function samePathFd(path: BigIntStats, fd: BigIntStats): boolean {
  // Only this one path and its own fd. Distinct-file equality never uses a
  // device wildcard or common-width truncation.
  return (path.dev === fd.dev || process.platform === 'win32' && (path.dev === 0n || BigInt.asUintN(32, path.dev) === fd.dev))
    && path.ino === fd.ino && path.size === fd.size && path.mtimeNs === fd.mtimeNs
    && path.ctimeNs === fd.ctimeNs && path.nlink === fd.nlink && standalone(path) && standalone(fd)
}
function paths(root: string, operationId: string, dagId: string) {
  const operation = join(root, 'backups', 'database-restore', durableSqlDagUuid(operationId))
  const collection = join(operation, 'knowledge-dags'), node = join(collection, durableSqlDagUuid(dagId))
  return { operation, collection, node, file: join(node, 'root.json') }
}
async function readFiniteText(path: string, root: string): Promise<string> {
  await assertRestorePath(path, root)
  const prior = await lstat(path, { bigint: true })
  if (!standalone(prior) || prior.size < 1n || prior.size > BigInt(DURABLE_SQL_DAG_MAX_NODE_BYTES))
    return durableSqlDagInvalid('DAG原件不是独立有限普通文件')
  const fd = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = await fd.stat({ bigint: true })
    if (!samePathFd(prior, before) || process.platform === 'win32' && before.dev === 0n)
      return durableSqlDagInvalid('DAG打开身份变化或卷身份不可用')
    const buffer = Buffer.alloc(Number(before.size) + 1)
    let offset = 0
    while (offset < buffer.length) {
      const count = await fd.read(buffer, offset, buffer.length - offset, offset)
      if (!count.bytesRead) break
      offset += count.bytesRead
    }
    const after = await fd.stat({ bigint: true }), current = await lstat(path, { bigint: true })
    await assertRestorePath(path, root)
    if (offset !== Number(before.size) || !sameFd(before, after) || !samePathFd(current, after))
      return durableSqlDagInvalid('DAG读取期间发生变化')
    const bytes = buffer.subarray(0, offset), text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    if (!Buffer.from(text, 'utf8').equals(bytes)) return durableSqlDagInvalid('DAG TEXT无法无损读取')
    return text
  } finally { await fd.close() }
}
export async function readDurableSqlDagNodeFile(profileRoot: string, input: DurableSqlDagReference): Promise<DurableSqlDagNodeFile> {
  const root = await canonicalDurableSqlDagProfileRoot(profileRoot), ref = validateDurableSqlDagReference(input), p = paths(root, ref.operationId, ref.dagId)
  await directory(p.operation, root); await directory(p.collection, root); await directory(p.node, root)
  const names = await readdir(p.node)
  if (names.length !== 1 || names[0] !== 'root.json') return durableSqlDagInvalid('DAG node缺原件或含额外/pending文件')
  const text = await readFiniteText(p.file, root), node = parseDurableSqlDagNode(text)
  if (durableSqlDagRootHash(node) !== ref.rootHash) return durableSqlDagInvalid('DAG根hash不匹配')
  await directory(p.node, root)
  const after = await readdir(p.node)
  if (after.length !== 1 || after[0] !== 'root.json') return durableSqlDagInvalid('DAG目录读取期间变化')
  return freezeCapsuleValue({ ref, node, path: p.file, bytes: Buffer.byteLength(text) })
}
export async function writeDurableSqlDagNodeFile(profileRoot: string, operationId: string, dagId: string,
  input: DurableSqlDagNode): Promise<DurableSqlDagNodeFile> {
  const root = await canonicalDurableSqlDagProfileRoot(profileRoot), node = validateDurableSqlDagNode(input), p = paths(root, operationId, dagId)
  await directory(p.operation, root)
  await restoreDirectory(p.collection, root); await directory(p.collection, root)
  await restoreDirectory(p.node, root, true); await directory(p.node, root)
  const text = capsuleJson(node), fd = await open(p.file, 'wx')
  try {
    const before = await fd.stat({ bigint: true })
    if (!standalone(before) || process.platform === 'win32' && before.dev === 0n) return durableSqlDagInvalid('新DAG文件身份不可用')
    await fd.writeFile(text, 'utf8'); await fd.sync()
    const after = await fd.stat({ bigint: true }), current = await lstat(p.file, { bigint: true })
    if (!standalone(after) || before.dev !== after.dev || before.ino !== after.ino
      || after.size !== BigInt(Buffer.byteLength(text)) || !samePathFd(current, after)) return durableSqlDagInvalid('新DAG持久化期间发生替换')
    await assertRestorePath(p.file, root)
  } finally { await fd.close() }
  await syncRestoreDirectory(p.node); await syncRestoreDirectory(p.collection)
  return readDurableSqlDagNodeFile(root, { kind: 'durable-sql-dag-ref', version: 1,
    operationId, dagId, rootHash: durableSqlDagRootHash(node) })
}

import * as syncDagFs from 'node:fs'
import { parse as syncDagParse, relative as syncDagRelative, sep as syncDagSep } from 'node:path'
import { capsuleBytesHash as syncDagBytesHash } from './restore-knowledge-capsule-model'

function syncDagPath(path: string, root: string): void {
  const absolute = resolve(path), child = syncDagRelative(root, absolute)
  if (child === '..' || child.startsWith('..' + syncDagSep) || isAbsolute(child)) return durableSqlDagInvalid('同步witness DAG越过profile')
  let cursor = syncDagParse(absolute).root
  for (const part of syncDagRelative(cursor, absolute).split(syncDagSep).filter(Boolean)) {
    cursor = join(cursor, part); const info = syncDagFs.lstatSync(cursor)
    if (info.isSymbolicLink() || cursor !== absolute && !info.isDirectory() || !samePath(syncDagFs.realpathSync.native(cursor), cursor))
      return durableSqlDagInvalid('同步witness DAG有重定向')
  }
}
function syncDagDirectory(path: string, root: string): BigIntStats {
  syncDagPath(path, root); const info = syncDagFs.lstatSync(path, { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink() || info.ino === 0n) return durableSqlDagInvalid('同步witness DAG目录身份不可认证')
  return info
}
/** Data assertion only: real DAG owner supplies this exact private Saved node;
 * the DTO itself cannot mint a SQL/DAG certificate or choose a closure subset. */
export function assertDurableSqlDagNodeFileNow(profileRoot: string, expected: DurableSqlDagNodeFile): void {
  if (typeof profileRoot !== 'string' || !isAbsolute(profileRoot) || !samePath(resolve(profileRoot), profileRoot)) return durableSqlDagInvalid('同步witness profile无效')
  const ref = validateDurableSqlDagReference(expected.ref), p = paths(profileRoot, ref.operationId, ref.dagId)
  const node = validateDurableSqlDagNode(expected.node), text = capsuleJson(node), bytes = Buffer.from(text, 'utf8')
  if (durableSqlDagRootHash(node) !== ref.rootHash || bytes.length !== expected.bytes || bytes.length > DURABLE_SQL_DAG_MAX_NODE_BYTES)
    return durableSqlDagInvalid('同步witness私有node原像变化')
  syncDagDirectory(p.operation, profileRoot); syncDagDirectory(p.collection, profileRoot)
  const directory = syncDagDirectory(p.node, profileRoot)
  if (capsuleJson(syncDagFs.readdirSync(p.node)) !== capsuleJson(['root.json'])) return durableSqlDagInvalid('同步witness node不是准确单文件闭集')
  syncDagPath(p.file, profileRoot); const prior = syncDagFs.lstatSync(p.file, { bigint: true })
  if (!standalone(prior) || prior.size !== BigInt(bytes.length)) return durableSqlDagInvalid('同步witness node不是准确独立普通文件')
  const fd = syncDagFs.openSync(p.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = syncDagFs.fstatSync(fd, { bigint: true })
    if (!samePathFd(prior, before) || process.platform === 'win32' && before.dev === 0n || before.size !== BigInt(bytes.length)) return durableSqlDagInvalid('同步witness node打开身份变化')
    const actual = Buffer.alloc(bytes.length + 1); let offset = 0
    while (offset < actual.length) { const count = syncDagFs.readSync(fd, actual, offset, actual.length - offset, offset); if (!count) break; offset += count }
    const after = syncDagFs.fstatSync(fd, { bigint: true }), current = syncDagFs.lstatSync(p.file, { bigint: true })
    syncDagPath(p.file, profileRoot)
    if (offset !== bytes.length || !sameFd(before, after) || !samePathFd(current, after) || !actual.subarray(0, offset).equals(bytes)
      || syncDagBytesHash(actual.subarray(0, offset)) !== syncDagBytesHash(bytes)) return durableSqlDagInvalid('同步witness node完整bytes/hash或身份变化')
    const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(actual.subarray(0, offset))
    if (decoded !== text || !Buffer.from(decoded, 'utf8').equals(actual.subarray(0, offset))) return durableSqlDagInvalid('同步witness node非准确canonical UTF8')
  } finally { syncDagFs.closeSync(fd) }
  const after = syncDagDirectory(p.node, profileRoot)
  if (directory.dev !== after.dev || directory.ino !== after.ino || directory.mtimeNs !== after.mtimeNs || directory.ctimeNs !== after.ctimeNs
    || capsuleJson(syncDagFs.readdirSync(p.node)) !== capsuleJson(['root.json'])) return durableSqlDagInvalid('同步witness DAG目录读取期间变化')
}
