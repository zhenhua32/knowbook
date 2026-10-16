import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { canonicalSyncedPortableJson } from '../src/shared/syncedBlockPortable'
import { syncedCanonicalEdits } from '../src/shared/syncedBlockValidation'
import { validateSyncedStructureInput } from '../src/shared/syncedBlockInputs'
import { parseMarkdownDocumentBlocks } from '../src/shared/markdownDocument'
import type { MarkdownNode } from '../src/shared/markdownEngine'
import { getSyncedOperation } from '../src/main/database/synced-blocks-content'
import { ordinary } from './helpers/synced-content-fixture'
import { withHostDatabase, a, b, c, bodyId, secondGroup, groupId, instanceId, born, now,
  moveRequest, moved, mixedForest, command, insertAck, parentChain, type MoveCommand,
  request, logical, copy, freshBlock, edit, restoreInput, restoreAck, snapshot, groupEdit,
  applySyncedHostFinal, applySyncedHostCommand, restoreSyncedHostOperation, getSyncedHostHistory,
  allTables, withoutOperations, totalChanges, identity, bodyBirth, changeBody
} from './helpers/synced-host-command-move-fixture'

const encode = canonicalSyncedPortableJson
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const ids = (db: Database.Database, documentId = a) => logical(db, documentId).blocks.map(block => block.id)
function operation(db: Database.Database, id: string) {
  const row = db.prepare('SELECT client_operation_id,request_hash,result_json,created_at FROM synced_operations WHERE client_operation_id=?')
    .get(id) as { client_operation_id: string; request_hash: string; result_json: string; created_at: string } | undefined
  assert.ok(row, 'The real move writer committed the original operation receipt'); return row
}
function journal(db: Database.Database, token: string | null) {
  assert.ok(token, 'A real nonidentity move has a nonnull journal token')
  const row = db.prepare('SELECT id,action_json,before_json,after_json,before_hash,after_hash,created_at FROM synced_host_history WHERE id=?')
    .get(token) as { id: string; action_json: string; before_json: string; after_json: string; before_hash: string; after_hash: string; created_at: string } | undefined
  assert.ok(row, 'The original move journal is persisted by the real writer'); return row
}
function reject(db: Database.Database, run: () => ReturnType<typeof applySyncedHostCommand>, status?: string, reason?: string) {
  const before = allTables(db), changes = totalChanges(db), result = run()
  assert.ok(result.status !== 'applied' && result.status !== 'noop', 'A rejected move never claims an accepted ACK')
  if (status) assert.equal(result.status, status)
  if (reason) { assert.ok(result.status === 'unsupported', 'Only an unsupported result carries the closed Main reason'); assert.equal(result.reason, reason) }
  assert.deepEqual(allTables(db), before, 'A rejected move leaves every user table unchanged')
  assert.equal(totalChanges(db), changes, 'Planning and authority rejection perform no provisional DML')
  return result
}
function expectWorking(db: Database.Database, input: MoveCommand) {
  assert.equal(encode(logical(db, input.action.target.documentId)), encode({ documentId: input.action.target.documentId,
    ...input.hostsWorkingBefore[0].workingBefore }))
}
function births(db: Database.Database, blockIds: string[]) {
  return blockIds.map(id => ({ id, identity: identity(db, id), createdAt: bodyBirth(db, id) }))
}
function roundtrip(db: Database.Database, input: MoveCommand, ack: ReturnType<typeof moved>) {
  const after = logical(db, input.action.target.documentId)
  restoreAck(db, ack, 'undo'); expectWorking(db, input)
  restoreAck(db, ack, 'redo'); assert.deepEqual(logical(db, input.action.target.documentId), after)
}
function seed(db: Database.Database, blocks: Array<{ id: string; content: string; type?: string }>) {
  blocks.forEach((block, index) => {
    ordinary(db, block.id, { owner: a, sort: 10 + index, type: block.type ?? 'paragraph' })
    db.prepare("UPDATE blocks SET content=?,tags_json='[]' WHERE id=?").run(block.content, block.id)
  })
}
function mixedRedo(db: Database.Database) {
  const prefix = edit(db, [c], 'executed prefix'), ab = edit(db, [a, b], 'shared AB')
  const inserted = command(db, { documentId: b, groupId: secondGroup }), insert = { input: inserted, ack: insertAck(applySyncedHostCommand(db, inserted)) }
  const moveInput = moveRequest(db, { documentId: b, selectedRootIds: [inserted.action.instanceId], target: { beforeBlockId: bodyId(b) } })
  const move = { input: moveInput, ack: moved(applySyncedHostCommand(db, moveInput)) }
  const bc = edit(db, [b, c], 'shared BC'), tail = edit(db, [c], 'peer tail')
  for (const item of [tail, bc, move, insert, ab]) restoreAck(db, item.ack, 'undo')
  return { prefix, ab, insert, move, bc, tail }
}
function noteIds(db: Database.Database) {
  const host = logical(db, a), model = parseMarkdownDocumentBlocks(host.blocks, host.title), result: Record<string, Array<{ label: string; id: number }>> = {}
  const walk = (nodes: MarkdownNode[], output: Array<{ label: string; id: number }>) => {
    for (const node of nodes) {
      if (node.token.type === 'footnote_ref') output.push({ label: String(node.token.meta?.label), id: Number(node.token.meta?.id) })
      walk(node.children, output)
    }
  }
  host.blocks.forEach((block, index) => { result[block.id] = []; walk(model.blockNodes[index], result[block.id]) })
  return result
}

