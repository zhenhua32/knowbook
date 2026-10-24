import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { copyFile, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareDurableSqlCapsuleOriginal, readOwnedRawCapsuleOriginal } from '../src/main/database/restore-knowledge-capsule-files'
import { certifyDurableSqlCapsuleOriginal, readCertifiedDurableSqlCapsule } from '../src/main/database/restore-knowledge-capsule-read'
import { capsuleJson } from '../src/main/database/restore-knowledge-capsule-model'
import { restoreInventory } from '../src/main/database/restore-safety-files'
import { captureDurableSqlDag, readCertifiedDurableSqlDag, reopenCertifiedDurableSqlDag,
  type CertifiedDurableSqlDag, type ReopenCertifiedDurableSqlDagInput } from '../src/main/database/restore-knowledge-dag-read'
import { readDurableSqlDagNodeFile, writeDurableSqlDagNodeFile } from '../src/main/database/restore-knowledge-dag-files'
import { DURABLE_SQL_DAG_MAX_DEPTH, DURABLE_SQL_DAG_MAX_NODE_BYTES, DURABLE_SQL_DAG_MAX_PARENTS, durableSqlDagLocator, durableSqlDagRootHash,
  validateDurableSqlDagNode, type DurableSqlCapsuleReference, type DurableSqlDagNode, type DurableSqlDagReference } from '../src/main/database/restore-knowledge-dag-model'
import { createV3Fixture, withV3Fixture, type V3Fixture } from './helpers/synced-backup-v3-fixture'
import { withControlledRestore, restoreKnowbookDatabase, assertOriginals, originals, noProcesses, inspect } from './helpers/controlled-restore-fixture'
// This static type edge also includes the real child entry in the test compiler;
// no tsconfig change or test-only runtime import is needed.
import type { DagReopenProcessResult } from './helpers/durable-sql-dag-reopen-process'

const execute = promisify(execFile)
const worker = fileURLToPath(new URL('./helpers/durable-sql-dag-reopen-process.ts', import.meta.url))
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const ordered = (refs: readonly DurableSqlDagReference[]) => [...refs].sort((a, b) => compare(durableSqlDagLocator(a), durableSqlDagLocator(b)))

