import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { assertRestorePath, canonicalRestoreRoot, restoreDirectory, syncRestoreDirectory } from './restore-safety-files'
import { capsuleJson, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { DURABLE_SQL_DAG_MAX_NODE_BYTES, durableSqlDagUuid } from './restore-knowledge-dag-model'
import { validateCoverageRootReference, type CoverageRootReference } from './restore-knowledge-coverage-model'
import { parseRequiredSqlDagNode, requiredDagInvalid, requiredSqlDagRootHash, validateRequiredSqlDagNode,
  type RequiredSqlDagNode } from './restore-knowledge-required-dag-model'

export interface RequiredSqlDagNodeFile {
  readonly ref: CoverageRootReference; readonly node: RequiredSqlDagNode; readonly path: string; readonly bytes: number
}
const samePath = (a: string, b: string): boolean => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
export async function canonicalRequiredSqlDagRoot(value: unknown): Promise<string> {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0') || !samePath(resolve(value), value)) return requiredDagInvalid('profile不是准确绝对路径')
  return canonicalRestoreRoot(value)
}
function nativeRef(value: unknown): CoverageRootReference {
  const ref = validateCoverageRootReference(value)
  if (ref.namespace.kind !== 'native') return requiredDagInvalid('此首次native files owner尚缺真实Main bundle importer；不按本机猜foreign ref')
  return ref
}
function paths(root: string, operationId: string, dagId: string) {
  const operation = join(root, 'backups', 'database-restore', durableSqlDagUuid(operationId))
  const collection = join(operation, 'knowledge-required-dags'), node = join(collection, durableSqlDagUuid(dagId))
  return { operation, collection, node, file: join(node, 'root.json') }
}
async function directory(value: string, root: string): Promise<void> {
  await assertRestorePath(value, root)
  const info = await lstat(value)
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(value, await realpath(value))) return requiredDagInvalid('目录有重定向或不是真实Main目录')
}
const standalone = (info: BigIntStats): boolean => info.isFile() && !info.isSymbolicLink() && info.nlink === 1n && info.ino !== 0n
function sameFd(a: BigIntStats, b: BigIntStats): boolean {
  return standalone(a) && standalone(b) && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
}
function samePathFd(a: BigIntStats, b: BigIntStats): boolean {
  return standalone(a) && standalone(b) && (a.dev === b.dev || process.platform === 'win32' && (a.dev === 0n || BigInt.asUintN(32, a.dev) === b.dev))
    && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
}
async function finiteText(file: string, root: string): Promise<string> {
  await assertRestorePath(file, root)
  const prior = await lstat(file, { bigint: true })
  if (!standalone(prior) || prior.size < 1n || prior.size > BigInt(DURABLE_SQL_DAG_MAX_NODE_BYTES)) return requiredDagInvalid('node不是独立有限普通原件')
  const fd = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = await fd.stat({ bigint: true })
    if (!samePathFd(prior, before) || process.platform === 'win32' && before.dev === 0n) return requiredDagInvalid('node打开身份变化或卷未知')
    const bytes = Buffer.alloc(Number(before.size) + 1); let offset = 0
    while (offset < bytes.length) { const next = await fd.read(bytes, offset, bytes.length - offset, offset); if (!next.bytesRead) break; offset += next.bytesRead }
    const after = await fd.stat({ bigint: true }), current = await lstat(file, { bigint: true })
    await assertRestorePath(file, root)
    if (offset !== Number(before.size) || !sameFd(before, after) || !samePathFd(current, after)) return requiredDagInvalid('node读取期间身份/bytes变化')
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, offset))
    if (!Buffer.from(text, 'utf8').equals(bytes.subarray(0, offset))) return requiredDagInvalid('node原TEXT不能无损解码')
    return text
  } finally { await fd.close() }
}
export async function readRequiredSqlDagNodeFile(profile: string, value: CoverageRootReference): Promise<RequiredSqlDagNodeFile> {
  const root = await canonicalRequiredSqlDagRoot(profile), ref = nativeRef(value), p = paths(root, ref.operationId, ref.dagId)
  await directory(p.operation, root); await directory(p.collection, root); await directory(p.node, root)
  const names = await readdir(p.node)
  if (names.length !== 1 || names[0] !== 'root.json') return requiredDagInvalid('node原件闭集不完整或有额外文件')
  const text = await finiteText(p.file, root), node = parseRequiredSqlDagNode(text)
  if (requiredSqlDagRootHash(node) !== ref.rootHash) return requiredDagInvalid('node原hash不符')
  await directory(p.node, root)
  const after = await readdir(p.node)
  if (after.length !== 1 || after[0] !== 'root.json') return requiredDagInvalid('node目录读取期间变化')
  return freezeCapsuleValue({ ref, node, path: p.file, bytes: Buffer.byteLength(text) })
}
export async function writeRequiredSqlDagNodeFile(profile: string, operationId: string, dagId: string, value: RequiredSqlDagNode): Promise<RequiredSqlDagNodeFile> {
  const root = await canonicalRequiredSqlDagRoot(profile), node = validateRequiredSqlDagNode(value), p = paths(root, operationId, dagId)
  await directory(p.operation, root); await restoreDirectory(p.collection, root); await directory(p.collection, root)
  await restoreDirectory(p.node, root, true); await directory(p.node, root)
  const text = capsuleJson(node), fd = await open(p.file, 'wx')
  try {
    const before = await fd.stat({ bigint: true })
    if (!standalone(before) || process.platform === 'win32' && before.dev === 0n) return requiredDagInvalid('新node FD身份不可用')
    await fd.writeFile(text, 'utf8'); await fd.sync()
    const after = await fd.stat({ bigint: true }), current = await lstat(p.file, { bigint: true })
    if (!standalone(after) || before.dev !== after.dev || before.ino !== after.ino || after.size !== BigInt(Buffer.byteLength(text))
      || !samePathFd(current, after)) return requiredDagInvalid('新node持久化期间被替换')
    await assertRestorePath(p.file, root)
  } finally { await fd.close() }
  await syncRestoreDirectory(p.node); await syncRestoreDirectory(p.collection)
  return readRequiredSqlDagNodeFile(root, validateCoverageRootReference({ kind: 'restore-knowledge-origin-root-ref', version: 1,
    namespace: { kind: 'native' }, operationId, dagId, rootHash: requiredSqlDagRootHash(node), readerVersion: 'knowbook-required-sql-knowledge-dag-v2' }))
}

