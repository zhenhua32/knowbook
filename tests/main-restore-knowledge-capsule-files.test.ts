import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { constants, copyFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { buildDurableSqlCapsuleArtifacts, CAPSULE_MAX_FACTS, CAPSULE_MAX_SHARD_BYTES,
  DURABLE_SQL_CAPSULE_FILES, durableSqlCapsuleManifestHash, parseDurableSqlCapsuleManifest, parseDurableSqlCapsuleShard,
  validateDurableSqlCapsuleManifest, type DurableSqlCapsuleDraft, type DurableSqlCapsuleFile } from '../src/main/database/restore-knowledge-capsule-model'
import { assertOwnedRawCapsuleOriginal, assertOwnedRawCapsuleScratchReady, prepareDurableSqlCapsuleOriginal,
  readDurableSqlCapsuleSeal, readOwnedRawCapsuleOriginal, sealDurableSqlCapsule,
  type OwnedRawCapsuleOriginal, type PrepareDurableSqlCapsuleOriginalInput } from '../src/main/database/restore-knowledge-capsule-files'
import type { RawHistoricalEvidenceFact, RawHistoricalEvidenceLocator } from '../src/main/database/synced-history-evidence-model'

const hash = (character: string) => character.repeat(64)
function fact(key: string, supports: readonly RawHistoricalEvidenceLocator[] = []): RawHistoricalEvidenceFact {
  return { family: 'group-ack', version: null, evidenceClass: 'durable-only',
    locator: { table: 'synced_operations', key: [key], rowHash: hash('3') }, supports }
}
function draft(facts: readonly RawHistoricalEvidenceFact[] = []): DurableSqlCapsuleDraft {
  return { schemaVersion: 26, workspaceScope: randomUUID(), recoveryEpoch: randomUUID(), schemaHash: hash('0'),
    workspaceHash: hash('1'), historyIdentityHash: hash('2'), facts }
}
const modelInventory: readonly DurableSqlCapsuleFile[] = DURABLE_SQL_CAPSULE_FILES.map((name, index) => ({
  name, present: index === 0, bytes: index === 0 ? 4096 : 0, sha256: index === 0 ? hash('4') : null }))

function byteInventory(directory: string) {
  return DURABLE_SQL_CAPSULE_FILES.map(name => ({ name, bytes: readFileSync(join(directory, name)) }))
}
async function withOriginal(run: (fixture: {
  root: string; input: PrepareDurableSqlCapsuleOriginalInput; originalBytes: ReturnType<typeof byteInventory>
}) => void | Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-capsule-files-')), profileRoot = join(root, 'profile')
  const recoveryDirectory = join(profileRoot, 'backups', 'database-restore', randomUUID()), sealedDirectory = join(recoveryDirectory, 'sealed-input')
  const producer = join(profileRoot, 'producer')
  mkdirSync(producer, { recursive: true }); mkdirSync(sealedDirectory, { recursive: true })
  try {
    const db = new Database(join(producer, 'knowbook.db'))
    try {
      // A real SQLite WAL/SHM inventory. Files/model tests do not claim that this
      // little database has KnowBook semantics or is a certified capsule.
      db.pragma('journal_mode=WAL')
      db.exec('CREATE TABLE actual_original(id INTEGER PRIMARY KEY, body TEXT NOT NULL)')
      db.prepare('INSERT INTO actual_original(body) VALUES(?)').run('Actual original bytes 中文')
      for (const name of DURABLE_SQL_CAPSULE_FILES) copyFileSync(join(producer, name), join(sealedDirectory, name), constants.COPYFILE_EXCL)
    } finally { db.close() }
    await run({ root, input: { profileRoot, recoveryDirectory, sealedDirectory, capsuleId: randomUUID(), label: 'source diagnostic only' },
      originalBytes: byteInventory(sealedDirectory) })
  } finally {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()), 'Only this isolated test root is removed')
    assert.ok(basename(root).startsWith('knowbook-capsule-files-'))
    rmSync(root, { recursive: true, force: true })
  }
}

