import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SyncedCanonicalEdit, SyncedCanonicalWire, SyncedGroupSnapshot, SyncedGroupWire, SyncedInstancePosition } from '../src/shared/synced-blocks'
import {
  parseSyncedBlockPayload, parseSyncedGroupWire, serializeSyncedBlockPayload, syncedCanonicalEdits,
  SyncedValidationError, validateSyncedBindings, validateSyncedCanonicalEdit,
  validateSyncedCanonicalProjection, validateSyncedCanonicalWire, validateSyncedGroupSnapshot, validateSyncedHostForest
} from '../src/shared/syncedBlockValidation'

const groupId = '00000000-0000-4000-8000-000000000001'
const instanceId = '00000000-0000-4000-8000-000000000002'
const createdAt = '2026-10-01T08:00:00+08:00'
function block(id = '旧块', type = 'paragraph', depth = 0, parentBlockId: string | null = null,
  content = '正文'): SyncedCanonicalEdit { return { id, type, depth, parentBlockId, content, checked: false } }
function wire(blocks: SyncedCanonicalWire[] = [{ ...block(), createdAt }]): SyncedGroupWire {
  return { kind: 'synced-group', id: groupId, creationId: instanceId, createdAt,
    origin: { version: 1, documentId: '原始文档', pathAtCreation: '知识/原始文档', firstInstanceId: instanceId }, bindings: [], blocks }
}
function instance(depth: number): SyncedInstancePosition {
  return { instanceId, hostDocumentId: '真实宿主', bindingVersion: groupId, depth, parentBlockId: depth ? '容器' : null, parentType: depth ? 'callout' : null }
}

test('canonical children preserve opaque historical identities and creation timestamp bytes', () => {
  for (const id of ['__proto__', 'constructor', 'prototype', ' 中文:块 ', '长'.repeat(200)]) {
    const input = [{ ...block(id), createdAt }]
    assert.deepEqual(validateSyncedCanonicalWire(input), input)
    assert.deepEqual(syncedCanonicalEdits(input), [block(id)])
  }
  assert.throws(() => validateSyncedCanonicalEdit([block(' ')]), SyncedValidationError)
  assert.throws(() => validateSyncedCanonicalEdit([block('重复'), block('重复')]), SyncedValidationError)
})

test('opaque child and column identities remain valid in a complete mixed columns forest', () => {
  const input = [block(' 布局 ', 'columns', 0, null, ''),
    { ...block(' 第一列 ', 'column', 1, ' 布局 ', ''), markdownFormat: { columnWeight: 6000 } },
    block('__proto__', 'callout', 2, ' 第一列 ', '提示'), block('constructor', 'paragraph', 3, '__proto__'),
    { ...block('第二列', 'column', 1, ' 布局 ', ''), markdownFormat: { columnWeight: 4000 } }]
  assert.deepEqual(validateSyncedCanonicalEdit(input), input)
  const malformed = structuredClone(input)
  malformed[4].markdownFormat = { columnWeight: 3000 }
  assert.throws(() => validateSyncedCanonicalEdit(malformed), SyncedValidationError)
  assert.equal(input[4].markdownFormat?.columnWeight, 4000)
})

test('raw forest validation rejects missing, closed and illegal parents without repair', () => {
  assert.throws(() => validateSyncedCanonicalEdit([]), SyncedValidationError)
  assert.deepEqual(validateSyncedHostForest([]), [])
  for (const input of [
    [block('跳级', 'paragraph', 1, '缺失')],
    [block('普通'), block('非法子块', 'paragraph', 1, '普通')],
    [block('外层', 'callout'), block('根'), block('关闭的子块', 'paragraph', 1, '外层')],
    [block('越界', 'paragraph', 7)],
    [{ ...block(), sortOrder: 0 }],
    [{ ...block(), depth: 1.2 }],
    [{ ...block(), type: ' paragraph ' }]
  ]) assert.throws(() => validateSyncedCanonicalEdit(input), SyncedValidationError)
})

