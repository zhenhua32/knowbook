import assert from 'node:assert/strict'
import test from 'node:test'
import type { SyncedHostWorkingBefore, SyncedStableBlockDraft } from '../src/shared/synced-blocks'
import { isSyncedUuid, serializeSyncedBlockPayload, SyncedValidationError } from '../src/shared/syncedBlockValidation'
import { applySyncedHostSourceChanges, copySyncedHostSourceRange, createSyncedHostSourceDraft, insertSyncedHostSourceReference,
  moveSyncedHostSourceRange, prepareSyncedHostSourceApply } from '../src/renderer/src/features/synced-blocks/hostSource'

const uuid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
const groupId = uuid(1)
const block = (id: string, content = 'Body', type = 'paragraph', depth = 0, parentBlockId: string | null = null): SyncedStableBlockDraft =>
  ({ id, type, content, checked: false, depth, parentBlockId })
const ref = (id: number, depth = 0, parentBlockId: string | null = null) =>
  block(uuid(id), serializeSyncedBlockPayload({ version: 1, groupId }), 'synced-block', depth, parentBlockId)
function opening(blocks = [ref(2), ref(3), { ...block(' 尾:__proto__ ', 'Tail'), tags: ['keep'], highlight: 'yellow' }]): SyncedHostWorkingBefore {
  return { documentId: ' 真实宿主 ', expectedPersistedUpdatedAt: '2026-10-16T00:00:00Z',
    workingBefore: { title: 'Unsaved title', summary: 'Unsaved summary', blocks } }
}
const fresh = (start = 100) => { let next = start; return () => uuid(next++) }
function draft(input = opening()) { return createSyncedHostSourceDraft(input, { sessionKey: 'source-session', freshKey: fresh() }) }

test('host Source captures complete unacknowledged W without changing its title, summary, IDs or caller objects', () => {
  const input = opening(), before = structuredClone(input), source = draft(input)
  assert.deepEqual(prepareSyncedHostSourceApply(source), { hostsWorkingBefore: [before],
    finalAfter: [{ documentId: before.documentId, ...before.workingBefore }], newRefSources: [] })
  assert.deepEqual(input, before)
  assert.equal(Object.isFrozen(input), false)
  assert.equal(Object.isFrozen(source), true)
  assert.equal(Object.isFrozen(source.opening.workingBefore.blocks), true)
  assert.equal(source.references.anchors.length, 2)
  assert.deepEqual(source.ordinary.anchors.map(anchor => anchor.block.id), [' 尾:__proto__ '], 'ordinary ownership excludes all reference IDs')
})

test('a real strict parse after a tail edit preserves mixed native/list ref roles and every untouched identity and annotation', () => {
  const input = opening([block('提示', 'Callout', 'callout'), block(' 布局 ', '', 'columns', 1, '提示'),
    { ...block('左列', '', 'column', 2, ' 布局 '), markdownFormat: { columnWeight: 6000 } },
    { ...block('列表', 'Parent', 'todo', 3, '左列'), checked: true, tags: ['task'] }, ref(2, 4, '列表'),
    { ...block('右列', '', 'column', 2, ' 布局 '), markdownFormat: { columnWeight: 4000 } }, block('右文', 'Right', 'paragraph', 3, '右列'),
    ref(3), { ...block(' 尾:__proto__ ', 'Tail'), tags: ['keep'], highlight: 'yellow' }])
  const before = structuredClone(input), initial = draft(input), at = initial.source.lastIndexOf('Tail') + 4
  const changed = applySyncedHostSourceChanges(initial, [{ from: at, to: at, insert: ' edited' }])
  const prepared = prepareSyncedHostSourceApply(changed)
  const expected = structuredClone(before.workingBefore.blocks)
  expected.at(-1)!.content = 'Tail edited'
  assert.deepEqual(prepared.finalAfter[0].blocks, expected)
  assert.deepEqual(prepared.hostsWorkingBefore, [before], 'Source Apply never saves/reloads an older P in place of W')
  assert.deepEqual(input, before)
})

test('explicit reordering of two equal fences changes instance order even when complete source bytes are unchanged', () => {
  const initial = draft(), [a, b] = initial.references.anchors
  const end = initial.source.indexOf('Tail')
  const moved = moveSyncedHostSourceRange(initial, { from: a.from, to: b.from, insertAt: end })
  assert.equal(moved.source, initial.source)
  assert.deepEqual(prepareSyncedHostSourceApply(moved).finalAfter[0].blocks.map(item => item.id), [b.instanceId, a.instanceId, ' 尾:__proto__ '])
  assert.deepEqual(prepareSyncedHostSourceApply(moved).newRefSources, [])
})