async function captureDirectory(profileRoot: string, operationId: string, sourceDirectory: string) {
  const recoveryDirectory = join(profileRoot, 'backups', 'database-restore', operationId)
  await mkdir(recoveryDirectory, { recursive: true })
  const sealedDirectory = join(recoveryDirectory, 'sealed-' + randomUUID()), capsuleId = randomUUID()
  await mkdir(sealedDirectory)
  const from = await realpath(sourceDirectory), inventory = await restoreInventory(from)
  // Source is genuinely independent and may be outside this Main profile. This
  // copies real fixed three-file originals, exactly as maintenance does.
  for (const file of inventory) if (file.present)
    await copyFile(join(from, file.name), join(sealedDirectory, file.name), constants.COPYFILE_EXCL)
  assert.deepEqual(await restoreInventory(sealedDirectory), inventory)
  assert.deepEqual(await restoreInventory(from), inventory)
  const original = await prepareDurableSqlCapsuleOriginal({ profileRoot, recoveryDirectory, sealedDirectory,
    capsuleId, label: 'real DAG original' })
  const capsule = await certifyDurableSqlCapsuleOriginal(original), seal = await readCertifiedDurableSqlCapsule(capsule)
  const info = readOwnedRawCapsuleOriginal(original)
  const ref: DurableSqlCapsuleReference = { kind: 'durable-sql-capsule-ref', version: 1, operationId, capsuleId, manifestHash: seal.manifestHash }
  return { capsule, seal, info, ref }
}
async function setupPair(f: V3Fixture) {
  const started = performance.now()
  const profileRoot = await realpath(f.userDataRoot), operationId = randomUUID()
  const foreign = createV3Fixture(join(f.root, 'independent-DAG-source'))
  try {
    const ready = performance.now() - started
    // The two databases, sealed inputs, capsule IDs and scratch directories are
    // independent. Both captures still perform every original inventory,
    // identity, fsync and SQL certification check. Settle both before closing
    // either fixture, including when one fails.
    const elapsed: number[] = []
    const captures = await Promise.allSettled([dirname(foreign.file), dirname(f.file)].map(async (directory, index) => {
      const captured = await captureDirectory(profileRoot, operationId, directory)
      elapsed[index] = performance.now() - started
      return captured
    }))
    console.error(`[dag-pair-fixture] ${JSON.stringify({ readyMs: ready, sourceMs: elapsed[0] ?? null, currentMs: elapsed[1] ?? null, settledMs: performance.now() - started })}`)
    const failures = captures.filter(result => result.status === 'rejected').map(result => result.reason)
    if (failures.length) throw new AggregateError(failures, 'Both genuine independent capsule captures must finish before cleanup')
    const [left, right] = captures
    assert.equal(left.status, 'fulfilled'); assert.equal(right.status, 'fulfilled')
    const source = left.value, current = right.value
    assert.notEqual(source.seal.manifest.workspaceScope, current.seal.manifest.workspaceScope)
    assert.notEqual(foreign.groupId, f.groupId)
    assert.ok(source.seal.facts.some(fact => fact.family === 'host-create-ack'))
    assert.ok(current.seal.facts.some(fact => fact.family === 'host-create-ack'))
    assert.notDeepEqual(source.seal.facts, current.seal.facts, 'Different source/current facts come from actual independent Main writers')
    return { profileRoot, operationId, recoveryDirectory: join(profileRoot, 'backups', 'database-restore', operationId), source, current }
  } finally { foreign.close() }
}
type Pair = Awaited<ReturnType<typeof setupPair>>
const node = (f: Pair, parents: readonly DurableSqlDagReference[] = []): DurableSqlDagNode => validateDurableSqlDagNode({
  kind: 'restore-durable-sql-dag-node', version: 1, readerVersion: 'knowbook-durable-sql-dag-v1', material: 'durable-sql-only',
  source: f.source.ref, current: f.current.ref, parents: ordered(parents) })
async function capture(f: Pair, parents: readonly CertifiedDurableSqlDag[] = []) {
  return captureDurableSqlDag({ profileRoot: f.profileRoot, operationId: f.operationId, dagId: randomUUID(),
    source: f.source.capsule, current: f.current.capsule, parents })
}
const input = (f: Pair, ref: DurableSqlDagReference): ReopenCertifiedDurableSqlDagInput => ({ profileRoot: f.profileRoot,
  operationId: ref.operationId, dagId: ref.dagId, expectedRootHash: ref.rootHash })
async function child(f: Pair, ref: DurableSqlDagReference): Promise<DagReopenProcessResult> {
  const result = await execute(process.execPath, ['--import', 'tsx', worker, JSON.stringify(input(f, ref))], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, maxBuffer: 1024 * 1024 })
  return JSON.parse(result.stdout) as DagReopenProcessResult
}
async function immutableBytes(f: Pair) {
  const output: Array<{ path: string; bytes: Buffer }> = []
  async function walk(directory: string) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => compare(a.name, b.name))) {
      const path = join(directory, entry.name)
      if (entry.name === 'scratch') continue
      assert.equal(entry.isSymbolicLink(), false)
      if (entry.isDirectory()) await walk(path)
      else { assert.ok(entry.isFile()); output.push({ path: relative(f.recoveryDirectory, path), bytes: await readFile(path) }) }
    }
  }
  await walk(f.source.info.capsuleDirectory); await walk(f.current.info.capsuleDirectory)
  await walk(join(f.recoveryDirectory, 'knowledge-dags'))
  return output
}

