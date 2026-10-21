import assert from 'node:assert/strict'
import test from 'node:test'
import { capsuleJson } from '../src/main/database/restore-knowledge-capsule-model'
import { readRawCapsule2ContentOwned } from '../src/main/database/restore-knowledge-capsule2-content-raw-read'
import { CAPSULE2_RAW_MAX_JSON_BYTES, CAPSULE2_RAW_MAX_VALUE_BYTES, capsule2RawContentHash,
  validateCapsule2RawContent, type Capsule2RawContent } from '../src/main/database/restore-knowledge-capsule2-raw-model'
import { rawRestoreSqlCell } from '../src/main/database/restore-knowledge-sql-cell'
import { withV3Fixture } from './helpers/synced-backup-v3-fixture'
import { withCapsule2RawCopy } from './helpers/capsule2-raw-fixture'

// Independent byte-count oracle for actual materialized SQL cells. This is not
// a source-scan attestation, a semantic validator or a capsule2 certificate.
function valueBytes(raw: Capsule2RawContent): number {
  return raw.tables.reduce((total, table) => total + table.rows.reduce((rows, row) => rows + row.cells.reduce((cells, cell) =>
    cells + (cell[0] === 'text' || cell[0] === 'blob' ? Buffer.from(cell[1], 'base64').length : 8), 0), 0), 0)
}

test('capsule2 raw real SQL content enforces the actual 64MiB boundary in preflight and pure validation/hash below the JSON cap', () => withV3Fixture(async f => {
  // Store writes a real policy-unresolved ordinary setting, with no new C,
  // accepted producer, fabricated SQL envelope or caller-controlled budget.
  const key = 'capsule2.raw.budget.padding'
  f.store.saveSetting(key, '')
  const baseline = await withCapsule2RawCopy(f, db => db.transaction(() => readRawCapsule2ContentOwned(db))())
  assert.equal(baseline.encoding, 'UTF-8')
  const paddingBytes = CAPSULE2_RAW_MAX_VALUE_BYTES - valueBytes(baseline)
  assert.ok(paddingBytes > 0)
  f.store.saveSetting(key, 'A'.repeat(paddingBytes))
  const atLimit = await withCapsule2RawCopy(f, db => db.transaction(() => readRawCapsule2ContentOwned(db))())
  assert.equal(valueBytes(atLimit), CAPSULE2_RAW_MAX_VALUE_BYTES)
  assert.ok(Buffer.byteLength(capsuleJson(atLimit)) < CAPSULE2_RAW_MAX_JSON_BYTES)
  assert.equal(validateCapsule2RawContent(atLimit).certified, false)
  assert.match(capsule2RawContentHash(atLimit), /^[0-9a-f]{64}$/)

  f.store.saveSetting(key, 'A'.repeat(paddingBytes + 1))
  await withCapsule2RawCopy(f, db => {
    assert.throws(() => db.transaction(() => readRawCapsule2ContentOwned(db))(), /超准备预算/)
    const source = db.prepare('SELECT _rowid_ AS rowid,typeof(value) AS storage,CAST(value AS BLOB) AS bytes FROM app_settings WHERE key=?')
      .safeIntegers(true).get(key) as { rowid: bigint; storage: string; bytes: Buffer }
    assert.equal(source.bytes.length, paddingBytes + 1)
    // This over-budget DTO probe replaces only the actual changed source cell
    // from the real readonly backup. Its outer shape/inventory reference is
    // reused from atLimit, not reauthenticated as a complete source artifact.
    // It remains uncertified; SQL reader refused the real oversized source.
    // No assertion treats this probe/hash as proof that the source was scanned.
    const overLimit: Capsule2RawContent = { ...atLimit, tables: atLimit.tables.map(table => table.name !== 'app_settings' ? table : {
      ...table, rows: table.rows.map(row => row.sourceRowId !== source.rowid.toString() ? row : { ...row,
        cells: row.cells.map((cell, index) => table.columns[index] === 'value' ? rawRestoreSqlCell(source.storage, source.bytes, atLimit.encoding) : cell) })
    }) }
    assert.equal(valueBytes(overLimit), CAPSULE2_RAW_MAX_VALUE_BYTES + 1)
    assert.ok(Buffer.byteLength(capsuleJson(overLimit)) < CAPSULE2_RAW_MAX_JSON_BYTES)
    assert.throws(() => validateCapsule2RawContent(overLimit), /value bytes超准备预算/)
    assert.throws(() => capsule2RawContentHash(overLimit), /value bytes超准备预算/)
    assert.equal((db.prepare('SELECT length(CAST(value AS BLOB)) AS bytes FROM app_settings WHERE key=?').get(key) as { bytes: number }).bytes, paddingBytes + 1)
  })
}))