test('explicit ordinary moves carry complete opaque identities and annotations without recognizing equal text', () => {
  const a = { ...block(' 原:__proto__ ', 'One'), tags: ['first'], highlight: 'blue' }, b = block('constructor', 'Two'), c = block('tail', 'Tail')
  const initial = draft(opening([a, b, c]))
  const moved = moveSyncedHostSourceRange(initial, { from: 0, to: initial.source.indexOf('Two'), insertAt: initial.source.indexOf('Tail') })
  assert.equal(moved.source, 'Two\n\nOne\n\nTail')
  const proof = prepareSyncedHostSourceApply(moved, () => { throw new Error('A complete same-document move must not allocate identities') })
  assert.deepEqual(proof.finalAfter[0].blocks, [b, a, c])
  assert.deepEqual(proof.hostsWorkingBefore, [opening([a, b, c])])
  const duplicate = draft(opening([{ ...a, content: 'Same' }, { ...b, content: 'Same' }, c]))
  const swapped = moveSyncedHostSourceRange(duplicate, { from: 0, to: 6, insertAt: duplicate.source.indexOf('Tail') })
  assert.equal(swapped.source, duplicate.source)
  assert.deepEqual(prepareSyncedHostSourceApply(swapped).finalAfter[0].blocks.map(item => item.id), [b.id, a.id, c.id])
  assert.equal(prepareSyncedHostSourceApply(swapped).finalAfter[0].blocks[1].highlight, 'blue')
})

test('one mixed ordinary and reference move retains both identities while Apply keeps the complete pre-action W', () => {
  const a = { ...block('ordinary', 'One'), tags: ['ordinary'], highlight: 'orange' }, reference = { ...ref(2), tags: ['reference'], highlight: 'green' }
  const b = block('other', 'Two'), second = ref(3), tail = block('tail', 'Tail'), input = opening([a, reference, b, second, tail])
  const initial = draft(input), before = structuredClone(input)
  const moved = moveSyncedHostSourceRange(initial, { from: 0, to: initial.source.indexOf('Two'), insertAt: initial.source.indexOf('Tail') })
  const prepared = prepareSyncedHostSourceApply(moved, () => { throw new Error('Neither complete ordinary nor reference move allocates IDs') })
  assert.deepEqual(prepared.finalAfter[0].blocks, [b, second, a, reference, tail])
  assert.deepEqual(prepared.hostsWorkingBefore, [before])
  assert.deepEqual(prepared.newRefSources, [])
  assert.deepEqual(input, before)
  assert.deepEqual(prepareSyncedHostSourceApply(initial).finalAfter[0].blocks, before.workingBefore.blocks)
})

test('empty move anchors use half-open selection boundaries and an occupied empty target cannot steal the moved identity', () => {
  const a = block('first', 'One'), empty = { ...block('empty', ''), tags: ['empty'] }, b = block('second', 'Two'), tail = block('tail', 'Tail')
  const initial = draft(opening([a, empty, b, tail])), emptyAt = initial.ordinary.anchors.find(anchor => anchor.block.id === empty.id)!.from
  const withEmpty = moveSyncedHostSourceRange(initial, { from: 0, to: initial.source.indexOf('Two'), insertAt: initial.source.indexOf('Tail') })
  assert.deepEqual(prepareSyncedHostSourceApply(withEmpty).finalAfter[0].blocks, [b, a, empty, tail])
  const beforeEmpty = moveSyncedHostSourceRange(initial, { from: 0, to: emptyAt, insertAt: initial.source.indexOf('Tail') })
  assert.deepEqual(prepareSyncedHostSourceApply(beforeEmpty).finalAfter[0].blocks, [empty, b, a, tail], 'the empty anchor at selection.to stays outside')
  const intoEmpty = moveSyncedHostSourceRange(initial, { from: initial.source.indexOf('Tail'), to: initial.source.length, insertAt: emptyAt })
  assert.deepEqual(prepareSyncedHostSourceApply(intoEmpty).finalAfter[0].blocks, [a, tail, b], 'complete moved content owns its occupied empty target')
  assert.deepEqual(prepareSyncedHostSourceApply(initial).finalAfter[0].blocks, [a, empty, b, tail])
  const another = block('another-empty', ''), third = block('third-empty', ''), blanks = draft(opening([empty, another, third, tail]))
  const reordered = moveSyncedHostSourceRange(blanks, { from: 0, to: 2, insertAt: 4 })
  assert.equal(reordered.source, blanks.source)
  assert.deepEqual(prepareSyncedHostSourceApply(reordered).finalAfter[0].blocks, [another, empty, third, tail],
    'moving blank separators preserves a separate empty destination and carries only the selected empty ID')
})

