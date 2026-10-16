import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { SyncedGroupSnapshot, SyncedGroupWire } from '../src/shared/synced-blocks'
import { canonicalSyncedPortableJson } from '../src/shared/syncedBlockPortable'
import { syncedCanonicalEdits, SYNCED_GROUP_MAX_BYTES } from '../src/shared/syncedBlockValidation'
import { validateSyncedStructureInput } from '../src/shared/syncedBlockInputs'
import { parseMarkdownDocumentBlocks } from '../src/shared/markdownDocument'
import type { MarkdownNode } from '../src/shared/markdownEngine'
import { getSyncedOperation } from '../src/main/database/synced-blocks-content'
import { getSyncedGroupSnapshots, listSyncedGroups } from '../src/main/database/synced-blocks-read'
import { readSyncedGroupLifecycles, syncedLifecycleSemanticHash } from '../src/main/database/synced-lifecycle-state'
import { assertNoUnsupportedSyncedContent } from '../src/main/database/synced-schema'
import { captureSyncedBaselineOwner, getSyncedOperationWithOwnedLinkSource, getSyncedOperationWithLinkSource,
  releaseSyncedReadOwner } from '../src/main/database/synced-binding-sources'
import { createdGroup27 } from './helpers/synced-lifecycle-fixture'
import { uuid } from './helpers/synced-content-fixture'
import { withHostDatabase, a, b, c, bodyId, secondGroup, groupId, instanceId, born, now,
  createRequest, created, createRestoreInput, restoreCreated, seedCreateBlocks, editCreatedGroup, createdOperation, createdJournal,
  getSyncedCreateRestoreContext, moveRequest, moved, command, insertAck,
  request, logical, copy, freshBlock, edit, restoreInput, restoreAck, snapshot, groupEdit,
  applySyncedHostFinal, applySyncedHostCommand, restoreSyncedHostOperation, getSyncedHostHistory,
  allTables, totalChanges, identity, bodyBirth, changeBody
} from './helpers/synced-host-command-create-fixture'

// DRAFT, NOT FROZEN OR EXECUTED. Main-only shape is the d170f436... contract.
const encode = canonicalSyncedPortableJson
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const wire = (value: SyncedGroupSnapshot): SyncedGroupWire => ({ kind: 'synced-group', id: value.groupId, creationId: value.creationId,
  createdAt: value.createdAt, origin: value.origin, bindings: value.bindings, blocks: value.blocks })
const ids = (db: Database.Database, documentId = a) => logical(db, documentId).blocks.map(block => block.id)
const pins = (db: Database.Database, id: string) => db.prepare('SELECT group_id,kind,pin_id,created_at FROM synced_group_pins WHERE group_id=? ORDER BY kind,pin_id')
  .all(id) as Array<{ group_id: string; kind: string; pin_id: string; created_at: string }>
function rejected(db: Database.Database, run: () => ReturnType<typeof applySyncedHostCommand>, status?: string) {
  const before = allTables(db), changes = totalChanges(db), result = run()
  assert.ok(result.status !== 'applied' && result.status !== 'noop', 'A refused create transition cannot claim an accepted ACK')
  if (status) assert.equal(result.status, status)
  assert.deepEqual(allTables(db), before, 'The refused create transition leaves all persistent tables unchanged')
  assert.equal(totalChanges(db), changes, 'A preflight create refusal performs no provisional DML')
  return result
}
function originalReplayed(db: Database.Database, input: unknown, ack: ReturnType<typeof created>, restore = false) {
  const row = copy(createdOperation(db, ack.operationId)), before = allTables(db), changes = totalChanges(db)
  const result = restore ? restoreSyncedHostOperation(db, input) : applySyncedHostCommand(db, input)
  assert.deepEqual(result, { ...ack, replayed: true })
  const lookup = getSyncedOperation(db, { clientOperationId: ack.operationId })
  assert.ok(lookup.status === 'committed', 'Generic lookup retains the complete original independent create ACK')
  assert.deepEqual(lookup.result, { ...ack, replayed: true }); assert.deepEqual(createdOperation(db, ack.operationId), row)
  assert.deepEqual(allTables(db), before); assert.equal(totalChanges(db), changes)
}
function active(db: Database.Database, ack: ReturnType<typeof created>) {
  const side = ack.createdLifecycle, state = readSyncedGroupLifecycles(db, [side.groupId]).get(side.groupId)
  assert.ok(state, 'The real created incarnation has a complete persistent lifecycle')
  const current = snapshot(db, side.groupId)
  assert.deepEqual(Object.keys(side).sort(), ['groupId', 'creationId', 'createdAt', 'origin', 'createHistoryId', 'stateVersion', 'exposure',
    'revision', 'topologyRevision', 'activationRevision', 'activationTopologyRevision', 'activationHash', 'activationInstances', 'state'].sort())
  assert.equal(side.state, 'active'); assert.equal(state.state, 'active'); assert.equal(state.exposure, 'never')
  assert.equal(side.creationId, current.creationId); assert.equal(side.createdAt, current.createdAt); assert.deepEqual(side.origin, current.origin)
  assert.equal(side.createHistoryId, ack.historyToken); assert.equal(state.createHistoryId, ack.historyToken)
  assert.equal(side.stateVersion, state.stateVersion); assert.equal(side.activationHash, syncedLifecycleSemanticHash(wire(current)))
  assert.equal(side.revision, current.revision); assert.equal(side.topologyRevision, current.topologyRevision)
  assert.equal(side.activationRevision, current.revision); assert.equal(side.activationTopologyRevision, current.topologyRevision)
  assert.deepEqual(side.activationInstances, current.instances.map(({ instanceId, hostDocumentId, bindingVersion }) => ({ instanceId, hostDocumentId, bindingVersion })))
  assert.equal(ack.groups.filter(group => group.groupId === side.groupId).length, 1)
  assert.deepEqual(pins(db, side.groupId).map(pin => [pin.kind, pin.pin_id]), [['host-history', ack.historyToken]])
  return current
}
function retired(db: Database.Database, ack: ReturnType<typeof created>) {
  const side = ack.createdLifecycle
  assert.ok(side.state === 'retired-create', 'A real create Undo returns the independent frozen retirement side')
  if (side.state !== 'retired-create') throw new Error('A real retired create ACK is required')
  assert.deepEqual(Object.keys(side).sort(), ['groupId', 'creationId', 'createdAt', 'origin', 'createHistoryId', 'stateVersion', 'exposure',
    'revision', 'topologyRevision', 'activationRevision', 'activationTopologyRevision', 'activationHash', 'activationInstances', 'state', 'wire', 'retiredAt'].sort())
  assert.equal(side.createHistoryId, ack.historyToken); assert.equal(side.activationHash, syncedLifecycleSemanticHash(side.wire))
  assert.equal(side.groupId, side.wire.id); assert.equal(side.creationId, side.wire.creationId); assert.equal(side.createdAt, side.wire.createdAt); assert.deepEqual(side.origin, side.wire.origin)
  assert.equal(side.revision, side.activationRevision); assert.equal(side.topologyRevision, side.activationTopologyRevision)
  assert.equal(getSyncedGroupSnapshots(db, { groupIds: [side.groupId] }).items[0].status, 'missing')
  assert.ok(!listSyncedGroups(db, { query: '', offset: 0, limit: 100 }).items.some(group => group.groupId === side.groupId), 'The real retired group is excluded before list pagination')
  assert.ok(!ack.groups.some(group => group.groupId === side.groupId), 'The retired ACK contains no fabricated active group snapshot')
  assert.equal((db.prepare('SELECT count(*) AS n FROM synced_group_blocks WHERE group_id=?').get(side.groupId) as { n: number }).n, 0)
  assert.equal((db.prepare('SELECT count(*) AS n FROM synced_instances WHERE group_id=?').get(side.groupId) as { n: number }).n, 0)
  assert.equal((db.prepare("SELECT count(*) AS n FROM block_identities WHERE last_owner_kind='group' AND last_owner_id=? AND state='live'").get(side.groupId) as { n: number }).n, 0)
  assert.deepEqual(pins(db, side.groupId), [])
  return side
}
function modelText(nodes: MarkdownNode[]): string {
  return nodes.map(node => node.token.type === 'text' || node.token.type === 'code_inline' ? node.token.content : modelText(node.children)).join(' ')
}
function modelFacts(nodes: MarkdownNode[]): Array<{ type: string; content: string; label: unknown; attrs: MarkdownNode['token']['attrs'] }> {
  return nodes.flatMap(node => [{ type: node.token.type, content: node.token.content, label: node.token.meta?.label, attrs: node.token.attrs }, ...modelFacts(node.children)])
}
function mixedFourRedo(db: Database.Database) {
  const prefix = edit(db, [c], 'executed prefix'), ab = edit(db, [a, b], 'shared AB')
  const insertInput = command(db, { documentId: b, groupId: secondGroup }), insert = { input: insertInput, ack: insertAck(applySyncedHostCommand(db, insertInput)) }
  const moveInput = moveRequest(db, { documentId: b, selectedRootIds: [insertInput.action.instanceId], target: { beforeBlockId: bodyId(b) } })
  const move = { input: moveInput, ack: moved(applySyncedHostCommand(db, moveInput)) }, bc = edit(db, [b, c], 'shared BC'), tail = edit(db, [c], 'peer tail')
  for (const item of [tail, bc, move, insert]) restoreAck(db, item.ack, 'undo')
  const createInput = createRequest(db), create = { input: createInput, ack: created(applySyncedHostCommand(db, createInput)) }
  const undoCreate = restoreCreated(db, create.ack, 'undo'); retired(db, undoCreate.ack)
  restoreAck(db, ab.ack, 'undo')
  return { prefix, ab, insert, move, bc, tail, create, undoCreate }
}

