import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { copyRestoreInventory, restoreInventory } from '../src/main/database/restore-safety-files'
import { prepareDurableSqlCapsuleOriginal, readOwnedRawCapsuleOriginal, sealDurableSqlCapsule,
  type ReopenDurableSqlCapsuleOriginalInput } from '../src/main/database/restore-knowledge-capsule-files'
import { certifyDurableSqlCapsuleOriginal, readCertifiedDurableSqlCapsule } from '../src/main/database/restore-knowledge-capsule-read'
import { capsuleBytesHash, capsuleJson, type DurableSqlCapsuleDraft } from '../src/main/database/restore-knowledge-capsule-model'
import { withV3Fixture, type V3Fixture } from './helpers/synced-backup-v3-fixture'

const execute = promisify(execFile)
const worker = fileURLToPath(new URL('./helpers/durable-sql-capsule-reopen-process.ts', import.meta.url))
async function child(input: ReopenDurableSqlCapsuleOriginalInput) {
  return execute(process.execPath, ['--import', 'tsx', worker, JSON.stringify(input)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, maxBuffer: 1024 * 1024
  })
}
async function fixture(f: V3Fixture) {
  const profileRoot = await realpath(f.userDataRoot), sourceDirectory = await realpath(dirname(f.file))
  const operationId = randomUUID(), capsuleId = randomUUID()
  const recoveryDirectory = join(profileRoot, 'backups', 'database-restore', operationId)
  const sealedDirectory = join(recoveryDirectory, 'sealed-input')
  await mkdir(recoveryDirectory, { recursive: true })
  await copyRestoreInventory(sourceDirectory, sealedDirectory, await restoreInventory(sourceDirectory), profileRoot)
  const input = { profileRoot, recoveryDirectory, sealedDirectory, capsuleId, label: 'process-boundary-original' }
  const original = await prepareDurableSqlCapsuleOriginal(input)
  const seal = await readCertifiedDurableSqlCapsule(await certifyDurableSqlCapsuleOriginal(original))
  const info = readOwnedRawCapsuleOriginal(original)
  const locator: ReopenDurableSqlCapsuleOriginalInput = { profileRoot, operationId, capsuleId, expectedManifestHash: seal.manifestHash }
  return { input, seal, info, locator }
}
async function bytes(directory: string) {
  const output: Array<{ name: string; bytes: Buffer }> = []
  async function walk(current: string) {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(current, entry.name)
      if (entry.isDirectory()) await walk(file)
      else { assert.ok(entry.isFile()); output.push({ name: relative(directory, file), bytes: await readFile(file) }) }
    }
  }
  await walk(directory); return output
}

test('a genuinely new process recertifies the complete persisted SQL capsule using only a fresh independent scratch', () => withV3Fixture(async f => {
  const saved = await fixture(f)
  assert.ok(saved.seal.facts.some(fact => fact.family === 'host-create-ack'), 'The archive contains actual Main historical SQL')
  // The completed old scratch is disposable SQLite work, never a persisted SQL
  // source. Corrupt it so a restart that opens/reuses it cannot pass this test.
  await writeFile(join(saved.info.scratchDirectory, 'knowbook.db'), 'old scratch must not be opened or repaired')
  await writeFile(join(saved.info.scratchDirectory, 'knowbook.db-journal'), 'old scratch diagnostic evidence')
  assert.equal(dirname(resolve(saved.input.sealedDirectory)), resolve(saved.input.recoveryDirectory))
  await rm(saved.input.sealedDirectory, { recursive: true }) // The capsule's own original is self-contained.
  const before = await bytes(saved.info.capsuleDirectory)
  const output = JSON.parse((await child(saved.locator)).stdout) as {
    pid: number; manifestHash: string; manifestPath: string; scratchDirectory: string; factsHash: string; facts: number; certifiedForInstallation: boolean
  }
  assert.notEqual(output.pid, process.pid, 'Certification took place after a real process boundary with fresh registries')
  assert.equal(output.manifestHash, saved.seal.manifestHash)
  assert.equal(output.manifestPath, saved.seal.manifestPath)
  assert.equal(output.factsHash, capsuleBytesHash(capsuleJson(saved.seal.facts)))
  assert.equal(output.facts, saved.seal.facts.length)
  assert.equal(output.certifiedForInstallation, false)
  assert.notEqual(output.scratchDirectory, saved.info.scratchDirectory)
  assert.equal(dirname(output.scratchDirectory), join(saved.info.recoveryDirectory, 'knowledge-capsule-reads'))
  assert.ok(!relative(saved.info.capsuleDirectory, output.scratchDirectory).split(sep).includes('scratch'))
  assert.deepEqual(await bytes(saved.info.capsuleDirectory), before, 'Manifest/index/original and even bad old scratch bytes remain exact')
  // Remove only the exact old scratch under this canonical capsule. The second
  // fresh process must not require the old directory to exist or recreate it.
  const canonicalCapsule = await realpath(saved.info.capsuleDirectory), oldScratch = await realpath(saved.info.scratchDirectory)
  assert.equal(saved.info.capsuleDirectory, canonicalCapsule)
  assert.equal(saved.info.scratchDirectory, oldScratch)
  assert.equal(oldScratch, join(canonicalCapsule, 'scratch'))
  await rm(oldScratch, { recursive: true })
  const withoutOldScratch = await bytes(canonicalCapsule)
  const reopened = JSON.parse((await child(saved.locator)).stdout) as typeof output
  assert.notEqual(reopened.pid, process.pid)
  assert.equal(reopened.manifestHash, output.manifestHash)
  assert.equal(reopened.manifestPath, output.manifestPath)
  assert.equal(reopened.factsHash, output.factsHash)
  assert.equal(reopened.facts, output.facts)
  assert.equal(reopened.certifiedForInstallation, false)
  assert.notEqual(reopened.scratchDirectory, output.scratchDirectory, 'A later process owns a different fresh UUID scratch')
  assert.notEqual(reopened.scratchDirectory, oldScratch)
  assert.equal(dirname(reopened.scratchDirectory), join(saved.info.recoveryDirectory, 'knowledge-capsule-reads'))
  assert.equal((await readdir(canonicalCapsule)).includes('scratch'), false, 'Reopening never recreates even an empty old scratch directory')
  assert.deepEqual(await bytes(canonicalCapsule), withoutOldScratch, 'A missing old scratch is neither required nor recreated; every remaining artifact byte stays exact')
}))

