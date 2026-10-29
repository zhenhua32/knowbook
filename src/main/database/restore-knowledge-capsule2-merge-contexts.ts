// Main-private source-spool originals, bound to genuine immutable SQL copies.
// No request.databasePath, caller path/list, hash DTO, or remote transport is
// used to locate files. All live selectors come from the genuine original SQL.
import Database from 'better-sqlite3'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { capsuleBytesHash, capsuleJson, capsuleRecord, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { readOwnedRawCapsuleOriginal, reopenPreparedRawCapsuleOriginal, assertOwnedRawCapsuleOriginal, assertOwnedRawCapsuleScratchReady, assertOwnedRawCapsuleScratchContent,
  type OwnedRawCapsuleOriginal } from './restore-knowledge-capsule-files'
import { readRawCapsule2AssetReferenceSourceOwned } from './restore-knowledge-capsule2-assets-read'
import { graph3Rows } from './restore-knowledge-graph3-data'
import { restoreSqliteFilename } from './restore-safety-sqlite-path'
import { assertRestorePath, restoreDirectory, syncRestoreDirectory } from './restore-safety-files'
import { DURABLE_SQL_DAG_MAX_ORIGINAL_BYTES } from './restore-knowledge-dag-model'
import { assertOriginCatalogDirectory, syncOriginCatalogAncestors } from './restore-knowledge-origin-bundle-files'
import type { Capsule2RawContent } from './restore-knowledge-capsule2-raw-model'
import { requiredRoot3MergeContextLocators3, createRoot3MergeContextReplay3, root3SupplementSourceContentHash3, root3SupplementOriginalRowHash3,
  type Root3MergeContextLocator3, type Root3MergeContextBytes3 } from './restore-knowledge-assets3-context'
import { validateExchangeJob, parseExchangeStored, exchangeJobHash, exchangeJobKey } from '../sync/synced-exchange-model'
import { publicationHash, publicationJson } from '../sync/synced-publication-model'
import { isSyncedUuid } from '../../shared/syncedBlockValidation'

interface ContextFile3 { readonly name: string; readonly sha256: string; readonly bytes: number }
interface ContextLocatorBinding3 {
  readonly jobSettingKey: string; readonly sourceRowId: string; readonly originalRowHash: string; readonly locatorHash: string
}
export type Capsule2MergeContextCapture3 = ContextLocatorBinding3 & (
  { readonly state: 'captured'; readonly fileHashes: readonly string[] }
  | { readonly state: 'unavailable'; readonly reason: 'missing-original-context'; readonly missingFiles: readonly string[]; readonly fileHashes: readonly [] })
type Capture3 = Capsule2MergeContextCapture3
interface CapturedContextForMain3 { readonly locator: Root3MergeContextLocator3; readonly files: readonly ContextFile3[] }
export interface Capsule2MergeContextInventory3 {
  readonly kind: 'capsule2-source-merge-context-originals'; readonly version: 2; readonly sourceContentHash: string
  readonly captures: readonly Capture3[]; readonly files: readonly { readonly sha256: string; readonly bytes: number }[]
  readonly inventoryHash: string; readonly certified: false; readonly semanticValidationComplete: false; readonly permit: false
}
export interface PreparedCapsule2MergeContexts3 { readonly kind: 'prepared-capsule2-merge-context-originals' }
export interface Capsule2MergeContextRead3 {
  readonly inventory: Capsule2MergeContextInventory3
  readonly sourceContent: Capsule2RawContent
  readonly baseAssets: Awaited<ReturnType<typeof source>>['assets']
}
/** Trusted Main consumer only. These callbacks neither select files nor mint
 * owners. They run after fixed original/SQL selection and native byte checks;
 * callers may use a result only after the visit resolves with its full tail. */
export interface Capsule2MergeContextVisitorForMain3 {
  begin(value: Capsule2MergeContextRead3): void | Promise<void>
  context(value: { readonly locator: Root3MergeContextLocator3; readonly bytes: Root3MergeContextBytes3;
    readonly replay: ReturnType<ReturnType<typeof createRoot3MergeContextReplay3>> }): void | Promise<void>
}
type CreatedIdentity3 = { readonly dev: bigint; readonly ino: bigint }
type KnownContextFiles3 = { readonly files: Map<string, number>; bytes: number }
interface Saved { original: OwnedRawCapsuleOriginal; root: string; directory: string; inventory: Capsule2MergeContextInventory3;
  created?: ReadonlyMap<string, CreatedIdentity3> }
const owners = new WeakMap<PreparedCapsule2MergeContexts3, Saved>(), used = new WeakSet<OwnedRawCapsuleOriginal>()
const fail = (reason: string): never => { throw new Error('capsule2 merge context originals: ' + reason + '；不授重放/语义选择/安装权，失败私有目录保留。') }
const same = (a: unknown, b: unknown) => capsuleJson(a) === capsuleJson(b)
const hash = (domain: string, value: unknown) => capsuleBytesHash(domain + '\0' + capsuleJson(value))
const regular = (stat: BigIntStats, independent = false) => stat.isFile() && !stat.isSymbolicLink() && stat.ino > 0n && stat.nlink > 0n && (!independent || stat.nlink === 1n)
const sameFd = (a: BigIntStats, b: BigIntStats) => regular(a) && regular(b) && a.dev === b.dev && a.ino === b.ino && a.mode === b.mode
  && a.size === b.size && a.nlink === b.nlink && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
const pathFd = (a: BigIntStats, b: BigIntStats) => regular(a) && regular(b) && a.ino === b.ino && a.mode === b.mode
  && (a.dev === b.dev || process.platform === 'win32' && (a.dev === 0n || BigInt.asUintN(32, a.dev) === b.dev))
  && a.size === b.size && a.nlink === b.nlink && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
const nameAllowed = (name: string) => ['inputs.json', 'job.json', 'ready.json', 'manifest.json'].includes(name)
  || /^(?:objects\/[a-f0-9]{64}\.json|assets\/[a-f0-9]{64})$/.test(name)
function inventoryBody(sourceContentHash: string, captures: readonly Capture3[], files: readonly { sha256: string; bytes: number }[]) {
  return { kind: 'capsule2-source-merge-context-originals' as const, version: 2 as const, sourceContentHash, captures, files,
    certified: false as const, semanticValidationComplete: false as const, permit: false as const }
}
function makeInventory(sourceContentHash: string, captures: readonly Capture3[], files: readonly { sha256: string; bytes: number }[]) {
  const body = inventoryBody(sourceContentHash, captures, files)
  return freezeCapsuleValue({ ...body, inventoryHash: hash('knowbook.capsule3.source-merge-context-inventory.v2', body) })
}
const validHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
function locatorBinding(locator: Root3MergeContextLocator3): ContextLocatorBinding3 {
  return { jobSettingKey: locator.jobSettingKey, sourceRowId: locator.sourceRowId, originalRowHash: locator.originalRowHash,
    locatorHash: hash('knowbook.capsule3.source-merge-context-locator.v1', locator) }
}
function capturedBinding(capture: CapturedContextForMain3): Capture3 {
  return { ...locatorBinding(capture.locator), state: 'captured', fileHashes: capture.files.map(file => file.sha256) }
}
export function validateCapsule2MergeContextInventory3(value: unknown): Capsule2MergeContextInventory3 {
  const row = capsuleRecord(value, ['kind', 'version', 'sourceContentHash', 'captures', 'files', 'inventoryHash', 'certified', 'semanticValidationComplete', 'permit'])
  if (row.kind !== 'capsule2-source-merge-context-originals' || row.version !== 2 || row.certified !== false || row.semanticValidationComplete !== false || row.permit !== false
    || typeof row.sourceContentHash !== 'string' || !/^[a-f0-9]{64}$/.test(row.sourceContentHash) || !Array.isArray(row.captures) || !Array.isArray(row.files)) return fail('未知context inventory或权限提升')
  let totalBytes = 0
  const files = row.files.map(value => { const file = capsuleRecord(value, ['sha256', 'bytes'])
    if (typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256) || typeof file.bytes !== 'number' || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > DURABLE_SQL_DAG_MAX_ORIGINAL_BYTES) return fail('原context文件hash/bytes无效')
    totalBytes += file.bytes
    if (!Number.isSafeInteger(totalBytes) || totalBytes > DURABLE_SQL_DAG_MAX_ORIGINAL_BYTES) return fail('context合计超原DAG总域')
    return { sha256: file.sha256, bytes: file.bytes } })
  if (files.some((file, index) => index > 0 && files[index - 1].sha256 >= file.sha256)) return fail('原context文件不严格排序')
  const allFiles = new Map(files.map(file => [file.sha256, file.bytes])), usedFiles = new Set<string>()
  const captures = row.captures.map((value): Capture3 => {
    const item = capsuleRecord(value, value && typeof value === 'object' && (value as Record<string, unknown>).state === 'unavailable'
      ? ['jobSettingKey', 'sourceRowId', 'originalRowHash', 'locatorHash', 'state', 'reason', 'missingFiles', 'fileHashes']
      : ['jobSettingKey', 'sourceRowId', 'originalRowHash', 'locatorHash', 'state', 'fileHashes'])
    const parts = typeof item.jobSettingKey === 'string' && item.jobSettingKey.startsWith('sync.webdav.protocol5.exchange-job.v1.')
      ? item.jobSettingKey.slice('sync.webdav.protocol5.exchange-job.v1.'.length).split('.') : []
    if (parts.length !== 2 || !isSyncedUuid(parts[0]) || !isSyncedUuid(parts[1]) || item.jobSettingKey !== exchangeJobKey(parts[0], parts[1])
      || typeof item.sourceRowId !== 'string' || !/^(?:0|-?[1-9][0-9]*)$/.test(item.sourceRowId)
      || BigInt(item.sourceRowId) < -(2n ** 63n) || BigInt(item.sourceRowId) >= 2n ** 63n
      || !validHash(item.originalRowHash) || !validHash(item.locatorHash) || !Array.isArray(item.fileHashes))
      return fail('compact context locator不是原UUID/int64/hash固定域')
    const binding: ContextLocatorBinding3 = { jobSettingKey: item.jobSettingKey as string, sourceRowId: item.sourceRowId,
      originalRowHash: item.originalRowHash, locatorHash: item.locatorHash }
    if (item.state === 'unavailable') {
      const missingFiles = item.missingFiles
      if (item.reason !== 'missing-original-context' || item.fileHashes.length || !Array.isArray(missingFiles)
        || !missingFiles.length || missingFiles.some(name => typeof name !== 'string'
          || name !== 'spool' && name !== 'objects/' && name !== 'assets/' && !nameAllowed(name)))
        return fail('缺失context不能伪造文件/缺失观察')
      if (missingFiles.some((name, index) => index > 0 && String(missingFiles[index - 1]) >= String(name))) return fail('缺失文件观察不严格排序')
      return { ...binding, state: 'unavailable', reason: 'missing-original-context', missingFiles: missingFiles as string[], fileHashes: [] }
    }
    if (item.state !== 'captured') return fail('未知context捕获状态')
    const fileHashes = item.fileHashes.map(value => {
      if (!validHash(value) || !allFiles.has(value)) return fail('compact context文件不属完整固定原件集')
      usedFiles.add(value); return value })
    return { ...binding, state: 'captured', fileHashes }
  })
  if (captures.some((item, index) => index > 0 && captures[index - 1].jobSettingKey >= item.jobSettingKey) || usedFiles.size !== files.length) return fail('context捕获/文件支持不严格闭合')
  const result = makeInventory(row.sourceContentHash, captures, files)
  if (row.inventoryHash !== result.inventoryHash || !same(row, result)) return fail('context inventory原规范data/hash不符')
  return result
}
/** Reconstruct selectors only from this fresh genuine SQL. The compact codec
 * alone never recovers paths or op/attempt selectors from a caller manifest. */