test('create commits the original method input raw roots full W A journal active never group and exact original ACK', () => withHostDatabase(db => {
  const input = createRequest(db), frozen = copy(input), old = snapshot(db), oldBirth = bodyBirth(db, bodyId(a)), before = logical(db, a)
  const ack = created(applySyncedHostCommand(db, input)), current = active(db, ack), row = createdJournal(db, ack.historyToken), action = JSON.parse(row.action_json)
  assert.deepEqual(input, frozen); assert.deepEqual(validateSyncedStructureInput(input), frozen)
  assert.equal(createdOperation(db, ack.operationId).request_hash, sha(encode({ method: 'applySyncedHostCommand', input })))
  assert.equal(action.kind, 'host-command'); assert.equal(action.version, 2); assert.deepEqual(action.input, input)
  assert.deepEqual(Object.keys(action).sort(), ['kind', 'version', 'input', 'persisted', 'births', 'groups', 'create'].sort())
  assert.deepEqual(Object.keys(action.create).sort(), ['wire', 'wireHash', 'selectedIds', 'auxiliary', 'instanceCreatedAt', 'sourceBindings'].sort())
  assert.deepEqual(action.create.wire, wire(current)); assert.equal(action.create.wireHash, syncedLifecycleSemanticHash(wire(current)))
  assert.deepEqual(action.create.selectedIds, [bodyId(a)]); assert.deepEqual(action.create.auxiliary, []); assert.deepEqual(action.create.sourceBindings, [])
  assert.equal(action.create.instanceCreatedAt, bodyBirth(db, input.action.instanceId))
  assert.deepEqual(JSON.parse(row.before_json), [{ documentId: a, content: input.hostsWorkingBefore[0].workingBefore }])
  assert.equal(row.before_hash, sha(encode(JSON.parse(row.before_json)))); assert.equal(row.after_hash, sha(encode(JSON.parse(row.after_json))))
  assert.deepEqual(ids(db), [instanceId, input.action.instanceId]); assert.deepEqual(snapshot(db), old)
  assert.deepEqual(current.blocks.map(block => block.id), [bodyId(a)]); assert.equal(current.blocks[0].createdAt, oldBirth)
  assert.deepEqual(current.blocks.map(({ createdAt: _birth, ...block }) => block), [before.blocks[1]])
  assert.equal(current.origin.documentId, a); assert.equal(current.origin.pathAtCreation, 'Home/Host A'); assert.equal(current.origin.firstInstanceId, input.action.instanceId)
  assert.equal(identity(db, bodyId(a))?.last_owner_kind, 'group'); assert.equal(identity(db, bodyId(a))?.last_owner_id, input.action.groupId)
  assert.equal(db.prepare('SELECT 1 FROM blocks WHERE id=?').get(bodyId(a)), undefined)
  assert.ok(!input.groups.some(group => group.groupId === input.action.groupId), 'Caller guards never claim an invented initial CAS for the new group')
  originalReplayed(db, input, ack)
}))

test('dirty W opaque original children and fresh child metadata enter canonical with exact original and first accepted births', () => withHostDatabase(db => {
  const fresh = ' create:W-only child\0 ', originalBirth = bodyBirth(db, bodyId(a)), input = createRequest(db, {
    selectedRootIds: [bodyId(a), fresh], dirty: working => {
      working.summary = ' raw dirty summary \r\n\t'; const body = working.blocks.find(block => block.id === bodyId(a))!
      body.content = 'dirty **原文**'; body.type = 'todo'; body.checked = true; body.tags = ['未ACK']; body.highlight = 'yellow'; body.markdownFormat = { listMarker: '+', listLoose: true }
      working.blocks.push({ ...freshBlock(fresh, 'fresh dirty child'), type: 'todo', checked: true, tags: ['fresh'] })
    } })
  const ack = created(applySyncedHostCommand(db, input)), current = active(db, ack)
  assert.deepEqual(current.blocks.map(({ createdAt: _birth, ...block }) => block), input.hostsWorkingBefore[0].workingBefore.blocks.slice(1))
  assert.equal(current.blocks[0].createdAt, originalBirth); assert.ok(current.blocks[1].createdAt !== born, 'Main gives the W-only child its first accepted real birth')
  assert.equal(identity(db, fresh)?.created_at, current.blocks[1].createdAt); assert.equal(logical(db, a).summary, input.hostsWorkingBefore[0].workingBefore.summary)
  const undo = restoreCreated(db, ack, 'undo'); retired(db, undo.ack)
  assert.equal(encode(logical(db, a)), encode({ documentId: a, ...input.hostsWorkingBefore[0].workingBefore }))
  assert.equal(bodyBirth(db, bodyId(a)), originalBirth); assert.equal(bodyBirth(db, fresh), current.blocks[1].createdAt)
  const redo = restoreCreated(db, undo.ack, 'redo'); assert.deepEqual(active(db, redo.ack).blocks, current.blocks)
}))

test('raw repeated ancestors preserve command hashing while complete selected nested subtrees keep IDs parent relations and births', () => withHostDatabase(db => {
  const owner = ' create:opaque owner\0 ', child = ' create:opaque child ', sibling = ' create:outside '
  seedCreateBlocks(db, [{ id: owner, type: 'toggle', content: 'Owner' }, { id: child, content: 'Child', depth: 1, parent: owner }, { id: sibling, content: 'Outside' }])
  const roots = [owner, child, owner], input = createRequest(db, { selectedRootIds: roots }), ack = created(applySyncedHostCommand(db, input)), current = active(db, ack)
  assert.deepEqual(current.blocks.map(block => [block.id, block.depth, block.parentBlockId, block.createdAt]), [[owner, 0, null, born], [child, 1, owner, born]])
  assert.deepEqual(ids(db), [instanceId, bodyId(a), input.action.instanceId, sibling])
  assert.deepEqual(JSON.parse(createdJournal(db, ack.historyToken).action_json).input.action.selectedRootIds, roots)
  const changed = copy(input); changed.action.selectedRootIds = [owner]
  rejected(db, () => applySyncedHostCommand(db, changed), 'idempotency-mismatch')
  const undo = restoreCreated(db, ack, 'undo'); assert.deepEqual(ids(db), [instanceId, bodyId(a), owner, child, sibling]); retired(db, undo.ack)
  const redo = restoreCreated(db, undo.ack, 'redo'); assert.deepEqual(active(db, redo.ack).blocks, current.blocks)
}))

test('selected nested roots are rebased into canonical while the replacement leaf keeps the exact former host placement', () => withHostDatabase(db => {
  const owner = ' create:unselected parent ', first = ' create:nested first ', second = ' create:nested second '
  seedCreateBlocks(db, [{ id: owner, type: 'toggle', content: 'Owner' }, { id: first, content: 'First', depth: 1, parent: owner }, { id: second, content: 'Second', depth: 1, parent: owner }])
  const input = createRequest(db, { selectedRootIds: [second, first] }), ack = created(applySyncedHostCommand(db, input)), current = active(db, ack)
  assert.deepEqual(current.blocks.map(block => [block.id, block.depth, block.parentBlockId]), [[first, 0, null], [second, 0, null]])
  const reference = logical(db, a).blocks.find(block => block.id === input.action.instanceId)
  assert.ok(reference, 'The actual host contains the single authorized replacement leaf')
  assert.equal(reference.depth, 1); assert.equal(reference.parentBlockId, owner)
  const undo = restoreCreated(db, ack, 'undo'); retired(db, undo.ack); assert.deepEqual(ids(db), [instanceId, bodyId(a), owner, first, second])
}))

test('old routes survive document to canonical to document conversion and the original host path gets a real identity route', () => withHostDatabase(db => {
  const before = allTables(db).document_block_routes, input = createRequest(db), ack = created(applySyncedHostCommand(db, input))
  const routes = db.prepare('SELECT document_path,block_id FROM document_block_routes WHERE block_id=? ORDER BY document_path').all(bodyId(a))
  assert.deepEqual(routes, [{ document_path: 'Home/Host A', block_id: bodyId(a) }, { document_path: 'Old/Host A', block_id: bodyId(a) }])
  const undo = restoreCreated(db, ack, 'undo'); retired(db, undo.ack)
  assert.deepEqual(db.prepare('SELECT document_path,block_id FROM document_block_routes WHERE block_id=? ORDER BY document_path').all(bodyId(a)), routes)
  assert.equal(identity(db, bodyId(a))?.last_owner_kind, 'document'); assert.equal(identity(db, bodyId(a))?.last_owner_id, a)
  assert.ok((before as Array<{ document_path: string }>).some(route => route.document_path === 'Old/Host A'), 'The pre-existing historical route is part of this actual fixture')
  restoreCreated(db, undo.ack, 'redo'); assert.equal(identity(db, bodyId(a))?.last_owner_id, input.action.groupId)
}))

