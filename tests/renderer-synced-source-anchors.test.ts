import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import type { SyncedReferenceIdentity } from '../src/shared/synced-blocks'
import { serializeSyncedBlockPayload, SYNCED_BLOCK_FENCE_INFO } from '../src/shared/syncedBlockValidation'
import {
  applySyncedSourceChanges, copySyncedSourceRange, createSyncedSourceSnapshot, insertSyncedSourceReference,
  moveSyncedSourceRange, SyncedSourceAnchorError,
  type SyncedSourceReferenceSeed, type SyncedSourceSnapshot, type SyncedSourceSnapshotInput
} from '../src/renderer/src/features/synced-blocks/sourceAnchors'
import type { MarkdownSourceChange } from '../src/renderer/src/utils/markdownSourceDraft'

const sessionKey = '源码会话🙂', sourceDocumentId = ' __proto__:原宿主 '
const fence = (groupId: string, eol = '\n') => '```' + SYNCED_BLOCK_FENCE_INFO + eol
  + serializeSyncedBlockPayload({ version: 1, groupId }) + eol + '```'
function input(options: { prefix?: string; eol?: string; sameGroup?: boolean } = {}): SyncedSourceSnapshotInput {
  const { prefix = '前文\n\n', eol = '\n', sameGroup = false } = options
  const groupA = randomUUID(), groupB = sameGroup ? groupA : randomUUID(), first = fence(groupA, eol), second = fence(groupB, eol)
  const separator = eol + eol, source = prefix + first + separator + second + separator
  const fromB = prefix.length + first.length + separator.length
  return { sessionKey, sourceDocumentId, source, anchors: [
    { key: '引用甲', instanceId: randomUUID(), groupId: groupA, from: prefix.length, to: prefix.length + first.length, newRefSource: null },
    { key: '引用乙', instanceId: randomUUID(), groupId: groupB, from: fromB, to: fromB + second.length, newRefSource: null }
  ] }
}
function state(options: Parameters<typeof input>[0] = {}) { return createSyncedSourceSnapshot(input(options)) }
function checkRanges(value: SyncedSourceSnapshot) {
  for (const anchor of value.anchors) {
    assert.equal(anchor.original, value.source.slice(anchor.from, anchor.to))
    assert.equal(anchor.sessionKey, value.sessionKey)
    for (const range of anchor.immutableRanges) assert.ok(range.from >= anchor.from && range.to <= anchor.to && range.from < range.to)
  }
}
function ids(...values: string[]) {
  let index = 0
  return () => {
    assert.ok(index < values.length, 'The operation must allocate only the specified identities')
    return values[index++]
  }
}

test('initial strict fence proof creates a deeply immutable owned snapshot without freezing its input', () => {
  const original = input({ sameGroup: true }), saved = structuredClone(original), result = createSyncedSourceSnapshot(original)
  assert.deepEqual(original, saved)
  assert.equal(Object.isFrozen(original), false)
  assert.equal(Object.isFrozen(original.anchors), false)
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.anchors))
  assert.equal(result.sourceDocumentId, sourceDocumentId)
  assert.equal(result.anchors[0].groupId, result.anchors[1].groupId)
  assert.notEqual(result.anchors[0].instanceId, result.anchors[1].instanceId)
  for (const anchor of result.anchors) {
    assert.ok(Object.isFrozen(anchor) && Object.isFrozen(anchor.immutableRanges))
    assert.ok(anchor.immutableRanges.every(Object.isFrozen))
  }
  checkRanges(result)
})

test('initial expectations reject wrong token ranges, damaged payloads and unclosed fences', () => {
  const original = input(), first = original.anchors[0]
  assert.throws(() => createSyncedSourceSnapshot({ ...original, anchors: [{ ...first, from: first.from + 1 }, original.anchors[1]] }))
  assert.throws(() => createSyncedSourceSnapshot({ ...original, anchors: [{ ...first, groupId: randomUUID() }, original.anchors[1]] }))
  for (const body of ['{"version":2,"groupId":"' + first.groupId + '"}',
    '{"version":1,"groupId":"' + first.groupId + '","groupId":"' + first.groupId + '"}',
    '{"version":1,"groupId":null}', '{"version":1,"groupId":"' + first.groupId + '","extra":true}']) {
    const source = '```' + SYNCED_BLOCK_FENCE_INFO + '\n' + body + '\n```'
    assert.throws(() => createSyncedSourceSnapshot({ sessionKey, sourceDocumentId, source,
      anchors: [{ ...first, from: 0, to: source.length }] }))
  }
  const source = fence(first.groupId).slice(0, -3)
  assert.throws(() => createSyncedSourceSnapshot({ sessionKey, sourceDocumentId, source,
    anchors: [{ ...first, from: 0, to: source.length }] }))
})

