import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import type { SyncedGroupWire } from '../src/shared/synced-blocks'
import { hasNoV3RetirementHistoricalReferences, hasNoV3RetirementSqlDependencies } from '../src/main/backup/v3-restore-source-dependencies'
import { readRawCapsule2SourceKnowledgeOwned } from '../src/main/database/restore-knowledge-payload-raw-read'
import { KnowbookStore } from '../src/main/database/store'
import { exchangeSyncedSnapshot } from '../src/main/sync/synced-exchange'
import { accepted, runtime, snapshot, withIncomingFixture } from './helpers/synced-initial-incoming-fixture'

test('V3 retirement distinguishes unrelated original templates and history from live and archived links to the retiring block', () =>
  withIncomingFixture(async fixture => {
    await fixture.publish()
    accepted(await fixture.receive())
    const group = snapshot(fixture.B.db, fixture.orphanId!)
    const wire: SyncedGroupWire = { kind: 'synced-group', id: group.groupId, creationId: group.creationId,
      createdAt: group.createdAt, origin: group.origin, blocks: group.blocks, bindings: group.bindings }
    const blockId = group.blocks[0].id
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
      assert.equal(observe(), true, 'Real unrelated saved templates, original Markdown, and checkpoints permit retirement')
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

      for (const content of [`[[Unknown#^${blockId}|wiki]]`, `[relative](Unknown.md#^${blockId})`]) {
        store.updateDocument(id, { title: 'Ordinary checklist [draft]', summary: '',
          blocks: [heading, { ...currentBlock, content }, quote] }, { skipCheckpoint: true })
        assert.equal(observe(), false, 'An exact ordinary link protects the retiring stable target')
      }
      store.updateDocument(id, { title: 'Ordinary checklist [draft]', summary: '',
        blocks: [heading, { ...currentBlock, content: `<a href="Unknown.md#%5E${blockId}">original HTML link</a>` }, quote] })
      store.documentRecovery.checkpoint(id, 'edit', true)
      assert.equal(observe(), false, 'A live HTML link protects the original stable target')
      store.updateDocument(id, { title: 'Ordinary checklist [draft]', summary: '', blocks: [heading, currentBlock, quote] })
      assert.equal(observe(), false, 'The actual archived pre-edit HTML link still protects the target')
      assert.ok(store.listDocumentTemplates().some(template => template.id === saved.id))
    } finally { store.destroy() }
  }, { orphan: true }))
