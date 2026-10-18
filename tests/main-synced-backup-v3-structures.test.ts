import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
import type { SyncedStableBlockDraft } from '../src/shared/synced-blocks'
import { canBlockNestUnder } from '../src/shared/blockTypes'
import { writeSyncedBackupV3 } from '../src/main/backup/v3-export'
import { readBackupV3Archive } from '../src/main/backup/v3-reader'
import { withV3Fixture, request, applied, applySyncedHostFinal, createRequest, created, applySyncedHostCommand,
  logical, snapshot, freshBlock, randomUUID, allTables } from './helpers/synced-backup-v3-fixture'

test('V3 actual Main weighted columns and nested toggle retain the complete raw host forest and transparent group reference', () => withV3Fixture(f => {
  const columns = ' v3:columns 中文 ', left = ' v3:left raw ', right = ' v3:right raw ', toggle = ' v3:toggle raw '
  const leftBody = ' v3:left ordinary ', rightBody = ' v3:right ordinary '
  const input = request(f.db, [f.hostId], after => {
    const reference = after[0].blocks.find(block => block.id === f.instanceId)
    assert.ok(reference, 'The nested structure moves the existing actual registered Main instance')
    const remaining = after[0].blocks.filter(block => block.id !== f.instanceId)
    after[0].blocks = [
      { ...freshBlock(columns, ''), type: 'columns' },
      { ...freshBlock(left, ''), type: 'column', depth: 1, parentBlockId: columns, markdownFormat: { columnWeight: 3500 } },
      { ...freshBlock(toggle, 'Toggle title with **real Markdown**'), type: 'toggle', depth: 2, parentBlockId: left, markdownFormat: { toggleDefaultOpen: true } },
      { ...reference, depth: 3, parentBlockId: toggle },
      { ...freshBlock(leftBody, 'Left ordinary **body**'), depth: 2, parentBlockId: left },
      { ...freshBlock(right, ''), type: 'column', depth: 1, parentBlockId: columns, markdownFormat: { columnWeight: 6500 } },
      { ...freshBlock(rightBody, 'Right ordinary [literal](https://example.invalid/)'), depth: 2, parentBlockId: right },
      ...remaining
    ]
  })
  const ack = applied(applySyncedHostFinal(f.db, input))
  assert.equal(ack.status, 'applied')
  const before = logical(f.db, f.hostId), groupBefore = snapshot(f.db, f.groupId)
  assert.ok(groupBefore.blocks.filter(block => block.depth === 0).every(block => canBlockNestUnder('toggle', block.type)),
    'The actual canonical roots are valid children of the true enclosing toggle')
  assert.equal(groupBefore.instances.find(instance => instance.instanceId === f.instanceId)?.parentType, 'toggle')
  assert.equal(groupBefore.instances.find(instance => instance.instanceId === f.instanceId)?.depth, 3)
  writeSyncedBackupV3(f.db, { userDataRoot: f.userDataRoot, destination: f.destination, snapshotId: randomUUID() })
  const archive = readBackupV3Archive(f.destination), host = archive.documents.find(document => document.id === f.hostId)
  assert.ok(host, 'The independently read archive includes the real structured host')
  assert.deepEqual(host.blocks.map(({ sortOrder: _order, ...block }) => block), before.blocks)
  assert.deepEqual(host.blocks.map(block => [block.id, block.depth, block.parentBlockId]), before.blocks.map(block => [block.id, block.depth, block.parentBlockId]))
  const group = archive.groups.find(group => group.wire.id === f.groupId)
  assert.ok(group, 'The nested instance still depends on the original full canonical file')
  assert.deepEqual(group.wire.blocks, groupBefore.blocks)
  assert.deepEqual(group.wire.bindings, groupBefore.bindings)
  assert.equal(archive.manifest.syncedInstances.find(instance => instance.id === f.instanceId)?.ownerDocumentId, f.hostId)
}))

