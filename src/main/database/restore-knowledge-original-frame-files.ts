import { lstat, readdir } from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import { dirname, join } from 'node:path'
import { capsuleBytesHash, capsuleJson } from './restore-knowledge-capsule-model'
import { assertRestorePath, restoreDirectory, syncRestoreDirectory } from './restore-safety-files'
import { readCapsule2AssetManifest, writeCapsule2AssetCopy } from './restore-knowledge-capsule2-assets-files'
import { canonicalOriginCatalogRoot, assertOriginCatalogDirectory, originCatalogLocalPath,
  readOriginCatalogFile, copyOriginCatalogFile, settleOriginCatalogBatch } from './restore-knowledge-origin-bundle-files'
import { REFERENCE_CONTEXT_MAX_BYTES, referenceContextFileKey, referenceContextInvalid as bad,
  referenceContextObjectPath, type ReferenceContextFile } from './restore-knowledge-reference-context-model'

/** File IO only. A flat object store preserves each logical original domain
 * independently; identical bytes in two frames are not one shared original.
 * These primitives cannot mint a semantic source, Root3 or install capability. */
export interface OriginalFrameCopy extends ReferenceContextFile { readonly sourcePath: string; readonly sourceRoot: string }
type Physical = { logical: ReferenceContextFile; path: string }
function physical<T extends ReferenceContextFile>(files: readonly T[]): Array<{ logical: T; path: string }> {
  const logical = new Set<string>(), paths = new Set<string>()
  return files.map(file => {
    const key = referenceContextFileKey(file), path = referenceContextObjectPath(file.frame, file.path)
    if (logical.has(key) || paths.has(path)) return bad('原件逻辑域/路径重复或物理对象键冲突')
    logical.add(key); paths.add(path); return { logical: file, path }
  })
}
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.isFile() && b.isFile() && !a.isSymbolicLink() && !b.isSymbolicLink() && a.nlink === 1n && b.nlink === 1n
    && a.ino !== 0n && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
}
function directoryKeys(files: readonly Physical[]): string[] {
  return ['objects', ...new Set(files.map(file => file.path.slice(0, file.path.lastIndexOf('/'))))].sort()
}
export async function assertOriginalFrameDirectory(rootInput: string, descriptorText: string, files: readonly ReferenceContextFile[]): Promise<void> {
  const root = await canonicalOriginCatalogRoot(rootInput), entries = physical(files), keys = directoryKeys(entries)
  const plans = ['', ...keys].map(key => ({ key, path: key ? originCatalogLocalPath(root, key) : root,
    depth: key ? key.split('/').length : 0, children: new Map<string, 'file' | 'directory'>() }))
  const byKey = new Map(plans.map(plan => [plan.key, plan]))
  const add = (path: string, kind: 'file' | 'directory') => {
    const slash = path.lastIndexOf('/'), parent = slash < 0 ? '' : path.slice(0, slash), name = path.slice(slash + 1), plan = byKey.get(parent)
    if (!plan || plan.children.has(name)) return bad('平面原件存储闭集缺父目录或重复路径')
    plan.children.set(name, kind)
  }
  for (const key of keys) add(key, 'directory')
  for (const file of entries) add(file.path, 'file')
  add('descriptor.json', 'file')
  const snapshots = new Map<string, { stat: Awaited<ReturnType<typeof assertOriginCatalogDirectory>>; names: string[] }>()
  const levels = [...new Set(plans.map(plan => plan.depth))].sort((a, b) => a - b)
  for (const level of levels) await settleOriginCatalogBatch(plans.filter(plan => plan.depth === level), async plan => {
    const stat = await assertOriginCatalogDirectory(plan.path, root), names = (await readdir(plan.path)).sort()
    if (capsuleJson(names) !== capsuleJson([...plan.children.keys()].sort())) return bad('平面原件存储有缺失或额外文件/目录')
    snapshots.set(plan.key, { stat, names })
  })
  const descriptor = { path: 'descriptor.json', bytes: Buffer.byteLength(descriptorText), sha256: capsuleBytesHash(descriptorText) }
  if (descriptor.bytes > REFERENCE_CONTEXT_MAX_BYTES) return bad('完整原件descriptor超预算')
  const fileSnapshots = new Map<string, BigIntStats>()
  await settleOriginCatalogBatch(entries, async file => {
    const path = originCatalogLocalPath(root, file.path), before = await lstat(path, { bigint: true })
    await readOriginCatalogFile(path, root, { ...file.logical, path: file.path })
    if (!sameFile(before, await lstat(path, { bigint: true }))) return bad('平面原件读取期间路径身份变化')
    fileSnapshots.set(path, before)
  })
  const descriptorPath = join(root, 'descriptor.json'), descriptorBefore = await lstat(descriptorPath, { bigint: true })
  await readOriginCatalogFile(descriptorPath, root, descriptor)
  if (!sameFile(descriptorBefore, await lstat(descriptorPath, { bigint: true }))) return bad('平面descriptor读取期间变化')
  fileSnapshots.set(descriptorPath, descriptorBefore)
  for (const level of [...levels].reverse()) await settleOriginCatalogBatch(plans.filter(plan => plan.depth === level), async plan => {
    const before = snapshots.get(plan.key), after = await assertOriginCatalogDirectory(plan.path, root), names = (await readdir(plan.path)).sort()
    if (!before || before.stat.dev !== after.dev || before.stat.ino !== after.ino
      || before.stat.mtimeNs !== after.mtimeNs || before.stat.ctimeNs !== after.ctimeNs || capsuleJson(names) !== capsuleJson(before.names))
      return bad('平面原件存储读取期间目录身份或闭集变化')
  })
  await settleOriginCatalogBatch([...fileSnapshots], async ([path, before]) => {
    await assertRestorePath(path, root)
    if (!sameFile(before, await lstat(path, { bigint: true }))) return bad('平面原件全集结束时路径或字节身份变化')
  })
}
export async function writeOriginalFrameDirectory(input: { profileRoot: string; directory: string; descriptorText: string; files: readonly OriginalFrameCopy[] }): Promise<void> {
  const root = await canonicalOriginCatalogRoot(input.profileRoot), entries = physical(input.files)
  if (Buffer.byteLength(input.descriptorText) > REFERENCE_CONTEXT_MAX_BYTES) return bad('完整原件descriptor超预算')
  await assertOriginCatalogDirectory(dirname(input.directory), root)
  await restoreDirectory(input.directory, root, true)
  for (const key of directoryKeys(entries)) await restoreDirectory(originCatalogLocalPath(input.directory, key), root)
  await settleOriginCatalogBatch(entries, async file => {
    const source = file.logical
    await copyOriginCatalogFile(source.sourcePath, source.sourceRoot, originCatalogLocalPath(input.directory, file.path), input.directory,
      { path: file.path, bytes: file.logical.bytes, sha256: file.logical.sha256 })
  })
  await writeCapsule2AssetCopy(join(input.directory, 'descriptor.json'), Buffer.from(input.descriptorText), root)
  for (const key of directoryKeys(entries).sort((a, b) => b.split('/').length - a.split('/').length))
    await syncRestoreDirectory(originCatalogLocalPath(input.directory, key))
  await syncRestoreDirectory(input.directory)
  await assertOriginalFrameDirectory(input.directory, input.descriptorText, input.files)
}
export async function readOriginalFrameText(root: string, file: ReferenceContextFile, maxBytes: number): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > REFERENCE_CONTEXT_MAX_BYTES || file.bytes > maxBytes)
    return bad('原件TEXT预分配预算无效')
  const path = originCatalogLocalPath(root, referenceContextObjectPath(file.frame, file.path))
  const before = await readOriginCatalogFile(path, root, { ...file, path: 'original-frame-text' })
  const text = await readCapsule2AssetManifest(path, root, maxBytes)
  if (Buffer.byteLength(text) !== before.bytes || capsuleBytesHash(text) !== before.sha256) return bad('原件TEXT与完整FD字节不相等')
  return text
}
