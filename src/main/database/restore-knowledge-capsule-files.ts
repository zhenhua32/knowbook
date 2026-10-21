import { randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isSyncedUuid } from '../../shared/syncedBlockValidation'
import { assertRestorePath, canonicalRestoreRoot, copyRestoreInventory, restoreDirectory, restoreInventory,
  syncRestoreDirectory } from './restore-safety-files'
import type { RestoreRawFile } from './restore-safety-model'
import { buildDurableSqlCapsuleArtifacts, CAPSULE_MAX_MANIFEST_BYTES, CAPSULE_MAX_SHARD_BYTES,
  capsuleBytesHash, capsuleInvalid, capsuleJson, capsuleRecord, capsuleText, DURABLE_SQL_CAPSULE_FILES,
  durableSqlCapsuleFactKey, durableSqlCapsuleManifestHash, freezeCapsuleValue, parseDurableSqlCapsuleManifest,
  parseDurableSqlCapsuleShard, validateDurableSqlCapsuleInventory,
  type DurableSqlCapsuleDraft, type DurableSqlCapsuleFile, type DurableSqlCapsuleManifest } from './restore-knowledge-capsule-model'
import type { RawHistoricalEvidenceFact } from './synced-history-evidence-model'

/** Registry identity, not a serializable path/inventory/manifest authorization. */
export interface OwnedRawCapsuleOriginal { readonly kind: 'owned-raw-capsule-original' }
export interface PrepareDurableSqlCapsuleOriginalInput {
  readonly profileRoot: string; readonly recoveryDirectory: string; readonly sealedDirectory: string
  readonly capsuleId: string; readonly label: string
}
/** Main-internal durable locator. The expected hash must come from the trusted
 * owning root/DAG, never a manifest or fact DTO supplied as authorization. */
export interface ReopenDurableSqlCapsuleOriginalInput {
  readonly profileRoot: string; readonly operationId: string; readonly capsuleId: string; readonly expectedManifestHash: string
}
export interface OwnedRawCapsuleOriginalInfo {
  readonly profileRoot: string; readonly recoveryDirectory: string; readonly sealedDirectory: string
  readonly capsuleDirectory: string; readonly originalDirectory: string; readonly scratchDirectory: string
  readonly databasePath: string; readonly originalInventory: readonly DurableSqlCapsuleFile[]
  readonly label: string
}
/** Persisted artifact only. A Root certifier separately authenticates SQL and
 * owns its private certified registry; no object returned here is a permit. */
export interface DurableSqlCapsuleSeal {
  readonly manifest: DurableSqlCapsuleManifest; readonly manifestHash: string; readonly manifestPath: string
  readonly shardsDirectory: string; readonly facts: readonly RawHistoricalEvidenceFact[]
}
type Saved = { info: OwnedRawCapsuleOriginalInfo; busy: boolean; failed: boolean; origin: 'new' | 'sealed'; sealed: DurableSqlCapsuleSeal | null }
const originals = new WeakMap<OwnedRawCapsuleOriginal, Saved>()
const samePath = (a: string, b: string): boolean => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
function beneath(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child !== '' && child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child)
}
function absolute(value: unknown): string {
  const checked = capsuleText(value)
  if (!isAbsolute(checked) || checked.includes('\0') || !samePath(resolve(checked), checked)) return capsuleInvalid('目录不是准确绝对路径')
  return resolve(checked)
}
function saved(handle: OwnedRawCapsuleOriginal): Saved {
  const value = originals.get(handle)
  if (!value || value.failed) return capsuleInvalid('不是有效Main-owned原件句柄')
  return value
}
async function directory(path: string, root: string): Promise<void> {
  await assertRestorePath(path, root)
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(path), path)) return capsuleInvalid('原件目录含重定向或身份变化')
}
function standalone(info: Stats): boolean { return info.isFile() && !info.isSymbolicLink() && info.nlink === 1 }
function sameFile(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && before.nlink === after.nlink
}
function samePathFile(path: Stats, fd: Stats): boolean {
  // Windows lstat can report dev=0 while stat of the already open descriptor
  // reports its volume ID. Only that path-side convention differs; fd-to-fd
  // checks above and every other identity/stability field stay exact.
  return (path.dev === fd.dev || process.platform === 'win32' && path.dev === 0)
    && path.ino === fd.ino && path.size === fd.size && path.mtimeMs === fd.mtimeMs
    && path.ctimeMs === fd.ctimeMs && path.nlink === fd.nlink
}
async function rawInventory(path: string, root: string): Promise<readonly DurableSqlCapsuleFile[]> {
  await directory(path, root)
  const entries = await readdir(path, { withFileTypes: true })
  if (entries.some(entry => !(DURABLE_SQL_CAPSULE_FILES as readonly string[]).includes(entry.name)))
    return capsuleInvalid('durable-sql-only原件目录有额外文件（包括rollback journal）')
  for (const entry of entries) {
    await assertRestorePath(join(path, entry.name), root)
    if (!standalone(await lstat(join(path, entry.name)))) return capsuleInvalid('原件不是独立普通文件或存在hardlink')
  }
  const inventory = validateDurableSqlCapsuleInventory(await restoreInventory(path))
  // The reused digest checks stable fd/path identity. Recheck hardlinks and the
  // finite directory as well, so a digest never follows an external alias.
  const after = await readdir(path, { withFileTypes: true })
  if (entries.map(row => row.name).sort().join('\0') !== after.map(row => row.name).sort().join('\0')) return capsuleInvalid('原件目录读取期间变化')
  for (const entry of after) if (!standalone(await lstat(join(path, entry.name)))) return capsuleInvalid('原件读取期间产生hardlink/重定向')
  return inventory
}
async function assertInventory(path: string, expected: readonly DurableSqlCapsuleFile[], root: string): Promise<void> {
  if (capsuleJson(await rawInventory(path, root)) !== capsuleJson(expected)) return capsuleInvalid('原封存DB/WAL/SHM清单或bytes已改变')
}