test('seed identity, dense arrays, ordered non-overlapping spans and closed fields are required', () => {
  const original = input(), a = original.anchors[0], b = original.anchors[1]
  const cases: unknown[] = [
    { ...original, sourceDocumentId: ' ' }, { ...original, sessionKey: '' },
    { ...original, anchors: [{ ...a, instanceId: 'old-instance' }, b] },
    { ...original, anchors: [a, { ...b, instanceId: a.instanceId }] },
    { ...original, anchors: [a, { ...b, key: a.key }] },
    { ...original, anchors: [b, a] }, { ...original, anchors: [a, { ...b, from: a.to - 1 }] },
    { ...original, anchors: [{ ...a, from: -1 }, b] }, { ...original, anchors: [{ ...a, to: Infinity }, b] },
    { ...original, anchors: [{ ...a, from: 0.5 }, b] },
    { ...original, anchors: [{ ...a, original: original.source.slice(a.from, a.to) }, b] },
    { ...original, anchors: [{ ...a, immutableRanges: [] }, b] }
  ]
  const sparse = new Array<SyncedSourceReferenceSeed>(2); sparse[1] = b
  cases.push({ ...original, anchors: sparse })
  for (const malformed of cases) assert.throws(() => createSyncedSourceSnapshot(malformed as SyncedSourceSnapshotInput), SyncedSourceAnchorError)
  assert.equal(original.anchors[0], a)
})

test('ordinary disjoint original-coordinate edits preserve raw BOM, emoji and CRLF offsets', () => {
  const before = state({ prefix: '\uFEFF🙂\r\n\r\n', eol: '\r\n', sameGroup: true })
  assert.equal(before.anchors[0].from, 7)
  const after = applySyncedSourceChanges(before, [
    { from: before.source.length, to: before.source.length, insert: '末尾🙂' },
    { from: 1, to: 3, insert: '汉字🙂' }
  ])
  assert.equal(after.source, before.source.slice(0, 1) + '汉字🙂' + before.source.slice(3) + '末尾🙂')
  assert.equal(after.anchors[0].from, before.anchors[0].from + 2)
  assert.equal(after.anchors[1].from, before.anchors[1].from + 2)
  assert.deepEqual(after.anchors.map(anchor => anchor.instanceId), before.anchors.map(anchor => anchor.instanceId))
  assert.ok(after.source.includes('\r\n'))
  checkRanges(after)
})

test('leading horizontal whitespace gaps support indent, dedent and zero-width indent insertion', () => {
  const before = state({ prefix: '', eol: '\r\n' }), anchor = before.anchors[0]
  const payload = before.source.indexOf('\r\n', anchor.from) + 2, close = before.source.indexOf('\r\n', payload) + 2
  const after = applySyncedSourceChanges(before, [{ from: close, to: close, insert: '\t' }, { from: payload, to: payload, insert: '  ' }])
  assert.equal(after.anchors[0].instanceId, anchor.instanceId)
  assert.equal(after.anchors[0].to, anchor.to + 3)
  assert.equal(after.anchors[1].from, before.anchors[1].from + 3)
  assert.equal(after.source.slice(payload, payload + 2), '  ')
  assert.ok(!after.anchors[0].immutableRanges.some(range => range.from <= payload && range.to > payload))
  const restored = applySyncedSourceChanges(after, [{ from: payload, to: payload + 2, insert: '' }, { from: close + 2, to: close + 3, insert: '' }])
  assert.equal(restored.source, before.source)
  assert.deepEqual(restored.anchors, before.anchors)
  checkRanges(after)
})