export function bindCapsule2MergeContextInventoryToSource3(inventory: Capsule2MergeContextInventory3, raw: Capsule2RawContent) {
  const locators = requiredRoot3MergeContextLocators3(raw), files = new Map(inventory.files.map(file => [file.sha256, file.bytes]))
  if (inventory.sourceContentHash !== root3SupplementSourceContentHash3(raw) || locators.length !== inventory.captures.length)
    return fail('compact context不是该genuine完整原SQL要求')
  return locators.map((locator, index) => {
    const capture = inventory.captures[index]
    const expected = locatorBinding(locator)
    if (capture.jobSettingKey !== expected.jobSettingKey || capture.sourceRowId !== expected.sourceRowId
      || capture.originalRowHash !== expected.originalRowHash || capture.locatorHash !== expected.locatorHash)
      return fail('compact locator未匹配同次原SQL完整selector/hash')
    if (capture.state === 'unavailable') {
      if (capture.missingFiles.some(name => name !== 'spool' && name !== 'objects/' && name !== 'assets/' && !locator.requiredFiles.includes(name)))
        return fail('缺失观察不属于真实SQL固定文件集合')
      return { locator, state: 'unavailable' as const, reason: capture.reason, missingFiles: capture.missingFiles }
    }
    if (capture.fileHashes.length !== locator.requiredFiles.length) return fail('compact context固定文件数量不符')
    return { locator, state: 'captured' as const, files: locator.requiredFiles.map((name, position) => {
      if (!nameAllowed(name)) return fail('真实原SQL生成未知文件路径')
      const sha256 = capture.fileHashes[position], bytes = files.get(sha256)
      if (bytes === undefined) return fail('compact context文件不在完整原filetable')
      return { name, sha256, bytes }
    }) }
  })
}
async function source(original: OwnedRawCapsuleOriginal) {
  const owned = readOwnedRawCapsuleOriginal(original)
  await assertOwnedRawCapsuleOriginal(original)
  // Another genuine reader may already have opened this owner's scratch;
  // SQLite may then change its derived SHM. Rebuild a fresh independent probe
  // only from the registry-bound immutable originals for every SQL capture.
  // Neither old scratch nor a caller locator/source DTO is an input here.
  const probe = await reopenPreparedRawCapsuleOriginal({ profileRoot: owned.profileRoot,
    operationId: basename(owned.recoveryDirectory), capsuleId: basename(owned.capsuleDirectory), expectedInventory: owned.originalInventory })
  const info = readOwnedRawCapsuleOriginal(probe)
  await assertOwnedRawCapsuleScratchReady(probe)
  const db = new Database(restoreSqliteFilename(info.databasePath), { readonly: true, fileMustExist: true })
  try { db.pragma('query_only=ON'); db.pragma('foreign_keys=ON'); return db.transaction(() => readRawCapsule2AssetReferenceSourceOwned(db))() }
  finally { db.close(); await assertOwnedRawCapsuleScratchContent(probe); await assertOwnedRawCapsuleOriginal(original) }
}
async function hashFile(path: string, root: string, independent = false) {
  await assertRestorePath(path, root); const named = await lstat(path, { bigint: true })
  if (!regular(named, independent) || named.size > BigInt(DURABLE_SQL_DAG_MAX_ORIGINAL_BYTES)) return fail('原context文件不普通或超原DAG总域')
  const fd = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = await fd.stat({ bigint: true })
    if (!pathFd(named, before) || !regular(before, independent) || process.platform === 'win32' && before.dev === 0n) return fail('原context opened FD身份无效')
    const digest = createHash('sha256'), buffer = Buffer.alloc(64 * 1024); let offset = 0
    while (offset < Number(before.size)) { const amount = (await fd.read(buffer, 0, Math.min(buffer.length, Number(before.size) - offset), offset)).bytesRead
      if (!amount) return fail('原context提前EOF'); digest.update(buffer.subarray(0, amount)); offset += amount }
    if ((await fd.read(buffer, 0, 1, offset)).bytesRead) return fail('原context多余尾bytes')
    const after = await fd.stat({ bigint: true }); await assertRestorePath(path, root)
    if (!sameFd(before, after) || !pathFd(await lstat(path, { bigint: true }), after)) return fail('原context读取期间FD/path变化')
    return { sha256: digest.digest('hex'), bytes: offset, stat: before }
  } finally { await fd.close() }
}
async function copyByHash(path: string, sourceRoot: string, directory: string, root: string, known: KnownContextFiles3, createdFiles: Map<string, CreatedIdentity3>) {
  const measured = await hashFile(path, sourceRoot), target = join(directory, measured.sha256)
  if (known.files.has(measured.sha256)) {
    if (known.files.get(measured.sha256) !== measured.bytes) return fail('同hash原context长度矛盾')
    const copied = await hashFile(target, root, true)
    if (copied.sha256 !== measured.sha256 || copied.bytes !== measured.bytes) return fail('既有独立context副本变化')
    return { sha256: measured.sha256, bytes: measured.bytes }
  }
  const totalBytes = known.bytes + measured.bytes
  if (!Number.isSafeInteger(totalBytes) || totalBytes > DURABLE_SQL_DAG_MAX_ORIGINAL_BYTES)
    return fail('独立context累计bytes超原DAG总域，不继续wx复制')
  await assertRestorePath(path, sourceRoot); await assertRestorePath(target, root)
  const input = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const output = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    try {
    const before = await input.stat({ bigint: true }), targetBefore = await output.stat({ bigint: true })
    if (!sameFd(before, measured.stat) || !regular(targetBefore, true) || process.platform === 'win32' && targetBefore.dev === 0n
      || targetBefore.dev === before.dev && targetBefore.ino === before.ino) return fail('context copy实际独立FD变化')
    const digest = createHash('sha256'), buffer = Buffer.alloc(64 * 1024); let offset = 0
    while (offset < measured.bytes) { const amount = (await input.read(buffer, 0, Math.min(buffer.length, measured.bytes - offset), offset)).bytesRead
      if (!amount) return fail('context copy提前EOF'); digest.update(buffer.subarray(0, amount))
      let written = 0; while (written < amount) { const count = (await output.write(buffer, written, amount - written, offset + written)).bytesWritten; if (!count) return fail('context wx copy没有推进'); written += count }
      offset += amount }
    if ((await input.read(buffer, 0, 1, offset)).bytesRead || digest.digest('hex') !== measured.sha256) return fail('context copy全部bytes/hash变化')
    await output.sync(); await assertRestorePath(path, sourceRoot); await assertRestorePath(target, root)
    if (!sameFd(before, await input.stat({ bigint: true })) || !pathFd(await lstat(path, { bigint: true }), before)) return fail('context source在copy尾变化')
    const created = await output.stat({ bigint: true })
    if (!regular(created, true) || created.dev !== targetBefore.dev || created.ino !== targetBefore.ino
      || created.size !== BigInt(measured.bytes) || !pathFd(await lstat(target, { bigint: true }), created)) return fail('context新副本不是实际独立目标')
    createdFiles.set(measured.sha256, { dev: created.dev, ino: created.ino })
    } finally { await output.close() }
  } finally { await input.close() }
  const after = await hashFile(target, root, true)
  if (after.sha256 !== measured.sha256 || after.bytes !== measured.bytes) return fail('context wx完整回读不符')
  known.files.set(measured.sha256, measured.bytes); known.bytes = totalBytes
  return { sha256: measured.sha256, bytes: measured.bytes }
}
async function readBytes(path: string, root: string, expected: { sha256: string; bytes: number }): Promise<Buffer> {
  // Pure protocol replay uses its original whole-JSON model. This is not a
  // claim of memory-bounded JSON validation: original Node buffer limits and
  // actual model depth apply, with no new smaller per-context 128MiB cap.
  const checked = await hashFile(path, root, true)
  if (checked.sha256 !== expected.sha256 || checked.bytes !== expected.bytes) return fail('sealed context原bytes不符')
  const fd = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = await fd.stat({ bigint: true }); if (!sameFd(before, checked.stat)) return fail('sealed context读取打开身份变化')
    const bytes = Buffer.alloc(expected.bytes); let offset = 0
    while (offset < bytes.length) {
      const count = (await fd.read(bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset)).bytesRead
      if (!count) return fail('sealed context重读提前EOF')
      offset += count
    }
    const extra = Buffer.alloc(1)
    if ((await fd.read(extra, 0, 1, offset)).bytesRead || publicationHash(bytes) !== expected.sha256
      || !sameFd(before, await fd.stat({ bigint: true }))) return fail('sealed context完整重读/EOF变化')
    await assertRestorePath(path, root)
    if (!pathFd(await lstat(path, { bigint: true }), before)) return fail('sealed context尾路径变化')
    return bytes
  } finally { await fd.close() }
}
/** File-only primitive for the fixed genuine package getter. This function
 * does not mint an original/context/blob owner. Its Main caller must first
 * derive path/root/hash from a registry-authenticated complete original catalog;
 * public factories never accept this primitive's path or expected DTO. */
