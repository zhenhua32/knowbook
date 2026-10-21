import assert from 'node:assert/strict'
import test from 'node:test'
import { readRawCapsule2CoverageSupportsOwned } from '../src/main/database/restore-knowledge-capsule2-coverage-raw-read'
import { readRawCapsule2ContentOwned } from '../src/main/database/restore-knowledge-capsule2-content-raw-read'
import { validateCapsule2RawCoverageSupports } from '../src/main/database/restore-knowledge-capsule2-raw-model'
import { coverageReceiptKey } from '../src/main/database/restore-knowledge-coverage-model'
import { withV3Fixture } from './helpers/synced-backup-v3-fixture'
import { actualHistorySyntax, insertCoverageSyntax } from './helpers/coverage-raw-sql-fixture'
import { withCapsule2RawCopy, writeMixedOrdinary501 } from './helpers/capsule2-raw-fixture'

test('capsule2 raw coverage seam keeps all actual B/R plus new untrusted C tuple support rows and remains unresolved', () => withV3Fixture(async f => {
  // Produce the original B/R through Main before the later ordinary501 edit;
  // this does not forge an old history, ACK, accepted root or coverage producer.
  const syntax = actualHistorySyntax(f.db, '2049-01-02T03:04:05.006Z')
  writeMixedOrdinary501(f)
  insertCoverageSyntax(f.db, syntax)
  await withCapsule2RawCopy(f, db => {
    const before = db.prepare('SELECT total_changes() AS count').get()
    const raw = db.transaction(() => ({ content: readRawCapsule2ContentOwned(db), coverage: readRawCapsule2CoverageSupportsOwned(db) }))()
    assert.equal(raw.content.certified, false); assert.equal(raw.coverage.certified, false)
    assert.equal(raw.coverage.requirements.entries.length, 1); assert.equal(raw.coverage.supports.length, 6)
    assert.equal(raw.coverage.acceptedCoverage, false); assert.equal(raw.coverage.state, 'unresolved-sql-supports-only')
    const expected = Object.values(raw.coverage.requirements.entries[0].supports).filter(Boolean)
    assert.equal(raw.coverage.supports.length, expected.length)
    for (const support of expected) assert.ok(raw.coverage.supports.some(row => JSON.stringify(row.reference) === JSON.stringify(support)))
    assert.throws(() => validateCapsule2RawCoverageSupports({ ...raw.coverage, supports: raw.coverage.supports.slice(1) }), /缺失/)
    assert.deepEqual(db.prepare('SELECT total_changes() AS count').get(), before)
  })
}))

test('capsule2 raw coverage seam rejects a missing mandatory receipt and preserves the incomplete new syntax as bad evidence', () => withV3Fixture(async f => {
  const syntax = actualHistorySyntax(f.db, '2049-02-02T03:04:05.006Z')
  insertCoverageSyntax(f.db, syntax)
  f.db.prepare('DELETE FROM app_settings WHERE key=?').run(coverageReceiptKey(syntax.coverage.operationId))
  await withCapsule2RawCopy(f, db => {
    const before = db.prepare('SELECT key,value,updated_at FROM app_settings ORDER BY key').all()
    assert.throws(() => db.transaction(() => readRawCapsule2CoverageSupportsOwned(db))(), /反向闭集|孤C/)
    assert.deepEqual(db.prepare('SELECT key,value,updated_at FROM app_settings ORDER BY key').all(), before)
  })
}))

test('capsule2 raw coverage seam rejects an unknown coverage family version without declaring empty or changing SQL', () => withV3Fixture(async f => {
  const key = 'synced.restore.coverage.v99.00000000-0000-0000-0000-000000000001'
  f.db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)').run(key, '{}', '2049-03-02T03:04:05.006Z')
  await withCapsule2RawCopy(f, db => {
    assert.throws(() => db.transaction(() => readRawCapsule2CoverageSupportsOwned(db))(), /未知coverage/)
    assert.equal((db.prepare('SELECT value FROM app_settings WHERE key=?').get(key) as { value: string }).value, '{}')
  })
}))