test('move stores the original validated command hash finite full W A journal and exact immutable ACK', () => withHostDatabase(db => {
  const input = moveRequest(db), frozen = copy(input), before = logical(db, a), old = snapshot(db), originalBirths = births(db, ids(db))
  const ack = moved(applySyncedHostCommand(db, input)), row = journal(db, ack.historyToken), action = JSON.parse(row.action_json)
  assert.deepEqual(input, frozen); assert.deepEqual(validateSyncedStructureInput(input), frozen)
  assert.equal(operation(db, ack.operationId).request_hash, sha(encode({ method: 'applySyncedHostCommand', input })))
  assert.equal(action.kind, 'host-command'); assert.equal(action.version, 1); assert.deepEqual(action.input, input)
  assert.deepEqual(JSON.parse(row.before_json), [{ documentId: a, content: input.hostsWorkingBefore[0].workingBefore }])
  assert.equal(row.before_hash, sha(encode(JSON.parse(row.before_json)))); assert.equal(row.after_hash, sha(encode(JSON.parse(row.after_json))))
  assert.deepEqual(ids(db), [bodyId(a), instanceId]); assert.deepEqual(logical(db, a).blocks, [before.blocks[1], before.blocks[0]])
  assert.deepEqual(snapshot(db), old, 'Changing only sibling order keeps exact existing binding and topology')
  assert.deepEqual(births(db, originalBirths.map(item => item.id)), originalBirths)
  const pins = allTables(db).synced_group_pins as Array<{ group_id: string; kind: string; pin_id: string }>
  assert.ok(pins.some(pin => pin.group_id === groupId && pin.kind === 'host-history' && pin.pin_id === ack.historyToken), 'The actual move journal pins its canonical dependency')
  const lookup = getSyncedOperation(db, { clientOperationId: ack.operationId })
  assert.ok(lookup.status === 'committed', 'Generic lookup returns the real original move ACK')
  assert.equal(encode(lookup.result), encode({ ...ack, replayed: true }))
  roundtrip(db, input, ack)
}))

test('contiguous mixed ordinary and reference roots move complete nested subtrees in W order with unchanged births and peers', () => withHostDatabase(db => {
  const forest = mixedForest(db), peer = command(db, { documentId: b, groupId: secondGroup })
  insertAck(applySyncedHostCommand(db, peer))
  const old = logical(db, a), peerHost = logical(db, b), groups = [snapshot(db), snapshot(db, secondGroup)], oldBirths = births(db, ids(db))
  const input = moveRequest(db, { selectedRootIds: [forest.owner, bodyId(a)] }), ack = moved(applySyncedHostCommand(db, input))
  assert.deepEqual(ids(db), [bodyId(a), forest.owner, forest.nestedId, forest.child, instanceId, forest.outside])
  assert.deepEqual(logical(db, a).blocks.map(block => [block.id, block]), ids(db).map(id => [id, old.blocks.find(block => block.id === id)]))
  assert.deepEqual(births(db, oldBirths.map(item => item.id)), oldBirths); assert.deepEqual(logical(db, b), peerHost)
  assert.deepEqual([snapshot(db), snapshot(db, secondGroup)], groups)
  roundtrip(db, input, ack); assert.deepEqual(logical(db, b), peerHost)
}))

test('moving a real root reference under an existing container renews only its binding and preserves nested peer bindings', () => withHostDatabase(db => {
  const forest = mixedForest(db), before = snapshot(db), oldBirths = births(db, ids(db))
  const input = moveRequest(db, { selectedRootIds: [instanceId], target: { parentBlockId: forest.owner, beforeBlockId: forest.child, depth: 1 } })
  const ack = moved(applySyncedHostCommand(db, input)), after = snapshot(db)
  assert.deepEqual(ids(db), [bodyId(a), forest.owner, forest.nestedId, instanceId, forest.child, forest.outside])
  const oldRoot = before.instances.find(item => item.instanceId === instanceId), newRoot = after.instances.find(item => item.instanceId === instanceId)
  assert.ok(oldRoot && newRoot, 'The same real reference identity exists before and after reparenting')
  assert.notEqual(newRoot.bindingVersion, oldRoot.bindingVersion); assert.notEqual(after.topologyRevision, before.topologyRevision)
  assert.deepEqual(after.instances.find(item => item.instanceId === forest.nestedId), before.instances.find(item => item.instanceId === forest.nestedId))
  assert.deepEqual(births(db, oldBirths.map(item => item.id)), oldBirths)
  roundtrip(db, input, ack)
}))

test('duplicate ancestor and contained raw roots reduce only execution while the original array remains in the command hash', () => withHostDatabase(db => {
  const forest = mixedForest(db), roots = [forest.owner, forest.nestedId, forest.owner, forest.child]
  const input = moveRequest(db, { selectedRootIds: roots }), ack = moved(applySyncedHostCommand(db, input))
  assert.deepEqual(ids(db), [forest.owner, forest.nestedId, forest.child, instanceId, bodyId(a), forest.outside])
  assert.deepEqual(JSON.parse(journal(db, ack.historyToken).action_json).input.action.selection.selectedRootIds, roots)
  const different = copy(input); different.action.selection.selectedRootIds = [forest.owner]
  reject(db, () => applySyncedHostCommand(db, different), 'idempotency-mismatch')
  roundtrip(db, input, ack)
}))

