import { createHash } from 'node:crypto'
import { constants, fstatSync, lstatSync, readdirSync, realpathSync, type BigIntStats } from 'node:fs'
import { lstat, open, readdir, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { assertReopenedRestoreAssetTransferState4, assertRestoreAssetTransferState4, publishRestoreAssetTransfer4, reopenRestoreAssetTransfer4,
  rollbackRestoreAssetTransfer4 } from './restore-asset-transfer4'
import { capsuleRecord, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { RESTORE_FENCE, assertRestorePath, canonicalRestoreRoot, isSameRestoreOpenFileIdentity, readRestoreText, restoreExists, restorePaths,
  syncRestoreDirectory, syncRestoreFile, writeRestoreJson } from './restore-safety-files'
import { RESTORE_FILES, parseRestoreJson, restoreHash, restoreJson, restoreUuid, validateRestoreInventory,
  type RestoreRawFile } from './restore-safety-model'

const fail = (message: string): never => { throw new Error('联合恢复认证失败：' + message) }
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : fail('SHA 无效')
const rawHash = (value: string) => createHash('sha256').update(value).digest('hex')
const checkedRoot = (value: unknown) => typeof value === 'string' && !value.includes('\0') && isAbsolute(value) && resolve(value) === value
  ? value : fail('缺准确 profile 目录')
const equal = (left: unknown, right: unknown) => restoreJson(left) === restoreJson(right)

export function jointRestorePaths4(root: string, operationId: string) {
  const paths = restorePaths(root, operationId)
  return { ...paths, candidateOriginal: join(paths.recovery, 'joint-candidate-original'),
    candidateDisplaced: join(paths.recovery, 'joint-rejected-candidate.db') }
}
type Paths = ReturnType<typeof jointRestorePaths4>
type Identity = { dev: string; ino: string }
type Inventory = { inventory: RestoreRawFile[]; identities: Array<Identity | null> }
const prepared = new WeakSet<JointRestoreIntent4>()

function identity(value: unknown): Identity {
  const row = capsuleRecord(value, ['dev', 'ino'])
  if (typeof row.dev !== 'string' || !/^(?:0|-?[1-9][0-9]{0,19})$/.test(row.dev)
    || typeof row.ino !== 'string' || !/^[1-9][0-9]{0,19}$/.test(row.ino)
    || process.platform === 'win32' && row.dev === '0') return fail('缺真实文件卷或 inode')
  return { dev: row.dev, ino: row.ino }
}

function identities(value: unknown, inventory: readonly RestoreRawFile[]) {
  if (!Array.isArray(value) || value.length !== inventory.length) return fail('SQL 文件身份清单不完整')
  const list = value.map((item, index) => inventory[index].present ? identity(item)
    : item === null ? null : fail('缺失 SQL 文件有身份'))
  const keys = list.flatMap(item => item ? [restoreJson(item)] : [])
  if (new Set(keys).size !== keys.length) return fail('两个 SQL 文件共享实际身份')
  return list
}

interface JointRestoreRequest4 {
  backupDirectory: string
  sourceArchive: { snapshotId: string; inventoryHash: string }
  stoppedPids: number[]
}

function validateJointRestoreRequest4(value: unknown): JointRestoreRequest4 {
  const row = capsuleRecord(value, ['backupDirectory', 'sourceArchive', 'stoppedPids'])
  const sourceArchive = capsuleRecord(row.sourceArchive, ['snapshotId', 'inventoryHash'])
  if (!Array.isArray(row.stoppedPids) || row.stoppedPids.some(pid => !Number.isSafeInteger(pid) || pid <= 0)
    || new Set(row.stoppedPids).size !== row.stoppedPids.length) return fail('联合请求的停止进程清单无效')
  return { backupDirectory: checkedRoot(row.backupDirectory),
    sourceArchive: { snapshotId: restoreUuid(sourceArchive.snapshotId), inventoryHash: hash(sourceArchive.inventoryHash) },
    stoppedPids: [...row.stoppedPids] }
}

export function validateJointRestoreIntent4(value: unknown) {
  const version: unknown = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'version')?.value : undefined
  if (version !== 3 && version !== 4) return fail('未知联合 intent')
  const row = capsuleRecord(value, ['kind', 'version', 'operationId', 'profileRoot', 'currentInventory', 'currentIdentities',
    'candidateInventory', 'candidateIdentity', 'assetTransferId', 'assetManifestHash', 'parentFenceHash', 'installationProofHash',
    ...(version === 4 ? ['request'] : [])])
  if (row.kind !== 'controlled-joint-restore-intent') return fail('未知联合 intent')
  const currentInventory = validateRestoreInventory(row.currentInventory), candidateInventory = validateRestoreInventory(row.candidateInventory)
  if (!currentInventory[0].present || !candidateInventory[0].present || candidateInventory.slice(1).some(file => file.present))
    return fail('需要真实旧主库和关闭的单文件候选')
  const currentIdentities = identities(row.currentIdentities, currentInventory), candidateIdentity = identity(row.candidateIdentity)
  if (currentIdentities.some(item => equal(item, candidateIdentity))) return fail('旧库与候选文件必须独立')
  const common = { kind: 'controlled-joint-restore-intent' as const, operationId: restoreUuid(row.operationId), profileRoot: checkedRoot(row.profileRoot),
    currentInventory, currentIdentities, candidateInventory, candidateIdentity, assetTransferId: restoreUuid(row.assetTransferId),
    assetManifestHash: hash(row.assetManifestHash), parentFenceHash: row.parentFenceHash === null ? null : hash(row.parentFenceHash),
    installationProofHash: hash(row.installationProofHash) }
  return version === 4 ? freezeCapsuleValue({ ...common, version: 4 as const, request: validateJointRestoreRequest4(row.request) })
    : freezeCapsuleValue({ ...common, version: 3 as const })
}
export type JointRestoreIntent4 = ReturnType<typeof validateJointRestoreIntent4>

export function validateJointRestoreFence4(value: unknown) {
  const row = capsuleRecord(value, ['kind', 'version', 'operationId', 'intentHash', 'parentFenceHash', 'phase'])
  if (row.kind !== 'controlled-joint-restore-fence' || row.version !== 2
    || row.phase !== 'prepared' && row.phase !== 'rolledback' && row.phase !== 'installed') return fail('未知联合 fence')
  return freezeCapsuleValue({ kind: row.kind, version: 2 as const, operationId: restoreUuid(row.operationId), intentHash: hash(row.intentHash),
    parentFenceHash: row.parentFenceHash === null ? null : hash(row.parentFenceHash), phase: row.phase })
}
export type JointRestoreFence4 = ReturnType<typeof validateJointRestoreFence4>

export function validateJointRestoreJournal4(value: unknown) {
  const row = capsuleRecord(value, ['kind', 'version', 'operationId', 'intentHash', 'phase'])
  if (row.kind !== 'controlled-joint-restore-journal' || row.version !== 3
    || row.phase !== 'moving' && row.phase !== 'rolling-back' && row.phase !== 'installed') return fail('未知联合 journal')
  return freezeCapsuleValue({ kind: row.kind, version: 3 as const, operationId: restoreUuid(row.operationId),
    intentHash: hash(row.intentHash), phase: row.phase })
}
type Journal = ReturnType<typeof validateJointRestoreJournal4>
const fenceFor = (intent: JointRestoreIntent4, phase: JointRestoreFence4['phase']) => validateJointRestoreFence4({
  kind: 'controlled-joint-restore-fence', version: 2, operationId: intent.operationId,
  intentHash: restoreHash(intent), parentFenceHash: intent.parentFenceHash, phase
})
const journalFor = (intent: JointRestoreIntent4, phase: Journal['phase']) => validateJointRestoreJournal4({
  kind: 'controlled-joint-restore-journal', version: 3, operationId: intent.operationId, intentHash: restoreHash(intent), phase
})

async function exactJson<T>(path: string, parse: (value: unknown) => T) {
  const text = await readRestoreText(path), value = parse(parseRestoreJson(text))
  if (text !== restoreJson(value)) return fail('联合恢复记录不是原规范字节')
  return { value, hash: rawHash(text) }
}

/** Can also read an archived parent fence at its fixed p.parent path. */
export async function readJointRestoreFence4(path: string) {
  const read = await exactJson(path, validateJointRestoreFence4)
  return Object.freeze({ fence: read.value, hash: read.hash })
}

export async function readJointRestoreIntent4(root: string, fence: JointRestoreFence4) {
  const p = jointRestorePaths4(root, fence.operationId), read = await exactJson(p.intent, validateJointRestoreIntent4)
  const intent = read.value
  if (intent.operationId !== fence.operationId || intent.profileRoot !== root || read.hash !== fence.intentHash
    || intent.parentFenceHash !== fence.parentFenceHash) return fail('联合 fence 与原 intent 不闭合')
  if (await parentHash(p.parent) !== intent.parentFenceHash) return fail('原父 fence 不存在或字节变化')
  return intent
}

async function parentHash(path: string) {
  return await restoreExists(path) ? rawHash(await readRestoreText(path)) : null
}

const regular = (value: BigIntStats) => value.isFile() && !value.isSymbolicLink() && value.nlink === 1n && value.ino !== 0n
function samePathFile(named: BigIntStats, fd: BigIntStats) {
  const device = named.dev === fd.dev || process.platform === 'win32' && (named.dev === 0n || BigInt.asUintN(32, named.dev) === fd.dev)
  return regular(named) && regular(fd) && device && named.ino === fd.ino && named.size === fd.size
    && named.ctimeNs === fd.ctimeNs && named.mtimeNs === fd.mtimeNs
}
function absent(name: RestoreRawFile['name']): RestoreRawFile {
  return { name, present: false, bytes: 0, sha256: null }
}
type FileState = { file: RestoreRawFile; identity: Identity | null }
type FileWitness = { assertPath: () => void; close?: () => Promise<void> }
const assertAbsent = (path: string) => {
  if (lstatSync(path, { throwIfNoEntry: false })) return fail('SQL 原件路径在最终提交前被占用')
}
async function readFile(path: string, name: RestoreRawFile['name'], root: string, expected?: RestoreRawFile,
  maxBytes = expected?.bytes ?? Number.MAX_SAFE_INTEGER, witnesses?: FileWitness[]): Promise<FileState> {
  await assertRestorePath(path, root)
  if (!await restoreExists(path)) {
    witnesses?.push({ assertPath: () => assertAbsent(path) })
    return { file: absent(name), identity: null }
  }
  const named = await lstat(path, { bigint: true })
  if (!regular(named) || named.size > BigInt(maxBytes) || expected && named.size !== BigInt(expected.bytes))
    return fail('SQL 原件不是独立有限普通文件或长度变化')
  const fd = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  let retained = false
  try {
    const before = await fd.stat({ bigint: true })
    if (!samePathFile(named, before) || process.platform === 'win32' && before.dev === 0n) return fail('SQL 原件 fd 身份变化')
    const bytes = Number(before.size), buffer = Buffer.alloc(64 * 1024), digest = createHash('sha256')
    for (let offset = 0; offset < bytes;) {
      const { bytesRead } = await fd.read(buffer, 0, Math.min(buffer.length, bytes - offset), offset)
      if (!bytesRead) return fail('SQL 原件提前结束')
      digest.update(buffer.subarray(0, bytesRead))
      offset += bytesRead
    }
    const probe = await fd.read(buffer, 0, 1, bytes), after = await fd.stat({ bigint: true })
    await assertRestorePath(path, root)
    const current = await lstat(path, { bigint: true }), sha256 = digest.digest('hex')
    if (probe.bytesRead || !isSameRestoreOpenFileIdentity(before, after) || !samePathFile(before, after)
      || !samePathFile(current, after) || expected && sha256 !== expected.sha256) return fail('SQL 原件字节或 fd 身份变化')
    if (witnesses) {
      witnesses.push({
        assertPath() {
          const tail = fstatSync(fd.fd, { bigint: true }), named = lstatSync(path, { bigint: true, throwIfNoEntry: false })
          if (!named || relative(realpathSync.native(path), path) !== '' || !isSameRestoreOpenFileIdentity(after, tail)
            || !samePathFile(after, tail) || !samePathFile(named, tail)) return fail('已移动 SQL 原件在最终提交前变化')
        },
        close: () => fd.close()
      })
      retained = true
    }
    return { file: { name, present: true, bytes, sha256 }, identity: identity({ dev: after.dev.toString(), ino: after.ino.toString() }) }
  } finally { if (!retained) await fd.close() }
}

async function readInventory(path: string, root: string, exact: boolean, expected?: readonly RestoreRawFile[],
  maxBytes?: readonly number[], witnesses?: FileWitness[]): Promise<Inventory> {
  await assertRestorePath(path, root)
  const directory = witnesses && lstatSync(path, { bigint: true })
  const names = (await readdir(path)).sort()
  if (names.includes('knowbook.db-journal') || exact && names.some(name => !(RESTORE_FILES as readonly string[]).includes(name)))
    return fail('SQL 目录含未声明原件或 rollback journal')
  const members = []
  for (const [index, name] of RESTORE_FILES.entries()) {
    members.push(await readFile(join(path, name), name, root, expected?.[index], maxBytes?.[index], witnesses))
  }
  await assertRestorePath(path, root)
  if (!equal((await readdir(path)).sort(), names)) return fail('SQL 文件目录在读取中变化')
  if (directory && witnesses) witnesses.push({
    assertPath() {
      const current = lstatSync(path, { bigint: true, throwIfNoEntry: false })
      if (!current?.isDirectory() || relative(realpathSync.native(path), path) !== ''
        || current.dev !== directory.dev || current.ino !== directory.ino || !equal(readdirSync(path).sort(), names)) {
        return fail('已移动 SQL 目录在最终提交前变化')
      }
    }
  })
  const inventory = members.map(item => item.file)
  return { inventory, identities: identities(members.map(item => item.identity), inventory) }
}

/** Call only after the common maintenance owner has stopped live writers. */
export async function readJointRestoreCurrent4(profileRoot: string) {
  const root = await canonicalRestoreRoot(checkedRoot(profileRoot))
  return freezeCapsuleValue(await readInventory(join(root, 'storage'), root, false))
}

function matches(actual: FileState, expected: RestoreRawFile, pin: Identity | null) {
  return equal(actual.file, expected) && equal(actual.identity, pin)
}
function assertMatches(actual: FileState, expected: RestoreRawFile, pin: Identity | null) {
  if (!matches(actual, expected, pin)) return fail('SQL 文件与已核验原字节或 fd 身份不同')
}

async function assertOriginals(intent: JointRestoreIntent4, p: Paths) {
  const old = await readInventory(p.safety, p.root, true, intent.currentInventory)
  const candidate = await readInventory(p.candidateOriginal, p.root, true, intent.candidateInventory)
  if (!equal(old.inventory, intent.currentInventory) || !equal(candidate.inventory, intent.candidateInventory))
    return fail('旧库或候选的独立封存原件变化')
  const pins = [...old.identities, ...candidate.identities, ...intent.currentIdentities, intent.candidateIdentity].filter(Boolean)
  if (new Set(pins.map(pin => restoreJson(pin))).size !== pins.length) return fail('封存文件与可移动 SQL 文件不是独立原件')
}

async function assertClosedStage(p: Paths) {
  for (const suffix of ['-wal', '-shm', '-journal']) if (await restoreExists(p.stage + suffix)) return fail('候选含活动或额外 SQL sidecar')
}

async function assertPristine(intent: JointRestoreIntent4, p: Paths) {
  await assertOriginals(intent, p)
  const live = await readInventory(p.storage, p.root, false, intent.currentInventory)
  const archive = await readInventory(p.original, p.root, true)
  if (!equal(live.inventory, intent.currentInventory) || !equal(live.identities, intent.currentIdentities)
    || archive.inventory.some(file => file.present) || await restoreExists(p.candidateDisplaced)) return fail('旧 SQL 身份变化或归档已有占用')
  await assertClosedStage(p)
  assertMatches(await readFile(p.stage, 'knowbook.db', p.root, intent.candidateInventory[0]), intent.candidateInventory[0], intent.candidateIdentity)
  await assertTransferPhase(intent, 'pristine')
}

export async function prepareJointRestoreIntent4(input: { profileRoot: string; operationId: string; current: Inventory;
  parentFenceHash: string | null; installationProofHash: string; assetTransferId: string; assetManifestHash: string; request?: JointRestoreRequest4 }) {
  const root = await canonicalRestoreRoot(checkedRoot(input.profileRoot)), p = jointRestorePaths4(root, input.operationId)
  await assertClosedStage(p)
  await syncRestoreFile(p.stage)
  await syncRestoreFile(join(p.candidateOriginal, 'knowbook.db'))
  await syncRestoreDirectory(p.candidateOriginal)
  await syncRestoreDirectory(p.recovery)
  const stage = await readFile(p.stage, 'knowbook.db', root), candidateInventory = [stage.file, absent('knowbook.db-wal'), absent('knowbook.db-shm')]
  const intent = validateJointRestoreIntent4({ kind: 'controlled-joint-restore-intent', version: input.request ? 4 : 3, profileRoot: root,
    operationId: input.operationId, currentInventory: input.current.inventory, currentIdentities: input.current.identities,
    candidateInventory, candidateIdentity: stage.identity, parentFenceHash: input.parentFenceHash, installationProofHash: input.installationProofHash,
    assetTransferId: input.assetTransferId, assetManifestHash: input.assetManifestHash, ...(input.request ? { request: input.request } : {}) })
  await assertPristine(intent, p)
  prepared.add(intent)
  return intent
}

const openTransfer = async (intent: JointRestoreIntent4) =>
  (await reopenRestoreAssetTransfer4(intent.profileRoot, intent.operationId, intent.assetTransferId, intent.assetManifestHash)).transfer

function assertTransferPhase(intent: JointRestoreIntent4, expected: 'pristine' | 'published') {
  return assertReopenedRestoreAssetTransferState4(intent.profileRoot, intent.operationId, intent.assetTransferId, intent.assetManifestHash, expected)
}

async function pinParent(intent: JointRestoreIntent4, p: Paths) {
  const present = await restoreExists(p.fence)
  const parent = present ? await readRestoreText(p.fence) : null
  if ((parent === null ? null : rawHash(parent)) !== intent.parentFenceHash || await restoreExists(p.parent))
    return fail('活动父 fence 已变化或原父记录已占用')
  if (parent !== null) {
    const fd = await open(p.parent, 'wx')
    try { await fd.writeFile(parent); await fd.sync() } finally { await fd.close() }
    await syncRestoreDirectory(p.recovery)
  }
}

async function assertJournal(p: Paths, expected: Journal) {
  if (!equal((await exactJson(p.journal, validateJointRestoreJournal4)).value, expected)) return fail('联合 journal 已换代')
}

async function assertFence(p: Paths, expected: JointRestoreFence4) {
  if (!equal((await readJointRestoreFence4(p.fence)).fence, expected)) return fail('联合 fence 已换代')
}

async function moveFile(from: string, to: string, file: RestoreRawFile, pin: Identity | null, p: Paths) {
  await assertRestorePath(to, p.root)
  assertMatches(await readFile(from, file.name, p.root, file), file, pin)
  if (await restoreExists(to)) return fail('SQL 移动目标已有未知占用')
  await rename(from, to)
  await syncRestoreDirectory(dirname(from))
  await syncRestoreDirectory(dirname(to))
  assertMatches(await readFile(to, file.name, p.root, file), file, pin)
}

async function rollbackPlan(intent: JointRestoreIntent4, p: Paths) {
  await assertOriginals(intent, p)
  await assertClosedStage(p)
  const archived = await readInventory(p.original, p.root, true, intent.currentInventory)
  const limits = intent.currentInventory.map((file, index) => Math.max(file.bytes, intent.candidateInventory[index].bytes))
  const live = await readInventory(p.storage, p.root, false, undefined, limits)
  const stage = await readFile(p.stage, 'knowbook.db', p.root, intent.candidateInventory[0])
  const displaced = await readFile(p.candidateDisplaced, 'knowbook.db', p.root, intent.candidateInventory[0])
  for (const item of [stage, displaced]) if (item.file.present) assertMatches(item, intent.candidateInventory[0], intent.candidateIdentity)
  const steps = intent.currentInventory.map((old, index) => {
    const archive = { file: archived.inventory[index], identity: archived.identities[index] }
    const current = { file: live.inventory[index], identity: live.identities[index] }
    if (archive.file.present) assertMatches(archive, old, intent.currentIdentities[index])
    if (old.present && !archive.file.present) {
      assertMatches(current, old, intent.currentIdentities[index])
      return { old, restore: false, setAside: false }
    }
    if (current.file.present) {
      if (index !== 0) return fail('实时 SQL sidecar 有未知占用')
      assertMatches(current, intent.candidateInventory[0], intent.candidateIdentity)
    }
    return { old, restore: archive.file.present, setAside: current.file.present }
  })
  if (Number(stage.file.present) + Number(displaced.file.present) + Number(steps[0].setAside) !== 1)
    return fail('唯一可移动候选 SQL 文件身份丢失或重复')
  return steps
}

async function rollbackSql(intent: JointRestoreIntent4, p: Paths) {
  for (const [index, step] of (await rollbackPlan(intent, p)).entries()) {
    const live = join(p.storage, step.old.name), archive = join(p.original, step.old.name)
    if (step.setAside) await moveFile(live, p.candidateDisplaced, intent.candidateInventory[0], intent.candidateIdentity, p)
    if (step.restore) await moveFile(archive, live, step.old, intent.currentIdentities[index], p)
  }
  const final = await rollbackPlan(intent, p)
  if (final.some(step => step.restore || step.setAside)) return fail('旧 SQL 回退尚未完成')
  for (const path of [p.storage, p.original, p.recovery]) await syncRestoreDirectory(path)
}

async function assertMoved(intent: JointRestoreIntent4, p: Paths, witnesses?: FileWitness[]) {
  await assertOriginals(intent, p)
  const archive = await readInventory(p.original, p.root, true, intent.currentInventory, undefined, witnesses)
  const live = await readInventory(p.storage, p.root, false, intent.candidateInventory, undefined, witnesses)
  if (!equal(archive.inventory, intent.currentInventory) || !equal(archive.identities, intent.currentIdentities)
    || !equal(live.inventory, intent.candidateInventory) || !equal(live.identities, [intent.candidateIdentity, null, null])
    || await restoreExists(p.stage) || await restoreExists(p.candidateDisplaced)) return fail('已移动 SQL 的原件闭集或 fd 身份不同')
  await assertClosedStage(p)
  witnesses?.push({ assertPath() {
    for (const path of [p.stage, p.candidateDisplaced, p.stage + '-wal', p.stage + '-shm', p.stage + '-journal']) assertAbsent(path)
  } })
}

/** Keep the actual moved SQL descriptors through the last asset and pointer
 * reads. The synchronous witness runs immediately before a durable publish. */
async function withMovedSqlWitness<T>(intent: JointRestoreIntent4, p: Paths, run: (assertSql: () => void) => Promise<T>) {
  const witnesses: FileWitness[] = []
  try {
    await assertMoved(intent, p, witnesses)
    const assertSql = () => { for (const witness of witnesses) witness.assertPath() }
    assertSql()
    return await run(assertSql)
  } finally {
    await Promise.all(witnesses.map(witness => witness.close?.()))
  }
}

export interface JointRestoreChecks4 {
  /** Real installer checks its immutable proof, source owner and live authority. */
  assertPrepared(intent: JointRestoreIntent4): Promise<void>
  /** Independently read the accepted SQL receipt, using only detached scratch. */
  assertInstalled(intent: JointRestoreIntent4, phase: 'committing' | 'steady'): Promise<void>
}
type Status = 'installed' | 'rolled-back' | 'aborted-before-move'
const resultFor = (intent: JointRestoreIntent4, status: Status) => Object.freeze({
  kind: 'controlled-joint-restore-result', version: 1, operationId: intent.operationId,
  installationProofHash: intent.installationProofHash, status
})
type Result = ReturnType<typeof resultFor>

async function verifyResult(p: Paths, expected: Result) {
  return await exactJson(p.result, value => {
    if (!equal(value, expected)) return fail('联合恢复终态记录不同')
    return expected
  })
}

export async function assertJointRestoreInstalledResult4(intent: JointRestoreIntent4) {
  return (await verifyResult(jointRestorePaths4(intent.profileRoot, intent.operationId), resultFor(intent, 'installed'))).value
}

async function finish(intent: JointRestoreIntent4, p: Paths, fence: JointRestoreFence4, journal: Journal | null, status: Status,
  assertSql?: () => void) {
  const result = resultFor(intent, status)
  if (await restoreExists(p.result)) await verifyResult(p, result)
  await assertFence(p, fence)
  if (journal) await assertJournal(p, journal)
  else if (await restoreExists(p.journal)) return fail('联合 journal 意外出现')
  // An earlier atomic journal replace may have reported a directory flush
  // error after making the new phase visible. Persist it before finishing.
  await syncRestoreDirectory(p.root)
  if (!await restoreExists(p.result)) await writeRestoreJson(p.result, result, p.root, false, assertSql)
  const phase = status === 'installed' ? 'installed' : 'rolledback'
  if (phase !== fence.phase) await writeRestoreJson(p.fence, fenceFor(intent, phase), p.root, false, assertSql)
  if (status === 'installed') await writeRestoreJson(p.safeMarker, { id: intent.operationId, recoveryDirectory: p.recovery }, p.root, false, assertSql)
  if (journal) {
    await assertJournal(p, journal)
    assertSql?.()
    await unlink(p.journal)
  }
  await syncRestoreDirectory(p.root)
  return result
}

async function recover(root: string, checks: JointRestoreChecks4): Promise<Result> {
  const { fence } = await readJointRestoreFence4(join(root, RESTORE_FENCE))
  const p = jointRestorePaths4(root, fence.operationId), intent = await readJointRestoreIntent4(root, fence)
  const journal = await restoreExists(p.journal) ? (await exactJson(p.journal, validateJointRestoreJournal4)).value : null
  if (!journal) {
    if (fence.phase === 'prepared') {
      await assertPristine(intent, p)
      return finish(intent, p, fence, null, 'aborted-before-move')
    }
    const expected = resultFor(intent, fence.phase === 'installed' ? 'installed' : 'rolled-back')
    if (fence.phase === 'installed') {
      await verifyResult(p, expected)
      await checks.assertInstalled(intent, 'steady')
      return expected
    }
    const result = parseRestoreJson(await readRestoreText(p.result))
    const terminal = equal(result, expected) ? expected : resultFor(intent, 'aborted-before-move')
    await verifyResult(p, terminal)
    return terminal
  }
  if (journal.operationId !== intent.operationId || journal.intentHash !== fence.intentHash
    || fence.phase === 'rolledback' && journal.phase !== 'rolling-back'
    || fence.phase === 'installed' && journal.phase !== 'installed') return fail('联合 intent、fence、journal 阶段不闭合')
  if (journal.phase === 'installed') {
    await assertMoved(intent, p)
    await assertTransferPhase(intent, 'published')
    await checks.assertInstalled(intent, 'committing')
    return withMovedSqlWitness(intent, p, async assertSql => {
      await assertTransferPhase(intent, 'published')
      return finish(intent, p, fence, journal, 'installed', assertSql)
    })
  }
  if (await restoreExists(p.result)) {
    if (journal.phase !== 'rolling-back') return fail('联合 journal 尚未回退却已有终态')
    await verifyResult(p, resultFor(intent, 'rolled-back'))
  } else if (fence.phase === 'rolledback') return fail('回退 fence 缺原终态')
  await rollbackPlan(intent, p)
  const transfer = await openTransfer(intent), rolling = journalFor(intent, 'rolling-back')
  await assertFence(p, fence)
  await assertJournal(p, journal)
  if (journal.phase === 'moving') await writeRestoreJson(p.journal, rolling, root)
  await rollbackRestoreAssetTransfer4(transfer)
  await rollbackSql(intent, p)
  await assertTransferPhase(intent, 'pristine')
  return finish(intent, p, fence, rolling, 'rolled-back')
}

/** Called by the common maintenance owner after selecting the exact joint
 * version. A contradictory phase retains the originals and blocks startup. */
export async function recoverJointRestore4Owned(profileRoot: string, checks: JointRestoreChecks4) {
  return recover(await canonicalRestoreRoot(checkedRoot(profileRoot)), checks)
}

/** Install only the freshly prepared private intent. The installed journal is
 * the durable commit point. The catch path and cold startup share recovery. */
export async function applyPreparedJointRestore4(profileRoot: string, intent: JointRestoreIntent4, checks: JointRestoreChecks4) {
  const root = await canonicalRestoreRoot(checkedRoot(profileRoot))
  if (!prepared.delete(intent) || root !== intent.profileRoot) return fail('缺同次实际准备的联合 intent')
  const p = jointRestorePaths4(root, intent.operationId), fence = fenceFor(intent, 'prepared'), moving = journalFor(intent, 'moving')
  if (await restoreExists(p.journal) || await restoreExists(p.result)) return fail('存在其他活动 journal 或终态')
  await checks.assertPrepared(intent)
  await assertPristine(intent, p)
  await pinParent(intent, p)
  await writeRestoreJson(p.intent, intent, root, true)
  try {
    if (await parentHash(p.fence) !== intent.parentFenceHash) return fail('原父 fence 在准备中变化')
    await writeRestoreJson(p.fence, fence, root)
    if (await restoreExists(p.journal)) return fail('发布前已有其他活动 journal')
    await writeRestoreJson(p.journal, moving, root)
    await checks.assertPrepared(intent)
    await assertPristine(intent, p)
    await assertFence(p, fence)
    await assertJournal(p, moving)
    for (const [index, file] of intent.currentInventory.entries()) if (file.present) {
      await moveFile(join(p.storage, file.name), join(p.original, file.name), file, intent.currentIdentities[index], p)
    }
    const transfer = await openTransfer(intent)
    await publishRestoreAssetTransfer4(transfer)
    await moveFile(p.stage, p.database, intent.candidateInventory[0], intent.candidateIdentity, p)
    await assertMoved(intent, p)
    await assertRestoreAssetTransferState4(transfer, 'published')
    await checks.assertInstalled(intent, 'committing')
    return await withMovedSqlWitness(intent, p, async assertSql => {
      await assertRestoreAssetTransferState4(transfer, 'published')
      await assertFence(p, fence)
      await assertJournal(p, moving)
      const installed = journalFor(intent, 'installed')
      await writeRestoreJson(p.journal, installed, root, false, assertSql)
      return finish(intent, p, fence, installed, 'installed', assertSql)
    })
  } catch (error) {
    let terminal: Result | undefined
    try {
      const actual = await parentHash(p.fence)
      if (actual === intent.parentFenceHash) throw error
      const current = (await readJointRestoreFence4(p.fence)).fence
      if (current.operationId !== intent.operationId || current.intentHash !== restoreHash(intent)) return fail('当前 fence 不属于本次恢复')
      terminal = await recover(root, checks)
    } catch (recoveryError) {
      if (recoveryError === error) throw error
      throw new AggregateError([error, recoveryError], '联合恢复仍需从原 journal 继续')
    }
    if (terminal.status === 'installed') return terminal
    throw error
  }
}