test('partial ordinary moves retain normal text-edit identity semantics without pretending the selected text is a whole block', () => {
  const a = { ...block('first', 'Alpha Beta'), tags: ['first'] }, b = block('second', 'Two'), tail = { ...block('tail', 'Tail'), highlight: 'yellow' }
  const initial = draft(opening([a, b, tail]))
  const moved = moveSyncedHostSourceRange(initial, { from: 0, to: 6, insertAt: initial.source.indexOf('Tail') })
  assert.equal(moved.source, 'Beta\n\nTwo\n\nAlpha Tail')
  assert.deepEqual(prepareSyncedHostSourceApply(moved).finalAfter[0].blocks, [{ ...a, content: 'Beta' }, b, { ...tail, content: 'Alpha Tail' }])
})

test('ordinary copies receive fresh identities at normal boundaries and cannot inherit an empty target identity or annotation', () => {
  const source = { ...block(' source ', 'One'), tags: ['source'], highlight: 'blue' }, tail = block('constructor', 'Tail')
  const empty = { ...block(' old-empty ', ''), tags: ['target-secret'], highlight: 'red' }, newId = uuid(500)
  for (const hasEmpty of [false, true]) {
    const input = opening(hasEmpty ? [source, empty, tail] : [source, tail]), initial = draft(input), before = structuredClone(input)
    const insertAt = hasEmpty ? initial.ordinary.anchors.find(anchor => anchor.block.id === empty.id)!.from : initial.source.indexOf('Tail')
    const copied = copySyncedHostSourceRange(initial, { from: 0, to: 5, insertAt })
    const prepared = prepareSyncedHostSourceApply(copied, () => newId), result = prepared.finalAfter[0].blocks
    assert.deepEqual(result, [source, { ...block(newId, 'One') }, tail])
    assert.notEqual(result[1].id, source.id); assert.notEqual(result[1].id, empty.id)
    assert.equal(result[1].tags, undefined); assert.equal(result[1].highlight, undefined)
    assert.deepEqual(prepared.hostsWorkingBefore, [before]); assert.deepEqual(prepared.newRefSources, [])
    assert.deepEqual(prepareSyncedHostSourceApply(initial).finalAfter[0].blocks, before.workingBefore.blocks)
    assert.deepEqual(input, before)
  }
})

test('explicit copy creates fresh reference provenance while same-text public replacement destroys the old reference identity', () => {
  const initial = draft(), [a, b] = initial.references.anchors
  const copied = copySyncedHostSourceRange(initial, { from: a.from, to: b.from, insertAt: initial.source.indexOf('Tail') }, fresh(200))
  const copiedProof = prepareSyncedHostSourceApply(copied)
  assert.deepEqual(copiedProof.newRefSources, [{ kind: 'working', instanceId: uuid(200), sourceDocumentId: initial.opening.documentId, sourceInstanceId: a.instanceId }])
  assert.deepEqual(copiedProof.finalAfter[0].blocks.filter(item => item.type === 'synced-block').map(item => item.id), [a.instanceId, b.instanceId, uuid(200)])
  const replaced = applySyncedHostSourceChanges(initial, [{ from: a.from, to: a.to, insert: initial.source.slice(a.from, a.to) }])
  assert.equal(replaced.source, initial.source)
  const final = prepareSyncedHostSourceApply(replaced, fresh(300))
  assert.deepEqual(final.finalAfter[0].blocks.filter(item => item.type === 'synced-block').map(item => item.id), [b.instanceId])
  assert.equal(final.finalAfter[0].blocks[0].type, 'code')
  assert.notEqual(final.finalAfter[0].blocks[0].id, a.instanceId)
  assert.ok(isSyncedUuid(final.finalAfter[0].blocks[0].id))
  assert.deepEqual(final.newRefSources, [])
})

test('only explicit internal candidate insertion emits provenance; an externally pasted equal fence remains ordinary code', () => {
  const initial = draft(opening([block('tail', 'Tail')])), identity = { workspaceScope: uuid(20), groupId, creationId: uuid(21) }
  const inserted = insertSyncedHostSourceReference(initial, { at: initial.source.length, identity }, fresh(400))
  const prepared = prepareSyncedHostSourceApply(inserted)
  assert.deepEqual(prepared.newRefSources, [{ kind: 'internal', instanceId: uuid(400), identity }])
  assert.equal(prepared.finalAfter[0].blocks.at(-1)!.id, uuid(400))
  const external = applySyncedHostSourceChanges(initial, [{ from: initial.source.length, to: initial.source.length,
    insert: inserted.source.slice(initial.source.length) }])
  const ordinary = prepareSyncedHostSourceApply(external, fresh(500))
  assert.equal(ordinary.finalAfter[0].blocks.at(-1)!.type, 'code')
  assert.deepEqual(ordinary.newRefSources, [])
})