test('a prepared DAG SQL-recertifies genuinely different source/current scopes and Main ACK facts without claiming K or installation', () => withV3Fixture(async f => {
  const pair = await setupPair(f), handle = await capture(pair), diagnostic = await readCertifiedDurableSqlDag(handle)
  const before = await immutableBytes(pair)
  assert.equal(diagnostic.nodes, 1); assert.equal(diagnostic.capsules, 2); assert.equal(diagnostic.height, 1)
  assert.equal(diagnostic.semanticKnowledgeExtracted, false); assert.equal(diagnostic.acceptedSqlCoverage, false)
  assert.equal(diagnostic.certifiedForInstallation, false)
  const file = await readDurableSqlDagNodeFile(pair.profileRoot, diagnostic.root)
  assert.deepEqual(file.node.source, pair.source.ref); assert.deepEqual(file.node.current, pair.current.ref)
  const reopened = await reopenCertifiedDurableSqlDag(input(pair, diagnostic.root))
  assert.deepEqual(await readCertifiedDurableSqlDag(reopened), diagnostic)
  assert.deepEqual(await immutableBytes(pair), before)
}))

test('a three-level prepared diamond preserves both branches and shares the exact ancestor and original vertices', () => withV3Fixture(async f => {
  const pair = await setupPair(f), ancestor = await capture(pair)
  await assert.rejects(capture(pair, [ancestor, ancestor]), /parent引用未按准确locator排序或重复矛盾/)
  assert.equal((await readdir(join(pair.recoveryDirectory, 'knowledge-dags'))).length, 1, 'A duplicate real parent handle did not mint another persistent node')
  const left = await capture(pair, [ancestor]), right = await capture(pair, [ancestor])
  const reads = join(pair.recoveryDirectory, 'knowledge-capsule-reads')
  const before = (await readdir(pair.recoveryDirectory)).includes('knowledge-capsule-reads') ? (await readdir(reads)).length : 0
  const diagnostic = await readCertifiedDurableSqlDag(await capture(pair, [left, right]))
  const afterCapture = (await readdir(pair.recoveryDirectory)).includes('knowledge-capsule-reads') ? (await readdir(reads)).length : 0
  assert.equal(diagnostic.nodes, 4, 'Two equal-byte branch nodes retain their different genuine locators')
  assert.equal(diagnostic.capsules, 2, 'The exact two shared original locators retain both genuine SQL certificates')
  assert.equal(afterCapture - before, 0, 'The producer reuses private SQL certificates and creates no redundant SQL scratch')
  const reopened = await readCertifiedDurableSqlDag(await reopenCertifiedDurableSqlDag(input(pair, diagnostic.root)))
  assert.deepEqual(reopened, diagnostic)
  assert.equal((await readdir(reads)).length - afterCapture, 2, 'Actual reopen creates exactly one independent SQL recertification scratch per unique original')
  assert.equal(diagnostic.height, 3)
  assert.equal(diagnostic.acceptedSqlCoverage, false, 'Prepared evidence ancestry does not claim three accepted restores')
}))

test('fabricated DAG or capsule handles and a wrong trusted root hash cannot produce a certified graph', () => withV3Fixture(async f => {
  const pair = await setupPair(f), handle = await capture(pair), diagnostic = await readCertifiedDurableSqlDag(handle)
  const before = await immutableBytes(pair)
  const fakeDag: CertifiedDurableSqlDag = Object.freeze({ kind: 'certified-durable-sql-dag' })
  const fakeCapsule: typeof pair.source.capsule = Object.freeze({ kind: 'certified-durable-sql-capsule' })
  await assert.rejects(readCertifiedDurableSqlDag(fakeDag), /句柄/)
  await assert.rejects(captureDurableSqlDag({ profileRoot: pair.profileRoot, operationId: pair.operationId, dagId: randomUUID(),
    source: fakeCapsule, current: pair.current.capsule, parents: [] }), /句柄/)
  await assert.rejects(capture(pair, [fakeDag]), /句柄/)
  const wrong = { ...diagnostic.root, rootHash: (diagnostic.root.rootHash[0] === '0' ? '1' : '0') + diagnostic.root.rootHash.slice(1) }
  await assert.rejects(reopenCertifiedDurableSqlDag(input(pair, wrong)), /根hash/)
  assert.equal((await readdir(join(pair.recoveryDirectory, 'knowledge-dags'))).length, 1, 'No fabricated handle minted another persistent node')
  assert.deepEqual(await readCertifiedDurableSqlDag(handle), diagnostic)
  assert.deepEqual(await immutableBytes(pair), before)
}))