test('structural indent of all fence lines retains core offsets and passes the same strict parser again', () => {
  const before = state({ prefix: '' }), anchor = before.anchors[0]
  const payload = before.source.indexOf('\n', anchor.from) + 1, closing = before.source.indexOf('\n', payload) + 1
  const indented = applySyncedSourceChanges(before, [anchor.from, payload, closing].map(from => ({ from, to: from, insert: '  ' })))
  assert.equal(indented.anchors[0].from, anchor.from + 2)
  assert.equal(indented.anchors[0].to, anchor.to + 6)
  const reopened = createSyncedSourceSnapshot({ sessionKey, sourceDocumentId, source: indented.source,
    anchors: indented.anchors.map(({ key, instanceId, groupId, from, to, newRefSource }) => ({ key, instanceId, groupId, from, to, newRefSource })) })
  assert.deepEqual(reopened, indented)
  const restored = applySyncedSourceChanges(indented, [
    { from: anchor.from, to: anchor.from + 2, insert: '' },
    { from: payload + 2, to: payload + 4, insert: '' },
    { from: closing + 4, to: closing + 6, insert: '' }
  ])
  assert.deepEqual(restored, before)
})

test('partial marker, payload or newline edits and non-horizontal gap insertions are rejected atomically', () => {
  const before = state(), anchor = before.anchors[0], saved = structuredClone(before)
  const payload = before.source.indexOf('\n', anchor.from) + 1, closing = before.source.indexOf('\n', payload)
  const changes = [
    { from: anchor.from + 1, to: anchor.from + 2, insert: '~' },
    { from: payload + 3, to: payload + 4, insert: 'X' },
    { from: payload - 1, to: payload, insert: '' },
    { from: closing, to: closing + 1, insert: '\r\n' },
    { from: payload, to: payload, insert: '\n' }, { from: payload, to: payload, insert: 'x' },
    { from: anchor.from - 1, to: anchor.from + 1, insert: '' }
  ]
  for (const change of changes) {
    assert.throws(() => applySyncedSourceChanges(before, [change]), (error: unknown) => error instanceof SyncedSourceAnchorError && error.code === 'protected')
    assert.deepEqual(before, saved)
  }
})

test('ordinary surrounding syntax may be incomplete without reparsing or losing reference identities', () => {
  const before = state(), prefix = '```ordinary-unclosed\n'
  const after = applySyncedSourceChanges(before, [{ from: 0, to: 0, insert: prefix }])
  assert.equal(after.source, prefix + before.source)
  assert.deepEqual(after.anchors.map(anchor => anchor.instanceId), before.anchors.map(anchor => anchor.instanceId))
  assert.equal(after.anchors[0].from, before.anchors[0].from + prefix.length)
  checkRanges(after)
})

test('complete deletion removes precisely covered anchors and supports deleting all source', () => {
  const before = state(), a = before.anchors[0]
  const after = applySyncedSourceChanges(before, [{ from: a.from, to: a.to, insert: '' }])
  assert.deepEqual(after.anchors.map(anchor => anchor.instanceId), [before.anchors[1].instanceId])
  const empty = applySyncedSourceChanges(before, [{ from: 0, to: before.source.length, insert: '' }])
  assert.equal(empty.source, '')
  assert.deepEqual(empty.anchors, [])
  assert.equal(before.anchors.length, 2)
  checkRanges(after)
})

test('public same-text replacements and cut-then-external-paste cannot reclaim anchor identity', () => {
  const before = state(), a = before.anchors[0]
  const replaced = applySyncedSourceChanges(before, [{ from: a.from, to: a.to, insert: a.original }])
  assert.equal(replaced.source, before.source)
  assert.deepEqual(replaced.anchors.map(anchor => anchor.instanceId), [before.anchors[1].instanceId])
  const cut = applySyncedSourceChanges(before, [{ from: a.from, to: a.to, insert: '' }])
  const pasted = applySyncedSourceChanges(cut, [{ from: a.from, to: a.from, insert: a.original }])
  assert.equal(pasted.source, before.source)
  assert.deepEqual(pasted.anchors, replaced.anchors)
  const publicOnly = createSyncedSourceSnapshot({ sessionKey, sourceDocumentId, source: a.original, anchors: [] })
  assert.deepEqual(publicOnly.anchors, [])
})