test('whole W first-binding reference definitions are captured outside selection with their exact typed targets and display title semantics', () => withHostDatabase(db => {
  db.prepare('UPDATE blocks SET content=? WHERE id=?').run('[shown][r]', bodyId(a))
  seedCreateBlocks(db, [{ id: ' create:ref definition ', content: '[r]: Host%20B.md "raw title"' }, { id: ' create:inactive definition ', content: '[r]: Host%20C.md "wrong"' }])
  const input = createRequest(db), ack = created(applySyncedHostCommand(db, input)), current = active(db, ack), model = parseMarkdownDocumentBlocks(current.blocks)
  assert.ok(current.bindings.some(binding => binding.target.kind === 'document' && binding.target.id === b), 'The original effective reference destination targets the real Host B identity')
  assert.ok(!current.bindings.some(binding => binding.target.kind === 'document' && binding.target.id === c), 'The inactive duplicate definition does not replace the actual first binding')
  const facts = modelFacts(model.blockNodes.flat())
  assert.ok(facts.some(fact => fact.type === 'text' && fact.content === 'shown')
    && facts.some(fact => fact.type === 'link_open' && fact.attrs?.some(([name, value]) => name === 'title' && value === 'raw title')),
  'Actual canonical parse preserves consumed display text and title')
  const undo = restoreCreated(db, ack, 'undo'); retired(db, undo.ack)
  assert.equal(logical(db, a).blocks.find(block => block.id === bodyId(a))!.content, '[shown][r]')
}))

test('recursive cyclic and inline named-note dependencies outside selection become real fresh auxiliary paragraphs with preserved stable link targets', () => withHostDatabase(db => {
  db.prepare('UPDATE blocks SET content=? WHERE id=?').run('Use[^a] and ^[inline [^b]]', bodyId(a))
  seedCreateBlocks(db, [{ id: ' create:note a ', content: '[^a]: Alpha [^b] [Target](Host%20B.md)' }, { id: ' create:note b ', content: '[^b]: Beta [^a]' }])
  const input = createRequest(db), originalIds = new Set(input.hostsWorkingBefore[0].workingBefore.blocks.map(block => block.id)), ack = created(applySyncedHostCommand(db, input)), current = active(db, ack)
  const auxiliary = current.blocks.filter(block => !originalIds.has(block.id))
  assert.ok(auxiliary.length >= 2, 'Each external recursive named definition has a real fresh canonical auxiliary paragraph')
  assert.ok(auxiliary.every(block => block.type === 'paragraph' && block.createdAt !== born && identity(db, block.id)?.last_owner_id === current.groupId), 'Auxiliary definitions have their own real group identities and first accepted births')
  assert.ok(current.blocks.some(block => block.id === bodyId(a)), 'The selected original child keeps its stable ID')
  assert.ok(!current.blocks.some(block => block.id === ' create:note a ' || block.id === ' create:note b '), 'External source definitions are copied with fresh identities')
  const model = parseMarkdownDocumentBlocks(current.blocks), text = modelText(model.footnotes)
  assert.ok(text.includes('Alpha') && text.includes('Beta'), 'Actual canonical footnote parse reaches the complete cyclic dependency closure')
  assert.ok(current.bindings.some(binding => binding.target.kind === 'document' && binding.target.id === b), 'A link inside the copied dependency keeps its original stable document target')
  const allocations = JSON.parse(createdJournal(db, ack.historyToken).action_json).create.auxiliary as Array<{
    id: string; createdAt: string; role: string; sourceBlockId: string; from: number; to: number; kind: string; label: string }>
  assert.deepEqual(allocations.filter(item => item.role === 'group-definition').map(item => item.id).sort(), auxiliary.map(item => item.id).sort())
  for (const item of allocations) {
    const source = input.hostsWorkingBefore[0].workingBefore.blocks.find(block => block.id === item.sourceBlockId)
    assert.ok(source, 'Each fresh auxiliary allocation names an actual original W physical definition block')
    const target = current.blocks.find(block => block.id === item.id)
    assert.ok(target, 'Each planned canonical definition allocation has its real committed physical child')
    assert.equal(item.kind, 'note'); assert.equal(target.createdAt, item.createdAt); assert.equal(target.content, source.content.slice(item.from, item.to))
  }
  const undo = restoreCreated(db, ack, 'undo'); retired(db, undo.ack)
  for (const block of auxiliary) { assert.equal(identity(db, block.id)?.state, 'retained'); assert.equal(identity(db, block.id)?.last_owner_id, current.groupId) }
  const redo = restoreCreated(db, undo.ack, 'redo'); assert.deepEqual(active(db, redo.ack).blocks, current.blocks)
}))

test('moving a definition into canonical gives a surviving host use a distinct fresh definition closure instead of depending on the lost original ID', () => withHostDatabase(db => {
  const definition = ' create:selected note definition '
  db.prepare('UPDATE blocks SET content=? WHERE id=?').run('Survivor[^kept]', bodyId(a))
  seedCreateBlocks(db, [{ id: definition, content: '[^kept]: Kept note body [Target](Host%20B.md)' }])
  const input = createRequest(db, { selectedRootIds: [definition] }), oldIds = new Set(ids(db)), ack = created(applySyncedHostCommand(db, input)), current = active(db, ack)
  assert.ok(current.blocks.some(block => block.id === definition && block.createdAt === born), 'The selected definition keeps its original canonical identity and birth')
  const copies = logical(db, a).blocks.filter(block => !oldIds.has(block.id) && block.id !== input.action.instanceId)
  assert.ok(copies.length >= 1 && copies.every(block => block.type === 'paragraph'), 'The surviving host receives real fresh ordinary auxiliary paragraphs')
  assert.ok(copies.every(block => identity(db, block.id)?.last_owner_id === a && bodyBirth(db, block.id) !== born), 'Survivor auxiliary copies have new document-owned births')
  assert.ok(modelText(parseMarkdownDocumentBlocks(logical(db, a).blocks).footnotes).includes('Kept note body'), 'The actual surviving host use still resolves after its original definition changes owner')
  const undo = restoreCreated(db, ack, 'undo'); retired(db, undo.ack)
  assert.equal(encode(logical(db, a)), encode({ documentId: a, ...input.hostsWorkingBefore[0].workingBefore }))
  for (const block of copies) { assert.equal(db.prepare('SELECT 1 FROM blocks WHERE id=?').get(block.id), undefined); assert.equal(identity(db, block.id)?.state, 'retained') }
}))

test('fresh selected W child self and cross links resolve through the exact prospective owner overlay and preserve empty CRLF destinations', () => withHostDatabase(db => {
  const child = uuid(710), input = createRequest(db, { selectedRootIds: [bodyId(a), child], dirty: working => {
    changeBody(working, '[new child](#^' + child + ')\r\n[empty]()')
    working.blocks.push(freshBlock(child, 'Fresh child'))
  } })
  const ack = created(applySyncedHostCommand(db, input)), current = active(db, ack)
  assert.ok(current.bindings.some(binding => binding.target.kind === 'block' && binding.target.id === child && binding.target.state === 'live'), 'The new selected W ID is captured as its exact live prospective canonical target')
  assert.ok(current.bindings.some(binding => binding.raw === '' && binding.from === binding.to && binding.target.kind === 'document' && binding.target.id === a), 'The actual empty Markdown destination preserves its zero-width origin-document binding')
  const undo = restoreCreated(db, ack, 'undo'); retired(db, undo.ack)
  assert.equal(logical(db, a).blocks.find(block => block.id === bodyId(a))!.content, input.hostsWorkingBefore[0].workingBefore.blocks[1].content)
}))