export const readCapsule2MergeContextBufferForMain3 = readBytes
/** Native stream evidence only. The digest DTO grants no blob or semantic
 * authority; genuine owners separately retain the actual file capability. */
export async function readCapsule2MergeContextDigestForMain3(path: string, root: string, expected: { sha256: string; bytes: number }) {
  const actual = await hashFile(path, root, true)
  if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) return fail('sealed context stream digest不符')
  return Object.freeze({ kind: 'main-stream-digest' as const, sha256: actual.sha256, byteLength: actual.bytes })
}
function createJobLookup(raw: Capsule2RawContent) {
  const byKey = new Map<string, ReturnType<typeof graph3Rows>>()
  for (const row of graph3Rows(raw, 'app_settings')) if (typeof row.value.key === 'string') {
    const rows = byKey.get(row.value.key) ?? []; rows.push(row); byKey.set(row.value.key, rows)
  }
  let cachedKey: string | undefined, cachedJob: ReturnType<typeof validateExchangeJob> | undefined
  return (locator: Root3MergeContextLocator3) => {
  if (cachedKey === locator.jobSettingKey && cachedJob) return cachedJob
  const rows = byKey.get(locator.jobSettingKey) ?? []
  if (rows.length !== 1 || typeof rows[0].value.value !== 'string') return fail('真实SQL context job缺失')
  if (rows[0].original.sourceRowId !== locator.sourceRowId || root3SupplementOriginalRowHash3(raw, rows[0]) !== locator.originalRowHash)
    return fail('genuine context不是该原native SQL row/原完整cells')
  const job = validateExchangeJob(parseExchangeStored(rows[0].value.value))
  if (job.request.operationId !== locator.operationId || job.attemptId !== locator.attemptId || exchangeJobHash(job) !== locator.jobHash
    || job.spoolHash !== locator.spoolHash || publicationHash(publicationJson(job.descriptor)) !== locator.descriptorHash) return fail('genuine SQL job与原locator不符')
  cachedKey = locator.jobSettingKey; cachedJob = job
  return job
  }
}
async function contextBytes(directory: string, root: string, capture: CapturedContextForMain3, jobFor: ReturnType<typeof createJobLookup>): Promise<Root3MergeContextBytes3> {
  const job = jobFor(capture.locator), files = new Map(capture.files.map(file => [file.name, file]))
  const get = async (name: string) => { const file = files.get(name) ?? fail('context缺固定原文件'); return readBytes(join(directory, file.sha256), root, file) }
  const getDigest = async (name: string) => { const file = files.get(name) ?? fail('context缺实际descriptor文件')
    return readCapsule2MergeContextDigestForMain3(join(directory, file.sha256), root, file) }
  const objects: NonNullable<Root3MergeContextBytes3['objects']>[number][] = [], assets: NonNullable<Root3MergeContextBytes3['assets']>[number][] = []
  for (const item of new Map(job.descriptor.next.objects.map(item => [item.hash, item])).values()) objects.push({ hash: item.hash, bytes: await getDigest(item.path) })
  for (const item of job.descriptor.next.assets) assets.push({ hash: item.hash, names: item.names, bytes: await getDigest(item.path) })
  return { operationId: capture.locator.operationId, attemptId: capture.locator.attemptId,
    inputBytes: await get('inputs.json'), jobBytes: await get('job.json'), readyBytes: await get('ready.json'), manifestBytes: await get('manifest.json'),
    objects, assets }
}
function spoolEntries(job: ReturnType<typeof validateExchangeJob>) {
  return new Map<string, string[]>([['', ['assets', 'inputs.json', 'job.json', 'manifest.json', 'objects', 'ready.json']],
    ['objects', [...new Set(job.descriptor.next.objects.map(item => item.hash + '.json'))].sort()],
    ['assets', job.descriptor.next.assets.map(item => item.hash).sort()]])
}
type DirectorySnapshot3 = Map<string, BigIntStats>
/** Missing is an observed source fact, never permission to consult a live DB,
 * another profile, managed tree, remote endpoint or same-hash unrelated spool. */
