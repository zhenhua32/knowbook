import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveSyncedCanonicalBlockAddress } from '../src/main/database/synced-canonical-block-navigation'
import { markdownEngine } from '../src/shared/markdownEngine'
import { collectMarkdownSourceLinks } from '../src/shared/markdownLinks'
import { parseWikiReference } from '../src/shared/markdownWiki'
import { formatSyncedCanonicalBlockAddress, parseSyncedCanonicalBlockAddress, type SyncedCanonicalBlockAddress } from '../src/shared/synced-canonical-block-address'
import { withCapsule2RawCopy } from './helpers/capsule2-raw-fixture'
import { allTables, applySyncedHostCommand, createRequest, created, freshBlock, makeV3Orphan, randomUUID, snapshot, withV3Fixture } from './helpers/synced-backup-v3-fixture'
import { restoreCreated } from './helpers/synced-host-command-create-fixture'
import { command } from './helpers/synced-host-command-insert-fixture'
import { totalChanges } from './helpers/synced-host-final-fixture'

const olderBirth = '2000-01-01T00:00:00.000Z'

test('canonical block addresses preserve opaque UTF-8 identities and accept only their one exact URI spelling', () => {
  const identity: SyncedCanonicalBlockAddress = { groupId: 'b9321264-877d-4c85-8a92-7cab957f1c53',
    creationId: 'b5912708-76c9-4dcf-b297-7bff97e69fd4', groupCreatedAt: olderBirth, blockId: ' 块/%?#()\\\0 ',
    blockCreatedAt: '2000-01-01T00:00:01.000Z' }
  const uri = formatSyncedCanonicalBlockAddress(identity)
  assert.equal(uri, 'knowbook-sync-block://b9321264-877d-4c85-8a92-7cab957f1c53/b5912708-76c9-4dcf-b297-7bff97e69fd4/'
    + '%20%E5%9D%97%2F%25%3F%23%28%29%5C%00%20?groupBirth=2000-01-01T00%3A00%3A00.000Z&blockBirth=2000-01-01T00%3A00%3A01.000Z')
  assert.deepEqual(parseSyncedCanonicalBlockAddress(uri), identity)
  assert.equal(markdownEngine.normalizeLink(uri), uri)
  const source = `[direct](${uri}) [[${uri}|别名]] [via definition][target]\n\n[target]: <${uri}>`
  assert.deepEqual(collectMarkdownSourceLinks(source).map(link => [link.kind, link.kind === 'wiki' ? parseWikiReference(link.url).target : link.url]),
    [['link', uri], ['wiki', uri], ['definition', uri]])
  const dot = { ...identity, blockId: '..' }
  const dotUri = formatSyncedCanonicalBlockAddress(dot)
  assert.match(dotUri, /\/%2E%2E\?/)
  assert.equal(markdownEngine.normalizeLink(dotUri), dotUri)
  assert.deepEqual(parseSyncedCanonicalBlockAddress(dotUri), dot)
  assert.throws(() => formatSyncedCanonicalBlockAddress({ ...identity, blockCreatedAt: '2000-01-01T00:00:01Z' }))
  const extra = { ...identity, instanceId: randomUUID() }
  assert.throws(() => formatSyncedCanonicalBlockAddress(extra))
  for (const invalid of [null, {}, 'https://example.test', '/Host.md#^target', uri.replace('knowbook-sync-block', 'https'),
    uri.replace('knowbook-sync-block', 'KNOWBOOK-SYNC-BLOCK'), uri.replace('%2F', '%2f'), uri.replace('%2F', '/'),
    uri.replace('%2F', '%ZZ'), uri.replace('%3A', ':'), uri.replace('://', '://username@'), uri + '#anchor', uri + '\n',
    uri + '&instanceId=' + randomUUID(), uri + '&blockBirth=2000-01-01T00%3A00%3A00.000Z', dotUri.replace('%2E%2E', '..')]) {
    assert.equal(parseSyncedCanonicalBlockAddress(invalid), null, JSON.stringify(invalid))
  }
})