/** Only a genuine fixed three-file Main-owned directory can create an original
 * handle. Original bytes and SQLite scratch are independent exclusive copies. */
export async function prepareDurableSqlCapsuleOriginal(input: PrepareDurableSqlCapsuleOriginalInput): Promise<OwnedRawCapsuleOriginal> {
  const row = capsuleRecord(input, ['profileRoot', 'recoveryDirectory', 'sealedDirectory', 'capsuleId', 'label'])
  const profileRoot = await canonicalRestoreRoot(absolute(row.profileRoot)), recoveryDirectory = absolute(row.recoveryDirectory)
  const recoveryBase = join(profileRoot, 'backups', 'database-restore'), operationId = relative(recoveryBase, recoveryDirectory)
  if (!isSyncedUuid(operationId)) return capsuleInvalid('capsule必须位于准确Main恢复operation目录')
  await directory(recoveryDirectory, profileRoot)
  const sealedDirectory = absolute(row.sealedDirectory)
  if (!beneath(recoveryDirectory, sealedDirectory)) return capsuleInvalid('输入不是本Main恢复目录内已封存原件')
  await directory(sealedDirectory, profileRoot)
  if (!isSyncedUuid(row.capsuleId)) return capsuleInvalid('capsule ID无效')
  const label = capsuleText(row.label, 128)
  if (/[\x00-\x1f\x7f]/.test(label)) return capsuleInvalid('诊断label无效')
  const capsulesDirectory = join(recoveryDirectory, 'knowledge-capsules'), capsuleDirectory = join(capsulesDirectory, row.capsuleId)
  if (samePath(sealedDirectory, capsuleDirectory) || beneath(capsuleDirectory, sealedDirectory) || beneath(sealedDirectory, capsuleDirectory))
    return capsuleInvalid('输入原件与新capsule目录重叠')
  const inventory = await rawInventory(sealedDirectory, profileRoot)
  await restoreDirectory(capsulesDirectory, profileRoot)
  await restoreDirectory(capsuleDirectory, profileRoot, true)
  const originalDirectory = join(capsuleDirectory, 'original'), scratchDirectory = join(capsuleDirectory, 'scratch')
  await copyRestoreInventory(sealedDirectory, originalDirectory, inventory as RestoreRawFile[], profileRoot)
  await assertInventory(originalDirectory, inventory, profileRoot)
  await copyRestoreInventory(originalDirectory, scratchDirectory, inventory as RestoreRawFile[], profileRoot)
  await assertInventory(scratchDirectory, inventory, profileRoot)
  await assertInventory(sealedDirectory, inventory, profileRoot)
  const info = freezeCapsuleValue({ profileRoot, recoveryDirectory, sealedDirectory, capsuleDirectory, originalDirectory, scratchDirectory,
    databasePath: join(scratchDirectory, 'knowbook.db'), originalInventory: inventory, label })
  const handle: OwnedRawCapsuleOriginal = Object.freeze({ kind: 'owned-raw-capsule-original' })
  originals.set(handle, { info, busy: false, failed: false, origin: 'new', sealed: null })
  return handle
}
/** Reopen persisted bytes, not process-local authority. Old scratch is neither
 * opened nor repaired. Every reopen makes its own exclusive SQLite copy outside
 * the immutable capsule directory and rereads all original/index artifacts. */