test('equal capsule manifest hashes at different real locators keep both original supports in the DAG', () => withV3Fixture(async f => {
  const pair = await setupPair(f), duplicate = await captureDirectory(pair.profileRoot, pair.operationId, pair.source.info.originalDirectory)
  assert.equal(duplicate.seal.manifestHash, pair.source.seal.manifestHash)
  assert.notEqual(duplicate.ref.capsuleId, pair.source.ref.capsuleId)
  const first = await capture(pair)
  const second = await captureDurableSqlDag({ profileRoot: pair.profileRoot, operationId: pair.operationId, dagId: randomUUID(),
    source: duplicate.capsule, current: pair.current.capsule, parents: [first] })
  assert.equal((await readCertifiedDurableSqlDag(second)).capsules, 3, 'Distinct locators are not discarded merely because their manifest hash is equal')
  const changed = join(duplicate.info.originalDirectory, 'knowbook.db')
  await writeFile(changed, Buffer.concat([await readFile(changed), Buffer.from('tamper only the second equal-hash copy')]))
  await assert.rejects(readCertifiedDurableSqlDag(second), /原件|bytes|清单/)
  await assert.rejects(capture(pair, [second]), /原件|bytes|清单/, 'Producer reuse must recheck every original in the private parent closure')
}))

test('a new process reopens the full DAG after all old SQLite scratch and sealed-input copies are removed', () => withV3Fixture(async f => {
  const pair = await setupPair(f), diagnostic = await readCertifiedDurableSqlDag(await capture(pair))
  const initialReopen = await readCertifiedDurableSqlDag(await reopenCertifiedDurableSqlDag(input(pair, diagnostic.root)))
  assert.deepEqual(initialReopen, diagnostic)
  assert.equal((await readdir(join(pair.recoveryDirectory, 'knowledge-capsule-reads'))).length, 2,
    'A genuine parent-process reopen first creates the old disposable SQL scratch directories')
  for (const saved of [pair.source, pair.current]) {
    assert.equal(saved.info.scratchDirectory, join(saved.info.capsuleDirectory, 'scratch'))
    assert.equal(await realpath(saved.info.scratchDirectory), saved.info.scratchDirectory)
    await rm(saved.info.scratchDirectory, { recursive: true })
    assert.equal(dirname(saved.info.sealedDirectory), pair.recoveryDirectory)
    await rm(saved.info.sealedDirectory, { recursive: true })
  }
  const reads = join(pair.recoveryDirectory, 'knowledge-capsule-reads')
  assert.equal(await realpath(reads), reads)
  assert.equal(dirname(resolve(reads)), resolve(pair.recoveryDirectory))
  await rm(reads, { recursive: true })
  const before = await immutableBytes(pair), reopened = await child(pair, diagnostic.root)
  assert.notEqual(reopened.pid, process.pid)
  assert.deepEqual(reopened.diagnostic, diagnostic)
  assert.equal((await readdir(reads)).length, 2, 'The child created one fresh SQL scratch per genuine unique original')
  assert.deepEqual(await immutableBytes(pair), before, 'Only new disposable work directories were created; immutable originals/roots/index remain exact')
}))