test('real canonical address lookup returns only one current exact occurrence and never promotes an ordinary route', () => withV3Fixture(async f => {
  const childId = ' actual canonical 块\0 /?# ' + randomUUID()
  const input = createRequest(f.db, { documentId: f.hostId, selectedRootIds: [childId], dirty(working) {
    working.blocks.push(freshBlock(childId, 'Canonical address native body'))
  } })
  const first = created(applySyncedHostCommand(f.db, input)), group = snapshot(f.db, input.action.groupId)
  const block = group.blocks.find(item => item.id === childId)!
  const address: SyncedCanonicalBlockAddress = { groupId: group.groupId, creationId: group.creationId,
    groupCreatedAt: group.createdAt, blockId: block.id, blockCreatedAt: block.createdAt }
  const uri = formatSyncedCanonicalBlockAddress(address)
  const read = (value: unknown = uri) => {
    const original = allTables(f.db), changes = totalChanges(f.db)
    const result = resolveSyncedCanonicalBlockAddress(f.db, value)
    assert.deepEqual(allTables(f.db), original)
    assert.equal(totalChanges(f.db), changes)
    return result
  }
  const initial = read()
  if (initial.status !== 'ready') throw Error('Expected the unique actual occurrence')
  assert.equal(initial.occurrence.instanceId, input.action.instanceId)
  assert.equal(initial.occurrence.hostDocumentId, f.hostId)
  assert.equal(initial.occurrence.canonicalBlockId, childId)
  assert.equal(initial.occurrence.canonicalCreatedAt, block.createdAt)
  assert.equal(f.store.resolveWorkspaceSearchOccurrence(initial.occurrence).status, 'ready')
  assert.equal(f.store.getBlockReference(group.origin.pathAtCreation, '^' + childId), null)
  assert.deepEqual(read(`${group.origin.pathAtCreation}.md#^${childId}`), { status: 'invalid-address' })
  for (const wrong of [{ ...address, creationId: randomUUID() }, { ...address, groupCreatedAt: olderBirth },
    { ...address, blockCreatedAt: olderBirth }]) {
    assert.deepEqual(read(formatSyncedCanonicalBlockAddress(wrong)), { status: 'target-mismatch' })
  }
  assert.deepEqual(read(formatSyncedCanonicalBlockAddress({ ...address, blockId: f.targetBodyId })), { status: 'missing-target' })

  const retired = restoreCreated(f.db, first, 'undo')
  assert.equal(f.store.getBlockReference(group.origin.pathAtCreation, '^' + childId)?.block.id, childId)
  assert.deepEqual(read(), { status: 'missing-target' }, 'A real physical block of the same birth is no longer a canonical target')
  restoreCreated(f.db, retired.ack, 'redo')
  const afterRedo = read()
  if (afterRedo.status !== 'ready') throw Error('The same true reactivated birth must resolve')
  assert.notEqual(afterRedo.occurrence.bindingVersion, initial.occurrence.bindingVersion)
  assert.equal(f.store.resolveWorkspaceSearchOccurrence(initial.occurrence).status, 'stale')
  assert.equal(f.store.resolveWorkspaceSearchOccurrence(afterRedo.occurrence).status, 'ready')

  await withCapsule2RawCopy(f, cold => {
    assert.deepEqual(resolveSyncedCanonicalBlockAddress(cold, uri), afterRedo)
    assert.equal(totalChanges(cold), 0)
  })

  const second = command(f.db, { documentId: f.hostId, groupId: group.groupId })
  assert.equal(applySyncedHostCommand(f.db, second).status, 'applied')
  assert.deepEqual(read(), { status: 'ambiguous-instance' }, 'Even two real references in one host are different occurrences')
  makeV3Orphan(f, second.action.instanceId)
  const again = read()
  if (again.status !== 'ready') throw Error('The unique remaining occurrence must resolve again')
  assert.notEqual(again.occurrence.topologyRevision, afterRedo.occurrence.topologyRevision)
  assert.equal(f.store.resolveWorkspaceSearchOccurrence(again.occurrence).status, 'ready')
  makeV3Orphan(f, input.action.instanceId)
  assert.deepEqual(read(), { status: 'no-instance' })
}))
