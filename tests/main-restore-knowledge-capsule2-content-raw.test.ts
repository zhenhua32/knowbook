import assert from 'node:assert/strict'
import test from 'node:test'
import { observeRawCapsule2TablesOwned, readRawCapsule2ContentOwned } from '../src/main/database/restore-knowledge-capsule2-content-raw-read'
import { capsule2RawContentHash, capsule2RawTableRows, capsule2RawTableRowCount, diagnoseCapsule2RawContent, hashValidatedCapsule2RawContent,
  hashValidatedCapsule2RawSqlTable, hashValidatedCapsule2RawSqlTablePair,
  validateCapsule2RawContent } from '../src/main/database/restore-knowledge-capsule2-raw-model'
import { readRawCapsule2ObserverOwned } from '../src/main/database/restore-knowledge-capsule2-observer-read'
import { readRawCapsule2OrdinaryPolicyEvidenceOwned, readRawCapsule2OrdinaryPolicySourceOwned } from '../src/main/database/restore-knowledge-capsule2-policy-source-read'
import { capsuleBytesHash, capsuleJson } from '../src/main/database/restore-knowledge-capsule-model'
import { hashBoundedCapsuleJson } from '../src/main/database/restore-knowledge-capsule-json-hash'
import { root3SupplementSourceContentHash3 } from '../src/main/database/restore-knowledge-assets3-context'
import { findGraph3OriginalRow, graph3Key, graph3TablesHashInput, type Graph3Inputs } from '../src/main/database/restore-knowledge-graph3-data'
import { scopeCurrentReferenceBlocks5, scopeIncomingReferenceTables5, withReferenceOriginalRows5 } from '../src/main/database/restore-knowledge-reference-original-rows5'
import { assertRootRestoreStage3ExactTable3 } from '../src/main/database/restore-knowledge-stage3-physical'
import { readRawCapsule2SourceKnowledgeOwned } from '../src/main/database/restore-knowledge-payload-raw-read'
import { createOriginalPhysicalNavigationReader3, deriveRootRestoreNavigationRewriteInputs3 } from '../src/main/database/restore-knowledge-navigation3-model'
import { validateCurrentHeadingSemantics } from '../src/main/database/restore-knowledge-canonical3-model'
import { getMarkdownHeadingTargets } from '../src/shared/markdownLinkMaintenance'
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
  f.db.prepare('UPDATE synced_group_blocks SET _rowid_=? WHERE _rowid_=(SELECT min(_rowid_) FROM synced_group_blocks)').run(-(2n ** 63n))
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
    const scoped = await withReferenceOriginalRows5(async store => scopeIncomingReferenceTables5(raw, store), async parked => {
      assert.equal(hashValidatedCapsule2RawContent(domain, parked), capsuleBytesHash(domain + '\0' + capsuleJson(raw)))
      for (const name of ['blocks', 'synced_group_blocks', 'document_history', 'document_trash']) {
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

test('Stage3 checks scoped current ordinary and canonical blocks against native rowid, storage class and exact bytes', () => withV3Fixture(async f => {
  const { id: canonicalId } = f.db.prepare('SELECT id FROM synced_group_blocks ORDER BY _rowid_ LIMIT 1').get() as { id: string }
  f.db.prepare('UPDATE blocks SET content=? WHERE id=?').run('Original ASCII cells', f.targetBodyId)
  f.db.prepare('UPDATE blocks SET _rowid_=? WHERE id=?').run(-(2n ** 63n), f.targetBodyId)
  f.db.prepare('UPDATE synced_group_blocks SET _rowid_=?,content=? WHERE id=?').run(-(2n ** 63n), 'Original ASCII cells', canonicalId)
  const raw = await withCapsule2RawCopy(f, db => db.transaction(() => readRawCapsule2ContentOwned(db))())
  await withReferenceOriginalRows5(async store => scopeCurrentReferenceBlocks5(raw, store), async current => {
    const blocks = current.tables.find(table => table.name === 'blocks')!
    const canonical = current.tables.find(table => table.name === 'synced_group_blocks')!
    assert.throws(() => blocks.rows, /逐行读取范围/)
    assert.throws(() => canonical.rows, /逐行读取范围/)
    const cutDomain = 'knowbook.restore.stage3.retained-cut.all-original-tables.v1\0'
    assert.equal(hashBoundedCapsuleJson(graph3TablesHashInput(current.tables), Number.MAX_SAFE_INTEGER, cutDomain),
      capsuleBytesHash(cutDomain + capsuleJson(raw.tables)))
    await withCapsule2RawCopy(f, db => db.transaction(() => {
      assert.equal(assertRootRestoreStage3ExactTable3(db, blocks, current.encoding), blocks)
      assert.equal(assertRootRestoreStage3ExactTable3(db, canonical, current.encoding), canonical)
    })())
    f.db.prepare('UPDATE synced_group_blocks SET content=? WHERE id=?').run('Changed! ASCII cells', canonicalId)
    await withCapsule2RawCopy(f, db => db.transaction(() => {
      assert.equal(assertRootRestoreStage3ExactTable3(db, blocks, current.encoding), blocks)
      assert.throws(() => assertRootRestoreStage3ExactTable3(db, canonical, current.encoding), /storage class\/bytes不符：synced_group_blocks:-9223372036854775808/)
    })())
    f.db.prepare('UPDATE blocks SET content=CAST(? AS BLOB) WHERE id=?').run('Original ASCII cells', f.targetBodyId)
    await withCapsule2RawCopy(f, db => db.transaction(() => {
      assert.throws(() => assertRootRestoreStage3ExactTable3(db, blocks, current.encoding), /storage class\/bytes不符.*-9223372036854775808/)
    })())
  })
}))

test('incoming physical group bodies keep their verified semantics and expand by original host', () => withV3Fixture(async f => {
  const captured = await withCapsule2RawCopy(f, db => db.transaction(() => readRawCapsule2SourceKnowledgeOwned(db))())
  const original = captured.source.physical
  const physicalHash = capsuleBytesHash(capsuleJson(original)), plain = createOriginalPhysicalNavigationReader3(original)
  const linked = original.documents.find(document => original.instances.some(instance => instance.host_document_id === document.documentId))!
  const unlinked = original.documents.find(document => !original.instances.some(instance => instance.host_document_id === document.documentId))!
  assert.ok(linked && unlinked)
  const groups = new Set(original.instances.filter(instance => instance.host_document_id === linked.documentId).map(instance => instance.group_id))
  assert.ok(groups.size > 0)
  const assignments = [
    ...original.documents.map(doc => ({ kind: 'document', sourceId: doc.documentId, birth: doc.createdAt, ownerKind: null, ownerId: null })),
    ...original.identities.filter(row => row.state === 'live').map(row => ({ kind: 'block', sourceId: row.id, birth: row.created_at,
      ownerKind: row.last_owner_kind, ownerId: row.last_owner_id }))
  ].map(row => ({ ...row, key: row.sourceId, targetId: row.sourceId, physical: true, ambiguous: false }))
  const source = { ...captured, materialHash: '1'.repeat(64) }
  const data = { inputs: { source, current: { materialHash: '2'.repeat(64) },
    knowledge: { conservationHash: '3'.repeat(64), constraints: { root: {} } } },
    value: { assignments, sourceWitness: {}, sourcePayload: '4'.repeat(64), allocationHash: '5'.repeat(64) } } as unknown as Graph3Inputs
  const plainNavigation = deriveRootRestoreNavigationRewriteInputs3(data)
  const { expand, scopedLinked, scopedUnlinked } = await withReferenceOriginalRows5(async (storeRows, storeGroups) => {
    assert.throws(() => storeGroups({ ...original }), /已验证的物理原件/)
    return { scoped: storeGroups(original), sourceContent: scopeIncomingReferenceTables5(captured.source.sourceContent, storeRows) }
  }, async ({ scoped, sourceContent }) => {
    assert.equal(capsuleBytesHash(capsuleJson(scoped)), physicalHash)
    const snapshot = scoped.groups.find(group => group.snapshot)?.snapshot
    assert.ok(snapshot)
    assert.equal(typeof Object.getOwnPropertyDescriptor(snapshot, 'blocks')?.get, 'function')
    assert.ok(Object.isFrozen(snapshot.blocks))
    const scopedLinked = scoped.documents.find(doc => doc.documentId === linked.documentId)!
    const scopedUnlinked = scoped.documents.find(doc => doc.documentId === unlinked.documentId)!
    assert.notEqual(scopedLinked, linked)
    assert.equal(typeof Object.getOwnPropertyDescriptor(scopedLinked, 'blocks')?.get, 'function')
    assert.ok(Object.isFrozen(scopedLinked.blocks))
    assert.deepEqual(scopedLinked.blocks, linked.blocks)
    const read = createOriginalPhysicalNavigationReader3(scoped)
    assert.deepEqual([...read(scopedLinked, groups)], [...plain(linked, groups)])
    assert.deepEqual([...read(scopedUnlinked, new Set())], [...plain(unlinked, new Set())])
    assert.throws(() => read(linked, groups), /navigation-original-physical-host/)
    const scopedData = { ...data, inputs: { ...data.inputs, source: { ...data.inputs.source,
      source: { ...captured.source, sourceContent, physical: scoped } } } }
    assert.deepEqual(deriveRootRestoreNavigationRewriteInputs3(scopedData), plainNavigation)
    return { expand: read, scopedLinked, scopedUnlinked }
  })
  assert.throws(() => [...expand(scopedUnlinked, new Set())], /读取范围已结束/)
  assert.throws(() => [...expand(scopedLinked, groups)], /读取范围已结束/)
}))

test('current scoped groups preserve host heading identity and exact anchor text with the same group ID on both sides', () => withV3Fixture(async f => {
  const capture = () => withCapsule2RawCopy(f, db => db.transaction(() => readRawCapsule2SourceKnowledgeOwned(db))())
  const findGroup = (physical: Awaited<ReturnType<typeof capture>>['source']['physical']) =>
    physical.groups.find(group => group.groupId === f.groupId)!.snapshot!
  const source = (await capture()).source
  const unmodified = findGroup(source.physical).blocks[0]
  const anchor = '锚点-anchor'
  const content = unmodified.content + '\n\n<a id="' + anchor + '"></a>'
  assert.equal(f.db.prepare('UPDATE synced_group_blocks SET content=? WHERE id=?').run(content, unmodified.id).changes, 1)
  const current = (await capture()).source
  const group = findGroup(current.physical)
  const block = group.blocks[0]
  const host = current.physical.documents.find(document => document.documentId === f.hostId)!
  const occurrenceId = graph3Key(f.instanceId, block.id)
  const heading = getMarkdownHeadingTargets([{ ...block, id: occurrenceId }], host.title).find(heading => heading.slug === anchor)!
  assert.equal(heading.blockId, occurrenceId)
  const projection = { side: 'current' as const, rowKey: 'binding', proofKind: 'current-domain-preserved',
    binding: { ...group.bindings[0], target: { kind: 'heading' as const, state: 'live' as const, documentId: f.hostId, slug: anchor } } }
  type Final = Parameters<typeof validateCurrentHeadingSemantics>[1]
  const final = (changed: string, instanceId = f.instanceId): Final => {
    const document = { id: f.hostId, birth: host.createdAt } as Final['headingNamespaces'][number]['document']
    const location = { blockId: block.id, instanceId, blockBirth: block.createdAt,
      instanceBirth: current.physical.identities.find(row => row.id === f.instanceId)!.created_at } as NonNullable<Final['headingNamespaces'][number]['headings'][number]['location']>
    return { headingNamespaces: [{ document, headings: [{ ...heading, location }] }],
      physicalBlock: () => ({ block: { type: block.type, content: changed } }) }
  }
  function conflicts(original: typeof current, finalIndex: Final) {
    const codes: string[] = []
    validateCurrentHeadingSemantics(original, finalIndex, [projection], code => codes.push(code))
    return codes
  }
  const replacement = 'canonical3-current-heading-occurrence-replaced'
  assert.deepEqual(conflicts(current, final(content)), [])
  assert.deepEqual(conflicts(current, final(content + ' changed')), [replacement])
  await withReferenceOriginalRows5(async (store, storeGroups) => {
    const incoming = storeGroups(source.physical)
    const physical = storeGroups(current.physical, 'current')
    assert.throws(() => storeGroups(current.physical, 'current'), /语义正文角色重复/)
    return { incoming, scoped: { ...current, physical, sourceContent: scopeCurrentReferenceBlocks5(current.sourceContent, store) } }
  }, async ({ incoming, scoped }) => {
    assert.deepEqual(findGroup(incoming).blocks, [unmodified])
    assert.deepEqual(findGroup(scoped.physical).blocks, group.blocks)
    assert.equal(capsuleBytesHash(capsuleJson(scoped.physical)), capsuleBytesHash(capsuleJson(current.physical)))
    assert.deepEqual(conflicts(scoped, final(content)), [])
    assert.deepEqual(conflicts(scoped, final(content + ' changed')), [replacement])
    assert.deepEqual(conflicts(scoped, final(content, 'borrowed-instance')), [replacement])
  })
}))