test('dirty ordinary W and a fresh ordinary parent child anchor persist exact accepted metadata and undo to the complete original W', () => withHostDatabase(db => {
  const parent = ' move:W-only parent ', child = ' move:W-only child ', oldBirth = bodyBirth(db, bodyId(a))
  const input = moveRequest(db, { dirty: working => {
    working.summary = 'unsaved exact W summary'; changeBody(working, 'unsaved **body** [Host B](Host%20B.md)')
    working.blocks[1].type = 'todo'; working.blocks[1].checked = true; working.blocks[1].tags = ['dirty', '原文']; working.blocks[1].highlight = 'yellow'
    working.blocks.push({ ...freshBlock(parent, 'Fresh owner'), type: 'toggle' }, { ...freshBlock(child, 'Fresh child'), parentBlockId: parent, depth: 1 })
  }, target: { parentBlockId: parent, beforeBlockId: child, depth: 1 } })
  const ack = moved(applySyncedHostCommand(db, input))
  assert.deepEqual(ids(db), [instanceId, parent, bodyId(a), child]); assert.equal(logical(db, a).summary, input.hostsWorkingBefore[0].workingBefore.summary)
  const body = logical(db, a).blocks.find(block => block.id === bodyId(a))
  assert.ok(body, 'The actual moved ordinary body retains its original stable ID')
  assert.deepEqual(body, { ...input.hostsWorkingBefore[0].workingBefore.blocks[1], depth: 1, parentBlockId: parent })
  assert.equal(bodyBirth(db, bodyId(a)), oldBirth)
  const freshBirths = births(db, [parent, child]); roundtrip(db, input, ack)
  assert.deepEqual(births(db, [parent, child]), freshBirths)
}))

test('stable before IDs resolve after removing the entire selected subtree rather than using an old index', () => withHostDatabase(db => {
  const forest = mixedForest(db), input = moveRequest(db, { selectedRootIds: [instanceId], target: { beforeBlockId: forest.outside } })
  const ack = moved(applySyncedHostCommand(db, input))
  assert.deepEqual(ids(db), [bodyId(a), forest.owner, forest.nestedId, forest.child, instanceId, forest.outside])
  roundtrip(db, input, ack)
}))

test('a null child anchor appends after all existing descendants of the exact parent', () => withHostDatabase(db => {
  const forest = mixedForest(db), input = moveRequest(db, { target: { parentBlockId: forest.owner, beforeBlockId: null, depth: 1 } })
  const ack = moved(applySyncedHostCommand(db, input))
  assert.deepEqual(ids(db), [instanceId, forest.owner, forest.nestedId, forest.child, bodyId(a), forest.outside])
  roundtrip(db, input, ack)
}))

test('noncontiguous roots and different-parent roots are an explicit unsupported move selection without any writes', () => {
  for (const kind of ['gap', 'different-parent'] as const) withHostDatabase(db => {
    const forest = mixedForest(db), input = moveRequest(db, { selectedRootIds: kind === 'gap' ? [instanceId, forest.outside] : [bodyId(a), forest.nestedId] })
    reject(db, () => applySyncedHostCommand(db, input), 'unsupported', 'move-selection')
  })
})

test('missing roots selected anchors cycles wrong direct children closed subtrees and inaccurate depths never guess a placement', () => {
  for (const kind of ['missing-root', 'selected-anchor', 'cycle', 'missing-parent', 'missing-anchor', 'not-direct-child', 'closed-subtree', 'depth', 'root-depth'] as const) withHostDatabase(db => {
    const forest = mixedForest(db), input = moveRequest(db, { selectedRootIds: [forest.owner], target: { beforeBlockId: instanceId } })
    if (kind === 'missing-root') input.action.selection.selectedRootIds = ['missing stable root']
    if (kind === 'selected-anchor') input.action.target.beforeBlockId = forest.nestedId
    if (kind === 'cycle') { input.action.target.parentBlockId = forest.owner; input.action.target.depth = 1; input.action.target.beforeBlockId = null }
    if (kind === 'missing-parent') { input.action.target.parentBlockId = 'missing parent'; input.action.target.depth = 1 }
    if (kind === 'missing-anchor') input.action.target.beforeBlockId = 'missing anchor'
    if (kind === 'not-direct-child') input.action.target.beforeBlockId = forest.child
    if (kind === 'closed-subtree') { input.action.selection.selectedRootIds = [bodyId(a)]; input.action.target = { documentId: a, parentBlockId: forest.owner, beforeBlockId: forest.outside, depth: 1 } }
    if (kind === 'depth') { input.action.selection.selectedRootIds = [bodyId(a)]; input.action.target = { documentId: a, parentBlockId: forest.owner, beforeBlockId: forest.child, depth: 2 } }
    if (kind === 'root-depth') input.action.target.depth = 1
    reject(db, () => applySyncedHostCommand(db, input), 'invalid')
  })
})

test('ordinary moves into a legal weighted column retain the complete container structure through true inverse', () => withHostDatabase(db => {
  const columns = ' move:columns ', left = ' move:left ', right = ' move:right ', child = ' move:column child '
  const setup = command(db, { dirty: working => working.blocks.push({ ...freshBlock(columns, ''), type: 'columns' },
    { ...freshBlock(left, ''), type: 'column', depth: 1, parentBlockId: columns, markdownFormat: { columnWeight: 5000 } },
    { ...freshBlock(child), depth: 2, parentBlockId: left },
    { ...freshBlock(right, ''), type: 'column', depth: 1, parentBlockId: columns, markdownFormat: { columnWeight: 5000 } }),
    target: { parentBlockId: right, depth: 2 } })
  insertAck(applySyncedHostCommand(db, setup))
  const input = moveRequest(db, { target: { parentBlockId: left, beforeBlockId: child, depth: 2 } }), ack = moved(applySyncedHostCommand(db, input))
  assert.deepEqual(ids(db), [instanceId, columns, left, bodyId(a), child, right, setup.action.instanceId])
  roundtrip(db, input, ack)
}))

