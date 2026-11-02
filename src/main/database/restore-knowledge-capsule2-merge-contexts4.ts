// Explicit archive4 collector. Registry-bound base capture decides settled
// originals before any spool lookup; v3 collector and codec stay unchanged.
import { readdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { capsuleBytesHash, capsuleJson, capsuleRecord, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { readOwnedRawCapsuleOriginal, assertOwnedRawCapsuleOriginal, type OwnedRawCapsuleOriginal } from './restore-knowledge-capsule-files'
import { restoreDirectory, syncRestoreDirectory } from './restore-safety-files'
import { DURABLE_SQL_DAG_MAX_ORIGINAL_BYTES } from './restore-knowledge-dag-model'
import { requiredRoot3MergeContextLocators3, createRoot3MergeContextReplay3,
  type Root3MergeContextLocator3, type Root3MergeContextBytes3 } from './restore-knowledge-assets3-context'
import { readCapsule2BaseProjection4, assertCapsule2BaseProjectionOriginal4, assertCapsule2BaseProjectionOriginalBytes4,
  type PreparedCapsule2BaseProjection4 } from './restore-knowledge-capsule2-base-projection4'
import { capsule2MergeContextNativeFilesForMain4 as io, validateCapsule2MergeContextInventory3,
  type Capsule2MergeContextInventory3, type Capsule2MergeContextCapture3 } from './restore-knowledge-capsule2-merge-contexts'

type BaseRead4 = Awaited<ReturnType<typeof readCapsule2BaseProjection4>>
type ContextFile4 = { readonly name: string; readonly sha256: string; readonly bytes: number }
type BoundContext4 = { readonly locator: Root3MergeContextLocator3; readonly files: readonly ContextFile4[] }
export interface Capsule2MergeContextInventory4 {
  readonly kind: 'capsule2-source-merge-context-originals'; readonly version: 3
  readonly sourceContentHash: string; readonly baseManifestHash: string; readonly settledEvidenceHash: string
  readonly settledBindings: readonly { readonly jobSettingKey: string; readonly sourceRowId: string; readonly originalRowHash: string
    readonly locatorHash: string; readonly contextHash: string; readonly bindingHash: string }[]
  readonly captures: readonly Capsule2MergeContextCapture3[]
  readonly files: Capsule2MergeContextInventory3['files']; readonly inventoryHash: string
  readonly certified: false; readonly semanticValidationComplete: false; readonly permit: false
}
export interface PreparedCapsule2MergeContexts4 { readonly kind: 'prepared-capsule2-merge-context-originals4' }
export interface Capsule2MergeContextVisitorForMain4 {
  begin(value: { readonly inventory: Capsule2MergeContextInventory4; readonly base: BaseRead4 }): void | Promise<void>
  context(value: { readonly locator: Root3MergeContextLocator3; readonly bytes: Root3MergeContextBytes3
    readonly replay: ReturnType<ReturnType<typeof createRoot3MergeContextReplay3>> }): void | Promise<void>
}
interface Saved4 { readonly original: OwnedRawCapsuleOriginal; readonly base: PreparedCapsule2BaseProjection4
  readonly root: string; readonly directory: string; readonly inventory: Capsule2MergeContextInventory4
  readonly created?: ReadonlyMap<string, { readonly dev: bigint; readonly ino: bigint }> }
const owners = new WeakMap<PreparedCapsule2MergeContexts4, Saved4>(), used = new WeakSet<PreparedCapsule2BaseProjection4>()
const fail = (reason: string): never => { throw new Error('capsule4 merge context originals: ' + reason + '；不授语义选择或安装权。') }
const hash = (domain: string, value: unknown) => capsuleBytesHash(domain + '\0' + capsuleJson(value))
const validHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const same = (a: unknown, b: unknown) => capsuleJson(a) === capsuleJson(b)
const body = (value: Omit<Capsule2MergeContextInventory4, 'inventoryHash'>) => ({ ...value,
  inventoryHash: hash('knowbook.capsule4.source-merge-context-inventory.v3', value) })
function legacyBody(sourceContentHash: string, captures: readonly Capsule2MergeContextCapture3[], files: Capsule2MergeContextInventory3['files']) {
  const value = { kind: 'capsule2-source-merge-context-originals' as const, version: 2 as const, sourceContentHash, captures, files,
    certified: false as const, semanticValidationComplete: false as const, permit: false as const }
  return { ...value, inventoryHash: hash('knowbook.capsule3.source-merge-context-inventory.v2', value) }
}
export function validateCapsule2MergeContextInventory4(value: unknown): Capsule2MergeContextInventory4 {
  const row = capsuleRecord(value, ['kind','version','sourceContentHash','baseManifestHash','settledEvidenceHash','settledBindings',
    'captures','files','inventoryHash','certified','semanticValidationComplete','permit'])
  if (row.kind !== 'capsule2-source-merge-context-originals' || row.version !== 3 || !validHash(row.baseManifestHash)
    || !validHash(row.settledEvidenceHash) || !Array.isArray(row.settledBindings)
    || row.certified !== false || row.semanticValidationComplete !== false || row.permit !== false) return fail('未知inventory或升级权限')
  // Reuse only the unchanged compact capture/file grammar, never its v3
  // selector semantics. Version4 partitions ALL genuine custom SQL jobs.
  const legacy = validateCapsule2MergeContextInventory3(legacyBody(row.sourceContentHash as string,
    row.captures as Capsule2MergeContextCapture3[], row.files as Capsule2MergeContextInventory3['files']))
  const settledBindings = row.settledBindings.map(value => {
    const item = capsuleRecord(value, ['jobSettingKey','sourceRowId','originalRowHash','locatorHash','contextHash','bindingHash'])
    const single = validateCapsule2MergeContextInventory3(legacyBody(legacy.sourceContentHash, [{ jobSettingKey: item.jobSettingKey as string,
      sourceRowId: item.sourceRowId as string, originalRowHash: item.originalRowHash as string, locatorHash: item.locatorHash as string,
      state: 'unavailable', reason: 'missing-original-context', missingFiles: ['spool'], fileHashes: [] }], [])).captures[0]
    if (!validHash(item.contextHash) || !validHash(item.bindingHash)) return fail('settled证据hash无效')
    return { jobSettingKey: single.jobSettingKey, sourceRowId: single.sourceRowId, originalRowHash: single.originalRowHash,
      locatorHash: single.locatorHash, contextHash: item.contextHash, bindingHash: item.bindingHash }
  })
  const captured = new Set(legacy.captures.map(value => value.jobSettingKey))
  if (settledBindings.some((value, i) => i > 0 && settledBindings[i - 1].jobSettingKey >= value.jobSettingKey || captured.has(value.jobSettingKey)))
    return fail('settled/captured分区重复或排序错误')
  const result = body({ kind: row.kind, version: 3, sourceContentHash: legacy.sourceContentHash, baseManifestHash: row.baseManifestHash,
    settledEvidenceHash: row.settledEvidenceHash, settledBindings, captures: legacy.captures, files: legacy.files,
    certified: false, semanticValidationComplete: false, permit: false })
  if (!same(result, row)) return fail('inventory原规范bytes/hash不同')
  return freezeCapsuleValue(result)
}
function selection(base: BaseRead4) {
  const all = requiredRoot3MergeContextLocators3(base.sourceContent, { includeSettled: true })
  const proven = new Map(base.settledEvidence.jobs.map(job => [job.jobSettingKey, job]))
  const settledBindings: Capsule2MergeContextInventory4['settledBindings'][number][] = [], wanted: Root3MergeContextLocator3[] = []
  for (const locator of all) {
    const evidence = proven.get(locator.jobSettingKey)
    if (!evidence) { wanted.push(locator); continue }
    if (evidence.jobHash !== locator.jobHash) return fail('settled证据不属于原SQL固定job')
    settledBindings.push({ ...io.locatorBinding(locator), contextHash: evidence.contextHash,
      bindingHash: hash('knowbook.capsule4.settled-job-binding.v1', evidence.binding) })
    proven.delete(locator.jobSettingKey)
  }
  if (proven.size) return fail('settled证据含非原SQL自定义job')
  return { wanted, settledBindings }
}
function bind(inventory: Capsule2MergeContextInventory4, base: BaseRead4) {
  const selected = selection(base), files = new Map(inventory.files.map(file => [file.sha256, file.bytes]))
  if (inventory.sourceContentHash !== base.commitment.sourceContentHash || inventory.baseManifestHash !== base.commitment.baseManifestHash
    || inventory.settledEvidenceHash !== base.settledEvidence.evidenceHash || !same(inventory.settledBindings, selected.settledBindings)
    || inventory.captures.length !== selected.wanted.length) return fail('inventory不是同次genuine base/settled分区')
  return selected.wanted.map((locator, index) => {
    const capture = inventory.captures[index], expected = io.locatorBinding(locator)
    for (const key of ['jobSettingKey','sourceRowId','originalRowHash','locatorHash'] as const) if (capture[key] !== expected[key]) return fail('compact locator不是同次原SQL')
    if (capture.state === 'unavailable') {
      if (capture.missingFiles.some(name => name !== 'spool' && name !== 'objects/' && name !== 'assets/' && !locator.requiredFiles.includes(name))) return fail('缺失文件不属于原固定集合')
      return { locator, state: 'unavailable' as const }
    }
    if (capture.fileHashes.length !== locator.requiredFiles.length) return fail('context完整文件数量不同')
    return { locator, state: 'captured' as const, files: locator.requiredFiles.map((name, i) => {
      const sha256 = capture.fileHashes[i], bytes = files.get(sha256); if (bytes === undefined) return fail('context file缺原闭集')
      return { name, sha256, bytes }
    }) }
  })
}
async function verifyBytes(saved: Saved4) {
  await assertOwnedRawCapsuleOriginal(saved.original)
  const before = await io.assertOriginCatalogDirectory(saved.directory, saved.root)
  const names = saved.inventory.files.map(file => file.sha256)
  if (!same((await readdir(saved.directory)).sort(), names)) return fail('context目录闭集变化')
  await io.assertContextFileInventory(saved)
  const after = await io.assertOriginCatalogDirectory(saved.directory, saved.root)
  if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode || before.nlink !== after.nlink
    || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || !same((await readdir(saved.directory)).sort(), names)) return fail('context目录身份在读后变化')
  await assertOwnedRawCapsuleOriginal(saved.original)
}
async function verify(saved: Saved4, visitor?: Capsule2MergeContextVisitorForMain4) {
  assertCapsule2BaseProjectionOriginal4(saved.base, saved.original)
  await verifyBytes(saved)
  const base = await readCapsule2BaseProjection4(saved.base), captures = bind(saved.inventory, base)
  await visitor?.begin({ inventory: saved.inventory, base })
  const replay = createRoot3MergeContextReplay3(base.sourceContent), jobFor = io.createJobLookup(base.sourceContent)
  for (const item of captures) if (item.state === 'captured') {
    const bytes = await io.contextBytes(saved.directory, saved.root, item, jobFor)
    await visitor?.context({ locator: item.locator, bytes, replay: replay(item.locator, bytes) })
  }
  // The just-authenticated SQL, proof and binary originals determine this
  // evidence. Close the long observer bracket by hashing ALL of those same
  // bytes again, without executing the complete planner a second time. This
  // never substitutes metadata or an earlier byte pass for the actual tail.
  await assertCapsule2BaseProjectionOriginalBytes4(saved.base)
  await verifyBytes(saved)
  return { inventory: saved.inventory, base }
}
function register(saved: Saved4) { const owner: PreparedCapsule2MergeContexts4 = Object.freeze({ kind: 'prepared-capsule2-merge-context-originals4' }); owners.set(owner, saved); return owner }
export async function prepareCapsule2MergeContextOriginals4(original: OwnedRawCapsuleOriginal, baseOwner: PreparedCapsule2BaseProjection4) {
  assertCapsule2BaseProjectionOriginal4(baseOwner, original)
  if (used.has(baseOwner)) return fail('同一base capture已开始，不覆盖重入')
  used.add(baseOwner)
  const base = await readCapsule2BaseProjection4(baseOwner), info = readOwnedRawCapsuleOriginal(original), selected = selection(base)
  const directory = join(info.recoveryDirectory, 'knowledge-complete-assets-v2', basename(info.capsuleDirectory), 'contexts')
  await restoreDirectory(dirname(directory), info.profileRoot); await restoreDirectory(directory, info.profileRoot, true)
  const known = { files: new Map<string, number>(), bytes: 0 }, created = new Map<string, { dev: bigint; ino: bigint }>(), captures: Capsule2MergeContextCapture3[] = []
  const replay = createRoot3MergeContextReplay3(base.sourceContent), jobFor = io.createJobLookup(base.sourceContent)
  for (const locator of selected.wanted) {
    const spool = join(info.profileRoot, 'storage', 'synced-exchanges-v1', locator.operationId, locator.attemptId), job = jobFor(locator)
    const before = await io.spoolPreflight(spool, info.profileRoot, job, locator)
    if (before.missingFiles.length) { captures.push({ ...io.locatorBinding(locator), state: 'unavailable', reason: 'missing-original-context', missingFiles: before.missingFiles, fileHashes: [] }); continue }
    const files: ContextFile4[] = []
    for (const name of locator.requiredFiles) files.push({ name, ...await io.copyByHash(join(spool, ...name.split('/')), info.profileRoot, directory, info.profileRoot, known, created) })
    const capture: BoundContext4 = { locator, files }, bytes = await io.contextBytes(directory, info.profileRoot, capture, jobFor)
    replay(locator, bytes)
    for (const file of files) { const again = await io.hashFile(join(spool, ...file.name.split('/')), info.profileRoot)
      if (again.sha256 !== file.sha256 || again.bytes !== file.bytes) return fail('source spool在尾复核变化') }
    await io.assertSpoolTail(spool, info.profileRoot, job, locator, before.directories)
    captures.push({ ...io.locatorBinding(locator), state: 'captured', fileHashes: files.map(file => file.sha256) })
  }
  const files = [...known.files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([sha256, bytes]) => ({ sha256, bytes }))
  if (files.reduce((sum, file) => sum + file.bytes, 0) > DURABLE_SQL_DAG_MAX_ORIGINAL_BYTES) return fail('context bytes超原DAG预算')
  const inventory = validateCapsule2MergeContextInventory4(body({ kind: 'capsule2-source-merge-context-originals', version: 3,
    sourceContentHash: base.commitment.sourceContentHash, baseManifestHash: base.commitment.baseManifestHash,
    settledEvidenceHash: base.settledEvidence.evidenceHash, settledBindings: selected.settledBindings, captures, files,
    certified: false, semanticValidationComplete: false, permit: false }))
  await syncRestoreDirectory(directory); await io.syncOriginCatalogAncestors(directory, info.profileRoot)
  const saved: Saved4 = { original, base: baseOwner, root: info.profileRoot, directory, inventory, created }
  await verify(saved); return Object.freeze({ owner: register(saved), inventory })
}
export async function reopenCapsule2MergeContextOriginals4(original: OwnedRawCapsuleOriginal, base: PreparedCapsule2BaseProjection4, expected: Capsule2MergeContextInventory4) {
  assertCapsule2BaseProjectionOriginal4(base, original)
  const info = readOwnedRawCapsuleOriginal(original), inventory = validateCapsule2MergeContextInventory4(expected)
  const saved: Saved4 = { original, base, root: info.profileRoot,
    directory: join(info.recoveryDirectory, 'knowledge-complete-assets-v2', basename(info.capsuleDirectory), 'contexts'), inventory }
  await verify(saved); return Object.freeze({ owner: register(saved), inventory })
}
export async function visitCapsule2MergeContextOriginals4(owner: PreparedCapsule2MergeContexts4, visitor: Capsule2MergeContextVisitorForMain4) {
  const saved = owners.get(owner); if (!saved) return fail('不是genuine context4 owner')
  return verify(saved, visitor)
}
export async function assertCapsule2MergeContextOriginalBytes4(owner: PreparedCapsule2MergeContexts4) {
  const saved = owners.get(owner); if (!saved) return fail('不是genuine context4 owner')
  await verifyBytes(saved)
}