async function spoolPreflight(spool: string, root: string, job: ReturnType<typeof validateExchangeJob>, locator: Root3MergeContextLocator3) {
  const directories: DirectorySnapshot3 = new Map(), missing = new Set<string>()
  for (const [relativePath, expected] of spoolEntries(job)) {
    const path = relativePath ? join(spool, relativePath) : spool
    await assertRestorePath(path, root)
    let stat: BigIntStats
    try { stat = await assertOriginCatalogDirectory(path, root) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      missing.add(relativePath ? relativePath + '/' : 'spool'); continue
    }
    directories.set(relativePath, stat)
    const names = await readdir(path)
    if (names.some(name => !expected.includes(name))) return fail('真实spool含未知/额外目录项')
    for (const name of expected) if (!names.includes(name)) missing.add(name === 'objects' || name === 'assets' ? name + '/'
      : relativePath ? relativePath + '/' + name : name)
  }
  for (const name of locator.requiredFiles) {
    if (!nameAllowed(name)) return fail('真实typed job生成非固定spool路径')
    const parent = name.startsWith('objects/') ? 'objects' : name.startsWith('assets/') ? 'assets' : ''
    if (!directories.has(parent) || missing.has(name)) continue
    const path = join(spool, ...name.split('/')); await assertRestorePath(path, root)
    try {
      const stat = await lstat(path, { bigint: true })
      if (!regular(stat) || stat.size > BigInt(DURABLE_SQL_DAG_MAX_ORIGINAL_BYTES)) return fail('原spool文件不是实际有限普通文件')
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') missing.add(name); else throw error }
  }
  return { directories, missingFiles: [...missing].sort() }
}
async function assertSpoolTail(spool: string, root: string, job: ReturnType<typeof validateExchangeJob>, locator: Root3MergeContextLocator3, before: DirectorySnapshot3) {
  const after = await spoolPreflight(spool, root, job, locator)
  if (after.missingFiles.length || after.directories.size !== before.size) return fail('source context目录/文件在capture尾消失')
  for (const [name, prior] of before) {
    const stat = after.directories.get(name)
    if (!stat || prior.dev !== stat.dev || prior.ino !== stat.ino || prior.mode !== stat.mode || prior.nlink !== stat.nlink
      || prior.mtimeNs !== stat.mtimeNs || prior.ctimeNs !== stat.ctimeNs) return fail('source context目录身份/闭集在capture期间变化')
  }
}
async function assertContextFileInventory(saved: Saved) {
  for (const file of saved.inventory.files) {
    const observed = await hashFile(join(saved.directory, file.sha256), saved.root, true)
    if (observed.sha256 !== file.sha256 || observed.bytes !== file.bytes) return fail('sealed context/blob原字节变化')
    const born = saved.created?.get(file.sha256)
    if (born && (born.dev !== observed.stat.dev || born.ino !== observed.stat.ino)) return fail('同一hot context owner的原wx创建FD身份变化')
  }
}
async function verify(saved: Saved, visitor?: Capsule2MergeContextVisitorForMain3): Promise<Capsule2MergeContextRead3> {
  await assertOwnedRawCapsuleOriginal(saved.original)
  const actual = await source(saved.original), captures = bindCapsule2MergeContextInventoryToSource3(saved.inventory, actual.sourceContent)
  const directory = await assertOriginCatalogDirectory(saved.directory, saved.root)
  if (!same((await readdir(saved.directory)).sort(), saved.inventory.files.map(file => file.sha256))) return fail('sealed context目录闭集不符')
  await assertContextFileInventory(saved)
  const result: Capsule2MergeContextRead3 = { inventory: saved.inventory, sourceContent: actual.sourceContent, baseAssets: actual.assets }
  await visitor?.begin(result)
  const replay = createRoot3MergeContextReplay3(actual.sourceContent), jobFor = createJobLookup(actual.sourceContent)
  for (const item of captures) if (item.state === 'captured') {
    // Only this context's four JSON headers and compact binary digests live
    // across the awaited consumer. No contexts[] or all-header cache survives
    // the iteration. Whole JSON/full planner memory remains an explicit limit.
    const bytes = await contextBytes(saved.directory, saved.root, item, jobFor)
    const checked = replay(item.locator, bytes)
    await visitor?.context({ locator: item.locator, bytes, replay: checked })
  }
  await assertContextFileInventory(saved)
  const tail = await assertOriginCatalogDirectory(saved.directory, saved.root)
  if (directory.dev !== tail.dev || directory.ino !== tail.ino || directory.mode !== tail.mode || directory.nlink !== tail.nlink
    || directory.mtimeNs !== tail.mtimeNs || directory.ctimeNs !== tail.ctimeNs
    || !same((await readdir(saved.directory)).sort(), saved.inventory.files.map(file => file.sha256))) return fail('sealed context目录在全量读取后变化')
  await assertOwnedRawCapsuleOriginal(saved.original)
  return result
}
function register(saved: Saved) { const owner: PreparedCapsule2MergeContexts3 = Object.freeze({ kind: 'prepared-capsule2-merge-context-originals' }); owners.set(owner, saved); return owner }
export async function prepareCapsule2MergeContextOriginals3(original: OwnedRawCapsuleOriginal) {
  const info = readOwnedRawCapsuleOriginal(original)
  if (used.has(original)) return fail('同一原件context已开始，不覆盖重入')
  used.add(original)
  const actual = await source(original), locators = requiredRoot3MergeContextLocators3(actual.sourceContent)
  const directory = join(info.recoveryDirectory, 'knowledge-complete-assets-v2', basename(info.capsuleDirectory), 'contexts')
  await restoreDirectory(dirname(directory), info.profileRoot)
  await restoreDirectory(directory, info.profileRoot, true)
  const known: KnownContextFiles3 = { files: new Map(), bytes: 0 }, created = new Map<string, CreatedIdentity3>(), captures: Capture3[] = []
  const replay = createRoot3MergeContextReplay3(actual.sourceContent), jobFor = createJobLookup(actual.sourceContent)
  for (const locator of locators) {
    // The pure locator comes only from the real validated original SQL; never
    // from request.databasePath or an external factory argument.
    const spool = join(info.profileRoot, 'storage', 'synced-exchanges-v1', locator.operationId, locator.attemptId)
    const job = jobFor(locator), before = await spoolPreflight(spool, info.profileRoot, job, locator)
    if (before.missingFiles.length) {
      captures.push({ ...locatorBinding(locator), state: 'unavailable', reason: 'missing-original-context', missingFiles: before.missingFiles, fileHashes: [] })
      continue
    }
    const files: ContextFile3[] = []
    for (const name of locator.requiredFiles) {
      if (!nameAllowed(name)) return fail('genuine selector生成未知spool路径')
      const copied = await copyByHash(join(spool, ...name.split('/')), info.profileRoot, directory, info.profileRoot, known, created)
      files.push({ name, ...copied })
    }
    const capture: CapturedContextForMain3 = { locator, files }
    const bytes = await contextBytes(directory, info.profileRoot, capture, jobFor)
    replay(locator, bytes)
    // Recheck source closure and all source bytes after the final async reads.
    for (const file of files) { const again = await hashFile(join(spool, ...file.name.split('/')), info.profileRoot)
      if (again.sha256 !== file.sha256 || again.bytes !== file.bytes) return fail('source spool在capture尾变化') }
    await assertSpoolTail(spool, info.profileRoot, job, locator, before.directories)
    captures.push(capturedBinding(capture))
  }
  const files = [...known.files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([sha256, bytes]) => ({ sha256, bytes }))
  if (files.reduce((sum, file) => sum + file.bytes, 0) > DURABLE_SQL_DAG_MAX_ORIGINAL_BYTES) return fail('context原件合计超原DAG总域')
  const inventory = validateCapsule2MergeContextInventory3(makeInventory(root3SupplementSourceContentHash3(actual.sourceContent), captures, files))
  await syncRestoreDirectory(directory); await syncOriginCatalogAncestors(directory, info.profileRoot); await assertOwnedRawCapsuleOriginal(original)
  const saved: Saved = { original, root: info.profileRoot, directory, inventory, created }; await verify(saved)
  return Object.freeze({ owner: register(saved), inventory })
}
export async function reopenCapsule2MergeContextOriginals3(original: OwnedRawCapsuleOriginal, expected: Capsule2MergeContextInventory3) {
  const info = readOwnedRawCapsuleOriginal(original), inventory = validateCapsule2MergeContextInventory3(expected)
  const saved: Saved = { original, root: info.profileRoot,
    directory: join(info.recoveryDirectory, 'knowledge-complete-assets-v2', basename(info.capsuleDirectory), 'contexts'), inventory }
  // This route reads only copied originals. No source-live spool is consulted.
  await verify(saved)
  return Object.freeze({ owner: register(saved), inventory })
}
export async function readCapsule2MergeContextOriginals3(owner: PreparedCapsule2MergeContexts3) {
  const saved = owners.get(owner)
  if (!saved) return fail('不是实际Main context owner')
  return verify(saved)
}
/** Actual byte-only tail for an already genuine owner. Does not open scratch
 * SQL, derive locators, run the planner, return source DTOs, or mint evidence.
 * Complete file hashes/EOF and held-FD identities are checked in one bounded
 * sequential pass, bracketed by the immutable SQL original and closed native
 * directory. This is not an OS lease or a cross-file atomic snapshot. */
export async function assertCapsule2MergeContextOriginalBytes3(owner: PreparedCapsule2MergeContexts3): Promise<void> {
  const saved = owners.get(owner)
  if (!saved) return fail('不是实际Main context owner，不能核字节尾')
  await assertOwnedRawCapsuleOriginal(saved.original)
  const before = await assertOriginCatalogDirectory(saved.directory, saved.root)
  const names = saved.inventory.files.map(file => file.sha256)
  if (!same((await readdir(saved.directory)).sort(), names)) return fail('bytes-tail context目录闭集不符')
  await assertContextFileInventory(saved)
  const after = await assertOriginCatalogDirectory(saved.directory, saved.root)
  if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode || before.nlink !== after.nlink
    || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
    || !same((await readdir(saved.directory)).sort(), names)) return fail('bytes-tail context目录身份/闭集变化')
  await assertOwnedRawCapsuleOriginal(saved.original)
}
/** Sequential genuine read, including complete pre/post inventory and original
 * byte brackets. Cold paths consult sealed by-hash files, never retired spools.
 * Public prepare/reopen still accept only genuine handles/finite locators. */
export async function visitCapsule2MergeContextOriginals3(owner: PreparedCapsule2MergeContexts3,
  visitor: Capsule2MergeContextVisitorForMain3): Promise<Capsule2MergeContextRead3> {
  const saved = owners.get(owner)
  if (!saved) return fail('不是实际Main context owner，不能逐context读取')
  return verify(saved, visitor)
}