test('canonical edit authority excludes timestamps and refuses lossy finite metadata', () => {
  for (const input of [
    [{ ...block(), createdAt }], [{ ...block(), updatedAt: createdAt }],
    [{ ...block(), checked: true }], [{ ...block(), language: 'ts' }],
    [{ ...block(), markdownFormat: { hidden: undefined } }],
    [{ ...block(), markdownFormat: { columnWeight: 5000 } }],
    [{ ...block(), tags: ['same', 'same'] }]
  ]) assert.throws(() => validateSyncedCanonicalEdit(input), SyncedValidationError)
  assert.throws(() => validateSyncedCanonicalWire([block()]), SyncedValidationError)
  assert.throws(() => validateSyncedCanonicalWire([{ ...block(), createdAt: 'not-a-date' }]), SyncedValidationError)
  const good = { ...block('code', 'code', 0, null, 'literal'), language: 'ts', markdownFormat: { codeInfo: 'ts test' } }
  assert.deepEqual(validateSyncedCanonicalEdit([good]), [good])
})

test('canonical tags reject sparse arrays preserved by IPC structured clone', () => {
  const tags = structuredClone(new Array<string>(1))
  assert.equal(Object.hasOwn(tags, 0), false)
  assert.throws(() => validateSyncedCanonicalEdit([{ ...block(), tags }]), SyncedValidationError)
})

test('link bindings reject sparse arrays before producing a non-round-trippable wire record', () => {
  const bindings = structuredClone(new Array(1))
  assert.throws(() => validateSyncedBindings(bindings, [block()]), SyncedValidationError)
})

test('local snapshot rejects sparse instance lists before installing an acknowledgement', () => {
  const { id: _id, kind: _kind, ...semantics } = wire()
  const snapshot = { ...semantics, groupId, revision: groupId, topologyRevision: instanceId,
    instances: structuredClone(new Array<SyncedInstancePosition>(1)),
    history: { cursor: instanceId, undoToken: null, redoToken: null }, maxRelativeDepth: 0 }
  assert.throws(() => validateSyncedGroupSnapshot(snapshot), SyncedValidationError)
})

test('synced host references are strict UUID leaf atoms and never canonical descendants', () => {
  const ref = block(instanceId, 'synced-block', 1, '提示', serializeSyncedBlockPayload({ version: 1, groupId }))
  const host = [block('提示', 'callout'), ref]
  assert.deepEqual(validateSyncedHostForest(host), host)
  assert.throws(() => validateSyncedCanonicalEdit(host), error => error instanceof SyncedValidationError && error.code === 'nested-sync')
  assert.throws(() => validateSyncedHostForest([...host, block('内层', 'paragraph', 2, instanceId)]), SyncedValidationError)
  assert.throws(() => validateSyncedHostForest([{ ...ref, id: '旧普通块', depth: 0, parentBlockId: null }]), SyncedValidationError)
  assert.deepEqual(validateSyncedCanonicalEdit([block('示例', 'code', 0, null,
    '```knowbook-synced-block-v1\n{"version":1,"groupId":"example"}\n```')]).length, 1)
})

test('reference codec rejects duplicate JSON, unsupported versions and non-finite payload shape', () => {
  const content = serializeSyncedBlockPayload({ version: 1, groupId })
  assert.deepEqual(parseSyncedBlockPayload(content), { version: 1, groupId })
  for (const invalid of [
    `{"version":1,"version":1,"groupId":"${groupId}"}`,
    `{"version":2,"groupId":"${groupId}"}`,
    `{"version":1,"groupId":"${groupId}","extra":true}`,
    `{"version":1,"groupId":"${groupId}","__proto__":{}}`,
    '{"version":1,"groupId":"not-an-instance-uuid"}'
  ]) assert.throws(() => parseSyncedBlockPayload(invalid), SyncedValidationError)
})

test('projection validates every instance at transparent depth without mutating its bindings', () => {
  const input = [block('a', 'callout'), block('b', 'toggle', 1, 'a'), block('c', 'paragraph', 2, 'b')]
  validateSyncedCanonicalProjection(input, [instance(4)])
  const deep = { ...instance(5), instanceId: '00000000-0000-4000-8000-000000000003' }
  const instances = [instance(1), deep]
  assert.throws(() => validateSyncedCanonicalProjection(input, instances), error => {
    assert.ok(error instanceof SyncedValidationError)
    assert.equal(error.code, 'depth')
    assert.deepEqual(error.blockingInstances, [{ instanceId: deep.instanceId, hostDocumentId: deep.hostDocumentId, bindingVersion: deep.bindingVersion }])
    return true
  })
  assert.equal(input[2].depth, 2)
  assert.equal(deep.depth, 5)
})

