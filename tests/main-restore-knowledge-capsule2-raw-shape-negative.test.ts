import assert from 'node:assert/strict'
import test from 'node:test'
import { capsuleJson } from '../src/main/database/restore-knowledge-capsule-model'
import type { CoverageSqlRowReference } from '../src/main/database/restore-knowledge-coverage-model'
import { CAPSULE2_READER, capsule2DerivedFtsTables, capsule2FixedDataTables, capsule2TableRole,
  validateCapsule2RawContent, capsule2RawContentHash, validateCapsule2RawCoverageSupports, capsule2RawCoverageSupportsHash,
  type Capsule2RawContent, type Capsule2RawCoverageSupports, type Capsule2RawSqlRow } from '../src/main/database/restore-knowledge-capsule2-raw-model'
import { id, hash, rawRequirement } from './helpers/coverage-structure-fixture'

// PREPARED ONLY, never executed during preparation. These are deliberately
// caller-constructible pure negative DTOs, with no SQL row/original/producer,
// source scan attestation, accepted root, complete schema or certificate.
// Actual SQL reader fixtures and the existing 64MiB draft stay byte-identical.
function contentProbe(row?: Capsule2RawSqlRow): Capsule2RawContent {
  return { kind: 'restore-knowledge-capsule2-raw-content', version: 1, forReader: CAPSULE2_READER,
    schemaVersion: 27, encoding: 'UTF-8', workspaceScope: id(100), recoveryEpoch: id(101), schemaHash: hash(1), legacyInventoryHash: hash(2),
    derivedTablesNotRepeated: capsule2DerivedFtsTables(),
    tables: capsule2FixedDataTables(27).map((name, index) => ({ name, role: capsule2TableRole(name),
      columns: ['id'], primaryKey: [], rows: index === 0 && row ? [row] : [] })),
    state: 'raw-storage-only', semanticValidationComplete: false, certified: false }
}
function supportProbe(): Capsule2RawCoverageSupports {
  const entry = rawRequirement(40)
  const references = Object.values(entry.supports).filter((reference): reference is CoverageSqlRowReference => reference !== null)
    .sort((a, b) => capsuleJson([a.table, a.key]) < capsuleJson([b.table, b.key]) ? -1 : 1)
  const columns = {
    app_settings: ['key', 'value', 'updated_at'],
    synced_operations: ['client_operation_id', 'request_hash', 'result_json', 'created_at'],
    synced_exposure_attempts: ['id', 'request_hash', 'channel', 'target_fingerprint', 'publication_hash', 'state', 'created_at', 'confirmed_at']
  } as const
  return { kind: 'restore-knowledge-capsule2-raw-coverage-supports', version: 1, forReader: CAPSULE2_READER,
    encoding: 'UTF-8', requirements: { kind: 'restore-knowledge-unresolved-required-roots', version: 1, schemaVersion: 27, entries: [entry] },
    supports: references.map((reference, index) => ({ reference, columns: [...columns[reference.table]],
      row: { sourceRowId: String(index + 1), cells: columns[reference.table].map(() => ['null'] as const) } })),
    state: 'unresolved-sql-supports-only', certified: false, acceptedCoverage: false }
}

test('capsule2 pure raw content rejects an empty column set even with zero rows', () => {
  const baseline = contentProbe()
  const probe: Capsule2RawContent = { ...baseline, tables: baseline.tables.map((table, index) => index === 0 ? { ...table, columns: [] } : table) }
  assert.equal(probe.certified, false)
  assert.throws(() => validateCapsule2RawContent(probe), /完整原行列闭集不得为空/)
  assert.throws(() => capsule2RawContentHash(probe), /完整原行列闭集不得为空/)
})

test('capsule2 pure mandatory supports reject an empty column and cell set without losing any locator', () => {
  const baseline = supportProbe()
  const probe: Capsule2RawCoverageSupports = { ...baseline, supports: baseline.supports.map((support, index) => index === 0
    ? { ...support, columns: [], row: { ...support.row, cells: [] } } : support) }
  assert.deepEqual(probe.supports.map(support => support.reference), baseline.supports.map(support => support.reference))
  assert.equal(probe.certified, false); assert.equal(probe.acceptedCoverage, false)
  assert.throws(() => validateCapsule2RawCoverageSupports(probe), /完整原行列闭集不得为空/)
  assert.throws(() => capsule2RawCoverageSupportsHash(probe), /完整原行列闭集不得为空/)
})

test('capsule2 pure raw INTEGER small spellings preserve canonical int64 endpoints and reject overlong or noncanonical values', () => {
  // Small caller DTOs check rejection/canonical behavior only. The source's
  // typeof -> length <= 20 -> regex -> BigInt order is reviewed statically;
  // assert.throws alone does not prove preparse cost, timing or memory bounds.
  for (const value of ['9'.repeat(21), '-' + '9'.repeat(20), '9'.repeat(4096), '-' + '9'.repeat(4095),
    '9223372036854775808', '-9223372036854775809', '', '00', '01', '-0', '+1', ' 1', '1.0', '1e0']) {
    const probe = contentProbe({ sourceRowId: '1', cells: [['integer', value]] })
    assert.equal(probe.certified, false)
    assert.throws(() => validateCapsule2RawContent(probe), /未知storage tag或非canonical原值/)
    assert.throws(() => capsule2RawContentHash(probe), /未知storage tag或非canonical原值/)
  }
  for (const value of ['0', '1', '-1', '9223372036854775807', '-9223372036854775808']) {
    const probe = contentProbe({ sourceRowId: '1', cells: [['integer', value]] }), parsed = validateCapsule2RawContent(probe)
    assert.deepEqual(parsed.tables[0].rows[0].cells, [['integer', value]])
    assert.equal(parsed.certified, false); assert.equal(parsed.semanticValidationComplete, false)
    assert.match(capsule2RawContentHash(probe), /^[0-9a-f]{64}$/)
  }
})

test('capsule2 pure raw rowid small spellings preserve canonical int64 endpoints and reject overlong or noncanonical values', () => {
  for (const value of ['9'.repeat(21), '-' + '9'.repeat(20), '9'.repeat(4096), '-' + '9'.repeat(4095),
    '9223372036854775808', '-9223372036854775809', '', '00', '01', '-0', '+1', ' 1', '1.0', '1e0']) {
    const probe = contentProbe({ sourceRowId: value, cells: [['null']] })
    assert.equal(probe.certified, false)
    assert.throws(() => validateCapsule2RawContent(probe), /原rowid证据无效/)
    assert.throws(() => capsule2RawContentHash(probe), /原rowid证据无效/)
  }
  for (const value of ['0', '1', '-1', '9223372036854775807', '-9223372036854775808']) {
    const probe = contentProbe({ sourceRowId: value, cells: [['null']] }), parsed = validateCapsule2RawContent(probe)
    assert.equal(parsed.tables[0].rows[0].sourceRowId, value)
    assert.equal(parsed.certified, false); assert.equal(parsed.semanticValidationComplete, false)
    assert.match(capsule2RawContentHash(probe), /^[0-9a-f]{64}$/)
  }
})
