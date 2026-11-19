import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import type { SyncedGroupWire } from '../src/shared/synced-blocks'
import { hasNoV3RetirementHistoricalReferences, hasNoV3RetirementSqlDependencies } from '../src/main/backup/v3-restore-source-dependencies'
import { applyV3RetirementSql } from '../src/main/database/v3-source-group-retirement-sql'
import { readV3SourceGroupRetirementsOwned } from '../src/main/database/v3-source-group-retirement'
import { readRawCapsule2SourceKnowledgeOwned } from '../src/main/database/restore-knowledge-payload-raw-read'
import { KnowbookStore } from '../src/main/database/store'
import { exchangeSyncedSnapshot } from '../src/main/sync/synced-exchange'
import { accepted, runtime, snapshot, withIncomingFixture } from './helpers/synced-initial-incoming-fixture'
import { actualHistorySyntax, insertCoverageSyntax } from './helpers/coverage-raw-sql-fixture'

const customAnchor = 'knowbook-missing-heading-manual'

test('V3 retirement distinguishes unrelated original templates and history from live and archived links to the retiring block', () =>
  withIncomingFixture(async fixture => {
    await fixture.publish()
    accepted(await fixture.receive())
    const group = snapshot(fixture.B.db, fixture.orphanId!)
    const wire: SyncedGroupWire = { kind: 'synced-group', id: group.groupId, creationId: group.creationId,
      createdAt: group.createdAt, origin: group.origin, blocks: group.blocks, bindings: group.bindings }
    const blockId = group.blocks[0].id
    assert.equal(group.blocks[0].type, 'heading-2')
    assert.ok(wire.bindings.some(binding => binding.target.kind === 'block' && binding.target.id === blockId))
    assert.ok(wire.bindings.some(binding => binding.target.kind === 'document' && binding.target.id === fixture.other))
    const store = KnowbookStore.openCanonicalRuntime(fixture.B.file)
    const observe = () => {
      const db = fixture.connect(fixture.B, true)
      try {
        db.pragma('query_only=ON')
        return db.transaction(() => hasNoV3RetirementHistoricalReferences(
          readRawCapsule2SourceKnowledgeOwned(db), [wire], new Set([wire.id])))()
      } finally { db.close() }
    }
    const block = (content: string, type = 'paragraph') => ({ id: randomUUID(), type, checked: false, depth: 0, content })
    try {
      const unrelated = 'Text with [a site](https://example.test) and [[Missing page|wiki]]'
      const id = store.createDocument(null), currentBlock = block(unrelated, 'bulleted-list')
      const heading = block('A different topic', 'heading-2'), quote = block('An independent quotation', 'quote')
      store.updateDocument(id, { title: 'Ordinary checklist [draft]', summary: '[relative](Unknown.md)', blocks: [heading, currentBlock, quote] })
      store.documentRecovery.checkpoint(id, 'edit', true)
      const saved = store.saveDocumentTemplate({ name: 'Independent', title: 'Independent', summary: '[link](Other.md)', blocks: [block(unrelated)] })
      assert.equal(hasNoV3RetirementSqlDependencies(fixture.B.db, [wire]), true)
      assert.equal(observe(), true, 'Real unrelated archives and the retiring group’s own bindings permit retirement')
      const rollback = new Error('Roll back this proof to continue checking dependencies against the original group')
      assert.throws(fixture.B.db.transaction(() => {
        const coverage = actualHistorySyntax(fixture.B.db, '2048-01-02T03:04:05.006Z')
        insertCoverageSyntax(fixture.B.db, coverage)
        const record = { kind: 'v3-source-group-retirement' as const, version: 1 as const,
          operationId: coverage.coverage.operationId, group: wire, sourceGroupId: wire.id, sourceCreationId: wire.creationId,
          sourceSnapshotId: randomUUID(), successorSnapshotId: randomUUID(),
          publicationHeadHash: 'a'.repeat(64), remoteEvidenceHash: 'b'.repeat(64) }
        const header = () => fixture.B.db.prepare('SELECT bindings_json FROM synced_groups WHERE id=?').pluck().get(wire.id)
        const originalBindings = header()
        applyV3RetirementSql(fixture.B.db, [record])
        assert.equal(header(), originalBindings)
        assert.deepEqual(readV3SourceGroupRetirementsOwned(fixture.B.db).get(wire.id), record)
        for (const original of wire.blocks) assert.deepEqual(fixture.B.db.prepare(
          'SELECT state,created_at FROM block_identities WHERE id=?').get(original.id),
        { state: 'retained', created_at: original.createdAt })
        throw rollback
      }).immediate, error => error === rollback)
      const synced = await exchangeSyncedSnapshot(fixture.B.db, fixture.input(), runtime)
      assert.equal(synced.status, 'applied')
      const exists = fixture.B.db.prepare('SELECT 1 FROM block_identities WHERE id=?')
      assert.ok(saved.blocks.every(block => !exists.get(block.id)), 'A real incremental exchange must not reserve template names')

      const dependent = store.saveDocumentTemplate({ name: 'Concrete destination', title: 'Concrete destination', summary: '',
        blocks: [block(`[reference]: Absent.md#%5E${encodeURIComponent(blockId)}\n\n[use][reference]`)] })
      assert.equal(observe(), false, 'A still-unresolved template destination to this exact original block retains the group')
      store.deleteDocumentTemplate(dependent.id)
      const deferred = store.saveDocumentTemplate({ name: 'Deferred destination', title: 'Deferred destination', summary: '',
        blocks: [block('[[#^{{title}}]]')] })
      assert.equal(observe(), false, 'A deferred template cannot prove its target is independent')
      store.deleteDocumentTemplate(deferred.id)
      assert.equal(observe(), true)

      store.updateDocument(id, { title: 'Ordinary checklist [draft]', summary: '[safe](/Other.md#retiring-heading)',
        blocks: [heading, { ...currentBlock, content: '[[Other#Retiring heading|independent]]' }, quote] }, { skipCheckpoint: true })
      assert.equal(observe(), true, 'A matching heading in another documented scope does not refer to the retiring group')
      const oldHeading = 'knowbook-missing-heading-' + Array.from(blockId + ':0',
        character => character.codePointAt(0)!.toString(16)).join('-')
      for (const content of [`[[Unknown#^${blockId}|wiki]]`, `[relative](Unknown.md#^${blockId})`,
        '[heading](Target.md#retiring-heading)', '[[Target#Retiring heading|exact heading]]',
        `[custom anchor](Target.md#${customAnchor})`, `[historical heading](Target.md#${oldHeading})`]) {
        store.updateDocument(id, { title: 'Ordinary checklist [draft]', summary: '',
          blocks: [heading, { ...currentBlock, content }, quote] }, { skipCheckpoint: true })
        assert.equal(observe(), false, 'An exact ordinary block or heading link protects the retiring target')
      }
      store.updateDocument(id, { title: 'Ordinary checklist [draft]', summary: '',
        blocks: [heading, { ...currentBlock, content: '<a href="Target.md#retiring-heading">original HTML link</a>' }, quote] })
      store.documentRecovery.checkpoint(id, 'edit', true)
      assert.equal(observe(), false, 'A live HTML link protects the original stable target')
      store.updateDocument(id, { title: 'Ordinary checklist [draft]', summary: '', blocks: [heading, currentBlock, quote] })
      assert.equal(observe(), false, 'The actual archived pre-edit HTML link still protects the target')
      assert.ok(store.listDocumentTemplates().some(template => template.id === saved.id))
    } finally { store.destroy() }
  }, { orphan: true, richOrphan: true, richOrphanAnchor: customAnchor }))
