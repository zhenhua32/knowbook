import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { constants, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { KnowbookStore } from '../../src/main/database/store'
import { prepareDurableSqlCapsuleOriginal, readOwnedRawCapsuleOriginal } from '../../src/main/database/restore-knowledge-capsule-files'
import { certifyDurableSqlCapsuleOriginal, readCertifiedDurableSqlCapsule,
  extractCertifiedDurableSqlCapsuleKnowledge, readCertifiedCapsuleKnowledge } from '../../src/main/database/restore-knowledge-capsule-read'
import { restoreInventory } from '../../src/main/database/restore-safety-files'
import type { DurableSqlCapsuleReference } from '../../src/main/database/restore-knowledge-dag-model'
import type { CapsuleKnowledgePayload, KnowledgeOriginalRow, KnowledgeSqlCell } from '../../src/main/database/restore-knowledge-payload-model'

/** Integration helper. Inputs are real fixture-owned
 * directories; no draft/fact/ACK/proof/permit is supplied to production code. */
export async function prepareKnowledgeOriginal(profileInput: string, sourceInput: string, operationId = randomUUID()) {
  const profileRoot = await realpath(profileInput), sourceDirectory = await realpath(sourceInput)
  const recoveryDirectory = join(profileRoot, 'backups', 'database-restore', operationId)
  await mkdir(recoveryDirectory, { recursive: true })
  const sealedDirectory = join(recoveryDirectory, 'sealed-payload-' + randomUUID()), capsuleId = randomUUID()
  await mkdir(sealedDirectory)
  const inventory = await restoreInventory(sourceDirectory)
  for (const file of inventory) if (file.present)
    await copyFile(join(sourceDirectory, file.name), join(sealedDirectory, file.name), constants.COPYFILE_EXCL)
  assert.deepEqual(await restoreInventory(sourceDirectory), inventory)
  assert.deepEqual(await restoreInventory(sealedDirectory), inventory)
  const original = await prepareDurableSqlCapsuleOriginal({ profileRoot, recoveryDirectory, sealedDirectory,
    capsuleId, label: 'actual payload integration original' })
  return { profileRoot, operationId, capsuleId, original, info: readOwnedRawCapsuleOriginal(original), inventory }
}
export async function captureKnowledgeOriginal(profileRoot: string, sourceDirectory: string, operationId = randomUUID()) {
  const prepared = await prepareKnowledgeOriginal(profileRoot, sourceDirectory, operationId)
  const capsule = await certifyDurableSqlCapsuleOriginal(prepared.original), seal = await readCertifiedDurableSqlCapsule(capsule)
  const ref: DurableSqlCapsuleReference = { kind: 'durable-sql-capsule-ref', version: 1,
    operationId, capsuleId: prepared.capsuleId, manifestHash: seal.manifestHash }
  return { ...prepared, capsule, seal, ref }
}
export type CapturedKnowledgeOriginal = Awaited<ReturnType<typeof captureKnowledgeOriginal>>
export async function extractKnowledge(captured: CapturedKnowledgeOriginal) {
  const handle = await extractCertifiedDurableSqlCapsuleKnowledge(captured.capsule)
  return { handle, payload: await readCertifiedCapsuleKnowledge(handle) }
}
export async function knowledgeArtifactBytes(captured: CapturedKnowledgeOriginal) {
  const paths = [captured.seal.manifestPath,
    ...captured.seal.manifest.files.filter(file => file.present).map(file => join(captured.info.originalDirectory, file.name)),
    ...captured.seal.manifest.evidenceIndex.shards.map(shard => join(captured.seal.shardsDirectory, shard.name))].sort()
  return Promise.all(paths.map(async path => ({ path: relative(captured.info.capsuleDirectory, path), bytes: await readFile(path) })))
}
export async function knowledgeReadScratchCount(profileRoot: string, operationId: string): Promise<number> {
  const directory = join(profileRoot, 'backups', 'database-restore', operationId, 'knowledge-capsule-reads')
  try { return (await readdir(directory)).length }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error }
}

export type PayloadEncoding = 'UTF-8' | 'UTF-16le' | 'UTF-16be'
export async function withPayloadStore(run: (fixture: {
  root: string; userDataRoot: string; file: string; store: KnowbookStore; db: Database.Database
}) => Promise<void>, encoding: PayloadEncoding = 'UTF-8') {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-payload-')), userDataRoot = join(root, 'profile')
  const file = join(userDataRoot, 'storage', 'knowbook.db')
  let initial: Database.Database | undefined, store: KnowbookStore | undefined
  try {
    mkdirSync(dirname(file), { recursive: true })
    initial = new Database(file); initial.pragma("encoding='" + encoding + "'")
    initial.exec('CREATE TABLE payload_encoding_fixture(value TEXT)')
    initial.close(); initial = undefined
    store = new KnowbookStore(file)
    const db = store.getUnsafeDatabaseHandle()
    assert.equal(String(db.pragma('encoding', { simple: true })).toLowerCase(), encoding.toLowerCase())
    await run({ root, userDataRoot, file, store, db })
  } finally {
    initial?.close(); store?.destroy()
    assert.equal(dirname(resolve(root)), resolve(tmpdir()))
    assert.ok(basename(root).startsWith('knowbook-payload-'))
    rmSync(root, { recursive: true, force: true })
  }
}
export function payloadTextCell(value: string, encoding: string): KnowledgeSqlCell {
  const bytes = Buffer.from(value, encoding === 'UTF-8' ? 'utf8' : 'utf16le')
  if (encoding === 'UTF-16be') bytes.swap16()
  return ['text', bytes.toString('base64')]
}
export function originalRow(payload: CapsuleKnowledgePayload, tableName: string, id: string): KnowledgeOriginalRow {
  const table = payload.originals.find(table => table.table === tableName)
  assert.ok(table, 'The complete related original table is retained')
  const expected = payloadTextCell(id, payload.encoding)
  const row = table.rows.find(row => JSON.stringify(row.key[0]) === JSON.stringify(expected))
  assert.ok(row, 'The exact typed primary-key source row remains present')
  return row
}