export async function reopenDurableSqlCapsuleOriginal(input: ReopenDurableSqlCapsuleOriginalInput): Promise<OwnedRawCapsuleOriginal> {
  const row = capsuleRecord(input, ['profileRoot', 'operationId', 'capsuleId', 'expectedManifestHash'])
  const profileRoot = await canonicalRestoreRoot(absolute(row.profileRoot))
  if (!isSyncedUuid(row.operationId) || !isSyncedUuid(row.capsuleId)
    || typeof row.expectedManifestHash !== 'string' || !/^[a-f0-9]{64}$/.test(row.expectedManifestHash)) return capsuleInvalid('重开locator身份/hash无效')
  const recoveryDirectory = join(profileRoot, 'backups', 'database-restore', row.operationId)
  const capsuleDirectory = join(recoveryDirectory, 'knowledge-capsules', row.capsuleId), originalDirectory = join(capsuleDirectory, 'original')
  await directory(recoveryDirectory, profileRoot)
  await assertCapsuleDirectory(capsuleDirectory, profileRoot)
  const inventory = await rawInventory(originalDirectory, profileRoot)
  const location = { profileRoot, capsuleDirectory, originalInventory: inventory }
  const seal = await readSeal(location, row.expectedManifestHash)
  await assertInventory(originalDirectory, inventory, profileRoot)
  const readsDirectory = join(recoveryDirectory, 'knowledge-capsule-reads')
  await restoreDirectory(readsDirectory, profileRoot)
  const scratchDirectory = join(readsDirectory, randomUUID())
  await copyRestoreInventory(originalDirectory, scratchDirectory, inventory as RestoreRawFile[], profileRoot)
  await assertInventory(scratchDirectory, inventory, profileRoot)
  await assertInventory(originalDirectory, inventory, profileRoot)
  const observed = await readSeal(location, seal.manifestHash)
  await assertCapsuleDirectory(capsuleDirectory, profileRoot)
  const info = freezeCapsuleValue({ profileRoot, recoveryDirectory, sealedDirectory: originalDirectory, capsuleDirectory,
    originalDirectory, scratchDirectory, databasePath: join(scratchDirectory, 'knowbook.db'), originalInventory: inventory, label: 'reopened durable SQL capsule' })
  const handle: OwnedRawCapsuleOriginal = Object.freeze({ kind: 'owned-raw-capsule-original' })
  originals.set(handle, { info, busy: false, failed: false, origin: 'sealed', sealed: observed })
  return handle
}
export function readOwnedRawCapsuleOriginal(handle: OwnedRawCapsuleOriginal): OwnedRawCapsuleOriginalInfo { return saved(handle).info }
/** Fixed persisted capsule namespace; old scratch contents are never input. */
async function assertCapsuleDirectory(capsuleDirectory: string, profileRoot: string): Promise<void> {
  await directory(capsuleDirectory, profileRoot)
  const entries = await readdir(capsuleDirectory)
  if (entries.some(name => !['original', 'scratch', 'index', 'manifest.json'].includes(name))) return capsuleInvalid('capsule目录含未知原件或pending文件')
}
/** Does not compare scratch sidecars after SQLite opened them; SQLite is allowed
 * to operate only on that independent scratch. Sealed original bytes stay exact. */
export async function assertOwnedRawCapsuleOriginal(handle: OwnedRawCapsuleOriginal): Promise<void> {
  const { info } = saved(handle)
  await assertCapsuleDirectory(info.capsuleDirectory, info.profileRoot)
  await directory(info.scratchDirectory, info.profileRoot)
  if (!samePath(info.sealedDirectory, info.originalDirectory)) {
    const results = await Promise.allSettled([
      assertInventory(info.sealedDirectory, info.originalInventory, info.profileRoot),
      assertInventory(info.originalDirectory, info.originalInventory, info.profileRoot)
    ])
    for (const result of results) if (result.status === 'rejected') throw result.reason
  } else await assertInventory(info.originalDirectory, info.originalInventory, info.profileRoot)
}
/** Call immediately before opening SQLite. The facts must start in an exact
 * independent copy, not a caller-replaced working database. */