test('reference outdent rebuilds its real parent and never restores the old W parent by identity', () => {
  const initial = draft(opening([block('parent', 'Parent', 'todo'), ref(2, 1, 'parent'), block('tail', 'Tail')]))
  const anchor = initial.references.anchors[0], changes: Array<{ from: number; to: number; insert: string }> = []
  const firstLine = initial.source.lastIndexOf('\n', anchor.from - 1) + 1
  changes.push({ from: firstLine, to: anchor.from, insert: '' })
  let at = initial.source.indexOf('\n', anchor.from) + 1
  while (at > 0 && at < anchor.to) {
    const indent = /^[ \t]*/.exec(initial.source.slice(at))![0].length
    if (indent) changes.push({ from: at, to: at + indent, insert: '' })
    const next = initial.source.indexOf('\n', at)
    if (next < 0) break
    at = next + 1
  }
  const outdented = applySyncedHostSourceChanges(initial, changes)
  const result = prepareSyncedHostSourceApply(outdented).finalAfter[0].blocks
  assert.equal(result.find(item => item.id === uuid(2))!.depth, 0)
  assert.equal(result.find(item => item.id === uuid(2))!.parentBlockId, null)
  assert.equal(initial.opening.workingBefore.blocks[1].parentBlockId, 'parent')
})

test('damaged payload is rejected before mutation and hidden syntax keeps its private buffer rather than silently detaching', () => {
  const initial = draft(), anchor = initial.references.anchors[0], at = initial.source.indexOf(groupId)
  assert.throws(() => applySyncedHostSourceChanges(initial, [{ from: at, to: at + groupId.length, insert: uuid(9) }]))
  assert.equal(initial.source.slice(anchor.from, anchor.to), anchor.original)
  const hidden = applySyncedHostSourceChanges(initial, [{ from: anchor.from, to: anchor.from, insert: '> ' }])
  assert.throws(() => prepareSyncedHostSourceApply(hidden), /unmatched/i)
  assert.ok(hidden.source.startsWith('> ```'))
  assert.equal(hidden.references.anchors.length, 2)
})

test('deleting every host reference prepares an empty host without deleting groups or inventing a canonical replacement', () => {
  const initial = draft(opening([ref(2)])), cleared = applySyncedHostSourceChanges(initial, [{ from: 0, to: initial.source.length, insert: '' }])
  const prepared = prepareSyncedHostSourceApply(cleared)
  assert.deepEqual(prepared.finalAfter[0].blocks, [])
  assert.deepEqual(prepared.newRefSources, [])
  assert.deepEqual(Object.keys(prepared).sort(), ['finalAfter', 'hostsWorkingBefore', 'newRefSources'])
})

test('fresh ordinary identities cannot collide with any opening reference, even after that reference is removed', () => {
  const initial = draft(), anchor = initial.references.anchors[0]
  const replaced = applySyncedHostSourceChanges(initial, [{ from: anchor.from, to: anchor.to, insert: 'New paragraph' }])
  assert.throws(() => prepareSyncedHostSourceApply(replaced, () => anchor.instanceId), SyncedValidationError)
  assert.equal(initial.references.anchors.length, 2)
})

test('copy and internal insertion reject every opening identity, including deleted references and live ordinary UUIDs', () => {
  const ordinaryId = uuid(40), initial = draft(opening([ref(2), ref(3), block(ordinaryId, 'Live')]))
  const removedAnchor = initial.references.anchors[0]
  const removed = applySyncedHostSourceChanges(initial, [{ from: removedAnchor.from, to: removedAnchor.to, insert: '' }])
  const before = structuredClone(removed), remaining = removed.references.anchors[0]
  const identity = { workspaceScope: uuid(20), groupId, creationId: uuid(21) }
  for (const collision of [removedAnchor.instanceId, ordinaryId]) {
    const ids = () => { let count = 0; return () => count++ === 0 ? collision : uuid(900 + count) }
    assert.throws(() => copySyncedHostSourceRange(removed, { from: remaining.from, to: remaining.to, insertAt: removed.source.length }, ids()),
      error => error instanceof SyncedValidationError && error.code === 'identity')
    assert.throws(() => insertSyncedHostSourceReference(removed, { at: removed.source.length, identity }, ids()),
      error => error instanceof SyncedValidationError && error.code === 'identity')
    assert.deepEqual(removed, before)
  }
  assert.equal(removed.references.anchors.length, 1)
  assert.equal(initial.references.anchors.length, 2)
})