test('create Undo reopen Redo Undo preserves original identities births immutable Origin frozen wire and every old ACK', () => withHostDatabase((db, second) => {
  db.prepare('UPDATE blocks SET content=? WHERE id=?').run('Use[^n]', bodyId(a)); seedCreateBlocks(db, [{ id: ' create:restart note ', content: '[^n]: Note body' }])
  const input = createRequest(db), ack = created(applySyncedHostCommand(db, input)), first = active(db, ack), journal = copy(createdJournal(db, ack.historyToken))
  const undo = restoreCreated(db, ack, 'undo'), frozen = retired(db, undo.ack)
  originalReplayed(db, input, ack); originalReplayed(db, undo.input, undo.ack, true)
  const reopened = second(), beforeRead = allTables(reopened), changes = totalChanges(reopened), context = getSyncedCreateRestoreContext(reopened, { historyToken: ack.historyToken, direction: 'redo' })
  assert.ok(context.status === 'ready', 'A reopened actual SQLite connection obtains a real retired exact-tail restore context')
  if (context.status !== 'ready') throw new Error('Expected actual ready Redo context')
  assert.equal(context.createdLifecycle.state, 'retired-create'); assert.deepEqual(allTables(reopened), beforeRead); assert.equal(totalChanges(reopened), changes)
  const guard = context.restore.groups.find(group => group.groupId === input.action.groupId)
  assert.ok(guard, 'Redo includes the actual retired group CAS guard although normal snapshot is missing')
  assert.equal(guard.expectedRevision, frozen.revision); assert.equal(guard.expectedTopologyRevision, frozen.topologyRevision)
  assert.ok(!context.restore.expectedInstances.some(instance => instance.instanceId === input.action.instanceId), 'Redo never claims a retained instance is in the current P registry')
  const redoInput = { clientOperationId: randomUUID(), ...context.restore }, redoAck = created(restoreSyncedHostOperation(reopened, redoInput)), reactivated = active(reopened, redoAck)
  assert.deepEqual(wire(reactivated), wire(first)); assert.notEqual(reactivated.revision, first.revision); assert.notEqual(reactivated.topologyRevision, first.topologyRevision)
  assert.ok(redoAck.createdLifecycle.stateVersion > undo.ack.createdLifecycle.stateVersion, 'Reactivation advances the observed persistent lifecycle version')
  originalReplayed(reopened, undo.input, undo.ack, true); originalReplayed(reopened, input, ack); originalReplayed(reopened, redoInput, redoAck, true)
  const secondUndo = restoreCreated(reopened, redoAck, 'undo'); retired(reopened, secondUndo.ack)
  assert.deepEqual(createdJournal(reopened, ack.historyToken), journal)
  assert.equal(encode(logical(reopened, a)), encode({ documentId: a, ...input.hostsWorkingBefore[0].workingBefore }))
}))

test('same create operation ID binds its original method group instance raw roots and complete W before any replay allocation', () => {
  for (const kind of ['method', 'group', 'instance', 'roots', 'W'] as const) withHostDatabase(db => {
    const input = createRequest(db), ack = created(applySyncedHostCommand(db, input)), changed = copy(input)
    if (kind === 'group') changed.action.groupId = randomUUID()
    if (kind === 'instance') changed.action.instanceId = randomUUID()
    if (kind === 'roots') changed.action.selectedRootIds.push(bodyId(a))
    if (kind === 'W') changeBody(changed.hostsWorkingBefore[0].workingBefore, 'different original dirty W')
    rejected(db, () => kind === 'method' ? applySyncedHostFinal(db, input) : applySyncedHostCommand(db, changed), 'idempotency-mismatch')
    assert.equal(createdOperation(db, ack.operationId).client_operation_id, ack.operationId)
  })
})

test('normal create cannot regress never to unknown and migrated unknown or old bare journals gain no accurate inverse authority', () => withHostDatabase(db => {
  const input = createRequest(db), ack = created(applySyncedHostCommand(db, input)), before = allTables(db)
  assert.throws(() => db.prepare("UPDATE synced_group_lifecycle SET exposure_state='unknown',state_version=state_version+1 WHERE group_id=?").run(input.action.groupId), /regress|never/i)
  assert.deepEqual(allTables(db), before); assert.equal(readSyncedGroupLifecycles(db, [groupId]).get(groupId)!.exposure, 'unknown')
  const bare = createdGroup27(db), bareBefore = allTables(db), context = getSyncedCreateRestoreContext(db, { historyToken: bare.journalId, direction: 'undo' })
  assert.deepEqual(context, { status: 'unavailable', reason: 'journal-kind' })
  const value = { clientOperationId: randomUUID(), historyToken: bare.journalId, direction: 'undo',
    expectedHosts: [{ documentId: a, expectedUpdatedAt: (db.prepare('SELECT updated_at FROM documents WHERE id=?').get(a) as { updated_at: string }).updated_at }], groups: [], expectedInstances: [] }
  const result = restoreSyncedHostOperation(db, value)
  assert.ok(result.status === 'unsupported' && result.reason === 'journal-kind', 'A legacy five-key bare journal still cannot claim a complete W to A inverse')
  assert.deepEqual(allTables(db), bareBefore)
}))

test('legal possible and confirmed exposure fixtures reject create Undo even when group revision and topology CAS do not change', () => {
  // These are schema-state fixtures, not a production publication API or claim race.
  for (const confirmed of [false, true]) withHostDatabase(db => {
    const input = createRequest(db), ack = created(applySyncedHostCommand(db, input)), { input: restore } = createRestoreInput(db, ack, 'undo'), current = snapshot(db, input.action.groupId), attempt = randomUUID()
    db.transaction(() => {
      db.prepare(`INSERT INTO synced_exposure_attempts(id,request_hash,channel,target_fingerprint,publication_hash,state,created_at)
        VALUES(?,?,'sqlite-fixture-only',?,?,'possible',?)`).run(attempt, '1'.repeat(64), '2'.repeat(64), '3'.repeat(64), now)
      db.prepare(`INSERT INTO synced_group_exposure_members(attempt_id,group_id,creation_id,revision,topology_revision,semantic_hash)
        VALUES(?,?,?,?,?,?)`).run(attempt, current.groupId, current.creationId, current.revision, current.topologyRevision, syncedLifecycleSemanticHash(wire(current)))
      if (confirmed) db.prepare("UPDATE synced_exposure_attempts SET state='confirmed',confirmed_at=? WHERE id=?").run(now, attempt)
    })()
    assert.equal(snapshot(db, current.groupId).revision, current.revision); assert.equal(snapshot(db, current.groupId).topologyRevision, current.topologyRevision)
    assert.equal(readSyncedGroupLifecycles(db, [current.groupId]).get(current.groupId)!.exposure, confirmed ? 'confirmed' : 'possible')
    rejected(db, () => restoreSyncedHostOperation(db, restore))
    assert.equal(getSyncedHostHistory(db, { documentId: a }).undoToken, ack.historyToken)
  })
})

test('content changed and changed back through real content commands still cannot overwrite the original activation to permit create Undo', () => withHostDatabase(db => {
  const input = createRequest(db), ack = created(applySyncedHostCommand(db, input)), original = snapshot(db, input.action.groupId), lifecycle = readSyncedGroupLifecycles(db, [input.action.groupId]).get(input.action.groupId)!
  editCreatedGroup(db, input.action.groupId); editCreatedGroup(db, input.action.groupId, syncedCanonicalEdits(original.blocks))
  assert.deepEqual(snapshot(db, input.action.groupId).blocks, original.blocks)
  assert.notEqual(snapshot(db, input.action.groupId).revision, original.revision)
  assert.equal(readSyncedGroupLifecycles(db, [input.action.groupId]).get(input.action.groupId)!.activationRevision, lifecycle.activationRevision)
  rejected(db, () => restoreSyncedHostOperation(db, restoreInput(db, ack, 'undo')))
}))

test('a real extra instance later undone leaves changed topology and its immutable external journal pin blocking create Undo', () => withHostDatabase(db => {
  const input = createRequest(db), ack = created(applySyncedHostCommand(db, input)), initial = snapshot(db, input.action.groupId)
  const inserted = command(db, { documentId: b, groupId: input.action.groupId }), insert = insertAck(applySyncedHostCommand(db, inserted))
  restoreAck(db, insert, 'undo'); const current = snapshot(db, input.action.groupId)
  assert.deepEqual(current.instances.map(instance => instance.instanceId), initial.instances.map(instance => instance.instanceId))
  assert.notEqual(current.topologyRevision, initial.topologyRevision)
  assert.ok(pins(db, input.action.groupId).some(pin => pin.kind === 'host-history' && pin.pin_id === insert.historyToken), 'The undone extra consumer retains its distinct immutable history dependency')
  rejected(db, () => restoreSyncedHostOperation(db, restoreInput(db, ack, 'undo')))
}))

test('only the exact own host-history pin is removable while every independent history trash template or differently keyed pin refuses retirement', () => {
  for (const kind of ['host-history', 'trash', 'template', 'other'] as const) withHostDatabase(db => {
    const input = createRequest(db), ack = created(applySyncedHostCommand(db, input)), { input: restore } = createRestoreInput(db, ack, 'undo'), foreign = randomUUID()
    db.prepare('INSERT INTO synced_group_pins(group_id,kind,pin_id,created_at) VALUES(?,?,?,?)').run(input.action.groupId, kind, foreign, now)
    rejected(db, () => restoreSyncedHostOperation(db, restore))
    assert.ok(pins(db, input.action.groupId).some(pin => pin.kind === 'host-history' && pin.pin_id === ack.historyToken), 'Rejection keeps the exact original own create pin intact')
  })
})

test('unrelated existing group content edits survive create Undo and Redo through current guards without restoring old canonical snapshots', () => withHostDatabase(db => {
  const input = createRequest(db), ack = created(applySyncedHostCommand(db, input)); groupEdit(db); const current = snapshot(db)
  const undo = restoreCreated(db, ack, 'undo'); retired(db, undo.ack)
  assert.deepEqual(snapshot(db).blocks, current.blocks); assert.equal(snapshot(db).revision, current.revision)
  const redo = restoreCreated(db, undo.ack, 'redo'); active(db, redo.ack)
  assert.deepEqual(snapshot(db).blocks, current.blocks); assert.equal(snapshot(db).revision, current.revision)
}))

