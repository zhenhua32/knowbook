import assert from 'node:assert/strict'
import test from 'node:test'
import { MarkdownLinkIndex } from '../src/main/database/markdown-link-index'
import { hostDetachOriginalsFromRaw } from '../src/main/database/restore-knowledge-host-detach-original'
import { readRawCapsule2ContentOwned } from '../src/main/database/restore-knowledge-capsule2-content-raw-read'
import { readRawCapsule2HistoricalEvidenceOwned } from '../src/main/database/restore-knowledge-capsule2-history-read'
import { resolveMarkdownDocumentPath } from '../src/shared/markdownLinks'
import { parseWikiReference, wikiDocumentPaths } from '../src/shared/markdownWiki'
import type { SyncedStructureApplied, SyncedStructureInput } from '../src/shared/synced-blocks'
import { decodedCapsule2Table, withCapsule2RawCopy } from './helpers/capsule2-raw-fixture'
import { allTables, createRequest, freshBlock, randomUUID, snapshot, withV3Fixture, type V3Fixture } from './helpers/synced-backup-v3-fixture'
import { command } from './helpers/synced-host-command-insert-fixture'
import { request, restoreInput, totalChanges } from './helpers/synced-host-final-fixture'

const markdown = './Missing%20Markdown.md?view=compact&from=detach#source-anchor'
const wiki = './Missing Wiki.md#source-anchor|保留 别名'
const copiedMarkdown = '../Unresolved%20Origin/Missing%20Markdown.md?view=compact&from=detach#source-anchor'
const copiedWiki = '/Unresolved Origin/Missing Wiki.md#source-anchor|保留 别名'
const markdownTarget = { kind: 'unresolved-url', path: 'Unresolved Origin/Missing Markdown', fragment: 'source-anchor' }
const wikiTarget = { kind: 'unresolved-url', path: 'Unresolved Origin/Missing Wiki.md', fragment: 'source-anchor' }
const body = (markdownUrl: string, wikiUrl: string) => `[原 Markdown](<${markdownUrl}> "保留标题") [[${wikiUrl}]]`

function ordinary(f: V3Fixture, parentId: string | null, title: string, heading = false) {
  const id = f.store.createDocument(parentId)
  const block = heading ? { ...freshBlock(randomUUID(), 'Source anchor'), type: 'heading-1' as const } : freshBlock(randomUUID(), title)
  f.store.updateDocument(id, { title, summary: '', blocks: [block] })
  return f.store.getDocumentDetail(id)!
}

function prepare(f: V3Fixture) {
  const origin = ordinary(f, null, 'Unresolved Origin')
  const source = ordinary(f, origin.id, 'Origin note')
  const destinationFolder = ordinary(f, null, 'Unresolved Destination')
  const destination = ordinary(f, destinationFolder.id, 'Detached note')
  const markdownDecoy = ordinary(f, destinationFolder.id, 'Missing Markdown', true)
  const wikiDecoy = ordinary(f, destinationFolder.id, 'Missing Wiki', true)
  assert.equal(resolveMarkdownDocumentPath(destination.path, markdown)?.path, markdownDecoy.path)
  const native = new MarkdownLinkIndex(f.db)
  assert.equal(native.resolveWiki(wiki, source.path), null)
  const decoy = native.resolveWiki(wiki, destination.path)
  assert.equal(decoy?.id, wikiDecoy.id)
  assert.equal(decoy?.exists, true, 'Keeping the original relative Wiki spelling would open a different real heading')

  const sender = Object.freeze({ frame: 'detach unresolved Markdown and Wiki' })
  const open = (documentId: string) => {
    const opened = f.store.openSyncedEditingSession(sender, { kind: 'host', hostDocumentId: documentId })
    if (opened.status !== 'ready') throw Error('Expected a real Main editing session')
    return opened.session.sessionId
  }
  const apply = (documentId: string, input: SyncedStructureInput) => f.store.invokeSyncedEditingSession(sender, {
    sessionId: open(documentId), method: 'applySyncedHostStructure', input
  })
  const linkId = randomUUID()
  const create = createRequest(f.db, { documentId: source.id, selectedRootIds: [linkId], dirty(working) {
    working.blocks.push(freshBlock(linkId, body(markdown, wiki)))
  } })
  assert.equal(apply(source.id, create).status, 'applied')
  const groupId = create.action.groupId
  assert.deepEqual(snapshot(f.db, groupId).bindings.map(binding => binding.target), [markdownTarget, wikiTarget])
  const insert = command(f.db, { documentId: destination.id, groupId })
  assert.equal(apply(destination.id, insert).status, 'applied')
  const { hostsWorkingBefore, groups, expectedInstances } = request(f.db, [destination.id])
  const input: SyncedStructureInput = { clientOperationId: randomUUID(), mode: 'command', hostsWorkingBefore, groups, expectedInstances,
    action: { kind: 'detach', groupId, instanceId: insert.action.instanceId } }
  const restore = (result: SyncedStructureApplied, direction: 'undo' | 'redo') => f.store.invokeSyncedEditingSession(sender, {
    sessionId: open(destination.id), method: 'restoreSyncedHostOperation', input: restoreInput(f.db, result, direction)
  })
  return { origin, source, destination, groupId, instanceId: insert.action.instanceId, input, linkId, native,
    detach: () => apply(destination.id, input), restore }
}