// Fixed synchronous v2 node bytes only. No SQL/currentness/accepted authority.
import * as syncRequiredFs from 'node:fs'
import { parse as syncRequiredParse, relative as syncRequiredRelative, sep as syncRequiredSep } from 'node:path'
import { capsuleBytesHash as syncRequiredBytesHash } from './restore-knowledge-capsule-model'

function syncRequiredPath(value: string, root: string): void {
  const absolute = resolve(value), child = syncRequiredRelative(root, absolute)
  if (child === '..' || child.startsWith('..' + syncRequiredSep) || isAbsolute(child)) return requiredDagInvalid('同步v2 witness路径越过profile')
  let cursor = syncRequiredParse(absolute).root
  for (const part of syncRequiredRelative(cursor, absolute).split(syncRequiredSep).filter(Boolean)) {
    cursor = join(cursor, part)
    const info = syncRequiredFs.lstatSync(cursor)
    if (info.isSymbolicLink() || cursor !== absolute && !info.isDirectory() || !samePath(syncRequiredFs.realpathSync.native(cursor), cursor))
      return requiredDagInvalid('同步v2 witness含重定向')
  }
}
function syncRequiredDirectory(value: string, root: string): BigIntStats {
  syncRequiredPath(value, root)
  const info = syncRequiredFs.lstatSync(value, { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink() || info.ino === 0n) return requiredDagInvalid('同步v2 witness目录身份不可认证')
  return info
}
/** Main file data assertion, never a node/material capability. The v2 owner
 * supplies its private exact file; expected.path cannot redirect the lookup. */
export function assertRequiredSqlDagNodeFileNow(profileRoot: string, expected: RequiredSqlDagNodeFile): void {
  if (typeof profileRoot !== 'string' || !isAbsolute(profileRoot) || !samePath(resolve(profileRoot), profileRoot)) return requiredDagInvalid('同步v2 profile无效')
  const ref = nativeRef(expected.ref), p = paths(profileRoot, ref.operationId, ref.dagId)
  const node = validateRequiredSqlDagNode(expected.node), text = capsuleJson(node), bytes = Buffer.from(text, 'utf8')
  if (requiredSqlDagRootHash(node) !== ref.rootHash || bytes.length !== expected.bytes || bytes.length > DURABLE_SQL_DAG_MAX_NODE_BYTES)
    return requiredDagInvalid('同步v2 node私有原像/hash变化')
  syncRequiredDirectory(p.operation, profileRoot); syncRequiredDirectory(p.collection, profileRoot)
  const directory = syncRequiredDirectory(p.node, profileRoot)
  if (capsuleJson(syncRequiredFs.readdirSync(p.node)) !== capsuleJson(['root.json'])) return requiredDagInvalid('同步v2 node不是准确单文件闭集')
  syncRequiredPath(p.file, profileRoot)
  const prior = syncRequiredFs.lstatSync(p.file, { bigint: true })
  if (!standalone(prior) || prior.size !== BigInt(bytes.length)) return requiredDagInvalid('同步v2 node不是准确独立普通原件')
  const fd = syncRequiredFs.openSync(p.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = syncRequiredFs.fstatSync(fd, { bigint: true })
    if (!samePathFd(prior, before) || process.platform === 'win32' && before.dev === 0n || before.size !== BigInt(bytes.length))
      return requiredDagInvalid('同步v2 node打开身份变化')
    const actual = Buffer.alloc(bytes.length + 1); let offset = 0
    while (offset < actual.length) { const count = syncRequiredFs.readSync(fd, actual, offset, actual.length - offset, offset); if (!count) break; offset += count }
    const after = syncRequiredFs.fstatSync(fd, { bigint: true }), current = syncRequiredFs.lstatSync(p.file, { bigint: true })
    syncRequiredPath(p.file, profileRoot)
    if (offset !== bytes.length || !sameFd(before, after) || !samePathFd(current, after) || !actual.subarray(0, offset).equals(bytes)
      || syncRequiredBytesHash(actual.subarray(0, offset)) !== syncRequiredBytesHash(bytes)) return requiredDagInvalid('同步v2 node全部bytes/hash或身份变化')
    const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(actual.subarray(0, offset))
    if (decoded !== text || !Buffer.from(decoded, 'utf8').equals(actual.subarray(0, offset))) return requiredDagInvalid('同步v2 node不是准确canonical UTF8')
  } finally { syncRequiredFs.closeSync(fd) }
  const after = syncRequiredDirectory(p.node, profileRoot)
  if (directory.dev !== after.dev || directory.ino !== after.ino || directory.mtimeNs !== after.mtimeNs || directory.ctimeNs !== after.ctimeNs
    || capsuleJson(syncRequiredFs.readdirSync(p.node)) !== capsuleJson(['root.json'])) return requiredDagInvalid('同步v2 node目录读取期间变化')
}