test('stale restore guards from an actual Undo Redo cycle cannot authorize another create Undo despite identical portable wire', () => withHostDatabase(db => {
  const input = createRequest(db), ack = created(applySyncedHostCommand(db, input)), old = createRestoreInput(db, ack, 'undo')
  const undo = restoreCreated(db, ack, 'undo'), redo = restoreCreated(db, undo.ack, 'redo')
  assert.equal(redo.ack.createdLifecycle.activationHash, ack.createdLifecycle.activationHash)
  assert.notEqual(redo.ack.createdLifecycle.revision, ack.createdLifecycle.revision)
  rejected(db, () => restoreSyncedHostOperation(db, old.input), 'conflict')
  const next = restoreCreated(db, redo.ack, 'undo'); retired(db, next.ack)
}))

test('restore context is a closed read-only fresh observation with no expected stateVersion field or hidden authority', () => withHostDatabase(db => {
  const input = createRequest(db), ack = created(applySyncedHostCommand(db, input)), before = allTables(db), changes = totalChanges(db)
  const context = getSyncedCreateRestoreContext(db, { historyToken: ack.historyToken, direction: 'undo' })
  assert.ok(context.status === 'ready', 'The actual active create tail has a complete read-only restore context')
  if (context.status !== 'ready') throw new Error('Expected ready create context')
  assert.deepEqual(Object.keys(context.restore).sort(), ['direction', 'expectedHosts', 'expectedInstances', 'groups', 'historyToken'].sort())
  assert.ok(context.restore.expectedInstances.some(instance => instance.instanceId === input.action.instanceId), 'Undo guards include the current actually registered created instance')
  assert.deepEqual(allTables(db), before); assert.equal(totalChanges(db), changes)
  const observed = { ...context, createdLifecycle: { ...context.createdLifecycle, stateVersion: Number.MAX_SAFE_INTEGER } }
  assert.notEqual(getSyncedCreateRestoreContext(db, { historyToken: ack.historyToken, direction: 'undo' }).status, 'unavailable')
  const fresh = getSyncedCreateRestoreContext(db, { historyToken: ack.historyToken, direction: 'undo' })
  assert.ok(fresh.status === 'ready' && fresh.createdLifecycle.stateVersion !== Number.MAX_SAFE_INTEGER, 'Mutating an observed DTO cannot alter stored lifecycle or later contexts')
  const originalInput = { clientOperationId: randomUUID(), ...observed.restore }, undo = created(restoreSyncedHostOperation(db, originalInput))
  retired(db, undo)
  assert.equal(createdOperation(db, undo.operationId).request_hash, sha(encode({ method: 'restoreSyncedHostOperation', input: originalInput })))
}))

test('context rejects malformed caller shapes transactions and noncreate history without turning damaged or absent authority into a ready handle', () => withHostDatabase(db => {
  const normal = edit(db, [a], 'ordinary finite history'), input = createRequest(db), ack = created(applySyncedHostCommand(db, input))
  assert.deepEqual(getSyncedCreateRestoreContext(db, { historyToken: normal.ack.historyToken, direction: 'undo' }), { status: 'unavailable', reason: 'journal-kind' })
  assert.deepEqual(getSyncedCreateRestoreContext(db, { historyToken: randomUUID(), direction: 'undo' }), { status: 'unavailable', reason: 'history' })
  const before = allTables(db), changes = totalChanges(db)
  for (const value of [{ historyToken: ack.historyToken, direction: 'sideways' }, { historyToken: 'bad uuid', direction: 'undo' },
    { historyToken: ack.historyToken, direction: 'undo', createdLifecycle: ack.createdLifecycle }]) assert.throws(() => getSyncedCreateRestoreContext(db, value))
  db.transaction(() => { assert.throws(() => getSyncedCreateRestoreContext(db, { historyToken: ack.historyToken, direction: 'undo' }), /外层|事务|transaction/i) })()
  assert.deepEqual(allTables(db), before); assert.equal(totalChanges(db), changes)
  const { input: restore } = createRestoreInput(db, ack, 'undo')
  rejected(db, () => restoreSyncedHostOperation(db, { ...restore, expectedLifecycle: ack.createdLifecycle }), 'invalid')
}))

test('the original active and retired ACK namespaces reject wrong lifecycle facts closures phases unknown keys and invented active snapshots', () => {
  for (const kind of ['missing-life', 'unknown-key', 'noop', 'null-token', 'wrong-token', 'bad-state-version', 'exposure', 'extra-group', 'retired-snapshot', 'retired-wire', 'retired-CAS'] as const) withHostDatabase(db => {
    const input = createRequest(db), forward = created(applySyncedHostCommand(db, input))
    const undo = kind.startsWith('retired-') ? restoreCreated(db, forward, 'undo') : null, ack = undo?.ack ?? forward
    const envelope = JSON.parse(createdOperation(db, ack.operationId).result_json), result = envelope.result
    if (kind === 'missing-life') delete result.createdLifecycle
    if (kind === 'unknown-key') result.createdLifecycle.extra = true
    if (kind === 'noop') result.status = 'noop'
    if (kind === 'null-token') result.historyToken = null
    if (kind === 'wrong-token') result.createdLifecycle.createHistoryId = randomUUID()
    if (kind === 'bad-state-version') result.createdLifecycle.stateVersion = 0
    if (kind === 'exposure') result.createdLifecycle.exposure = 'possible'
    if (kind === 'extra-group') result.groups.push(snapshot(db, secondGroup))
    if (kind === 'retired-snapshot') result.groups.push(forward.groups.find(group => group.groupId === input.action.groupId))
    if (kind === 'retired-wire') result.createdLifecycle.wire.blocks[0].content += ' forged retirement body'
    if (kind === 'retired-CAS') result.createdLifecycle.revision = randomUUID()
    db.prepare('UPDATE synced_operations SET result_json=? WHERE client_operation_id=?').run(JSON.stringify(envelope), ack.operationId)
    const before = allTables(db), changes = totalChanges(db)
    assert.throws(() => getSyncedOperation(db, { clientOperationId: ack.operationId }), /收据损坏|回执损坏|收据|回执/i)
    assert.throws(() => undo ? restoreSyncedHostOperation(db, undo.input) : applySyncedHostCommand(db, input), /收据损坏|回执损坏|收据|回执/i)
    assert.deepEqual(allTables(db), before); assert.equal(totalChanges(db), changes)
  })
})

test('new create receipts remain unavailable to both group-only source ticket readers', () => withHostDatabase(db => {
  const input = createRequest(db), ack = created(applySyncedHostCommand(db, input)), owner = captureSyncedBaselineOwner(db, { groupId: input.action.groupId })
  assert.ok(owner.status === 'ready', 'The real created active group can have an independent Main read owner')
  if (owner.status !== 'ready') throw new Error('Expected a real ready owner')
  try {
    assert.throws(() => getSyncedOperationWithLinkSource(db, { clientOperationId: ack.operationId }), /收据|回执|结构|kind|ack/i)
    assert.throws(() => getSyncedOperationWithOwnedLinkSource(db, { readOwnerId: owner.readOwnerId, clientOperationId: ack.operationId }), /收据|回执|结构|kind|ack/i)
  } finally { releaseSyncedReadOwner(db, { readOwnerId: owner.readOwnerId }) }
}))

test('selection scope hidden W structure nested synced descendants and caller supplied authority reject before provisional create writes', () => {
  for (const kind of ['missing', 'gap', 'different-parent', 'nested-sync', 'delete-W', 'reorder-W', 'fresh-ref-W', 'extra-A', 'extra-Origin'] as const) withHostDatabase(db => {
    const owner = ' create:rejected owner ', child = ' create:rejected child ', outside = ' create:rejected outside '
    seedCreateBlocks(db, [{ id: owner, type: 'toggle', content: 'Owner' }, { id: child, content: 'Child', depth: 1, parent: owner }, { id: outside, content: 'Outside' }])
    const input = createRequest(db)
    if (kind === 'missing') input.action.selectedRootIds = ['missing W ID']
    if (kind === 'gap') input.action.selectedRootIds = [bodyId(a), outside]
    if (kind === 'different-parent') input.action.selectedRootIds = [bodyId(a), child]
    if (kind === 'nested-sync') input.action.selectedRootIds = [instanceId]
    if (kind === 'delete-W') { input.action.selectedRootIds = [owner]; input.hostsWorkingBefore[0].workingBefore.blocks.splice(1, 1) }
    if (kind === 'reorder-W') { const body = input.hostsWorkingBefore[0].workingBefore.blocks.splice(1, 1)[0]; input.hostsWorkingBefore[0].workingBefore.blocks.push(body) }
    if (kind === 'fresh-ref-W') input.hostsWorkingBefore[0].workingBefore.blocks.push({ ...input.hostsWorkingBefore[0].workingBefore.blocks[0], id: randomUUID() })
    const value = kind === 'extra-A' ? { ...input, finalAfter: [] } : kind === 'extra-Origin' ? { ...input, action: { ...input.action, origin: { version: 1, documentId: b } } } : input
    rejected(db, () => applySyncedHostCommand(db, value))
  })
})