test('explicit move carries original same-group identities in either direction and supports a boundary no-op', () => {
  const before = state({ prefix: '', sameGroup: true }), a = before.anchors[0], b = before.anchors[1]
  const moved = moveSyncedSourceRange(before, { from: a.from, to: b.from, insertAt: before.source.length })
  assert.deepEqual(moved.anchors.map(anchor => anchor.instanceId), [b.instanceId, a.instanceId])
  assert.deepEqual(moved.anchors.map(anchor => anchor.key), [b.key, a.key])
  assert.ok(moved.anchors.every(anchor => anchor.newRefSource === null))
  const restored = moveSyncedSourceRange(moved, { from: moved.anchors[1].from, to: moved.source.length, insertAt: 0 })
  assert.deepEqual(restored, before)
  assert.equal(moveSyncedSourceRange(before, { from: a.from, to: b.from, insertAt: a.from }), before)
  checkRanges(moved)
})

test('explicit copies allocate fresh instance/key and flatten copy-of-copy working provenance', () => {
  const before = state({ prefix: '', sameGroup: true }), a = before.anchors[0]
  const instanceId = randomUUID(), key = randomUUID()
  const copied = copySyncedSourceRange(before, { from: a.from, to: before.anchors[1].from, insertAt: before.source.length }, ids(instanceId, key))
  const copy = copied.anchors[2]
  assert.equal(copy.instanceId, instanceId); assert.equal(copy.key, key)
  assert.equal(copy.groupId, a.groupId); assert.equal(copy.original, a.original)
  assert.deepEqual(copy.newRefSource, { kind: 'working', instanceId, sourceDocumentId, sourceInstanceId: a.instanceId })
  const nextId = randomUUID(), nextKey = randomUUID()
  const again = copySyncedSourceRange(copied, { from: copy.from, to: copied.source.length, insertAt: copied.source.length }, ids(nextId, nextKey))
  assert.deepEqual(again.anchors[3].newRefSource, { kind: 'working', instanceId: nextId, sourceDocumentId, sourceInstanceId: a.instanceId })
  assert.equal(new Set(again.anchors.map(anchor => anchor.instanceId)).size, 4)
  checkRanges(again)
})

test('a copied range containing two same-group references maps each occurrence once with independent fresh identities', () => {
  const before = state({ sameGroup: true }), instanceA = randomUUID(), instanceB = randomUUID()
  const copied = copySyncedSourceRange(before, { from: before.anchors[0].from, to: before.source.length, insertAt: 0 },
    ids(instanceA, randomUUID(), instanceB, randomUUID()))
  assert.deepEqual(copied.anchors.map(anchor => anchor.instanceId), [instanceA, instanceB, ...before.anchors.map(anchor => anchor.instanceId)])
  assert.deepEqual(copied.anchors.slice(0, 2).map(anchor => anchor.newRefSource), before.anchors.map((anchor, index) => ({
    kind: 'working', instanceId: index === 0 ? instanceA : instanceB, sourceDocumentId, sourceInstanceId: anchor.instanceId
  })))
  assert.ok(copied.anchors.every(anchor => anchor.groupId === before.anchors[0].groupId))
  assert.equal(new Set(copied.anchors.map(anchor => anchor.key)).size, 4)
  checkRanges(copied)
})

test('internal insertion builds canonical source with a candidate provenance and copies retain that identity', () => {
  const before = createSyncedSourceSnapshot({ sessionKey, sourceDocumentId, source: '前后', anchors: [] })
  const identity: SyncedReferenceIdentity = { workspaceScope: randomUUID(), groupId: randomUUID(), creationId: randomUUID() }
  const originalIdentity = structuredClone(identity), instanceId = randomUUID(), key = randomUUID()
  const inserted = insertSyncedSourceReference(before, { at: 1, identity }, ids(instanceId, key))
  assert.equal(inserted.source, '前\n\n' + fence(identity.groupId) + '\n\n后')
  assert.deepEqual(inserted.anchors[0].newRefSource, { kind: 'internal', instanceId, identity })
  assert.ok(Object.isFrozen(inserted.anchors[0].newRefSource))
  assert.deepEqual(identity, originalIdentity)
  assert.equal(Object.isFrozen(identity), false)
  const newId = randomUUID(), newKey = randomUUID(), anchor = inserted.anchors[0]
  const copied = copySyncedSourceRange(inserted, { from: anchor.from, to: anchor.to, insertAt: inserted.source.length }, ids(newId, newKey))
  assert.deepEqual(copied.anchors[1].newRefSource, { kind: 'internal', instanceId: newId, identity })
  checkRanges(copied)
})