for (const change of ['root-bytes', 'extra-node-file', 'missing-original-db', 'index-bytes'] as const)
  test(`DAG recertification refuses ${change} without repairing the immutable evidence`, () => withV3Fixture(async f => {
    const pair = await setupPair(f), handle = await capture(pair), diagnostic = await readCertifiedDurableSqlDag(handle)
    const root = await readDurableSqlDagNodeFile(pair.profileRoot, diagnostic.root)
    if (change === 'root-bytes') await writeFile(root.path, capsuleJson(root.node) + ' '.repeat(DURABLE_SQL_DAG_MAX_NODE_BYTES + 1))
    else if (change === 'extra-node-file') await writeFile(join(dirname(root.path), 'pending.json'), '{}', { flag: 'wx' })
    else if (change === 'missing-original-db') await rm(join(pair.source.info.originalDirectory, 'knowbook.db'))
    else {
      const file = join(pair.source.seal.shardsDirectory, pair.source.seal.manifest.evidenceIndex.shards[0].name)
      await writeFile(file, Buffer.concat([await readFile(file), Buffer.from('tampered index')]))
    }
    const before = await immutableBytes(pair)
    await assert.rejects(capture(pair, [handle]), /DAG|原件|manifest|分片|清单|缺失|bytes/, 'An earlier private certificate cannot hide changed original evidence')
    await assert.rejects(reopenCertifiedDurableSqlDag(input(pair, diagnostic.root)), /DAG|原件|manifest|分片|清单|缺失|bytes/)
    await assert.rejects(readCertifiedDurableSqlDag({ kind: 'certified-durable-sql-dag' }), /句柄/)
    assert.deepEqual(await immutableBytes(pair), before)
  }))

test('one physical DAG locator with conflicting expected hashes is refused across independently encoded branches', () => withV3Fixture(async f => {
  const pair = await setupPair(f), ancestor = (await readCertifiedDurableSqlDag(await capture(pair))).root
  const wrong = { ...ancestor, rootHash: (ancestor.rootHash[0] === '0' ? '1' : '0') + ancestor.rootHash.slice(1) }
  const [leftId, rightId] = [randomUUID(), randomUUID()].sort(compare)
  const left = await writeDurableSqlDagNodeFile(pair.profileRoot, pair.operationId, leftId, node(pair, [ancestor]))
  const right = await writeDurableSqlDagNodeFile(pair.profileRoot, pair.operationId, rightId, node(pair, [wrong]))
  const head = await writeDurableSqlDagNodeFile(pair.profileRoot, pair.operationId, randomUUID(), node(pair, [left.ref, right.ref]))
  // File/model output is deliberately untrusted. The real graph reader must
  // discover the mismatch; no fake loader/certified node is injected.
  await assert.rejects(reopenCertifiedDurableSqlDag(input(pair, head.ref)), /同一DAG locator出现矛盾root hash/)
  const [goodCapsuleBranch, badCapsuleBranch] = [randomUUID(), randomUUID()].sort(compare)
  const badSource = { ...pair.source.ref,
    manifestHash: (pair.source.ref.manifestHash[0] === '0' ? '1' : '0') + pair.source.ref.manifestHash.slice(1) }
  const good = await writeDurableSqlDagNodeFile(pair.profileRoot, pair.operationId, goodCapsuleBranch, node(pair))
  const bad = await writeDurableSqlDagNodeFile(pair.profileRoot, pair.operationId, badCapsuleBranch,
    validateDurableSqlDagNode({ ...node(pair), source: badSource }))
  const capsuleConflict = await writeDurableSqlDagNodeFile(pair.profileRoot, pair.operationId, randomUUID(), node(pair, [good.ref, bad.ref]))
  await assert.rejects(reopenCertifiedDurableSqlDag(input(pair, capsuleConflict.ref)), /同一原capsule locator出现矛盾manifest hash/)
  assert.equal((await readCertifiedDurableSqlCapsule(pair.source.capsule)).manifestHash, pair.source.ref.manifestHash)
  assert.equal((await readCertifiedDurableSqlCapsule(pair.current.capsule)).manifestHash, pair.current.ref.manifestHash)
}))

