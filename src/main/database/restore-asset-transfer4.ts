import { createHash, randomUUID } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { link, lstat, open, readdir, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { buildSyncedPortableAssetUri, syncedPortableAssetBackupPath } from '../../shared/syncedBlockPortable'
import { capsuleRecord, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { readCapsule2AssetManifest } from './restore-knowledge-capsule2-assets-files'
import { readRootRestoreAssetAliasStageCopies5, type RootRestoreAssetAliasStage5 } from './restore-knowledge-asset-alias-stage5'
import type { PreparedRestoreHistoryScope3 } from './restore-knowledge-stage3-physical'
import { copyOriginCatalogFileWithIdentity3, syncOriginCatalogAncestors } from './restore-knowledge-origin-bundle-files'
import { assertRestorePath, canonicalRestoreRoot, restoreDirectory, restoreExists, restorePaths,
  syncRestoreDirectory, writeRestoreJson } from './restore-safety-files'
import { parseRestoreJson, restoreHash, restoreJson, restoreUuid } from './restore-safety-model'

interface FileFact { readonly hash: string; readonly bytes: number; readonly logicalName: string }
interface Identity { readonly dev: string; readonly ino: string }
type Entry = FileFact & { readonly action: 'keep' | 'link'; readonly identity: Identity }
interface Manifest {
  readonly kind: 'controlled-restore-asset-transfer'; readonly version: 4
  readonly operationId: string; readonly transferId: string; readonly entries: readonly Entry[]
}
interface Saved { root: string; directory: string; manifest: Manifest; manifestHash: string }
export interface RestoreAssetTransfer4 { readonly kind: 'main-owned-restore-asset-transfer' }
/** Main passes independently verified alias-stage files. This shape is not a
 * claim that the source is selected or sufficient to accept a restore. */
export interface RestoreAssetTransferSource4 extends FileFact { sourceRoot: string; sourcePath: string }
const owners = new WeakMap<RestoreAssetTransfer4, Saved>()
const maxFiles = 100_000, maxBytes = 50 * 1024 * 1024, maxManifestBytes = 64 * 1024 * 1024
const fail = (message: string): never => { throw new Error('恢复附件发布认证失败：' + message) }
const order = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0
const alias = (file: FileFact) => syncedPortableAssetBackupPath(buildSyncedPortableAssetUri({ hash: file.hash, name: file.logicalName }))
  .slice('__knowbook/assets/'.length)
const windowsKey = (file: FileFact) => alias(file).toLowerCase()
const key = process.platform === 'win32' ? windowsKey : alias
const collection = (root: string, operationId: string) => join(restorePaths(root, operationId).recovery, 'asset-transfer-v4')
const payload = (directory: string, index: number) => join(directory, 'payloads', index + '.bin')
const destination = (root: string, file: FileFact) => join(root, 'storage', 'assets', ...alias(file).split('/'))
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : fail('附件 SHA 无效')

function readFact(value: Record<string, unknown>): FileFact {
  const bytes = value.bytes, logicalName = value.logicalName
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > maxBytes
    || typeof logicalName !== 'string') return fail('附件大小或逻辑名无效')
  const fact = { hash: hash(value.hash), bytes, logicalName }
  alias(fact)
  return fact
}

function readIdentity(value: unknown, requireDevice: boolean): Identity {
  const row = capsuleRecord(value, ['dev', 'ino'])
  if (typeof row.dev !== 'string' || !/^-?(?:0|[1-9][0-9]{0,19})$/.test(row.dev)
    || typeof row.ino !== 'string' || !/^[1-9][0-9]{0,19}$/.test(row.ino)
    || requireDevice && row.dev === '0') return fail('附件文件身份无效')
  return { dev: row.dev, ino: row.ino }
}

function readManifest(value: unknown, archived = false): Manifest {
  const row = capsuleRecord(value, ['kind', 'version', 'operationId', 'transferId', 'entries'])
  if (row.kind !== 'controlled-restore-asset-transfer' || row.version !== 4
    || !Array.isArray(row.entries) || row.entries.length > maxFiles) return fail('未知附件转移格式或超清单预算')
  const entries = row.entries.map((value: unknown): Entry => {
    const item = capsuleRecord(value, ['hash', 'bytes', 'logicalName', 'action', 'identity'])
    if (item.action !== 'keep' && item.action !== 'link') return fail('未知附件转移操作')
    return { ...readFact(item), action: item.action, identity: readIdentity(item.identity, !archived && process.platform === 'win32') }
  })
  const sorted = (keyOf: (file: FileFact) => string) =>
    entries.every((entry, index) => index === 0 || order(keyOf(entries[index - 1]), keyOf(entry)) < 0)
  // A transported manifest can retain the producer's platform ordering.
  // Live transfers always use the local path rules and device identity.
  const validOrder = archived ? sorted(alias) || sorted(windowsKey) && entries.every(entry => entry.identity.dev !== '0') : sorted(key)
  if (!validOrder) return fail('附件目标重复或顺序无效')
  return freezeCapsuleValue({ kind: row.kind, version: 4 as const, operationId: restoreUuid(row.operationId),
    transferId: restoreUuid(row.transferId), entries })
}

function sameIdentity(a: Identity, b: Identity) { return a.dev === b.dev && a.ino === b.ino }
function identity(stat: BigIntStats): Identity { return { dev: stat.dev.toString(), ino: stat.ino.toString() } }
function sameFile(a: BigIntStats, b: BigIntStats, path = false) {
  const device = a.dev === b.dev || path && process.platform === 'win32' && (a.dev === 0n || BigInt.asUintN(32, a.dev) === b.dev)
  return device && a.isFile() && b.isFile() && a.ino !== 0n && a.ino === b.ino && a.size === b.size
    && a.nlink === b.nlink && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
}

async function readFile(path: string, root: string, file: FileFact) {
  await assertRestorePath(path, root)
  const original = await lstat(path, { bigint: true }), bytes = BigInt(file.bytes)
  if (!original.isFile() || original.size !== bytes) return fail('附件不是准确大小的普通文件')
  const fd = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = await fd.stat({ bigint: true })
    if (!sameFile(original, before, true) || process.platform === 'win32' && before.dev === 0n) return fail('附件打开身份变化')
    const buffer = Buffer.alloc(64 * 1024), digest = createHash('sha256')
    for (let offset = 0; offset < file.bytes;) {
      const { bytesRead } = await fd.read(buffer, 0, Math.min(buffer.length, file.bytes - offset), offset)
      if (!bytesRead) return fail('附件读取中途截断')
      digest.update(buffer.subarray(0, bytesRead))
      offset += bytesRead
    }
    const probe = await fd.read(buffer, 0, 1, file.bytes), after = await fd.stat({ bigint: true })
    await assertRestorePath(path, root)
    const current = await lstat(path, { bigint: true })
    if (probe.bytesRead || digest.digest('hex') !== file.hash || !sameFile(before, after) || !sameFile(current, after, true))
      return fail('附件读取期间字节或路径身份变化')
    return { identity: identity(after), links: after.nlink }
  } finally { await fd.close() }
}