test('transparent moved references obey current canonical parent roles rather than the placeholder type', () => {
  for (const compatible of [false, true]) withHostDatabase(db => {
    const parent = ' move:list parent '
    if (compatible) groupEdit(db, syncedCanonicalEdits(snapshot(db).blocks).map(block => ({ ...block, type: 'bulleted-list' })))
    const input = moveRequest(db, { selectedRootIds: [instanceId], dirty: working => working.blocks.push({ ...freshBlock(parent, 'List'), type: 'bulleted-list' }),
      target: { parentBlockId: parent, beforeBlockId: null, depth: 1 } })
    if (compatible) { const ack = moved(applySyncedHostCommand(db, input)); roundtrip(db, input, ack) }
    else reject(db, () => applySyncedHostCommand(db, input), 'invalid')
  })
})

test('expanded current canonical depth is checked at the exact moved destination without clamping', () => withHostDatabase(db => {
  const root = syncedCanonicalEdits(snapshot(db).blocks)[0]
  groupEdit(db, [{ ...root, type: 'toggle' }, { ...freshBlock(' move:canonical child '), depth: 1, parentBlockId: root.id }])
  const input = moveRequest(db, { selectedRootIds: [instanceId], dirty: working => { parentChain(working, 6, ' move:deep:') },
    target: { parentBlockId: ' move:deep:5', beforeBlockId: null, depth: 6 } })
  const result = reject(db, () => applySyncedHostCommand(db, input), 'invalid')
  assert.ok(result.status === 'invalid' && result.code === 'depth', 'The unchanged six-level expanded-depth contract rejects this actual destination')
}))

test('W cannot implicitly remove reorder reparent retarget or create a reference before the explicit move authority', () => {
  for (const kind of ['delete', 'reorder', 'retarget', 'fresh-ref', 'parent-role'] as const) withHostDatabase(db => {
    const forest = mixedForest(db), input = moveRequest(db, { selectedRootIds: [instanceId], target: { beforeBlockId: forest.outside } })
    const blocks = input.hostsWorkingBefore[0].workingBefore.blocks
    if (kind === 'delete') blocks.splice(blocks.findIndex(block => block.id === bodyId(a)), 1)
    if (kind === 'reorder') { const body = blocks.splice(blocks.findIndex(block => block.id === bodyId(a)), 1)[0]; blocks.push(body) }
    if (kind === 'retarget') blocks[0].content = JSON.stringify({ version: 1, groupId: secondGroup })
    if (kind === 'fresh-ref') blocks.push({ ...blocks[0], id: randomUUID() })
    if (kind === 'parent-role') blocks.find(block => block.id === forest.owner)!.type = 'callout'
    reject(db, () => applySyncedHostCommand(db, input), 'unsupported', 'working-structure')
  })
})

test('cross-host selections extra W hosts and other command kinds cannot widen the single-host move method', () => {
  for (const kind of ['source-host', 'target-host', 'extra-W', 'duplicate'] as const) withHostDatabase(db => {
    const input = moveRequest(db)
    if (kind === 'source-host') input.action.selection.documentId = b
    if (kind === 'target-host') input.action.target.documentId = b
    if (kind === 'extra-W') input.hostsWorkingBefore.push(request(db, [b]).hostsWorkingBefore[0])
    const value = kind === 'duplicate' ? { ...input, action: { ...input.action, kind: 'duplicate' } } : input
    reject(db, () => applySyncedHostCommand(db, value), 'unsupported', 'command')
  })
})

test('real host group topology and binding CAS guards reject stale move requests with the original dirty W untouched', () => {
  for (const kind of ['host', 'revision', 'topology', 'binding', 'group-omission', 'extra-group', 'instance-omission'] as const) withHostDatabase(db => {
    const input = moveRequest(db, { dirty: working => { changeBody(working, 'stale unsaved W'); working.summary = 'stale summary' } })
    if (kind === 'host') input.hostsWorkingBefore[0].expectedPersistedUpdatedAt = born
    if (kind === 'revision') input.groups[0].expectedRevision = randomUUID()
    if (kind === 'topology') input.groups[0].expectedTopologyRevision = randomUUID()
    if (kind === 'binding') input.expectedInstances[0].bindingVersion = randomUUID()
    if (kind === 'group-omission') input.groups = []
    if (kind === 'extra-group') { const other = snapshot(db, secondGroup); input.groups.push({ groupId: secondGroup, expectedRevision: other.revision, expectedTopologyRevision: other.topologyRevision }) }
    if (kind === 'instance-omission') input.expectedInstances = []
    const frozen = copy(input); reject(db, () => applySyncedHostCommand(db, input)); assert.deepEqual(input, frozen)
  })
})

test('P W A identity commits only its original null-token noop receipt and initializes no history', () => withHostDatabase(db => {
  const input = moveRequest(db, { target: { beforeBlockId: null } }), old = withoutOperations(db), changes = totalChanges(db)
  const ack = applySyncedHostCommand(db, input)
  assert.ok(ack.status === 'noop', 'Moving the already last root to the same root tail is a real noop')
  assert.equal(ack.historyToken, null); assert.deepEqual(withoutOperations(db), old); assert.equal(totalChanges(db), changes + 1)
  assert.deepEqual(ack.affectedInstanceIds, []); assert.throws(() => getSyncedHostHistory(db, { documentId: a }), /初始化|state|history/)
  const saved = allTables(db)
  assert.deepEqual(applySyncedHostCommand(db, input), { ...ack, replayed: true }); assert.deepEqual(allTables(db), saved)
}))