test('a real on-disk DAG chain beyond the full depth budget is refused without truncating ancestors', () => withV3Fixture(async f => {
  const started = performance.now()
  const mark = (phase: string) => console.error(`[dag-depth-fixture] ${JSON.stringify({ phase, elapsedMs: performance.now() - started })}`)
  const pair = await setupPair(f)
  mark('pair-ready')
  const first = await writeDurableSqlDagNodeFile(pair.profileRoot, pair.operationId, randomUUID(), node(pair))
  let head = first.ref
  const pending: Array<{ dagId: string; value: DurableSqlDagNode; ref: DurableSqlDagReference }> = []
  for (let depth = 1; depth <= DURABLE_SQL_DAG_MAX_DEPTH; depth++) {
    const dagId = randomUUID(), value = node(pair, [head])
    const ref: DurableSqlDagReference = { kind: 'durable-sql-dag-ref', version: 1,
      operationId: pair.operationId, dagId, rootHash: durableSqlDagRootHash(value) }
    pending.push({ dagId, value, ref }); head = ref
  }
  // Raw refs are untrusted model data. Distinct node writes do not read their
  // parents, so the full chain can be planned before bounded independent I/O.
  // Every original still uses the exact writer's identity/fsync/readback checks.
  for (let offset = 0; offset < pending.length; offset += 4) {
    const batch = pending.slice(offset, offset + 4)
    const written = await Promise.allSettled(batch.map(entry =>
      writeDurableSqlDagNodeFile(pair.profileRoot, pair.operationId, entry.dagId, entry.value)))
    const failures = written.filter(result => result.status === 'rejected').map(result => result.reason)
    if (failures.length) throw new AggregateError(failures, 'All independent DAG node writes must finish before fixture cleanup')
    for (let index = 0; index < written.length; index++) {
      const result = written[index]
      assert.equal(result.status, 'fulfilled')
      assert.deepEqual(result.value.ref, batch[index].ref, 'Each planned reference is checked against its actual durable original')
    }
  }
  assert.equal(pending.length + 1, DURABLE_SQL_DAG_MAX_DEPTH + 1)
  mark('all-original-nodes-written')
  const before = await immutableBytes(pair)
  mark('original-bytes-recorded')
  await assert.rejects(reopenCertifiedDurableSqlDag(input(pair, head)), /节点\/深度超预算|最长DAG路径超预算/)
  mark('depth-refusal-verified')
  assert.deepEqual(await immutableBytes(pair), before)
  mark('all-original-bytes-unchanged')
}))

test('the DAG codec rejects oversized parent sets, getter facts, extra own hash and a single capsule reused as both originals', () => {
  const source: DurableSqlCapsuleReference = { kind: 'durable-sql-capsule-ref', version: 1,
    operationId: randomUUID(), capsuleId: randomUUID(), manifestHash: '0'.repeat(64) }
  const current = { ...source, capsuleId: randomUUID() }
  const base = validateDurableSqlDagNode({ kind: 'restore-durable-sql-dag-node', version: 1,
    readerVersion: 'knowbook-durable-sql-dag-v1', material: 'durable-sql-only', source, current, parents: [] })
  const parents = ordered(Array.from({ length: DURABLE_SQL_DAG_MAX_PARENTS + 1 }, (): DurableSqlDagReference => ({
    kind: 'durable-sql-dag-ref', version: 1, operationId: randomUUID(), dagId: randomUUID(), rootHash: '1'.repeat(64) })))
  assert.throws(() => validateDurableSqlDagNode({ ...base, parents }), /集合超预算/)
  assert.throws(() => validateDurableSqlDagNode({ ...base, version: 2 }), /未知/)
  assert.throws(() => validateDurableSqlDagNode({ ...base, readerVersion: 'caller-raw-mode' }), /未知/)
  assert.throws(() => validateDurableSqlDagNode({ ...base, rootHash: durableSqlDagRootHash(base) }), /闭集/)
  assert.throws(() => validateDurableSqlDagNode({ ...base, current: source }), /独立原件/)
  let getterReads = 0
  const accessor = { ...base }
  Object.defineProperty(accessor, 'source', { enumerable: true, get() { getterReads++; return source } })
  assert.throws(() => validateDurableSqlDagNode(accessor), /访问器/)
  assert.equal(getterReads, 0)
})