export async function assertOwnedRawCapsuleScratchReady(handle: OwnedRawCapsuleOriginal): Promise<void> {
  const { info } = saved(handle)
  await assertOwnedRawCapsuleOriginal(handle)
  await assertInventory(info.scratchDirectory, info.originalInventory, info.profileRoot)
}
async function assertScratchContent(info: OwnedRawCapsuleOriginalInfo): Promise<void> {
  const actual = await rawInventory(info.scratchDirectory, info.profileRoot)
  // query_only/readonly SQLite may create or update SHM, whose bytes are not
  // semantic input. It may also create an empty WAL for a checkpointed WAL-mode
  // database. An empty/absent WAL carries no SQL frames; never admit new frames
  // or any change to a nonempty original WAL or the original database bytes.
  const originalWal = info.originalInventory[1]
  if (capsuleJson(actual[0]) !== capsuleJson(info.originalInventory[0])
    || (originalWal.bytes > 0 ? capsuleJson(actual[1]) !== capsuleJson(originalWal) : actual[1].bytes !== 0))
    return capsuleInvalid('scratch DB/WAL已不属于封存原件')
}

async function writeExclusive(path: string, text: string, root: string): Promise<void> {
  await assertRestorePath(path, root)
  const fd = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
  try {
    const before = await fd.stat()
    if (!standalone(before)) return capsuleInvalid('持久artifact创建为外部别名')
    await fd.writeFile(text, 'utf8'); await fd.sync()
    const after = await fd.stat(), current = await lstat(path)
    if (!standalone(after) || !standalone(current) || !samePathFile(current, after)
      || after.size !== Buffer.byteLength(text)) return capsuleInvalid('持久artifact写入期间变化')
  } finally { await fd.close() }
}
async function readText(path: string, root: string, maxBytes: number): Promise<{ text: string; bytes: number; sha256: string }> {
  await assertRestorePath(path, root)
  const prior = await lstat(path)
  if (!standalone(prior) || prior.size > maxBytes) return capsuleInvalid('artifact不是独立有限普通文件')
  const fd = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = await fd.stat()
    if (!standalone(before) || !samePathFile(prior, before)) return capsuleInvalid('artifact打开身份变化')
    const buffer = Buffer.alloc(before.size + 1)
    let offset = 0
    while (offset < buffer.length) { const read = await fd.read(buffer, offset, buffer.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead }
    const after = await fd.stat(), current = await lstat(path)
    if (offset !== before.size || !sameFile(before, after) || !samePathFile(current, after) || !standalone(current)) return capsuleInvalid('artifact读取期间变化')
    const bytes = buffer.subarray(0, offset)
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    if (!Buffer.from(text, 'utf8').equals(bytes)) return capsuleInvalid('artifact TEXT无法无损读取')
    return { text, bytes: offset, sha256: capsuleBytesHash(bytes) }
  } finally { await fd.close() }
}
async function readSeal(info: Pick<OwnedRawCapsuleOriginalInfo, 'profileRoot' | 'capsuleDirectory' | 'originalInventory'>, expectedManifestHash: string): Promise<DurableSqlCapsuleSeal> {
  const manifestPath = join(info.capsuleDirectory, 'manifest.json'), shardsDirectory = join(info.capsuleDirectory, 'index')
  const raw = await readText(manifestPath, info.profileRoot, CAPSULE_MAX_MANIFEST_BYTES), manifest = parseDurableSqlCapsuleManifest(raw.text)
  const manifestHash = durableSqlCapsuleManifestHash(manifest)
  if (manifestHash !== expectedManifestHash || capsuleJson(manifest.files) !== capsuleJson(info.originalInventory)) return capsuleInvalid('读回manifest不是准确原件artifact')
  await directory(shardsDirectory, info.profileRoot)
  const expectedNames = manifest.evidenceIndex.shards.map(row => row.name).sort(), entries = await readdir(shardsDirectory)
  if (capsuleJson(entries.sort()) !== capsuleJson(expectedNames)) return capsuleInvalid('事实分片文件不是准确闭集')
  const facts: RawHistoricalEvidenceFact[] = []
  let previous: string | null = null
  for (const shard of manifest.evidenceIndex.shards) {
    const original = await readText(join(shardsDirectory, shard.name), info.profileRoot, CAPSULE_MAX_SHARD_BYTES)
    if (original.bytes !== shard.bytes || original.sha256 !== shard.sha256) return capsuleInvalid('事实分片原bytes/hash变化')
    const value = parseDurableSqlCapsuleShard(original.text, shard.index)
    if (value.facts.length !== shard.entries) return capsuleInvalid('事实分片数量不符')
    for (const item of value.facts) {
      const key = durableSqlCapsuleFactKey(item)
      if (previous !== null && previous >= key) return capsuleInvalid('跨分片事实顺序或身份重复')
      previous = key; facts.push(item)
    }
  }
  if (facts.length !== manifest.evidenceIndex.entries) return capsuleInvalid('读回事实不完整')
  return freezeCapsuleValue({ manifest, manifestHash, manifestPath, shardsDirectory, facts })
}
/** Persistence/readback only, never certification. A failed seal invalidates this
 * process-local handle; partial artifacts remain evidence, never reusable proof. */