test('new group and instance IDs cannot reuse an active or retired group or any live retained reserved ordinary or canonical instance identity', () => {
  for (const kind of ['active-group', 'retired-group', 'ordinary-instance', 'canonical-instance', 'retained-instance', 'reserved-instance'] as const) withHostDatabase(db => {
    let input = createRequest(db)
    if (kind === 'active-group') input.action.groupId = groupId
    if (kind === 'retired-group') {
      const first = createRequest(db), ack = created(applySyncedHostCommand(db, first)); restoreCreated(db, ack, 'undo')
      const next = createRequest(db, { groupId: first.action.groupId }); rejected(db, () => applySyncedHostCommand(db, next)); return
    }
    if (kind === 'ordinary-instance') { const id = uuid(712); seedCreateBlocks(db, [{ id, content: 'Occupied ordinary UUID' }]); input = createRequest(db, { instanceId: id }) }
    if (kind === 'canonical-instance') { const id = uuid(713); groupEdit(db, [freshBlock(id, 'Occupied canonical UUID')]); input = createRequest(db, { instanceId: id }) }
    if (kind === 'retained-instance' || kind === 'reserved-instance') {
      const id = randomUUID(); db.prepare("INSERT INTO block_identities(id,last_owner_kind,last_owner_id,state,created_at) VALUES(?,?,?,'retained',?)")
        .run(id, kind === 'reserved-instance' ? 'reserved' : 'document', kind === 'reserved-instance' ? 'fixture-reservation' : a, kind === 'reserved-instance' ? null : born)
      input.action.instanceId = id
    }
    rejected(db, () => applySyncedHostCommand(db, input))
  })
})

test('foreign W ownership unknown retained birth and stale complete CAS guards cannot be accepted as a source of canonical identities', () => {
  for (const kind of ['foreign-child', 'unknown-birth', 'host-CAS', 'revision-CAS', 'topology-CAS', 'binding-CAS', 'group-closure', 'instance-closure'] as const) withHostDatabase(db => {
    const input = createRequest(db)
    if (kind === 'foreign-child') { input.hostsWorkingBefore[0].workingBefore.blocks.push({ ...logical(db, b).blocks[0] }); input.action.selectedRootIds = [bodyId(b)] }
    if (kind === 'unknown-birth') {
      const id = ' create:unknown retained birth '; db.prepare("INSERT INTO block_identities(id,last_owner_kind,last_owner_id,state,created_at) VALUES(?,'document',?,'retained',NULL)").run(id, a)
      input.hostsWorkingBefore[0].workingBefore.blocks.push(freshBlock(id)); input.action.selectedRootIds = [id]
    }
    if (kind === 'host-CAS') input.hostsWorkingBefore[0].expectedPersistedUpdatedAt = born
    if (kind === 'revision-CAS') input.groups[0].expectedRevision = randomUUID()
    if (kind === 'topology-CAS') input.groups[0].expectedTopologyRevision = randomUUID()
    if (kind === 'binding-CAS') input.expectedInstances[0].bindingVersion = randomUUID()
    if (kind === 'group-closure') input.groups = []
    if (kind === 'instance-closure') input.expectedInstances = []
    const original = copy(input); rejected(db, () => applySyncedHostCommand(db, input)); assert.deepEqual(input, original)
  })
})

test('unsafe definition projection and heading identity rewrites refuse the create instead of flattening source or redirecting surviving bindings', () => {
  for (const kind of ['native-definition', 'duplicate-heading'] as const) withHostDatabase(db => {
    let input = createRequest(db)
    if (kind === 'native-definition') {
      const owner = ' create:ambiguous definition owner ', definition = ' create:ambiguous definition '
      seedCreateBlocks(db, [{ id: owner, type: 'toggle', content: 'Owner' }, { id: definition, content: '[^inside]: Native note', depth: 1, parent: owner }])
      db.prepare('UPDATE blocks SET content=? WHERE id=?').run('Use[^inside]', bodyId(a)); input = createRequest(db)
    } else {
      seedCreateBlocks(db, [{ id: ' create:heading first ', type: 'heading-2', content: 'Same' }, { id: ' create:heading second ', type: 'heading-2', content: 'Same' }])
      input = createRequest(db, { selectedRootIds: [' create:heading first '] })
    }
    rejected(db, () => applySyncedHostCommand(db, input))
  })
})

test('a later real host journal pins the created content even after its own Undo so create cannot consume it as a pure reference inverse', () => withHostDatabase(db => {
  const input = createRequest(db), ack = created(applySyncedHostCommand(db, input))
  const next = request(db, [a], after => { after[0].summary = 'later ordinary summary' }), nextAck = applySyncedHostFinal(db, next)
  assert.ok(nextAck.status === 'applied' && !('createdLifecycle' in nextAck), 'The later operation is an ordinary finite host-final journal')
  if (nextAck.status !== 'applied') throw new Error('Expected actual host-final ACK')
  restoreAck(db, nextAck, 'undo')
  assert.ok(pins(db, input.action.groupId).some(pin => pin.pin_id === nextAck.historyToken), 'The immutable external host journal pin survives its own Undo')
  rejected(db, () => restoreSyncedHostOperation(db, restoreInput(db, ack, 'undo')))
}))

test('a new command prunes the four-format AB BC shared Redo fixed point while the retired create keeps no self pin or false reactivation', () => withHostDatabase(db => {
  const chain = mixedFourRedo(db), items = [chain.prefix, chain.ab, chain.insert, chain.move, chain.bc, chain.tail, chain.create]
  const before = allTables(db), receipts = items.map(item => copy(createdOperation(db, item.input.clientOperationId))), oldCreate = copy(createdJournal(db, chain.create.ack.historyToken))
  const input = moveRequest(db), ack = moved(applySyncedHostCommand(db, input)), rows = allTables(db)
  const mappings = rows.synced_host_history_documents as Array<{ history_id: string; document_id: string }>
  const discarded = [chain.ab, chain.insert, chain.move, chain.bc, chain.tail, chain.create].map(item => item.ack.historyToken)
  assert.ok(!mappings.some(mapping => discarded.includes(mapping.history_id)), 'All four finite formats join the same transitive shared Redo cut')
  assert.ok(mappings.some(mapping => mapping.history_id === chain.prefix.ack.historyToken && mapping.document_id === c), 'The executed independent prefix is preserved')
  assert.deepEqual(createdJournal(db, chain.create.ack.historyToken), oldCreate)
  assert.deepEqual(allTables(db).synced_group_retirements, before.synced_group_retirements)
  assert.deepEqual(pins(db, chain.create.input.action.groupId), [])
  for (const row of receipts) assert.deepEqual(createdOperation(db, row.client_operation_id), row)
  assert.equal(getSyncedHostHistory(db, { documentId: c }).undoToken, chain.prefix.ack.historyToken)
  assert.equal(getSyncedHostHistory(db, { documentId: a }).undoToken, ack.historyToken)
  assert.deepEqual(getSyncedCreateRestoreContext(db, { historyToken: chain.create.ack.historyToken, direction: 'redo' }), { status: 'unavailable', reason: 'history' })
  originalReplayed(db, chain.create.input, chain.create.ack)
}))

test('late forward SQL failures restore every ordinary canonical identity route registry cursor pin and journal before the same original create retries', () => {
  for (const phase of ['journal', 'owner', 'canonical', 'instance', 'route', 'receipt'] as const) withHostDatabase(db => {
    const input = createRequest(db), group = input.action.groupId
    const definition = phase === 'journal' ? "BEFORE INSERT ON synced_host_history"
      : phase === 'owner' ? "BEFORE UPDATE ON block_identities WHEN NEW.last_owner_kind='group' AND NEW.last_owner_id='" + group + "'"
      : phase === 'canonical' ? "BEFORE INSERT ON synced_group_blocks WHEN NEW.group_id='" + group + "'"
      : phase === 'instance' ? "BEFORE INSERT ON synced_instances WHEN NEW.group_id='" + group + "'"
      : phase === 'route' ? 'BEFORE INSERT ON document_block_routes' : 'BEFORE INSERT ON synced_operations'
    db.exec("CREATE TRIGGER fail_create_forward " + definition + " BEGIN SELECT RAISE(ABORT,'injected create forward late SQL'); END")
    const before = allTables(db)
    assert.throws(() => applySyncedHostCommand(db, input), /injected create forward late SQL/); assert.deepEqual(allTables(db), before)
    db.exec('DROP TRIGGER fail_create_forward'); const ack = created(applySyncedHostCommand(db, input)); active(db, ack)
  })
})