test('the real ordinary maintenance path writes only prepared DAG diagnostics and preserves receipt1 intent2 and both original sides', () => withControlledRestore(async f => {
  const before = f.sealCurrent(), result = await restoreKnowbookDatabase({ userDataRoot: f.profile, backupPath: f.backup, stopProcesses: noProcesses })
  const preflight = JSON.parse(await readFile(join(result.recoveryDirectory, 'knowledge-dag-preflight.json'), 'utf8'))
  assert.equal(preflight.status, 'prepared-originals-only')
  assert.equal(preflight.acceptedSourceKnowledge, false); assert.equal(preflight.acceptedSqlCoverage, false)
  assert.equal(preflight.certifiedForInstallation, false); assert.equal(preflight.dag.certifiedForInstallation, false)
  assert.equal(preflight.dag.nodes, 1); assert.equal(preflight.dag.capsules, 2)
  const intent = JSON.parse(await readFile(join(result.recoveryDirectory, 'intent.json'), 'utf8'))
  assert.equal(intent.version, 2); assert.equal(intent.receipt.version, 1)
  assert.equal('knowledgeRoot' in intent.receipt, false, 'Prepared evidence is not sneaked into the old accepted receipt codec')
  assert.equal(inspect(f.database, db => (db.prepare('SELECT title FROM documents WHERE id=?').get(f.id) as { title: string }).title), 'Ordinary source backup')
  assert.deepEqual(await readFile(f.backup), f.sourceBytes)
  assertOriginals(join(result.recoveryDirectory, 'original', 'knowbook.db'), before)
}))

test('the real maintenance knowledge gate still refuses source before stopping current and never claims a joint DAG preflight', () => withV3Fixture(async f => {
  const backup = join(f.root, 'real-knowledge-source.db')
  await f.store.backupDatabase(backup)
  const before = originals(f.file), sourceBytes = await readFile(backup)
  let stopped = false, replaced = false
  await assert.rejects(restoreKnowbookDatabase({ userDataRoot: f.userDataRoot, backupPath: backup,
    stopProcesses: async () => { stopped = true; return [] }, beforeReplace: async () => { replaced = true } }), /同步知识|同步历史/)
  assert.equal(stopped, false); assert.equal(replaced, false)
  assertOriginals(f.file, before)
  assert.deepEqual(await readFile(backup), sourceBytes)
  const recovery = join(f.userDataRoot, 'backups', 'database-restore'), names = await readdir(recovery)
  assert.equal(names.length, 1)
  assert.equal((await readdir(join(recovery, names[0]))).includes('knowledge-dag-preflight.json'), false)
}))

test('a late prepared DAG root tamper triggers the original maintenance rollback and leaves both original sides intact', () => withControlledRestore(async f => {
  const before = f.sealCurrent()
  let changed: string | undefined
  await assert.rejects(restoreKnowbookDatabase({ userDataRoot: f.profile, backupPath: f.backup, stopProcesses: noProcesses,
    beforeReplace: async () => {
      const recovery = join(f.profile, 'backups', 'database-restore'), names = await readdir(recovery)
      assert.equal(names.length, 1)
      const preflight = JSON.parse(await readFile(join(recovery, names[0], 'knowledge-dag-preflight.json'), 'utf8'))
      const ref = preflight.dag.root as DurableSqlDagReference
      changed = join(recovery, ref.operationId, 'knowledge-dags', ref.dagId, 'root.json')
      await writeFile(changed, Buffer.concat([await readFile(changed), Buffer.from('\n')]))
    } }), /DAG|canonical/)
  assert.ok(changed)
  assertOriginals(f.database, before)
  assert.deepEqual(await readFile(f.backup), f.sourceBytes)
  assert.ok((await readFile(changed, 'utf8')).endsWith('\n'), 'The failed prepared artifact remains diagnostic evidence')
}))