async function assertNames(path: string, root: string, expected: string[]) {
  await assertRestorePath(path, root)
  if (restoreJson((await readdir(path)).sort()) !== restoreJson(expected.sort())) return fail('附件转移目录清单不符')
}

async function readState(saved: Saved) {
  const { root, directory, manifest } = saved
  await assertNames(directory, root, ['manifest.json', 'payloads'])
  await assertNames(join(directory, 'payloads'), root,
    manifest.entries.flatMap((file, index) => file.action === 'link' ? [index + '.bin'] : []))
  const actual: Array<'keep' | 'absent' | 'published'> = []
  for (const [index, file] of manifest.entries.entries()) {
    const target = destination(root, file)
    await assertRestorePath(target, root)
    const exists = await restoreExists(target)
    if (file.action === 'keep') {
      if (!exists || !sameIdentity((await readFile(target, root, file)).identity, file.identity))
        return fail('原本已存在的附件已变动')
      actual.push('keep')
      continue
    }
    const staged = await readFile(payload(directory, index), root, file)
    if (!sameIdentity(staged.identity, file.identity) || staged.links !== (exists ? 2n : 1n))
      return fail('独立转移附件身份或链接数不同')
    if (exists && !sameIdentity((await readFile(target, root, file)).identity, staged.identity))
      return fail('目标附件由其他来源占用')
    actual.push(exists ? 'published' : 'absent')
  }
  return actual
}

function mint(saved: Saved) {
  const transfer: RestoreAssetTransfer4 = Object.freeze({ kind: 'main-owned-restore-asset-transfer' })
  owners.set(transfer, saved)
  return Object.freeze({ transfer, transferId: saved.manifest.transferId, manifestHash: saved.manifestHash })
}