test('capsule model preserves schema26 origin and every support beyond 128 without a self-referencing manifest or material permit', () => {
  const supports = Array.from({ length: 160 }, (_, index): RawHistoricalEvidenceLocator => ({
    table: 'synced_operations', key: ['original-' + String(index).padStart(5, '0')], rowHash: hash('5') }))
  const artifacts = buildDurableSqlCapsuleArtifacts(draft([fact('z', [...supports].reverse()), fact('a')]), modelInventory)
  assert.equal(artifacts.manifest.schemaVersion, 26)
  assert.equal(artifacts.manifest.material, 'durable-sql-only')
  assert.equal(artifacts.manifest.evidenceIndex.entries, 2)
  assert.deepEqual(parseDurableSqlCapsuleManifest(artifacts.manifestText), artifacts.manifest)
  assert.equal(durableSqlCapsuleManifestHash(artifacts.manifest), artifacts.manifestHash)
  const shard = parseDurableSqlCapsuleShard(artifacts.shards[0].text, 0)
  assert.equal(shard.facts.find(row => row.locator.key[0] === 'z')?.supports.length, 160)
  assert.equal(shard.facts[0].locator.key[0], 'a')
  assert.ok(Object.isFrozen(shard.facts) && Object.isFrozen(shard.facts[1].supports[0].key))
  assert.equal(artifacts.shards[0].text.includes('"manifestHash"'), false)
  assert.equal(Object.hasOwn(artifacts.manifest, 'permit'), false)
  const legacy = buildDurableSqlCapsuleArtifacts({ ...draft(), schemaVersion: 25, workspaceScope: null, recoveryEpoch: null }, modelInventory)
  assert.equal(legacy.manifest.workspaceScope, null)
  assert.throws(() => buildDurableSqlCapsuleArtifacts({ ...draft(), workspaceScope: null, recoveryEpoch: null }, modelInventory), /scope|epoch/)
  assert.throws(() => buildDurableSqlCapsuleArtifacts({ ...draft(), schemaVersion: 25 }, modelInventory), /scope|epoch/)
})

test('capsule model refuses accessors, holes, unknown fields/formats, repeated supports and duplicate facts without evaluating getters', () => {
  let reads = 0
  const accessor = { ...draft() }
  Object.defineProperty(accessor, 'schemaHash', { enumerable: true, get() { reads++; return hash('0') } })
  assert.throws(() => buildDurableSqlCapsuleArtifacts(accessor, modelInventory), /访问器/)
  assert.equal(reads, 0)
  assert.throws(() => buildDurableSqlCapsuleArtifacts({ ...draft(), facts: new Array(1) }, modelInventory), /空洞/)
  assert.throws(() => buildDurableSqlCapsuleArtifacts({ ...draft(), permit: true } as DurableSqlCapsuleDraft, modelInventory), /闭集/)
  assert.throws(() => buildDurableSqlCapsuleArtifacts(draft([{ ...fact('a'), family: 'caller-proof' } as unknown as RawHistoricalEvidenceFact]), modelInventory), /未知.*证据族/)
  assert.throws(() => buildDurableSqlCapsuleArtifacts(draft([fact('a'), fact('a')]), modelInventory), /重复/)
  const support: RawHistoricalEvidenceLocator = { table: 'synced_operations', key: ['same-support'], rowHash: hash('5') }
  assert.throws(() => buildDurableSqlCapsuleArtifacts(draft([fact('a', [support, support])]), modelInventory), /重复/)
})