test('a true identity move preserves an existing mixed redo branch without cursor initialization or pruning', () => withHostDatabase(db => {
  const chain = mixedRedo(db), history = [a, b, c].map(documentId => getSyncedHostHistory(db, { documentId })), before = withoutOperations(db)
  const input = moveRequest(db, { target: { beforeBlockId: null } }), ack = applySyncedHostCommand(db, input)
  assert.ok(ack.status === 'noop', 'An actual identity placement remains a noop even with reachable redo')
  assert.equal(ack.historyToken, null); assert.deepEqual(withoutOperations(db), before)
  assert.deepEqual([a, b, c].map(documentId => getSyncedHostHistory(db, { documentId })), history)
  assert.equal(history[0].redoToken, chain.ab.ack.historyToken)
}))

test('P differs from W but A equals W saves the exact dirty working body and prunes redo with an applied null token', () => withHostDatabase(db => {
  const prefix = edit(db, [a], 'executed prefix'), tail = edit(db, [a], 'undone tail')
  restoreAck(db, tail.ack, 'undo'); const immutable = copy(journal(db, tail.ack.historyToken)), oldReceipt = copy(operation(db, tail.input.clientOperationId))
  const input = moveRequest(db, { target: { beforeBlockId: null }, dirty: working => { changeBody(working, 'actual dirty save'); working.summary = 'exact dirty summary' } })
  const ack = applySyncedHostCommand(db, input)
  assert.ok(ack.status === 'applied', 'A real P to W save is applied even when the explicit placement is identity')
  assert.equal(ack.historyToken, null); expectWorking(db, input)
  const history = getSyncedHostHistory(db, { documentId: a }); assert.equal(history.undoToken, prefix.ack.historyToken); assert.equal(history.redoToken, null)
  assert.deepEqual(journal(db, tail.ack.historyToken), immutable); assert.deepEqual(operation(db, tail.input.clientOperationId), oldReceipt)
}))

