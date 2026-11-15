import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { MarkdownLinkIndex } from '../src/main/database/markdown-link-index'
import { a, b, c, allTables, bodyBirth, bodyId, freshBlock, mixedForest, request, totalChanges, withHostDatabase } from './helpers/synced-host-command-move-fixture'
import { ordinary } from './helpers/synced-content-fixture'
import type { HostMoveInput } from '../src/main/database/synced-host-move-plan'
import { readCrossHostMovePlan } from '../src/main/database/synced-host-cross-move-plan'

function moveInput(db: Database.Database, roots: string[], participants = [a, b]): HostMoveInput {
  const before = request(db, participants)
  return { clientOperationId: randomUUID(), mode: 'command', hostsWorkingBefore: before.hostsWorkingBefore,
    groups: before.groups, expectedInstances: before.expectedInstances,
    action: { kind: 'move', selection: { documentId: a, selectedRootIds: roots },
      target: { documentId: b, beforeBlockId: bodyId(b), parentBlockId: null, depth: 0 } } }
}

test('derives the actual mixed subtree transfer and closes a third real indexed inbound rewrite', () => withHostDatabase(db => {
  const mixed = mixedForest(db)
  db.prepare('UPDATE blocks SET content=? WHERE id=?').run(`[[Home/Host A#${mixed.nestedId}|inbound]]`, bodyId(c))
  const links = new MarkdownLinkIndex(db)
  for (const id of [a, b, c]) links.syncDocument(id)
  const start = allTables(db), changes = totalChanges(db)
  assert.throws(() => db.transaction(() => readCrossHostMovePlan(db, moveInput(db, [mixed.owner])))(), /link-participants/)
  const input = moveInput(db, [mixed.owner, mixed.nestedId], [b, a, c])
  input.hostsWorkingBefore[0].workingBefore.summary = 'dirty destination summary'
  const dirty = freshBlock('fresh-target-paragraph', 'untouched dirty target text')
  input.hostsWorkingBefore[0].workingBefore.blocks.push(dirty)
  const expectedBefore = structuredClone(input.hostsWorkingBefore.map(({ documentId, workingBefore }) => ({ documentId, content: workingBefore })))
  const planned = db.transaction(() => readCrossHostMovePlan(db, input))()
  assert.deepEqual(planned.before, expectedBefore)
  assert.deepEqual(planned.moved, [mixed.owner, mixed.nestedId, mixed.child].map(blockId => ({ blockId, from: a, to: b, createdAt: bodyBirth(db, blockId) })))
  assert.equal(planned.after[0].content.summary, 'dirty destination summary')
  assert.deepEqual(planned.after[0].content.blocks.find(block => block.id === dirty.id), dirty)
  const leaf = planned.after[0].content.blocks.find(block => block.id === mixed.nestedId)
  assert.equal(leaf?.type, 'synced-block')
  assert.equal(leaf?.parentBlockId, mixed.owner)
  assert.equal(planned.after[2].content.blocks[0].content, `[[Home/Host B#${mixed.nestedId}|inbound]]`)
  assert.deepEqual(allTables(db), start)
  assert.equal(totalChanges(db), changes)
}))

test('rejects moved headings, stale endpoints, missing anchors and unexplained extra hosts before any write', () => withHostDatabase(db => {
  const mixed = mixedForest(db), heading = 'moved-heading'
  ordinary(db, heading, { owner: a, sort: 20, type: 'heading-2' })
  db.prepare('UPDATE blocks SET content=? WHERE id=?').run('Stable source heading', heading)
  const start = allTables(db), changes = totalChanges(db)
  const read = (input: HostMoveInput) => db.transaction(() => readCrossHostMovePlan(db, input))()
  assert.throws(() => read(moveInput(db, [heading])), /heading-rewrite/)
  assert.throws(() => read(moveInput(db, [mixed.owner], [a, b, c])), /link-participants/)
  const stale = moveInput(db, [mixed.owner]); stale.hostsWorkingBefore[1].expectedPersistedUpdatedAt = '2000-01-01T00:00:00.000Z'
  assert.throws(() => read(stale), /stale-host/)
  const badAnchor = moveInput(db, [mixed.owner]); badAnchor.action.target.beforeBlockId = mixed.child
  assert.throws(() => read(badAnchor), /真实目标锚点/)
  const changedLinks = moveInput(db, [mixed.owner]); changedLinks.hostsWorkingBefore[1].workingBefore.blocks[0].content = '[[Home/Host A]]'
  assert.throws(() => read(changedLinks), /working-links/)
  const noPhysicalOwner = moveInput(db, ['fresh-selected'])
  noPhysicalOwner.hostsWorkingBefore[0].workingBefore.blocks.push(freshBlock('fresh-selected', 'pure W'))
  assert.throws(() => read(noPhysicalOwner), /实际来源活块/)
  const foreign = moveInput(db, [mixed.owner]); foreign.hostsWorkingBefore[0].workingBefore.blocks.push(freshBlock(bodyId(c), 'forged owner'))
  assert.throws(() => read(foreign), /保留身份的 owner\/birth/)
  assert.deepEqual(allTables(db), start)
  assert.equal(totalChanges(db), changes)
}))

