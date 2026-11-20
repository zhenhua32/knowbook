import assert from 'node:assert/strict'
import test from 'node:test'
import { observeRawCapsule2TablesOwned, readRawCapsule2ContentOwned } from '../src/main/database/restore-knowledge-capsule2-content-raw-read'
import { capsule2RawContentHash, capsule2RawTableRows, capsule2RawTableRowCount, diagnoseCapsule2RawContent, hashValidatedCapsule2RawContent,
  hashValidatedCapsule2RawSqlTable, hashValidatedCapsule2RawSqlTablePair,
  validateCapsule2RawContent } from '../src/main/database/restore-knowledge-capsule2-raw-model'
import { readRawCapsule2ObserverOwned } from '../src/main/database/restore-knowledge-capsule2-observer-read'
import { readRawCapsule2OrdinaryPolicyEvidenceOwned, readRawCapsule2OrdinaryPolicySourceOwned } from '../src/main/database/restore-knowledge-capsule2-policy-source-read'
import { capsuleBytesHash, capsuleJson } from '../src/main/database/restore-knowledge-capsule-model'
import { root3SupplementSourceContentHash3 } from '../src/main/database/restore-knowledge-assets3-context'
import { findGraph3OriginalRow } from '../src/main/database/restore-knowledge-graph3-data'
import { scopeIncomingReferenceHistory5, withReferenceOriginalRows5 } from '../src/main/database/restore-knowledge-reference-original-rows5'
import { readInitialIncomingWorkspace } from '../src/main/database/synced-initial-incoming-read'
import { withV3Fixture } from './helpers/synced-backup-v3-fixture'
import { decodedCapsule2Table, withCapsule2RawCopy, writeMixedOrdinary501 } from './helpers/capsule2-raw-fixture'

for (const encoding of ['UTF-8', 'UTF-16le', 'UTF-16be'] as const) test(`raw source hash retains its original canonical JSON in ${encoding}`,
  () => withV3Fixture(async f => {
    const opaque = 'opaque\0中文 😀 "quoted" \\path'
    f.db.prepare('INSERT INTO app_settings(rowid,key,value,updated_at) VALUES(?,?,?,?)')
      .run(-42n, 'raw-json-parity', opaque, '2048-01-02T03:04:05.000Z')
    await withCapsule2RawCopy(f, db => db.transaction(() => {
      const { sourceContent: raw, policy } = readRawCapsule2OrdinaryPolicySourceOwned(db)
      const observer = readRawCapsule2ObserverOwned(db)
      assert.equal(raw.encoding, encoding)
      const settings = raw.tables.find(table => table.name === 'app_settings')!
      assert.equal(settings.rows[0].sourceRowId, '-42')
      assert.equal(decodedCapsule2Table(raw, 'app_settings')[0].value, opaque)
      const previous = (domain: string, value: unknown = raw) => capsuleBytesHash(domain + '\0' + capsuleJson(value))
      assert.equal(capsule2RawContentHash(raw), previous('knowbook.capsule2.raw-content.v1'))
      assert.equal(observer.rawContentHash, previous('knowbook.capsule2.observer-content.v1'))
      assert.equal(policy.sourceContentHash, previous('knowbook.capsule2.workspace-history-source-content.v1'))
      const evidence = readRawCapsule2OrdinaryPolicyEvidenceOwned(db)
      assert.deepEqual(evidence.policy, policy)
      assert.equal('sourceContent' in evidence, false)
      assert.equal(root3SupplementSourceContentHash3(raw), policy.sourceContentHash)
      assert.throws(() => observeRawCapsule2TablesOwned(db, table => {
        table.rows[Symbol.iterator]().next()
      }), /必须读完原表/)
      const tableHashes: string[] = [], tableDomain = 'knowbook.restore.stage3.exact-table.v1'
      const header = observeRawCapsule2TablesOwned(db, table => {
        tableHashes.push(hashValidatedCapsule2RawSqlTable(tableDomain, table))
      })
      const { tables, ...originalHeader } = raw
      assert.deepEqual(header, originalHeader)
      assert.deepEqual(tableHashes, tables.map(table => previous(tableDomain, table)))
      const pairs: Array<readonly [string, string]> = []
      observeRawCapsule2TablesOwned(db, table => {
        let ordinal = 0
        pairs.push(hashValidatedCapsule2RawSqlTablePair(tableDomain, table,
          () => { const index = ordinal++; return [index % 2 === 0, index % 3 === 1] }))
      })
      assert.deepEqual(pairs, tables.map(table => [
        previous(tableDomain, { ...table, rows: table.rows.filter((_, index) => index % 2 === 0) }),
        previous(tableDomain, { ...table, rows: table.rows.filter((_, index) => index % 3 === 1) })
      ]))
      for (const table of policy.tables) {
        const original = raw.tables.find(source => source.name === table.table)!
        assert.equal(table.originalTableHash, previous('knowbook.capsule2.source-policy-original-table.v1', original))
      }
    })())
  }, encoding))