test('original complete move ACK replays after child link host and canonical changes without reading today as the old result', () => withHostDatabase(db => {
  const child = ' move:child doc ', path = 'Home/Host A/Child'
  db.prepare('INSERT INTO documents(id,title,slug,path,parent_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(child, 'Child', child, path, a, born, now)
  db.prepare('UPDATE blocks SET content=? WHERE id=?').run('[Host B](Host%20B.md)', bodyId(a))
  db.prepare('INSERT INTO links(id,source_document_id,target_document_id,label,created_at) VALUES(?,?,?,?,?)').run(randomUUID(), b, a, 'Host A', born)
  const input = moveRequest(db), ack = moved(applySyncedHostCommand(db, input)), original = copy(operation(db, ack.operationId))
  assert.deepEqual(ack.hosts[0].after.children, [{ id: child, title: 'Child', path }])
  assert.ok(ack.hosts[0].after.outgoingLinks.length && ack.hosts[0].after.backlinks.length, 'The old full ACK includes actual link and backlink collections')
  db.prepare("UPDATE documents SET title='Later child',path='Home/Host A/Later child' WHERE id=?").run(child)
  db.prepare("UPDATE links SET label='later label' WHERE target_document_id=?").run(a)
  edit(db, [a], 'later host body'); groupEdit(db); const before = allTables(db)
  assert.deepEqual(applySyncedHostCommand(db, input), { ...ack, replayed: true })
  const lookup = getSyncedOperation(db, { clientOperationId: ack.operationId })
  assert.ok(lookup.status === 'committed', 'The old command remains queryable through generic original ACK lookup')
  assert.deepEqual(lookup.result, { ...ack, replayed: true }); assert.deepEqual(operation(db, ack.operationId), original); assert.deepEqual(allTables(db), before)
}))

test('same operation ID binds the original method action raw root array target and complete W before any replay', () => {
  for (const kind of ['method', 'action', 'roots', 'target', 'W'] as const) withHostDatabase(db => {
    const input = moveRequest(db), ack = moved(applySyncedHostCommand(db, input)), changed = copy(input)
    if (kind === 'roots') changed.action.selection.selectedRootIds.push(bodyId(a))
    if (kind === 'target') changed.action.target.beforeBlockId = null
    if (kind === 'W') changeBody(changed.hostsWorkingBefore[0].workingBefore, 'changed original W')
    const value = kind === 'action' ? { ...changed, action: { ...changed.action, kind: 'duplicate' } } : changed
    reject(db, () => kind === 'method' ? applySyncedHostFinal(db, input) : applySyncedHostCommand(db, value), 'idempotency-mismatch')
    assert.equal(operation(db, ack.operationId).client_operation_id, ack.operationId)
  })
})

test('corrupt stored full move receipts fail closed on exact replay and generic lookup without reconstructing current state', () => {
  for (const kind of ['extra', 'missing-children', 'null-token', 'stored-replayed', 'empty-after'] as const) withHostDatabase(db => {
    const input = moveRequest(db), ack = moved(applySyncedHostCommand(db, input)), envelope = JSON.parse(operation(db, ack.operationId).result_json)
    if (kind === 'extra') envelope.extra = true
    if (kind === 'missing-children') delete envelope.result.hosts[0].after.children
    if (kind === 'null-token') envelope.result.historyToken = null
    if (kind === 'stored-replayed') envelope.result.replayed = true
    if (kind === 'empty-after') envelope.result.hosts[0].after.blocks = []
    db.prepare('UPDATE synced_operations SET result_json=? WHERE client_operation_id=?').run(JSON.stringify(envelope), ack.operationId)
    const before = allTables(db), changes = totalChanges(db)
    assert.throws(() => getSyncedOperation(db, { clientOperationId: ack.operationId }), /宿主|结构|回执|收据|ack/i)
    assert.throws(() => applySyncedHostCommand(db, input), /宿主|结构|回执|收据|W\/A|ack/i)
    assert.deepEqual(allTables(db), before); assert.equal(totalChanges(db), changes)
  })
})

test('host-final insert and move journals undo and redo in the true common tail order with immutable original action kinds', () => withHostDatabase(db => {
  const first = edit(db, [a], 'host-final prefix'), insertInput = command(db, { groupId: secondGroup }), inserted = insertAck(applySyncedHostCommand(db, insertInput))
  const input = moveRequest(db, { selectedRootIds: [insertInput.action.instanceId] }), ack = moved(applySyncedHostCommand(db, input)), after = logical(db, a), originalBirths = births(db, ids(db))
  assert.equal(JSON.parse(journal(db, first.ack.historyToken).action_json).kind, 'host-final')
  assert.equal(JSON.parse(journal(db, inserted.historyToken).action_json).input.action.kind, 'insert')
  assert.equal(JSON.parse(journal(db, ack.historyToken).action_json).input.action.kind, 'move')
  for (const item of [ack, inserted, first.ack]) restoreAck(db, item, 'undo')
  for (const item of [first.ack, inserted, ack]) restoreAck(db, item, 'redo')
  assert.deepEqual(logical(db, a), after); assert.deepEqual(births(db, originalBirths.map(item => item.id)), originalBirths)
}))

test('a new move prunes mixed host-final insert move AB BC redo fixed points and preserves executed prefixes journals pins and ACKs', () => withHostDatabase(db => {
  const chain = mixedRedo(db), before = allTables(db), items = [chain.prefix, chain.ab, chain.insert, chain.move, chain.bc, chain.tail]
  const receipts = items.map(item => copy(operation(db, item.input.clientOperationId))), input = moveRequest(db), ack = moved(applySyncedHostCommand(db, input)), rows = allTables(db)
  const mappings = rows.synced_host_history_documents as Array<{ history_id: string; document_id: string }>
  const discarded = [chain.ab, chain.insert, chain.move, chain.bc, chain.tail].map(item => item.ack.historyToken)
  assert.ok(!mappings.some(row => discarded.includes(row.history_id)), 'Pruning removes the entire transitively shared redo fixed point')
  assert.ok(mappings.some(row => row.history_id === chain.prefix.ack.historyToken && row.document_id === c), 'The executed independent prefix remains mapped')
  for (const table of ['synced_host_history', 'synced_group_pins']) {
    const prior = before[table] as unknown[], current = rows[table] as unknown[]
    assert.deepEqual(current.filter(row => prior.some(value => encode(value) === encode(row))), prior)
  }
  for (const receipt of receipts) assert.deepEqual(operation(db, receipt.client_operation_id), receipt)
  assert.equal(getSyncedHostHistory(db, { documentId: c }).undoToken, chain.prefix.ack.historyToken)
  assert.equal(getSyncedHostHistory(db, { documentId: b }).redoToken, null); assert.equal(getSyncedHostHistory(db, { documentId: a }).undoToken, ack.historyToken)
}))

test('late move receipt failure rolls back nested bindings dirty births mixed pruning and every table before exact original retry', () => withHostDatabase(db => {
  const forest = mixedForest(db), ab = edit(db, [a, b], 'shared undone suffix'); restoreAck(db, ab.ack, 'undo')
  const oldGroup = snapshot(db), oldBirths = births(db, ids(db)), input = moveRequest(db, { selectedRootIds: [instanceId],
    dirty: working => working.blocks.push(freshBlock(' move:late fresh birth ')), target: { parentBlockId: forest.owner, beforeBlockId: forest.child, depth: 1 } })
  db.exec("CREATE TRIGGER fail_move_receipt BEFORE INSERT ON synced_operations BEGIN SELECT RAISE(ABORT,'injected move late receipt'); END")
  const before = allTables(db)
  assert.throws(() => applySyncedHostCommand(db, input), /injected move late receipt/); assert.deepEqual(allTables(db), before)
  db.exec('DROP TRIGGER fail_move_receipt'); const ack = moved(applySyncedHostCommand(db, input)), next = snapshot(db)
  assert.deepEqual(next.instances.find(item => item.instanceId === forest.nestedId), oldGroup.instances.find(item => item.instanceId === forest.nestedId))
  assert.deepEqual(births(db, oldBirths.map(item => item.id)), oldBirths); roundtrip(db, input, ack)
}))

test('two actual SQLite connections accept one move CAS and preserve the losing client original complete dirty W', () => withHostDatabase((db, second) => {
  const peer = second(), first = moveRequest(db), stale = moveRequest(peer, { dirty: working => { changeBody(working, 'peer unsaved W'); working.summary = 'peer summary' } }), frozen = copy(stale)
  moved(applySyncedHostCommand(db, first)); reject(peer, () => applySyncedHostCommand(peer, stale), 'conflict')
  assert.deepEqual(stale, frozen); assert.deepEqual(ids(peer), [bodyId(a), instanceId])
}))

test('corrupt move action original roots planned A hashes births and mappings fail closed before inverse or pruning', () => {
  for (const kind of ['extra-action', 'changed-roots', 'changed-target', 'forged-A', 'missing-birth', 'missing-mapping'] as const) withHostDatabase(db => {
    const input = moveRequest(db), ack = moved(applySyncedHostCommand(db, input)); restoreAck(db, ack, 'undo')
    const row = journal(db, ack.historyToken), action = JSON.parse(row.action_json)
    if (kind === 'extra-action') action.extra = true
    if (kind === 'changed-roots') action.input.action.selection.selectedRootIds = [instanceId]
    if (kind === 'changed-target') action.input.action.target.beforeBlockId = null
    if (kind === 'missing-birth') action.births.pop()
    if (kind === 'forged-A') { const sides = JSON.parse(row.after_json); sides[0].content.summary += ' self-hashed forged A'; db.prepare('UPDATE synced_host_history SET after_json=?,after_hash=? WHERE id=?').run(encode(sides), sha(encode(sides)), row.id) }
    else if (kind === 'missing-mapping') db.prepare('DELETE FROM synced_host_history_documents WHERE history_id=?').run(row.id)
    else db.prepare('UPDATE synced_host_history SET action_json=? WHERE id=?').run(JSON.stringify(action), row.id)
    const restore = restoreInput(db, ack, 'redo'), next = moveRequest(db), before = allTables(db), changes = totalChanges(db)
    assert.throws(() => restoreSyncedHostOperation(db, restore), /日志|journal|历史|格式|birth|mappings|参与者/i)
    assert.deepEqual(allTables(db), before); assert.equal(totalChanges(db), changes)
    if (kind !== 'missing-mapping') { assert.throws(() => applySyncedHostCommand(db, next), /日志|journal|历史|格式|birth|分支/i); assert.deepEqual(allTables(db), before) }
  })
})

test('move inverse preserves current legal canonical content revision old identities and routes instead of replaying an old group body', () => withHostDatabase(db => {
  const forest = mixedForest(db), input = moveRequest(db, { selectedRootIds: [instanceId], target: { parentBlockId: forest.owner, beforeBlockId: forest.child, depth: 1 } })
  const oldBirths = births(db, ids(db)), routes = allTables(db).document_block_routes, ack = moved(applySyncedHostCommand(db, input))
  groupEdit(db); const current = snapshot(db)
  restoreAck(db, ack, 'undo'); assert.deepEqual(snapshot(db).blocks, current.blocks); assert.equal(snapshot(db).revision, current.revision)
  restoreAck(db, ack, 'redo'); assert.deepEqual(snapshot(db).blocks, current.blocks); assert.equal(snapshot(db).revision, current.revision)
  assert.deepEqual(births(db, oldBirths.map(item => item.id)), oldBirths); assert.deepEqual(allTables(db).document_block_routes, routes)
}))

test('undo keeps its live move token when current canonical growth makes the original deep reference position illegal', () => withHostDatabase(db => {
  const setup = command(db, { dirty: working => { parentChain(working, 6, ' move:inverse deep:') }, target: { parentBlockId: ' move:inverse deep:5', depth: 6 } })
  insertAck(applySyncedHostCommand(db, setup))
  const input = moveRequest(db, { selectedRootIds: [setup.action.instanceId] }), ack = moved(applySyncedHostCommand(db, input))
  const root = syncedCanonicalEdits(snapshot(db).blocks)[0]
  groupEdit(db, [{ ...root, type: 'toggle' }, { ...freshBlock(' move:new canonical depth1 '), depth: 1, parentBlockId: root.id }])
  const current = snapshot(db), history = getSyncedHostHistory(db, { documentId: a })
  reject(db, () => restoreSyncedHostOperation(db, restoreInput(db, ack, 'undo')), 'invalid')
  assert.deepEqual(getSyncedHostHistory(db, { documentId: a }), history); assert.deepEqual(snapshot(db), current)
}))

test('old move tokens cannot bypass a later real tail or a missing executed prefix mapping', () => {
  for (const missing of [false, true]) withHostDatabase(db => {
    const prefix = edit(db, [a], 'prefix before move'), input = moveRequest(db), ack = moved(applySyncedHostCommand(db, input))
    if (missing) {
      assert.equal(db.prepare('DELETE FROM synced_host_history_documents WHERE document_id=? AND history_id=? AND position=1').run(a, prefix.ack.historyToken).changes, 1)
      const before = allTables(db), changes = totalChanges(db)
      assert.throws(() => restoreSyncedHostOperation(db, restoreInput(db, ack, 'undo')), /历史|位置|连续|映射|chain|history/i)
      assert.deepEqual(allTables(db), before); assert.equal(totalChanges(db), changes)
    } else { edit(db, [a], 'later actual tail'); reject(db, () => restoreSyncedHostOperation(db, restoreInput(db, ack, 'undo')), 'conflict') }
  })
})

test('caller transactions disabled foreign keys and late inverse receipt failure preserve the original move authority and all state', () => withHostDatabase(db => {
  const input = moveRequest(db), before = allTables(db)
  db.transaction(() => { assert.throws(() => applySyncedHostCommand(db, input), /外层|事务|transaction/i) })(); assert.deepEqual(allTables(db), before)
  db.pragma('foreign_keys=OFF'); assert.throws(() => applySyncedHostCommand(db, input), /外键|foreign/i)
  assert.deepEqual(allTables(db), before); db.pragma('foreign_keys=ON')
  const ack = moved(applySyncedHostCommand(db, input)), inverse = restoreInput(db, ack, 'undo')
  db.exec("CREATE TRIGGER fail_move_inverse_receipt BEFORE INSERT ON synced_operations BEGIN SELECT RAISE(ABORT,'injected move inverse receipt'); END")
  const after = allTables(db); assert.throws(() => restoreSyncedHostOperation(db, inverse), /injected move inverse receipt/); assert.deepEqual(allTables(db), after)
  db.exec('DROP TRIGGER fail_move_inverse_receipt'); moved(restoreSyncedHostOperation(db, inverse)); expectWorking(db, input)
}))

test('duplicate ordinary headings cannot change their stable slug bindings through a same-host reorder', () => withHostDatabase(db => {
  seed(db, [{ id: ' move:heading first ', type: 'heading-1', content: 'Same' }, { id: ' move:heading second ', type: 'heading-1', content: 'Same' }])
  const input = moveRequest(db, { selectedRootIds: [' move:heading second '], target: { beforeBlockId: ' move:heading first ' } })
  reject(db, () => applySyncedHostCommand(db, input), 'unsupported', 'heading-rewrite')
}))

test('unique ordinary headings and exact typed code math lookalikes can move without inventing Markdown definition bindings', () => withHostDatabase(db => {
  seed(db, [{ id: ' move:heading unique ', type: 'heading-2', content: 'Unique heading' },
    { id: ' move:code literal ', type: 'code', content: '[r]: Literal.md\n[^n]: literal' },
    { id: ' move:math literal ', type: 'math', content: '[r]: literal' }])
  const input = moveRequest(db, { selectedRootIds: [' move:heading unique ', ' move:code literal ', ' move:math literal '] }), ack = moved(applySyncedHostCommand(db, input))
  assert.deepEqual(ids(db).slice(0, 3), [' move:heading unique ', ' move:code literal ', ' move:math literal '])
  roundtrip(db, input, ack)
}))

test('moving an equally addressed duplicate reference definition ahead of the first definition is still a semantic binding change', () => {
  for (const destination of ['Target.md', 'Different.md']) withHostDatabase(db => {
    seed(db, [{ id: ' move:reference use ', content: '[shown][r]' }, { id: ' move:reference first ', content: '[r]: Target.md "title"' },
      { id: ' move:reference inactive ', content: '[r]: ' + destination + ' "title"' }])
    const input = moveRequest(db, { selectedRootIds: [' move:reference inactive '], target: { beforeBlockId: ' move:reference first ' } })
    reject(db, () => applySyncedHostCommand(db, input), 'unsupported', 'semantic-binding')
  })
})

test('inactive reference definitions can move while the original effective physical definition and actual use remain unchanged', () => withHostDatabase(db => {
  seed(db, [{ id: ' move:reference first ', content: '[r]: Target.md "first"' }, { id: ' move:reference spacer ', content: 'Spacer' },
    { id: ' move:reference inactive ', content: '[r]: Ignored.md "inactive"' }, { id: ' move:reference use ', content: '[shown][r]' }])
  const before = parseMarkdownDocumentBlocks(logical(db, a).blocks).environment.references
  const input = moveRequest(db, { selectedRootIds: [' move:reference inactive '], target: { beforeBlockId: ' move:reference spacer ' } }), ack = moved(applySyncedHostCommand(db, input))
  assert.deepEqual(parseMarkdownDocumentBlocks(logical(db, a).blocks).environment.references, before)
  roundtrip(db, input, ack)
}))

test('named footnote duplicate last-definition identity cannot silently change even when both definition bodies match', () => {
  for (const body of ['Same body', 'Different body']) withHostDatabase(db => {
    seed(db, [{ id: ' move:note use ', content: 'Use[^n]' }, { id: ' move:note earlier ', content: '[^n]: Same body' },
      { id: ' move:note effective ', content: '[^n]: ' + body }])
    const input = moveRequest(db, { selectedRootIds: [' move:note effective '], target: { beforeBlockId: ' move:note earlier ' } })
    reject(db, () => applySyncedHostCommand(db, input), 'unsupported', 'semantic-binding')
  })
})

test('a uniquely bound top-level named footnote definition moves as its original whole physical block through undo redo', () => withHostDatabase(db => {
  seed(db, [{ id: ' move:unique note use ', content: 'Use[^only]' }, { id: ' move:unique note definition ', content: '[^only]: Original note **body**' },
    { id: ' move:unique note spacer ', content: 'Spacer' }])
  const input = moveRequest(db, { selectedRootIds: [' move:unique note definition '], target: { beforeBlockId: ' move:unique note use ' } })
  const ack = moved(applySyncedHostCommand(db, input))
  assert.deepEqual(ids(db).slice(2), [' move:unique note definition ', ' move:unique note use ', ' move:unique note spacer '])
  assert.equal(logical(db, a).blocks.find(block => block.id === ' move:unique note definition ')!.content, '[^only]: Original note **body**')
  roundtrip(db, input, ack)
}))

test('reordering only named footnote uses permits actual encounter-number changes with the same stable labels and definitions', () => withHostDatabase(db => {
  seed(db, [{ id: ' move:use one ', content: 'One[^first]' }, { id: ' move:use two ', content: 'Two[^second]' },
    { id: ' move:definition first ', content: '[^first]: First body' }, { id: ' move:definition second ', content: '[^second]: Second body' }])
  const before = noteIds(db), input = moveRequest(db, { selectedRootIds: [' move:use two '], target: { beforeBlockId: ' move:use one ' } })
  const ack = moved(applySyncedHostCommand(db, input)), after = noteIds(db)
  assert.deepEqual(before[' move:use one '].map(item => item.label), ['first']); assert.deepEqual(after[' move:use one '].map(item => item.label), ['first'])
  assert.deepEqual(before[' move:use two '].map(item => item.label), ['second']); assert.deepEqual(after[' move:use two '].map(item => item.label), ['second'])
  assert.notEqual(before[' move:use one '][0].id, after[' move:use one '][0].id, 'Actual parser numbering follows the new visible use order')
  roundtrip(db, input, ack)
}))

test('whole-W parse context rejects a move that activates a reference use through fence scope despite an unchanged first definition', () => withHostDatabase(db => {
  seed(db, [{ id: ' move:fence open ', content: '```md' }, { id: ' move:fenced use ', content: '[shown][r]' },
    { id: ' move:fence close ', content: '```' }, { id: ' move:outside definition ', content: '[r]: Target.md' }])
  const input = moveRequest(db, { selectedRootIds: [' move:fenced use '], target: { beforeBlockId: ' move:outside definition ' } })
  reject(db, () => applySyncedHostCommand(db, input), 'unsupported', 'semantic-binding')
}))