test('link binding ranges use original UTF-16 source and preserve the incoming order', () => {
  const input = block('__proto__', 'paragraph', 0, null, '🧭 [甲](one) [乙](two)')
  const first = input.content.indexOf('['), second = input.content.lastIndexOf('[')
  const binding = (from: number, to: number) => ({ blockId: input.id, from, to, raw: input.content.slice(from, to),
    syntax: 'markdown' as const, target: { kind: 'document' as const, id: '目标', state: 'live' as const } })
  const ordered = [binding(second, input.content.length), binding(first, second - 1)]
  assert.deepEqual(validateSyncedBindings(ordered, [input]), ordered)
  assert.throws(() => validateSyncedBindings([{ ...ordered[0], from: 2 }], [input]), SyncedValidationError)
  assert.throws(() => validateSyncedBindings([ordered[0], ordered[0]], [input]), SyncedValidationError)
})

test('portable group parser accepts exact semantic shape and rejects local authority and UTF-8 overflow', () => {
  const input = wire()
  assert.deepEqual(parseSyncedGroupWire(JSON.stringify(input)), input)
  for (const extra of ['revision', 'topologyRevision', 'clientOperationId', 'history']) {
    assert.throws(() => parseSyncedGroupWire(JSON.stringify({ ...input, [extra]: groupId })), SyncedValidationError)
  }
  const oversized = wire([{ ...block('large', 'paragraph', 0, null, '汉'.repeat(2 * 1024 * 1024)), createdAt }])
  assert.throws(() => parseSyncedGroupWire(JSON.stringify(oversized)), SyncedValidationError)
})

test('local snapshot validates actual history, unique bindings and derived depth without a portable file URL limit', () => {
  const portable = wire(), { id: _id, kind: _kind, ...semantics } = portable
  const snapshot: SyncedGroupSnapshot = { ...semantics, groupId, revision: groupId, topologyRevision: instanceId,
    instances: [instance(0)], history: { cursor: instanceId, undoToken: null, redoToken: groupId }, maxRelativeDepth: 0 }
  assert.deepEqual(validateSyncedGroupSnapshot(snapshot), snapshot)
  for (const invalid of [{ ...snapshot, maxRelativeDepth: 1 }, { ...snapshot, instances: [instance(0), instance(0)] },
    { ...snapshot, instances: [{ ...instance(1), parentBlockId: null }] },
    { ...snapshot, instances: [{ ...instance(0), bindingVersion: 'old' }] },
    { ...snapshot, history: { ...snapshot.history, cursor: 'old' } },
    { ...snapshot, history: { ...snapshot.history, expectedRevision: groupId } },
    { ...snapshot, sourceRevision: groupId }]) assert.throws(() => validateSyncedGroupSnapshot(invalid), SyncedValidationError)
  const localized = { ...snapshot, instances: [], blocks: [{ ...snapshot.blocks[0], content: `![file](file:///${'长'.repeat(2 * 1024 * 1024)})` }] }
  assert.deepEqual(validateSyncedGroupSnapshot(localized), localized)
})

test('projection refuses root frontmatter at nested instances before the rich candidate is accepted', () => {
  const blocks = [block('yaml', 'frontmatter', 0, null, 'title: literal')]
  validateSyncedCanonicalProjection(blocks, [instance(0)])
  const nested = instance(1)
  assert.throws(() => validateSyncedCanonicalProjection(blocks, [instance(0), nested]), error =>
    error instanceof SyncedValidationError && error.code === 'forest' && error.blockingInstances.length === 1
      && error.blockingInstances[0].instanceId === nested.instanceId)
})

test('transparent list references defer their actual root role until the group projection is known', () => {
  const parent = block('列表父', 'todo'), reference = block(instanceId, 'synced-block', 1, parent.id,
    serializeSyncedBlockPayload({ version: 1, groupId }))
  assert.deepEqual(validateSyncedHostForest([parent, reference]), [parent, reference])
  const position = { ...instance(1), parentBlockId: parent.id, parentType: 'todo' }
  validateSyncedCanonicalProjection([block('列表子', 'todo')], [position])
  assert.throws(() => validateSyncedCanonicalProjection([block('普通子')], [position]),
    error => error instanceof SyncedValidationError && error.code === 'forest')
  assert.throws(() => validateSyncedCanonicalProjection([block('列表子', 'todo'), block('混合普通')], [position]), SyncedValidationError)
})