export async function prepareRestoreAssetTransfer4(profileRoot: string, operationId: string, files: readonly RestoreAssetTransferSource4[]) {
  const root = await canonicalRestoreRoot(profileRoot), transferId = randomUUID(), base = collection(root, operationId)
  if (!Array.isArray(files) || files.length > maxFiles) return fail('附件超清单预算')
  const entries = files.map(file => {
    const row = capsuleRecord(file, ['hash', 'bytes', 'logicalName', 'sourceRoot', 'sourcePath'])
    const { sourceRoot, sourcePath } = row
    if (typeof sourceRoot !== 'string' || typeof sourcePath !== 'string' || !isAbsolute(sourceRoot) || !isAbsolute(sourcePath)
      || resolve(sourceRoot) !== sourceRoot || resolve(sourcePath) !== sourcePath) return fail('附件原件路径无效')
    return { ...readFact(row), sourceRoot, sourcePath }
  }).sort((a, b) => order(key(a), key(b)))
  if (new Set(entries.map(key)).size !== entries.length) return fail('附件目标重复')
  await assertRestorePath(dirname(base), root)
  if (!(await lstat(dirname(base))).isDirectory()) return fail('缺实际恢复操作目录')
  await restoreDirectory(base, root)
  const directory = join(base, transferId)
  await restoreDirectory(directory, root, true)
  await restoreDirectory(join(directory, 'payloads'), root, true)
  const plan: Entry[] = []
  for (const [index, file] of entries.entries()) {
    await assertRestorePath(file.sourceRoot, root)
    await assertRestorePath(file.sourcePath, file.sourceRoot)
    const { hash, bytes, logicalName } = file, target = destination(root, file)
    await assertRestorePath(target, root)
    if (await restoreExists(target)) {
      await readFile(file.sourcePath, file.sourceRoot, file)
      const present = await readFile(target, root, file)
      plan.push({ hash, bytes, logicalName, action: 'keep', identity: present.identity })
    } else {
      const staged = await copyOriginCatalogFileWithIdentity3(file.sourcePath, file.sourceRoot, payload(directory, index), root,
        { path: 'payloads/' + index + '.bin', sha256: hash, bytes })
      plan.push({ hash, bytes, logicalName, action: 'link', identity: { dev: staged.dev.toString(), ino: staged.ino.toString() } })
    }
  }
  const manifest = readManifest({ kind: 'controlled-restore-asset-transfer', version: 4, operationId, transferId, entries: plan })
  if (Buffer.byteLength(restoreJson(manifest)) > maxManifestBytes) return fail('附件转移清单超字节预算')
  await syncRestoreDirectory(join(directory, 'payloads'))
  await writeRestoreJson(join(directory, 'manifest.json'), manifest, root, true)
  await syncOriginCatalogAncestors(base, root)
  const saved = { root, directory, manifest, manifestHash: restoreHash(manifest) }
  await readState(saved)
  return mint(saved)
}

/** The genuine staged aliases can prepare an independent transfer, but the
 * coverage and outer installation journal still control any live publication. */
export async function prepareRootRestoreAssetTransfer4(owner: RootRestoreAssetAliasStage5, scope?: PreparedRestoreHistoryScope3) {
  const before = scope ? await (await import('./restore-knowledge-stage3-physical')).readPreparedRootRestoreAliasTransferCopies3(owner, scope)
    : await readRootRestoreAssetAliasStageCopies5(owner)
  const files = before.files.map(({ path, ...file }) => {
    if (path !== alias(file)) return fail('实际别名与目标路径不符')
    return file
  })
  const { profileRoot, operationId } = before.location
  const { transferId, manifestHash } = await prepareRestoreAssetTransfer4(profileRoot, operationId, files)
  await before.assertOriginalBytes()
  return Object.freeze({ transferId, manifestHash, aliasStageId: before.stageId, aliasManifestHash: before.manifestHash,
    remaining: before.remaining, installPermit: false as const })
}

function checkedTransfer(source: string, operationId: string, transferId: string, expectedManifestHash: string, archived = false) {
  const manifest = readManifest(parseRestoreJson(source), archived), manifestHash = restoreHash(manifest)
  if (manifest.operationId !== operationId || manifest.transferId !== transferId || manifestHash !== hash(expectedManifestHash)
    || archived && source !== restoreJson(manifest))
    return fail('原附件转移清单与已记录凭据不同')
  return manifest
}

async function readSavedTransfer(profileRoot: string, operationId: string, transferId: string, expectedManifestHash: string): Promise<Saved> {
  const root = await canonicalRestoreRoot(profileRoot), directory = join(collection(root, operationId), restoreUuid(transferId))
  const source = await readCapsule2AssetManifest(join(directory, 'manifest.json'), root, maxManifestBytes)
  const manifest = checkedTransfer(source, operationId, transferId, expectedManifestHash)
  return { root, directory, manifest, manifestHash: expectedManifestHash }
}

/** These are canonical archived facts. A foreign transfer manifest cannot
 * authorize a file read, link, rollback or installation. */