test('detach keeps unresolved Markdown and Wiki destinations across folders, with exact cold originals and guarded inverses', () => withV3Fixture(async f => {
  const actual = prepare(f), result = actual.detach()
  if (result.status !== 'applied') throw Error('The two genuinely unresolved destinations must copy: ' + JSON.stringify(result))
  const copiedId = result.blockIdMap.find(item => item.from === actual.linkId)?.to
  assert.ok(copiedId)
  const expected = body(copiedMarkdown, copiedWiki)
  assert.equal(result.hosts[0].after.blocks.find(block => block.id === copiedId)?.content, expected)
  assert.deepEqual(resolveMarkdownDocumentPath(actual.destination.path, copiedMarkdown), resolveMarkdownDocumentPath(actual.source.path, markdown))
  assert.deepEqual(wikiDocumentPaths(parseWikiReference(copiedWiki).path, actual.destination.path),
    ['Unresolved Origin/Missing Wiki.md', 'Unresolved Origin/Missing Wiki'])
  assert.equal(actual.native.resolveWiki(copiedWiki, actual.destination.path), null)
  assert.deepEqual(f.db.prepare('SELECT target_path,fragment FROM markdown_link_sources WHERE source_document_id=? AND source_block_id=? ORDER BY source_offset')
    .all(actual.destination.id, copiedId), [{ target_path: markdownTarget.path, fragment: 'source-anchor' }, { target_path: null, fragment: null }])
  const group = snapshot(f.db, actual.groupId)
  assert.deepEqual(group.bindings.map(binding => binding.target), [markdownTarget, wikiTarget])
  assert.equal(group.instances.some(instance => instance.instanceId === actual.instanceId), false)

  assert.equal(actual.restore(result, 'undo').status, 'applied')
  assert.equal(actual.restore(result, 'redo').status, 'applied')
  assert.equal(f.store.getDocumentDetail(actual.destination.id)?.blocks.find(block => block.id === copiedId)?.content, expected)
  assert.equal(actual.restore(result, 'undo').status, 'applied')

  // The second Wiki candidate (without .md) becomes an actual ordinary heading.
  const newTarget = ordinary(f, actual.origin.id, 'Missing Wiki', true)
  const nowLive = actual.native.resolveWiki(copiedWiki, actual.destination.path)
  assert.equal(nowLive?.id, newTarget.id)
  assert.equal(nowLive?.exists, true)
  const before = allTables(f.db), changes = totalChanges(f.db)
  const denied = actual.restore(result, 'redo')
  assert.ok(denied.status === 'unsupported' || denied.status === 'conflict', JSON.stringify(denied))
  assert.deepEqual(allTables(f.db), before)
  assert.equal(totalChanges(f.db), changes)

  await withCapsule2RawCopy(f, db => {
    const history = db.transaction(() => readRawCapsule2HistoricalEvidenceOwned(db))()
    const fact = history.legacyFacts.find(item => item.family === 'host-detach-ack' && item.locator.key[0] === actual.input.clientOperationId)
    assert.ok(fact?.supports.some(item => item.table === 'synced_host_history' && item.key[0] === result.historyToken))
    const raw = db.transaction(() => readRawCapsule2ContentOwned(db))()
    const operation = decodedCapsule2Table(raw, 'synced_operations').find(row => row.client_operation_id === actual.input.clientOperationId)!
    const original = hostDetachOriginalsFromRaw(raw)(operation)
    assert.equal(original.result.hosts[0].after.blocks.find(block => block.id === copiedId)?.content, expected)
    assert.deepEqual(original.journal.detach.projection.links.map(link => link.resolved.target), [markdownTarget, wikiTarget])
    const journals = decodedCapsule2Table(raw, 'synced_host_history')
    const withoutJournal = { ...raw, tables: raw.tables.map(table => table.name !== 'synced_host_history' ? table :
      { ...table, rows: table.rows.filter((_row, index) => journals[index].id !== result.historyToken) }) }
    assert.throws(() => hostDetachOriginalsFromRaw(withoutJournal)(operation), /解除同步/)
  })
}))

test('detach rejects a stored unresolved Markdown link after the original target appears and makes no SQLite changes', () => withV3Fixture(f => {
  const actual = prepare(f), target = ordinary(f, actual.origin.id, 'Missing Markdown', true)
  assert.equal(target.path, markdownTarget.path)
  assert.deepEqual(snapshot(f.db, actual.groupId).bindings.map(binding => binding.target), [markdownTarget, wikiTarget])
  const before = allTables(f.db), changes = totalChanges(f.db)
  assert.deepEqual(actual.detach(), { status: 'unsupported', reason: 'semantic-binding' })
  assert.deepEqual(allTables(f.db), before)
  assert.equal(totalChanges(f.db), changes)
}))