for (const target of ['index', 'original'] as const) test('a new process refuses tampered persisted ' + target + ' bytes without repairing the old artifact', () => withV3Fixture(async f => {
  const saved = await fixture(f)
  const file = target === 'index' ? join(saved.seal.shardsDirectory, saved.seal.manifest.evidenceIndex.shards[0].name)
    : join(saved.info.originalDirectory, 'knowbook.db')
  const changed = Buffer.concat([await readFile(file), Buffer.from('deliberately changed original bytes')])
  await writeFile(file, changed)
  const before = await bytes(saved.info.capsuleDirectory)
  await assert.rejects(child(saved.locator), /manifest|分片|原件|bytes|清单/)
  assert.deepEqual(await bytes(saved.info.capsuleDirectory), before)
}))

test('a new process requires the trusted owning root expected full manifest hash', () => withV3Fixture(async f => {
  const saved = await fixture(f), before = await bytes(saved.info.capsuleDirectory)
  const wrong = (saved.locator.expectedManifestHash[0] === '0' ? '1' : '0') + saved.locator.expectedManifestHash.slice(1)
  await assert.rejects(child({ ...saved.locator, expectedManifestHash: wrong }), /manifest/)
  await assert.rejects(child({ ...saved.locator, operationId: '../' + randomUUID() }), /locator/)
  assert.deepEqual(await bytes(saved.info.capsuleDirectory), before)
}))

test('a complete canonical seal with a caller-omitted real fact is refused after independent SQL reconstruction', () => withV3Fixture(async f => {
  const actual = await fixture(f), capsuleId = randomUUID()
  const untrusted = await prepareDurableSqlCapsuleOriginal({ ...actual.input, capsuleId })
  const manifest = actual.seal.manifest
  const draft: DurableSqlCapsuleDraft = { schemaVersion: manifest.schemaVersion, workspaceScope: manifest.workspaceScope,
    recoveryEpoch: manifest.recoveryEpoch, schemaHash: manifest.schemaHash, workspaceHash: manifest.workspaceHash,
    historyIdentityHash: manifest.historyIdentityHash, facts: [] }
  assert.ok(actual.seal.facts.length > 0)
  // Files/model sealing deliberately is not certification. This writes a fully
  // canonical self-consistent artifact; the new process must read actual SQL to
  // discover that the supplied evidence index is incomplete.
  const forged = await sealDurableSqlCapsule(untrusted, draft), info = readOwnedRawCapsuleOriginal(untrusted)
  const before = await bytes(info.capsuleDirectory)
  await assert.rejects(child({ ...actual.locator, capsuleId, expectedManifestHash: forged.manifestHash }), /独立原SQL重建/)
  assert.deepEqual(await bytes(info.capsuleDirectory), before, 'Even a syntactically valid but false old seal is left for diagnosis')
}))