export function readArchivedTransferFacts4(text: string, locator: { operationId: string; transferId: string; manifestHash: string }) {
  return checkedTransfer(text, locator.operationId, locator.transferId, locator.manifestHash, true).entries
}

export async function readPinnedTransferManifestText4(profileRoot: string, locator: { operationId: string; transferId: string; manifestHash: string }) {
  const root = await canonicalRestoreRoot(profileRoot), directory = join(collection(root, locator.operationId), restoreUuid(locator.transferId))
  const text = await readCapsule2AssetManifest(join(directory, 'manifest.json'), root, maxManifestBytes)
  checkedTransfer(text, locator.operationId, locator.transferId, locator.manifestHash, true)
  return text
}

export async function reopenRestoreAssetTransfer4(profileRoot: string, operationId: string, transferId: string, expectedManifestHash: string) {
  const saved = await readSavedTransfer(profileRoot, operationId, transferId, expectedManifestHash)
  await readState(saved)
  return mint(saved)
}

/** Only the absence of a path entry can select an earlier installed transfer.
 * An existing entry with different bytes or live identity fails closed.
 * Other previous live names may have been legitimately removed since commit. */
export async function tryReadInstalledRestoreAsset4(profileRoot: string, operationId: string, transferId: string,
  manifestHash: string, file: FileFact) {
  const { root, directory, manifest } = await readSavedTransfer(profileRoot, operationId, transferId, manifestHash)
  const index = manifest.entries.findIndex(entry => alias(entry) === alias(file))
  if (index < 0) return
  const entry = manifest.entries[index], target = destination(root, entry)
  if (entry.bytes !== file.bytes) return fail('安装附件与同路径原 transfer 长度不同')
  const actual = await readFile(target, root, entry)
  if (!sameIdentity(actual.identity, entry.identity)) return fail('安装附件已经由其他实际文件替换')
  if (entry.action === 'link') {
    const staged = await readFile(payload(directory, index), root, entry)
    if (!sameIdentity(staged.identity, entry.identity) || staged.links !== 2n || actual.links !== 2n)
      return fail('安装附件不再是原 transfer 的准确链接')
  }
  return actual.identity
}

async function authenticated(transfer: RestoreAssetTransfer4) {
  const saved = owners.get(transfer) ?? fail('缺实际 Main 附件转移 owner')
  const stored = await readCapsule2AssetManifest(join(saved.directory, 'manifest.json'), saved.root, maxManifestBytes)
  if (stored !== restoreJson(saved.manifest)) return fail('原附件转移清单已变化')
  return { saved, states: await readState(saved) }
}

/** A reopened transfer may describe a partial publication. These assertions
 * let the outer journal distinguish its own pre-move and commit phases. */
export async function assertRestoreAssetTransferState4(transfer: RestoreAssetTransfer4, expected: 'pristine' | 'published') {
  const { states } = await authenticated(transfer)
  if (states.includes(expected === 'pristine' ? 'published' : 'absent'))
    return fail('附件转移状态与联合恢复阶段不同')
}

/** Called only under the outer restore owner and its durable moving journal.
 * The transfer copy remains available until the outer journal is committed. */
export async function publishRestoreAssetTransfer4(transfer: RestoreAssetTransfer4) {
  const { saved, states } = await authenticated(transfer)
  for (const [index, file] of saved.manifest.entries.entries()) if (states[index] === 'absent') {
    const target = destination(saved.root, file), parent = dirname(target)
    await restoreDirectory(parent, saved.root)
    const source = payload(saved.directory, index), staged = await readFile(source, saved.root, file)
    if (!sameIdentity(staged.identity, file.identity) || staged.links !== 1n) return fail('附件转移原件已变动')
    await link(source, target)
    await syncOriginCatalogAncestors(parent, saved.root)
  }
  if ((await authenticated(transfer)).states.includes('absent')) return fail('附件发布未完成')
}

/** Retryable after a crash at any link. Validate the whole plan before any
 * removal and unlink only aliases to this operation's exact transfer inode. */
export async function rollbackRestoreAssetTransfer4(transfer: RestoreAssetTransfer4) {
  const { saved, states } = await authenticated(transfer)
  for (const [index, file] of saved.manifest.entries.entries()) if (states[index] === 'published') {
    const target = destination(saved.root, file)
    if (!sameIdentity((await readFile(target, saved.root, file)).identity, file.identity)) return fail('发布后附件身份不同')
    await unlink(target)
    await syncRestoreDirectory(dirname(target))
  }
  if ((await authenticated(transfer)).states.includes('published')) return fail('附件回退未完成')
}