test('late create Undo failures at retirement own pin owner transition lifecycle or receipt preserve the complete active tail and exact request retry', () => {
  for (const phase of ['retirement', 'own-pin', 'owner', 'lifecycle', 'receipt'] as const) withHostDatabase(db => {
    const input = createRequest(db), ack = created(applySyncedHostCommand(db, input)), { input: restore } = createRestoreInput(db, ack, 'undo'), group = input.action.groupId
    const definition = phase === 'retirement' ? 'BEFORE INSERT ON synced_group_retirements'
      : phase === 'own-pin' ? "BEFORE DELETE ON synced_group_pins WHEN OLD.group_id='" + group + "'"
      : phase === 'owner' ? "BEFORE UPDATE ON block_identities WHEN OLD.last_owner_kind='group' AND OLD.last_owner_id='" + group + "' AND NEW.last_owner_kind='document'"
      : phase === 'lifecycle' ? "BEFORE UPDATE ON synced_group_lifecycle WHEN NEW.group_id='" + group + "' AND NEW.state='retired-create'"
      : 'BEFORE INSERT ON synced_operations'
    db.exec("CREATE TRIGGER fail_create_undo " + definition + " BEGIN SELECT RAISE(ABORT,'injected create undo late SQL'); END")
    const before = allTables(db)
    assert.throws(() => restoreSyncedHostOperation(db, restore), /injected create undo late SQL/); assert.deepEqual(allTables(db), before)
    db.exec('DROP TRIGGER fail_create_undo'); const undone = created(restoreSyncedHostOperation(db, restore)); retired(db, undone)
  })
})

test('late Redo failures preserve frozen retirement retained births and original Redo while the same exact request can reactivate afterward', () => {
  for (const phase of ['activation', 'canonical', 'own-pin', 'receipt'] as const) withHostDatabase(db => {
    const input = createRequest(db), ack = created(applySyncedHostCommand(db, input)), undo = restoreCreated(db, ack, 'undo'), { input: restore } = createRestoreInput(db, undo.ack, 'redo'), group = input.action.groupId
    const definition = phase === 'activation' ? "BEFORE UPDATE ON synced_group_lifecycle WHEN NEW.group_id='" + group + "' AND NEW.state='active'"
      : phase === 'canonical' ? "BEFORE INSERT ON synced_group_blocks WHEN NEW.group_id='" + group + "'"
      : phase === 'own-pin' ? "BEFORE INSERT ON synced_group_pins WHEN NEW.group_id='" + group + "'"
      : 'BEFORE INSERT ON synced_operations'
    db.exec("CREATE TRIGGER fail_create_redo " + definition + " BEGIN SELECT RAISE(ABORT,'injected create redo late SQL'); END")
    const before = allTables(db)
    assert.throws(() => restoreSyncedHostOperation(db, restore), /injected create redo late SQL/); assert.deepEqual(allTables(db), before)
    db.exec('DROP TRIGGER fail_create_redo'); const redone = created(restoreSyncedHostOperation(db, restore)); active(db, redone)
  })
})

test('two real SQLite connections allow one create CAS and preserve the other client original complete dirty W with no second identities', () => withHostDatabase((db, second) => {
  const peer = second(), input = createRequest(db), stale = createRequest(peer, { dirty: working => { changeBody(working, 'peer dirty W'); working.summary = 'peer summary' } }), original = copy(stale)
  const ack = created(applySyncedHostCommand(db, input)); rejected(peer, () => applySyncedHostCommand(peer, stale), 'conflict')
  assert.deepEqual(stale, original); assert.equal(db.prepare('SELECT 1 FROM synced_groups WHERE id=?').get(stale.action.groupId), undefined)
  assert.equal(identity(db, stale.action.instanceId), undefined); active(peer, ack)
}))