test('capsule canonical parsing authenticates the complete index count/root and enforces fact/shard budgets', () => {
  const artifacts = buildDurableSqlCapsuleArtifacts(draft([fact('a')]), modelInventory)
  assert.throws(() => parseDurableSqlCapsuleManifest(artifacts.manifestText + ' '), /canonical/)
  assert.throws(() => parseDurableSqlCapsuleManifest('{"kind":"duplicate",' + artifacts.manifestText.slice(1)), /JSON/)
  assert.throws(() => validateDurableSqlCapsuleManifest({ ...artifacts.manifest, evidenceIndex: { ...artifacts.manifest.evidenceIndex, entries: 2 } }), /索引|root/)
  assert.throws(() => validateDurableSqlCapsuleManifest({ ...artifacts.manifest, evidenceIndex: { ...artifacts.manifest.evidenceIndex, rootHash: hash('f') } }), /索引|root/)
  assert.throws(() => parseDurableSqlCapsuleShard(artifacts.shards[0].text, 1), /顺序/)
  assert.throws(() => buildDurableSqlCapsuleArtifacts({ ...draft(), facts: new Array(CAPSULE_MAX_FACTS + 1) }, modelInventory), /预算/)
  assert.throws(() => validateDurableSqlCapsuleManifest({ ...artifacts.manifest, evidenceIndex: { ...artifacts.manifest.evidenceIndex,
    shards: [{ ...artifacts.manifest.evidenceIndex.shards[0], bytes: CAPSULE_MAX_SHARD_BYTES + 1 }] } }), /预算/)
})

test('real DB/WAL/SHM originals and independent scratch survive durable seal/readback without changing sealed bytes', () => withOriginal(async f => {
  const handle = await prepareDurableSqlCapsuleOriginal(f.input), info = readOwnedRawCapsuleOriginal(handle)
  assert.deepEqual(byteInventory(info.originalDirectory), f.originalBytes)
  assert.deepEqual(byteInventory(info.scratchDirectory), f.originalBytes)
  assert.notEqual(info.originalDirectory, info.scratchDirectory)
  assert.ok(Object.isFrozen(info) && Object.isFrozen(info.originalInventory[0]))
  await assertOwnedRawCapsuleScratchReady(handle)
  const saved = await sealDurableSqlCapsule(handle, draft([fact('historical-index-only')]))
  assert.equal(saved.manifest.material, 'durable-sql-only')
  assert.deepEqual(saved.manifest.files, info.originalInventory)
  assert.deepEqual(await readDurableSqlCapsuleSeal(handle), saved)
  assert.deepEqual(byteInventory(f.input.sealedDirectory), f.originalBytes)
  assert.deepEqual(byteInventory(info.originalDirectory), f.originalBytes)
  assert.equal(Object.hasOwn(saved, 'certified'), false, 'A persisted model artifact is not a raw SQL certificate')
}))

test('serialized path/manifest lookalikes cannot mint or read a Main-owned original handle', () => withOriginal(async f => {
  const handle = await prepareDurableSqlCapsuleOriginal(f.input), info = readOwnedRawCapsuleOriginal(handle)
  const fake = { kind: 'owned-raw-capsule-original', ...info } as OwnedRawCapsuleOriginal
  assert.throws(() => readOwnedRawCapsuleOriginal(fake), /句柄/)
  await assert.rejects(assertOwnedRawCapsuleOriginal(fake), /句柄/)
  await assert.rejects(sealDurableSqlCapsule(fake, draft()), /句柄/)
  await assert.rejects(readDurableSqlCapsuleSeal(handle), /没有已完成/)
  assert.deepEqual(byteInventory(f.input.sealedDirectory), f.originalBytes)
}))

test('a scratch DB replacement cannot be sealed against an unchanged genuine original inventory', () => withOriginal(async f => {
  const handle = await prepareDurableSqlCapsuleOriginal(f.input), info = readOwnedRawCapsuleOriginal(handle)
  const changed = readFileSync(info.databasePath)
  changed[changed.length - 1] ^= 1
  writeFileSync(info.databasePath, changed)
  await assert.rejects(assertOwnedRawCapsuleScratchReady(handle), /bytes|清单/)
  await assert.rejects(sealDurableSqlCapsule(handle, draft()), /scratch DB\/WAL/)
  await assert.rejects(readDurableSqlCapsuleSeal(handle), /句柄/)
  assert.deepEqual(byteInventory(f.input.sealedDirectory), f.originalBytes)
  assert.deepEqual(byteInventory(info.originalDirectory), f.originalBytes)
}))