test('capsule2 raw content keeps a real mixed ordinary501 and Main group source without changing the public wire500 rule', () => withV3Fixture(async f => {
  const { title, template, documentId } = writeMixedOrdinary501(f)
  f.store.saveSetting('ai.apiKey', 'capsule2-private-test-secret')
  await withCapsule2RawCopy(f, db => {
    assert.throws(() => readRawCapsule2ContentOwned(db), /owned事务/)
    const before = db.prepare('SELECT total_changes() AS count').get()
    assert.throws(() => db.transaction(() => readInitialIncomingWorkspace(db))(), /文档标题无效/)
    const raw = db.transaction(() => readRawCapsule2ContentOwned(db))()
    assert.equal(decodedCapsule2Table(raw, 'documents').find(row => row.id === documentId)?.title, title)
    assert.equal(decodedCapsule2Table(raw, 'synced_groups').length, 1)
    assert.equal(decodedCapsule2Table(raw, 'document_templates').find(row => row.id === template.id)?.blocks_json,
      (db.prepare('SELECT blocks_json FROM document_templates WHERE id=?').get(template.id) as { blocks_json: string }).blocks_json)
    assert.ok(decodedCapsule2Table(raw, 'synced_operations').length > 0)
    assert.equal(raw.semanticValidationComplete, false); assert.equal(raw.certified, false)
    const diagnostic = JSON.stringify(diagnoseCapsule2RawContent(raw))
    assert.equal(diagnostic.includes('capsule2-private-test-secret'), false)
    assert.equal(diagnostic.includes(title), false)
    assert.throws(() => validateCapsule2RawContent({ ...raw, certified: true }), /非授权状态/)
    assert.deepEqual(db.prepare('SELECT total_changes() AS count').get(), before)
  })
}))

test('capsule2 raw content preserves actual ordinary history rowid order and all NULL-composite-PK occurrences as unvalidated storage', () => withV3Fixture(async f => {
  const { title, documentId } = writeMixedOrdinary501(f)
  f.store.documentRecovery.checkpoint(documentId, 'edit', true)
  const detail = f.store.getDocumentDetail(documentId); assert.ok(detail)
  f.store.updateDocument(documentId, { title, summary: 'A real later ordinary summary', blocks: detail.blocks })
  f.store.documentRecovery.checkpoint(documentId, 'edit', true)
  const dropped = f.store.createDocument(null)
  f.store.deleteDocument(dropped)
  f.db.prepare('UPDATE document_history SET _rowid_=? WHERE _rowid_=(SELECT min(_rowid_) FROM document_history)').run(-(2n ** 63n))
  // Legal SQLite legacy storage shape, deliberately not claimed to have a
  // valid semantic owner. Raw preparation must retain it for the later owner.
  const insert = f.db.prepare('INSERT INTO document_database_values(document_id,column_id,value_text,updated_at,entity_id) VALUES(NULL,?,?,?,NULL)')
  insert.run(f.catalogColumn.id, 'legacy A', '2048-01-02T03:04:05.000Z')
  insert.run(f.catalogColumn.id, 'legacy B', '2048-01-02T03:04:05.000Z')
  await withCapsule2RawCopy(f, async db => {
    const raw = db.transaction(() => readRawCapsule2ContentOwned(db))(), history = raw.tables.find(table => table.name === 'document_history'); assert.ok(history)
    const actual = db.prepare('SELECT rowid FROM document_history ORDER BY rowid').safeIntegers(true).all() as Array<{ rowid: bigint }>
    assert.deepEqual(history.rows.map(row => row.sourceRowId), actual.map(row => row.rowid.toString()))
    const values = decodedCapsule2Table(raw, 'document_database_values').filter(row => row.document_id === null && row.entity_id === null)
    assert.deepEqual(values.map(row => row.value_text), ['legacy A', 'legacy B'])
    assert.equal(raw.state, 'raw-storage-only'); assert.equal(raw.semanticValidationComplete, false)
    const domain = 'test.active-original'
    const scoped = await withReferenceOriginalRows5(async store => scopeIncomingReferenceHistory5(raw, store), async parked => {
      assert.equal(hashValidatedCapsule2RawContent(domain, parked), capsuleBytesHash(domain + '\0' + capsuleJson(raw)))
      for (const name of ['document_history', 'document_trash']) {
        const before = raw.tables.find(table => table.name === name)!, table = parked.tables.find(table => table.name === name)!
        assert.ok(before.rows.length > 0)
        assert.throws(() => table.rows, /逐行读取范围/)
        assert.equal(capsule2RawTableRowCount(table), before.rows.length)
        assert.deepEqual([...capsule2RawTableRows(table)], before.rows)
        assert.equal(hashValidatedCapsule2RawSqlTable(domain, table), capsuleBytesHash(domain + '\0' + capsuleJson(before)))
        for (const row of before.rows) assert.deepEqual(findGraph3OriginalRow(table, row.sourceRowId), row)
        assert.equal(findGraph3OriginalRow(table, '9223372036854775808'), undefined)
      }
      return parked.tables.find(table => table.name === 'document_history')!
    })
    assert.throws(() => [...capsule2RawTableRows(scoped)], /读取范围已结束/)
    assert.throws(() => findGraph3OriginalRow(scoped, '-9223372036854775808'), /读取范围已结束/)
  })
}))

test('capsule2 raw content rejects unknown ordinary columns and preserves the unsupported source instead of silently pruning it', () => withV3Fixture(async f => {
  writeMixedOrdinary501(f)
  f.db.pragma('foreign_keys=OFF')
  f.db.prepare('UPDATE blocks SET document_id=? WHERE id=?').run('missing-owner', f.targetBodyId)
  await withCapsule2RawCopy(f, db => {
    assert.throws(() => db.transaction(() => readRawCapsule2ContentOwned(db))(), /原SQL物理\/FK完整性失败/)
  })
  f.db.exec('ALTER TABLE documents ADD COLUMN future_content TEXT')
  f.db.prepare('UPDATE documents SET future_content=? WHERE id=?').run('must not disappear', f.targetId)
  await withCapsule2RawCopy(f, db => {
    assert.throws(() => db.transaction(() => readRawCapsule2ContentOwned(db))(), /未知.*普通列/)
    assert.equal((db.prepare('SELECT future_content FROM documents WHERE id=?').get(f.targetId) as { future_content: string }).future_content, 'must not disappear')
  })
}))