test('V3 actual Main list-root group moved below a list parent preserves its raw reference and complete list forest', () => withV3Fixture(f => {
  const canonicalId = ' v3:canonical bullet ', parentId = ' v3:host bullet '
  const create = createRequest(f.db, { documentId: f.hostId, selectedRootIds: [canonicalId], dirty(working) {
    working.blocks.push({ ...freshBlock(canonicalId, 'Canonical **bullet** body'), type: 'bulleted-list', markdownFormat: { listMarker: '-', listLoose: false } })
  } })
  const creation = created(applySyncedHostCommand(f.db, create))
  assert.equal(creation.createdLifecycle.state, 'active')
  const groupBefore = snapshot(f.db, create.action.groupId)
  assert.ok(groupBefore.blocks.filter(block => block.depth === 0).every(block => canBlockNestUnder('bulleted-list', block.type)),
    'A list parent is used only after a real Main create produced canonical list roots')
  const input = request(f.db, [f.hostId], after => {
    const index = after[0].blocks.findIndex(block => block.id === create.action.instanceId)
    assert.ok(index >= 0, 'The true newly created instance is present before the Main host-final move')
    const parent: SyncedStableBlockDraft = { ...freshBlock(parentId, 'Parent **bullet** body'), type: 'bulleted-list', markdownFormat: { listMarker: '*', listLoose: false } }
    after[0].blocks.splice(index, 1, parent, { ...after[0].blocks[index], depth: 1, parentBlockId: parentId })
  })
  assert.equal(applied(applySyncedHostFinal(f.db, input)).status, 'applied')
  const before = logical(f.db, f.hostId), positioned = snapshot(f.db, create.action.groupId)
  assert.equal(positioned.instances.find(instance => instance.instanceId === create.action.instanceId)?.parentType, 'bulleted-list')
  assert.equal(positioned.instances.find(instance => instance.instanceId === create.action.instanceId)?.depth, 1)
  writeSyncedBackupV3(f.db, { userDataRoot: f.userDataRoot, destination: f.destination, snapshotId: randomUUID() })
  const archive = readBackupV3Archive(f.destination), host = archive.documents.find(document => document.id === f.hostId)
  assert.ok(host, 'The independent reader returns the true host with its list-owned transparent reference')
  assert.deepEqual(host.blocks.map(({ sortOrder: _order, ...block }) => block), before.blocks)
  const reference = host.blocks.find(block => block.id === create.action.instanceId)
  assert.ok(reference, 'The list-owned instance remains the original leaf identity')
  assert.equal(reference.type, 'synced-block')
  assert.equal(reference.depth, 1)
  assert.equal(reference.parentBlockId, parentId)
  assert.equal(reference.content, before.blocks.find(block => block.id === create.action.instanceId)?.content)
  assert.deepEqual(archive.groups.find(group => group.wire.id === create.action.groupId)?.wire.blocks, groupBefore.blocks)
  assert.equal(archive.manifest.syncedInstances.filter(instance => instance.id === create.action.instanceId).length, 1)
}))

test('V3 actual Main paragraphs that cannot roundtrip literal metadata or CRLF fail closed before possible exposure and external output', async () => {
  for (const content of [
    'before\n<!-- knowbook:block {"id":"literal metadata ID","type":"paragraph","depth":0,"parentBlockId":null} -->\nafter',
    'first real line\r\nsecond real line'
  ]) await withV3Fixture(f => {
    const input = request(f.db, [f.hostId], after => {
      const body = after[0].blocks.find(block => block.id === f.hostBodyId)
      assert.ok(body, 'The refusal oracle edits the actual ordinary host body through Main')
      body.content = content
    })
    assert.equal(applied(applySyncedHostFinal(f.db, input)).status, 'applied')
    assert.equal(logical(f.db, f.hostId).blocks.find(block => block.id === f.hostBodyId)?.content, content)
    const before = allTables(f.db)
    assert.throws(() => writeSyncedBackupV3(f.db, { userDataRoot: f.userDataRoot, destination: f.destination, snapshotId: randomUUID() }))
    assert.equal(existsSync(f.destination), false)
    assert.deepEqual(allTables(f.db), before, 'A non-lossless V3 projection cannot commit even a possible exposure row')
    assert.equal(logical(f.db, f.hostId).blocks.find(block => block.id === f.hostBodyId)?.content, content)
  })
})
