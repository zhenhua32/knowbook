import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { basename, dirname } from 'node:path'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import test from 'node:test'
import { readRawRestoreSqlInventoryOwned } from '../src/main/database/restore-knowledge-sql-inventory'
import { readRawCapsule2SourceKnowledgeOwned } from '../src/main/database/restore-knowledge-payload-raw-read'
import { rawRestoreSqlCell } from '../src/main/database/restore-knowledge-sql-cell'
import { publicationHash, publicationJson } from '../src/main/sync/synced-publication-model'
import { withPayloadStore } from './helpers/restore-knowledge-payload-fixture'
import { withCapsule2RawCopy } from './helpers/capsule2-raw-fixture'
import { withV3Fixture } from './helpers/synced-backup-v3-fixture'

const fs: typeof import('node:fs') = createRequire(import.meta.url)('node:fs')

test('complete capsule2 K checks all large settings through the digest-only sorter and exposes only historical settings', () => withV3Fixture(async f => {
  const before = await withCapsule2RawCopy(f, db => db.transaction(() => readRawCapsule2SourceKnowledgeOwned(db))())
  const sentinel = 'opaque settings value \0 fixture only, never in a row-hash spill'
  const insert = f.db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES (?,?,?)')
  f.db.transaction(() => {
    for (let index = 16_500; index > 0; index--) insert.run('k-opaque-' + index, sentinel + index, '2026-01-01T00:00:00.000Z')
  })()
  const removal = Object.getOwnPropertyDescriptor(fs, 'rmSync')!, remove = fs.rmSync
  const observed: string[] = []
  Object.defineProperty(fs, 'rmSync', { ...removal, value: (...args: unknown[]) => {
    const [path] = args
    if (typeof path === 'string' && basename(path) === 'row-hashes.db'
      && basename(dirname(path)).startsWith('knowbook-restore-row-hashes-')) {
      const bytes = fs.readFileSync(path)
      assert.equal(bytes.subarray(0, 16).toString(), 'SQLite format 3\0')
      assert.equal(bytes.includes(Buffer.from(sentinel)), false)
      assert.equal(bytes.includes(Buffer.from(Buffer.from(sentinel).toString('base64'))), false)
      observed.push(dirname(path))
    }
    return Reflect.apply(remove, fs, args)
  } })
  syncBuiltinESMExports()
  try {
    const actual = await withCapsule2RawCopy(f, db => db.transaction(() => {
      const changes = db.prepare('SELECT total_changes()').pluck().get()
      const source = readRawCapsule2SourceKnowledgeOwned(db)
      assert.equal(db.prepare('SELECT total_changes()').pluck().get(), changes)
      return source
    })())
    assert.deepEqual(actual.knowledge.originals.find(table => table.table === 'app_settings'),
      before.knowledge.originals.find(table => table.table === 'app_settings'))
    assert.notEqual(actual.knowledge.inventoryHash, before.knowledge.inventoryHash)
    assert.notEqual(actual.knowledge.observationHash, before.knowledge.observationHash)
    // Raw content, the independent K inventory, and the original K rows each
    // check the complete settings table even when its K disclosure is small.
    assert.ok(observed.length >= 3)
    assert.ok(observed.every(path => !fs.existsSync(path)))
  } finally {
    Object.defineProperty(fs, 'rmSync', removal)
    syncBuiltinESMExports()
  }
}))

test('large real restore inventory spills its sorted hashes to a private SQLite file and preserves the original hash', () => withPayloadStore(async f => {
  const insert = f.db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES (?,?,?)')
  f.db.transaction(() => {
    for (let index = 16_500; index > 0; index--) insert.run('spill-fixture-' + index, '中-' + index, '2026-01-01T00:00:00.000Z')
  })()
  const rows = f.db.prepare('SELECT typeof(key),CAST(key AS BLOB),typeof(value),CAST(value AS BLOB),typeof(updated_at),CAST(updated_at AS BLOB) FROM app_settings')
    .raw(true).all() as unknown[][]
  const hashes = rows.map(row => publicationHash(publicationJson([0, 2, 4].map(index => rawRestoreSqlCell(row[index], row[index + 1], 'UTF-8'))))).sort()
  const original = createHash('sha256').update('knowbook.raw-sql-row-set.v1\0')
  for (const hash of hashes) original.update(hash)
  const expected = original.digest('hex'), before = f.db.prepare('SELECT total_changes() AS n').get()
  const removal = Object.getOwnPropertyDescriptor(fs, 'rmSync')!, remove = fs.rmSync
  const observed: string[] = []
  Object.defineProperty(fs, 'rmSync', { ...removal, value: (...args: unknown[]) => {
    const [path] = args
    if (typeof path === 'string' && basename(path) === 'row-hashes.db'
      && basename(dirname(path)).startsWith('knowbook-restore-row-hashes-')) {
      assert.equal(fs.readFileSync(path).subarray(0, 16).toString(), 'SQLite format 3\0')
      observed.push(dirname(path))
    }
    return Reflect.apply(remove, fs, args)
  } })
  syncBuiltinESMExports()
  try {
    f.db.pragma('query_only=ON')
    const inventory = f.db.transaction(() => readRawRestoreSqlInventoryOwned(f.db))()
    const settings = inventory.tables.find(table => table.name === 'app_settings')
    assert.equal(settings?.rowSetHash, expected)
    assert.equal(settings?.rows, rows.length)
    assert.deepEqual(f.db.prepare('SELECT total_changes() AS n').get(), before)
    assert.equal(observed.length, 1)
    assert.equal(fs.existsSync(observed[0]), false)
  } finally {
    f.db.pragma('query_only=OFF')
    Object.defineProperty(fs, 'rmSync', removal)
    syncBuiltinESMExports()
  }
}))