test('immutable lifecycle journal and frozen retirement cannot be rewritten while inserted corrupt finite rows still fail strict read and inverse', () => {
  for (const kind of ['extra', 'forged-A', 'changed-W', 'bad-hash'] as const) withHostDatabase(db => {
    const input = createRequest(db), ack = created(applySyncedHostCommand(db, input)), original = createdJournal(db, ack.historyToken)
    assert.throws(() => db.prepare("UPDATE synced_host_history SET action_json='{}' WHERE id=?").run(ack.historyToken), /cannot be rewritten/)
    const fake = randomUUID(), action = JSON.parse(original.action_json), before = original.before_json
    let after = original.after_json, afterHash = original.after_hash
    if (kind === 'extra') action.extra = true
    if (kind === 'changed-W') action.input.hostsWorkingBefore[0].workingBefore.summary += ' forged W'
    if (kind === 'forged-A') { const sides = JSON.parse(after); sides[0].content.summary += ' self-hashed forged A'; after = encode(sides); afterHash = sha(after) }
    if (kind === 'bad-hash') afterHash = '0'.repeat(64)
    db.prepare('INSERT INTO synced_host_history(id,action_json,before_json,after_json,before_hash,after_hash,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(fake, JSON.stringify(action), before, after, original.before_hash, afterHash, original.created_at)
    db.prepare('UPDATE synced_host_history_documents SET history_id=? WHERE history_id=?').run(fake, ack.historyToken)
    const restore = { ...restoreInput(db, ack, 'undo'), historyToken: fake }, corrupted = allTables(db), changes = totalChanges(db)
    assert.throws(() => getSyncedCreateRestoreContext(db, { historyToken: fake, direction: 'undo' }), /日志|历史|journal|格式/i)
    assert.throws(() => restoreSyncedHostOperation(db, restore), /日志|历史|journal|格式/i)
    assert.deepEqual(allTables(db), corrupted); assert.equal(totalChanges(db), changes)
  })
  withHostDatabase(db => {
    const input = createRequest(db), ack = created(applySyncedHostCommand(db, input)), undo = restoreCreated(db, ack, 'undo'), before = allTables(db)
    assert.throws(() => db.prepare("UPDATE synced_group_retirements SET semantic_hash=? WHERE group_id=?").run('0'.repeat(64), input.action.groupId), /cannot be rewritten/)
    assert.deepEqual(allTables(db), before); retired(db, undo.ack)
  })
})

test('missing exact own pin mappings foreign retained owner and changed birth refuse lifecycle inverse without spending the tail', () => {
  for (const kind of ['own-pin', 'mapping', 'birth', 'owner'] as const) withHostDatabase(db => {
    const input = createRequest(db), ack = created(applySyncedHostCommand(db, input))
    if (kind === 'own-pin') {
      const restore = createRestoreInput(db, ack, 'undo').input
      db.prepare("DELETE FROM synced_group_pins WHERE group_id=? AND kind='host-history' AND pin_id=?").run(input.action.groupId, ack.historyToken)
      rejected(db, () => restoreSyncedHostOperation(db, restore)); return
    }
    if (kind === 'mapping') {
      db.prepare('DELETE FROM synced_host_history_documents WHERE history_id=?').run(ack.historyToken)
      const before = allTables(db)
      assert.throws(() => getSyncedCreateRestoreContext(db, { historyToken: ack.historyToken, direction: 'undo' }), /历史|位置|连续|映射|chain|history/i)
      assert.deepEqual(allTables(db), before); return
    }
    const undo = restoreCreated(db, ack, 'undo'), restore = createRestoreInput(db, undo.ack, 'redo').input
    // The original instance is retained after Undo, so these injected owner/birth
    // corruptions obey physical consistency triggers without relaxing any guard.
    const instance = identity(db, input.action.instanceId)
    assert.ok(instance, 'The original created instance retains its exact identity after Undo')
    db.prepare('UPDATE block_identities SET last_owner_id=?,created_at=? WHERE id=?')
      .run(kind === 'owner' ? b : instance.last_owner_id, kind === 'birth' ? born : instance.created_at, input.action.instanceId)
    rejected(db, () => restoreSyncedHostOperation(db, restore))
  })
})

test('caller transactions disabled foreign keys and later actual tails never bypass create restore authority or production gates', () => withHostDatabase(db => {
  const input = createRequest(db), before = allTables(db)
  db.transaction(() => { assert.throws(() => applySyncedHostCommand(db, input), /外层|事务|transaction/i) })(); assert.deepEqual(allTables(db), before)
  db.pragma('foreign_keys=OFF'); assert.throws(() => applySyncedHostCommand(db, input), /外键|foreign/i); db.pragma('foreign_keys=ON')
  assert.deepEqual(allTables(db), before)
  const ack = created(applySyncedHostCommand(db, input)), restore = createRestoreInput(db, ack, 'undo').input
  const later = request(db, [a], after => { after[0].summary = 'actual later tail' }), laterAck = applySyncedHostFinal(db, later)
  assert.ok(laterAck.status === 'applied', 'A later real host-final operation becomes the current history tail')
  rejected(db, () => restoreSyncedHostOperation(db, restore), 'conflict')
  assert.throws(() => assertNoUnsupportedSyncedContent(db), /尚不支持|同步块/)
}))

test('create Undo refuses a current prospective W local URL that would silently bind another document after original path reuse', () => withHostDatabase(db => {
  db.prepare("UPDATE documents SET title='Target',path='Home/Target' WHERE id=?").run(b)
  db.prepare("UPDATE documents SET path='Home/Other' WHERE id=?").run(c)
  db.prepare('UPDATE blocks SET content=? WHERE id=?').run('[target](Target.md)', bodyId(a))
  const input = createRequest(db), frozenInput = copy(input), ack = created(applySyncedHostCommand(db, input)), current = snapshot(db, input.action.groupId)
  assert.ok(current.bindings.some(binding => binding.target.kind === 'document' && binding.target.id === b), 'Creation captured the original stable document target before its path changed')
  const restore = createRestoreInput(db, ack, 'undo').input
  db.prepare("UPDATE documents SET path='Home/Renamed target' WHERE id=?").run(b)
  db.prepare("UPDATE documents SET title='Target',path='Home/Target' WHERE id=?").run(c)
  assert.equal(snapshot(db, input.action.groupId).revision, current.revision); assert.equal(snapshot(db, input.action.groupId).topologyRevision, current.topologyRevision)
  rejected(db, () => restoreSyncedHostOperation(db, restore))
  assert.deepEqual(input, frozenInput); assert.deepEqual(snapshot(db, input.action.groupId).bindings, current.bindings)
  assert.equal(getSyncedHostHistory(db, { documentId: a }).undoToken, ack.historyToken)
}))

test('create Redo refuses old path reuse or newly activated unresolved URLs in current ordinary W instead of substituting frozen canonical targets', () => {
  for (const kind of ['path-reused', 'unresolved-activated'] as const) withHostDatabase(db => {
    if (kind === 'path-reused') db.prepare("UPDATE documents SET title='Target',path='Home/Target' WHERE id=?").run(b)
    db.prepare("UPDATE documents SET path='Home/Other' WHERE id=?").run(c)
    db.prepare('UPDATE blocks SET content=? WHERE id=?').run('[target](Target.md)', bodyId(a))
    const input = createRequest(db), ack = created(applySyncedHostCommand(db, input)), canonical = snapshot(db, input.action.groupId)
    if (kind === 'unresolved-activated') assert.ok(canonical.bindings.some(binding => binding.target.kind === 'unresolved-url'), 'The original absent destination is recorded as unresolved rather than a guessed document')
    const undo = restoreCreated(db, ack, 'undo'), restore = createRestoreInput(db, undo.ack, 'redo').input, retiredBefore = copy(undo.ack.createdLifecycle)
    if (kind === 'path-reused') db.prepare("UPDATE documents SET path='Home/Renamed target' WHERE id=?").run(b)
    db.prepare("UPDATE documents SET title='Target',path='Home/Target' WHERE id=?").run(c)
    rejected(db, () => restoreSyncedHostOperation(db, restore))
    assert.equal(logical(db, a).blocks.find(block => block.id === bodyId(a))!.content, '[target](Target.md)')
    assert.equal(getSyncedHostHistory(db, { documentId: a }).redoToken, ack.historyToken)
    const row = db.prepare('SELECT wire_json FROM synced_group_retirements WHERE group_id=?').get(input.action.groupId) as { wire_json: string }
    assert.deepEqual(JSON.parse(row.wire_json), wire(canonical)); assert.deepEqual(undo.ack.createdLifecycle, retiredBefore)
  })
})

test('a real historical block route can prove the same stable block across path reuse so create Undo and Redo preserve raw W and original target identity', () => withHostDatabase(db => {
  const target = uuid(711)
  db.prepare("UPDATE documents SET title='Target',path='Home/Target' WHERE id=?").run(b)
  db.prepare("UPDATE documents SET path='Home/Other' WHERE id=?").run(c)
  seedCreateBlocks(db, [{ id: target, content: 'Stable target block' }], b)
  db.prepare('INSERT INTO document_block_routes(document_path,block_id) VALUES(?,?)').run('Home/Target', target)
  const raw = '[target](Target.md#^' + target + ')'; db.prepare('UPDATE blocks SET content=? WHERE id=?').run(raw, bodyId(a))
  const input = createRequest(db), ack = created(applySyncedHostCommand(db, input)), canonical = snapshot(db, input.action.groupId)
  assert.ok(canonical.bindings.some(binding => binding.target.kind === 'block' && binding.target.id === target), 'The actual source resolves to the precise routed block identity')
  db.prepare("UPDATE documents SET path='Home/Renamed target' WHERE id=?").run(b)
  db.prepare("UPDATE documents SET title='Target',path='Home/Target' WHERE id=?").run(c)
  const undo = restoreCreated(db, ack, 'undo'); retired(db, undo.ack)
  assert.equal(logical(db, a).blocks.find(block => block.id === bodyId(a))!.content, raw)
  const redo = restoreCreated(db, undo.ack, 'redo'), after = active(db, redo.ack)
  assert.deepEqual(after.bindings.map(binding => binding.target.kind === 'block' ? binding.target.id : binding.target),
    canonical.bindings.map(binding => binding.target.kind === 'block' ? binding.target.id : binding.target))
  assert.equal(after.blocks.find(block => block.id === bodyId(a))!.content, canonical.blocks.find(block => block.id === bodyId(a))!.content)
}))

test('whole W last-binding named notes use the last physical definition and keep genuinely undefined note literals unactivated', () => withHostDatabase(db => {
  db.prepare('UPDATE blocks SET content=? WHERE id=?').run('Use[^n] and Missing[^absent]', bodyId(a))
  seedCreateBlocks(db, [{ id: ' create:inactive earlier note ', content: '[^n]: Earlier inactive body' },
    { id: ' create:effective last note ', content: '[^n]: Last effective body' }])
  const input = createRequest(db), ack = created(applySyncedHostCommand(db, input)), current = active(db, ack), model = parseMarkdownDocumentBlocks(current.blocks)
  const rendered = modelText(model.footnotes), facts = modelFacts(model.blockNodes.flat())
  assert.ok(rendered.includes('Last effective body') && !rendered.includes('Earlier inactive body'), 'The actual resulting note uses the real original last definition rather than the first matching label')
  assert.ok(facts.some(fact => fact.type === 'footnote_missing' && fact.label === 'absent'), 'An originally undefined note use remains a literal missing use after auxiliary closure creation')
  const undo = restoreCreated(db, ack, 'undo'); retired(db, undo.ack)
  assert.equal(logical(db, a).blocks.find(block => block.id === bodyId(a))!.content, 'Use[^n] and Missing[^absent]')
}))

test('creating the entire only ordinary host body needs no invented old-group guard or filler and keeps one exact physical leaf', () => withHostDatabase(db => {
  const input = createRequest(db, { documentId: b }), before = logical(db, b)
  assert.deepEqual(input.groups, []); assert.deepEqual(input.expectedInstances, [])
  const ack = created(applySyncedHostCommand(db, input)), current = active(db, ack)
  assert.deepEqual(ids(db, b), [input.action.instanceId]); assert.deepEqual(ack.groups.map(group => group.groupId), [input.action.groupId])
  assert.deepEqual(current.blocks.map(({ createdAt: _birth, ...block }) => block), before.blocks)
  const undo = restoreCreated(db, ack, 'undo'); retired(db, undo.ack); assert.deepEqual(logical(db, b), before)
  const redo = restoreCreated(db, undo.ack, 'redo'); active(db, redo.ack); assert.deepEqual(ids(db, b), [input.action.instanceId])
}))

test('fresh copied note definitions count against the unchanged complete group wire budget before any identity or journal writes', () => withHostDatabase(db => {
  assert.equal(SYNCED_GROUP_MAX_BYTES, 5 * 1024 * 1024)
  db.prepare('UPDATE blocks SET content=? WHERE id=?').run('Use[^large]', bodyId(a))
  seedCreateBlocks(db, [{ id: ' create:large external definition ', content: '[^large]: ' + 'N'.repeat(SYNCED_GROUP_MAX_BYTES) }])
  const input = createRequest(db), result = rejected(db, () => applySyncedHostCommand(db, input), 'invalid')
  assert.ok(result.status === 'invalid' && result.code === 'budget', 'The actual copied canonical closure is included in the original five MiB group limit')
  assert.equal(db.prepare('SELECT 1 FROM synced_groups WHERE id=?').get(input.action.groupId), undefined)
  assert.equal(identity(db, input.action.instanceId), undefined)
}))

test('relative image source cannot cross a changed actual host path during create Undo or Redo without a proved asset context', () => {
  for (const direction of ['undo', 'redo'] as const) withHostDatabase(db => {
    const raw = '![relative image](relative/picture.png)'; db.prepare('UPDATE blocks SET content=? WHERE id=?').run(raw, bodyId(a))
    const input = createRequest(db), forward = created(applySyncedHostCommand(db, input))
    const current = direction === 'redo' ? restoreCreated(db, forward, 'undo').ack : forward
    const restore = createRestoreInput(db, current, direction).input
    db.prepare("UPDATE documents SET path='Home/Moved/Host A' WHERE id=?").run(a)
    const result = rejected(db, () => restoreSyncedHostOperation(db, restore))
    assert.ok(result.status === 'unsupported' && result.reason === 'semantic-binding', 'A changed real host path has no proved relative asset equivalence under the immutable original Origin')
    assert.equal(current.createdLifecycle.origin.pathAtCreation, 'Home/Host A')
    const group = db.prepare('SELECT revision,topology_revision FROM synced_groups WHERE id=?').get(input.action.groupId) as { revision: string; topology_revision: string }
    assert.equal(group.revision, current.createdLifecycle.revision); assert.equal(group.topology_revision, current.createdLifecycle.topologyRevision)
    if (direction === 'redo') assert.equal(logical(db, a).blocks.find(block => block.id === bodyId(a))!.content, raw)
  })
})