test('parallel seal reentry and later overwrite are refused while the first exact artifact remains readable', () => withOriginal(async f => {
  const handle = await prepareDurableSqlCapsuleOriginal(f.input), input = draft([fact('a')])
  const first = sealDurableSqlCapsule(handle, input)
  await assert.rejects(sealDurableSqlCapsule(handle, input), /正在封存|已封存/)
  const complete = await first
  await assert.rejects(sealDurableSqlCapsule(handle, draft()), /已封存/)
  assert.deepEqual(await readDurableSqlCapsuleSeal(handle), complete)
  assert.deepEqual(byteInventory(f.input.sealedDirectory), f.originalBytes)
}))

for (const target of ['sealed', 'original'] as const) test('changed ' + target + ' original bytes invalidate a genuine handle without rewriting evidence', () => withOriginal(async f => {
  const handle = await prepareDurableSqlCapsuleOriginal(f.input), info = readOwnedRawCapsuleOriginal(handle)
  const file = join(target === 'sealed' ? f.input.sealedDirectory : info.originalDirectory, 'knowbook.db')
  rmSync(file)
  await assert.rejects(assertOwnedRawCapsuleOriginal(handle), /原DB缺失|原件|清单/)
  writeFileSync(file, Buffer.from('replacement original bytes'))
  const changed = readFileSync(file)
  await assert.rejects(sealDurableSqlCapsule(handle, draft()), /原件|清单|bytes/)
  assert.deepEqual(readFileSync(file), changed)
}))

test('extra rollback journals or foreign recovery directories cannot be silently omitted from an original capsule', () => withOriginal(async f => {
  writeFileSync(join(f.input.sealedDirectory, 'knowbook.db-journal'), 'actual extra rollback evidence')
  await assert.rejects(prepareDurableSqlCapsuleOriginal(f.input), /额外文件|rollback journal/)
  await assert.rejects(prepareDurableSqlCapsuleOriginal({ ...f.input, recoveryDirectory: join(f.root, 'external-recovery') }), /恢复operation目录/)
  await assert.rejects(prepareDurableSqlCapsuleOriginal({ ...f.input, sealedDirectory: f.root }), /本Main恢复目录/)
}))

test('real hardlinks to a sealed DB are rejected when the platform can create them', async t => withOriginal(async f => {
  const outsideProfile = join(f.root, 'outside-profile-hardlink.db')
  try { linkSync(join(f.input.sealedDirectory, 'knowbook.db'), outsideProfile) }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && ['EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS', 'EXDEV'].includes(String(error.code))) {
      t.skip('The filesystem cannot establish a real hardlink for this test'); return
    }
    throw error
  }
  await assert.rejects(prepareDurableSqlCapsuleOriginal(f.input), /hardlink/)
  assert.deepEqual(byteInventory(f.input.sealedDirectory), f.originalBytes)
}))

test('real directory junctions or symlinks cannot redirect a Main-owned original outside its recovery directory', async t => withOriginal(async f => {
  const alias = join(f.input.recoveryDirectory, 'redirected-input')
  try { symlinkSync(f.input.sealedDirectory, alias, process.platform === 'win32' ? 'junction' : 'dir') }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && ['EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS'].includes(String(error.code))) {
      t.skip('The platform cannot establish a real directory redirection for this test'); return
    }
    throw error
  }
  await assert.rejects(prepareDurableSqlCapsuleOriginal({ ...f.input, sealedDirectory: alias }), /symlink|junction|重定向/)
  assert.deepEqual(byteInventory(f.input.sealedDirectory), f.originalBytes)
}))

for (const target of ['manifest', 'shard'] as const) test('sealed ' + target + ' tampering cannot be repaired or hidden by the original handle', () => withOriginal(async f => {
  const handle = await prepareDurableSqlCapsuleOriginal(f.input), complete = await sealDurableSqlCapsule(handle, draft([fact('a')]))
  const file = target === 'manifest' ? complete.manifestPath : join(complete.shardsDirectory, complete.manifest.evidenceIndex.shards[0].name)
  const original = readFileSync(file), changed = Buffer.concat([original, Buffer.from(' ')])
  writeFileSync(file, changed)
  await assert.rejects(readDurableSqlCapsuleSeal(handle), /canonical|bytes|hash/)
  assert.deepEqual(readFileSync(file), changed)
  assert.deepEqual(byteInventory(f.input.sealedDirectory), f.originalBytes)
}))