test('range operations refuse partial references, overlapping destinations and reused/faulty fresh IDs', () => {
  const before = state(), a = before.anchors[0], saved = structuredClone(before)
  for (const run of [moveSyncedSourceRange, copySyncedSourceRange]) {
    for (const operation of [{ from: a.from + 1, to: a.to, insertAt: before.source.length },
      { from: a.from, to: a.to, insertAt: a.from + 1 },
      { from: 0, to: a.from, insertAt: a.from + 2 },
      { from: 0, to: 0, insertAt: 0 }, { from: 0, to: before.source.length + 1, insertAt: 0 }]) {
      assert.throws(() => run(before, operation), SyncedSourceAnchorError)
    }
  }
  const operation = { from: a.from, to: a.to, insertAt: before.source.length }
  assert.throws(() => copySyncedSourceRange(before, operation, ids(a.instanceId)), SyncedSourceAnchorError)
  assert.throws(() => copySyncedSourceRange(before, operation, ids(randomUUID(), a.key)), SyncedSourceAnchorError)
  assert.throws(() => copySyncedSourceRange(before, operation, () => 'not-a-uuid'), SyncedSourceAnchorError)
  assert.deepEqual(before, saved)
})

test('invalid changes cannot change caller source, anchor arrays or a Source Undo/Redo snapshot', () => {
  const before = state(), after = applySyncedSourceChanges(before, [{ from: 0, to: 0, insert: '普通编辑' }])
  const history = { entries: [before, after], index: 0 }, saved = structuredClone(history)
  const sparse = new Array<MarkdownSourceChange>(2); sparse[1] = { from: 0, to: 0, insert: '' }
  const invalid: unknown[] = [
    [{ from: -1, to: 0, insert: '' }], [{ from: NaN, to: 0, insert: '' }], [{ from: 0, to: Infinity, insert: '' }],
    [{ from: 0.5, to: 1, insert: '' }], [{ from: 0, to: 0, insert: 3 }],
    [{ from: 0, to: 3, insert: 'a' }, { from: 2, to: 4, insert: 'b' }],
    [{ from: 0, to: 0, insert: 'a' }, { from: 0, to: 0, insert: 'b' }],
    [{ from: 0, to: 0, insert: '', claimed: true }], sparse
  ]
  for (const changes of invalid) {
    assert.throws(() => applySyncedSourceChanges(history.entries[history.index], changes as MarkdownSourceChange[]), SyncedSourceAnchorError)
    assert.deepEqual(history, saved)
    assert.equal(history.entries[0], before); assert.equal(history.entries[1], after)
  }
  assert.equal(applySyncedSourceChanges(before, []), before)
  checkRanges(history.entries[1])
})

test('supplied snapshots cannot weaken derived protection or mix source sessions/provenance', () => {
  const before = state(), anchor = before.anchors[0]
  const sparse = new Array<{ from: number; to: number }>(anchor.immutableRanges.length)
  for (const bad of [{ ...anchor, immutableRanges: [] }, { ...anchor, immutableRanges: sparse },
    { ...anchor, sessionKey: '另一会话' }, { ...anchor, original: 'another' },
    { ...anchor, newRefSource: { kind: 'internal', instanceId: anchor.instanceId,
      identity: { workspaceScope: randomUUID(), groupId: randomUUID(), creationId: randomUUID() } } },
    { ...anchor, newRefSource: { kind: 'working', instanceId: randomUUID(), sourceDocumentId, sourceInstanceId: anchor.instanceId } }]) {
    assert.throws(() => applySyncedSourceChanges({ ...before, anchors: [bad, before.anchors[1]] } as SyncedSourceSnapshot, []), SyncedSourceAnchorError)
  }
})