test('original triggers carry live identity and permit a re-bound leaf, then rollback a real missed CAS', () => withHostDatabase(db => {
  const mixed = mixedForest(db)
  db.prepare('UPDATE blocks SET content=? WHERE id=?').run(`[[Home/Host A#${mixed.nestedId}|inbound]]`, bodyId(c))
  const linkIndex = new MarkdownLinkIndex(db)
  for (const id of [a, b, c]) linkIndex.syncDocument(id)
  db.prepare('INSERT INTO document_block_routes(document_path, block_id) VALUES(?,?)').run('Home/Host A', mixed.nestedId)
  const start = allTables(db)
  let missed = false

  // This test-only transaction isolates the existing trigger behavior. The
  // normal editor still requires its own guards, routes, journal and receipt.
  const sqlProbe = db.transaction((probeMiss: boolean) => {
    const input = moveInput(db, [mixed.owner], [a, b, c]), plan = readCrossHostMovePlan(db, input)
    const oldLeaf = db.prepare('SELECT * FROM synced_instances WHERE instance_id=?').get(mixed.nestedId) as
      { host_document_id: string; group_id: string; binding_version: string; parent_block_id: string; depth: number }
    const detach = db.prepare('DELETE FROM synced_instances WHERE instance_id=? AND host_document_id=? AND binding_version=?')
    assert.equal(detach.run(mixed.nestedId, oldLeaf.host_document_id, oldLeaf.binding_version).changes, 1)
    const transfer = db.prepare('UPDATE blocks SET document_id=? WHERE id=? AND document_id=? AND created_at=?')
    for (const [index, move] of plan.moved.entries()) {
      // A real earlier row update models the expected predecessor losing its
      // physical address before the guarded transfer reads its exact row.
      if (probeMiss && index === 1) assert.equal(db.prepare('UPDATE blocks SET document_id=? WHERE id=? AND document_id=?')
        .run(c, move.blockId, move.from).changes, 1)
      const outcome = transfer.run(move.to, move.blockId, move.from, move.createdAt)
      if (outcome.changes !== 1) { missed = true; throw new Error('exact owner CAS missed') }
    }
    const binding = randomUUID()
    const insert = db.prepare('INSERT INTO synced_instances(instance_id,group_id,host_document_id,binding_version,parent_block_id,depth) VALUES(?,?,?,?,?,?)')
    assert.equal(insert.run(mixed.nestedId, oldLeaf.group_id, b, binding, oldLeaf.parent_block_id, oldLeaf.depth).changes, 1)
    assert.notEqual(binding, oldLeaf.binding_version)
    return plan
  }).immediate
  assert.throws(() => sqlProbe(true), /exact owner CAS missed/)
  assert.equal(missed, true)
  assert.deepEqual(allTables(db), start)

  const moved = sqlProbe(false)
  for (const item of moved.moved) {
    assert.deepEqual(db.prepare('SELECT document_id,created_at FROM blocks WHERE id=?').get(item.blockId), { document_id: b, created_at: item.createdAt })
    assert.deepEqual(db.prepare('SELECT last_owner_id,state,created_at FROM block_identities WHERE id=?').get(item.blockId),
      { last_owner_id: b, state: 'live', created_at: item.createdAt })
  }
  const after = allTables(db)
  for (const table of ['documents', 'markdown_link_sources', 'links', 'document_block_routes', 'synced_groups']) {
    assert.deepEqual(after[table], start[table])
  }
  assert.deepEqual(db.pragma('foreign_key_check'), [])
}))