export async function sealDurableSqlCapsule(handle: OwnedRawCapsuleOriginal, draft: DurableSqlCapsuleDraft): Promise<DurableSqlCapsuleSeal> {
  const state = saved(handle)
  if (state.busy || state.sealed) return capsuleInvalid('capsule正在封存或已封存，不能用另一份DTO覆盖')
  state.busy = true
  try {
    await assertOwnedRawCapsuleOriginal(handle)
    await assertScratchContent(state.info)
    const artifacts = buildDurableSqlCapsuleArtifacts(draft, state.info.originalInventory), index = join(state.info.capsuleDirectory, 'index')
    await restoreDirectory(index, state.info.profileRoot, true)
    for (const shard of artifacts.shards) await writeExclusive(join(index, shard.reference.name), shard.text, state.info.profileRoot)
    await syncRestoreDirectory(index)
    await writeExclusive(join(state.info.capsuleDirectory, 'manifest.json'), artifacts.manifestText, state.info.profileRoot)
    await syncRestoreDirectory(state.info.capsuleDirectory)
    const observed = await readSeal(state.info, artifacts.manifestHash)
    await assertScratchContent(state.info)
    await assertOwnedRawCapsuleOriginal(handle)
    state.sealed = observed
    return observed
  } catch (error) { state.failed = true; throw error }
  finally { state.busy = false }
}
/** The private registry chooses new seal versus persisted-seal comparison.
 * Reopened artifacts are never rewritten, even if a caller supplies a plausible
 * draft. Only the independent SQL certifier may turn this comparison into a new
 * process-local certified handle. */
export async function completeDurableSqlCapsuleSeal(handle: OwnedRawCapsuleOriginal, draft: DurableSqlCapsuleDraft): Promise<DurableSqlCapsuleSeal> {
  const state = saved(handle)
  if (state.origin === 'new') return sealDurableSqlCapsule(handle, draft)
  if (state.busy || !state.sealed) return capsuleInvalid('重开原件正在认证或缺已封存manifest')
  state.busy = true
  try {
    await assertOwnedRawCapsuleOriginal(handle)
    await assertScratchContent(state.info)
    const rebuilt = buildDurableSqlCapsuleArtifacts(draft, state.info.originalInventory)
    const observed = await readSeal(state.info, state.sealed.manifestHash)
    if (rebuilt.manifestHash !== observed.manifestHash || capsuleJson(rebuilt.manifest) !== capsuleJson(observed.manifest))
      return capsuleInvalid('独立原SQL重建不等于既有完整manifest与事实索引')
    await assertScratchContent(state.info)
    await assertOwnedRawCapsuleOriginal(handle)
    return observed
  } catch (error) { state.failed = true; throw error }
  finally { state.busy = false }
}
export async function readDurableSqlCapsuleSeal(handle: OwnedRawCapsuleOriginal): Promise<DurableSqlCapsuleSeal> {
  const state = saved(handle)
  if (state.busy || !state.sealed) return capsuleInvalid('capsule没有已完成的Main-owned封存')
  await assertOwnedRawCapsuleOriginal(handle)
  const observed = await readSeal(state.info, state.sealed.manifestHash)
  await assertOwnedRawCapsuleOriginal(handle)
  return observed
}
