import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import test from 'node:test'
import { withV3Fixture, allTables } from './helpers/synced-backup-v3-fixture'
import { EditorRecoveryDraftStore } from '../src/main/editor-recovery/draft-store'
import { EditorRecoveryDraftService } from '../src/main/editor-recovery/draft-service'
import type { KnowbookStore } from '../src/main/database/store'
import type { EditorCloseIpcEvent } from '../src/main/editor-close-barrier'
import type { EditorRecoveryDraftInput } from '../src/shared/editor-recovery-drafts'

class Contents extends EventEmitter {
  readonly id = 13
  readonly mainFrame = { processId: 103, routingId: 203, detached: false }
  isDestroyed() { return false }
  getOSProcessId() { return 303 }
  send(_channel: string, _value: unknown) {}
}
function service(side: EditorRecoveryDraftStore, store: KnowbookStore) {
  const sender = new Contents(), event: EditorCloseIpcEvent = { sender, senderFrame: sender.mainFrame }
  return { event, service: new EditorRecoveryDraftService(side, store, actual => {
    if (actual.sender !== event.sender || actual.senderFrame !== event.senderFrame) throw Error('The original Main frame is required')
  }) }
}

test('an actually saved empty-tag ordinary draft is cold-clean by physical SQL equivalence without changing its original W bytes or losing nonempty metadata', () => withV3Fixture(f => {
  const side = new EditorRecoveryDraftStore(join(f.root, 'empty-tag-recovery'))
  try {
    const id = f.store.createDocument(null), before = f.store.getDocumentDetail(id)!, live = service(side, f.store)
    const opened = live.service.open(live.event, { kind: 'host', documentId: id, expectedUpdatedAt: before.updatedAt, openRequestId: randomUUID() })
    const blocks = before.blocks.map(({ sortOrder: _sortOrder, ...block }) => ({ ...Object.fromEntries(Object.entries(block).filter(([, value]) => value !== undefined)),
      id: block.id, type: block.type, content: 'Saved ordinary A', checked: block.checked, depth: block.depth, parentBlockId: block.parentBlockId, tags: [] as string[] }))
    const draft: EditorRecoveryDraftInput = { draftSessionId: opened.draftSessionId, generation: 1, expectedPreviousGeneration: 0,
      working: { kind: 'host', title: before.title, summary: before.summary, blocks }, sources: [], pending: [], selection: null, composing: false, importing: false }
    const expected = live.service.write(live.event, { records: [draft] }, { kind: 'background' }).records[0]
    const original = side.read(expected)
    f.store.updateDocument(id, { expectedUpdatedAt: before.updatedAt, title: before.title, summary: before.summary, blocks })
    const saved = f.store.getDocumentDetail(id)!
    assert.equal(saved.blocks[0].tags, undefined, 'The actual public DTO omits physically empty SQL tags')
    assert.equal((f.db.prepare('SELECT tags_json FROM blocks WHERE id=?').get(blocks[0].id) as { tags_json: string }).tags_json, '[]')
    assert.deepEqual(original.draft.working.kind === 'host' && original.draft.working.blocks[0].tags, [])
    live.service.releaseSender(live.event.sender)
    const cold = service(side, f.store), rows = allTables(f.db), changes = (f.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
    assert.deepEqual(cold.service.list(cold.event, { limit: 20 }).records, [], 'An explicit empty tags value already persisted in SQL is not an unsaved cold draft')
    assert.equal(side.head(opened.draftSessionId), null)
    assert.deepEqual(side.read(expected), original, 'Only the current head is retired; the immutable raw W is never normalized')
    assert.deepEqual(allTables(f.db), rows)
    assert.equal((f.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n, changes)
    const next = service(side, f.store)
    const current = f.store.getDocumentDetail(id)!
    const nextOpened = next.service.open(next.event, { kind: 'host', documentId: id, expectedUpdatedAt: current.updatedAt, openRequestId: randomUUID() })
    const rawBlocks = blocks.map(block => ({ ...block, tags: ['retained draft metadata'] }))
    const nextDraft: EditorRecoveryDraftInput = { ...draft, draftSessionId: nextOpened.draftSessionId,
      working: { kind: 'host', title: current.title, summary: current.summary, blocks: rawBlocks } }
    const retained = next.service.write(next.event, { records: [nextDraft] }, { kind: 'background' }).records[0]
    f.store.updateDocument(id, { expectedUpdatedAt: current.updatedAt, title: current.title, summary: current.summary,
      blocks: blocks.map(block => ({ ...block, tags: ['different saved metadata'] })) })
    next.service.releaseSender(next.event.sender)
    const later = service(side, f.store), after = allTables(f.db), afterChanges = (f.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
    assert.deepEqual(later.service.list(later.event, { limit: 20 }).records.map(row => row.recordId), [retained.recordId], 'Nonempty authored metadata never acquires empty-tag equivalence')
    assert.deepEqual(side.read(retained).draft, nextDraft)
    assert.deepEqual(allTables(f.db), after)
    assert.equal((f.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n, afterChanges)
  } finally { side.close() }
}))
