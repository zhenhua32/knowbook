import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import type { SyncedCanonicalWire, SyncedGroupWire, SyncedStableBlockDraft } from '../src/shared/synced-blocks'
import { serializeSyncedBlockPayload, SyncedValidationError } from '../src/shared/syncedBlockValidation'
import { expandSyncedGraphDocument, validateSyncedWorkspaceGraph, type SyncedGraphDocument } from '../src/shared/syncedBlockGraph'

const time = '2026-10-16T00:00:00Z'
const block = (id: string, type = 'paragraph', depth = 0, parentBlockId: string | null = null): SyncedStableBlockDraft =>
  ({ id, type, content: '正文', checked: false, depth, parentBlockId })
function group(children: SyncedStableBlockDraft[] = [block(' 旧:正文 ')]): SyncedGroupWire {
  return { kind: 'synced-group', id: randomUUID(), creationId: randomUUID(), createdAt: time,
    origin: { version: 1, documentId: '原文档', pathAtCreation: 'Home/Origin', firstInstanceId: randomUUID() }, bindings: [],
    blocks: children.map(item => ({ ...item, createdAt: time })) }
}
function ref(source: SyncedGroupWire, depth = 0, parentBlockId: string | null = null) {
  return { ...block(randomUUID(), 'synced-block', depth, parentBlockId), content: serializeSyncedBlockPayload({ version: 1, groupId: source.id }) }
}

test('complete graph rejects sparse IPC document and group collections', () => {
  assert.throws(() => validateSyncedWorkspaceGraph(structuredClone(new Array<SyncedGraphDocument>(1)), []), SyncedValidationError)
  assert.throws(() => validateSyncedWorkspaceGraph([], structuredClone(new Array<SyncedGroupWire>(1))), SyncedValidationError)
})

test('complete graph rejects ordinary/canonical/instance identity collisions and missing dependency closure', () => {
  const source = group(), instance = ref(source)
  for (const documents of [
    [{ documentId: '宿主', blocks: [block(source.blocks[0].id), instance] }],
    [{ documentId: '宿主', blocks: [instance] }, { documentId: '另一宿主', blocks: [block(instance.id)] }],
    [{ documentId: '宿主', blocks: [instance] }, { documentId: '宿主', blocks: [] }]
  ]) assert.throws(() => validateSyncedWorkspaceGraph(documents, [source]), SyncedValidationError)
  assert.throws(() => validateSyncedWorkspaceGraph([{ documentId: '宿主', blocks: [instance] }], []),
    error => error instanceof SyncedValidationError && error.code === 'binding')
  assert.throws(() => validateSyncedWorkspaceGraph([], [source, source]), SyncedValidationError)
  assert.throws(() => validateSyncedWorkspaceGraph([], [source, group([block(source.blocks[0].id)])]), SyncedValidationError)
})

test('every occurrence is transparent and preserves scoped identity tuples without materializing persistent IDs', () => {
  const source = group([block('__proto__', 'toggle'), block(' 子:块 ', 'paragraph', 1, '__proto__')])
  const a = ref(source), b = ref(source, 1, '提示'), documents = [{ documentId: '宿主', blocks: [a, block('提示', 'callout'), b] }]
  const before = structuredClone({ source, documents }), graph = validateSyncedWorkspaceGraph(documents, [source])
  const expanded = [...expandSyncedGraphDocument(graph, '宿主')]
  assert.equal(expanded.length, 5)
  assert.deepEqual(expanded.map(item => [item.instanceId, item.block.id, item.depth]), [
    [a.id, '__proto__', 0], [a.id, ' 子:块 ', 1], [null, '提示', 0], [b.id, '__proto__', 1], [b.id, ' 子:块 ', 2]])
  assert.deepEqual(expanded[1].parent, { instanceId: a.id, blockId: '__proto__' })
  assert.deepEqual(expanded[3].parent, { instanceId: null, blockId: '提示' })
  assert.equal(graph.occurrences.get(source.id)?.length, 2)
  assert.deepEqual(graph.owners.get('__proto__'), { kind: 'group', id: source.id })
  assert.deepEqual({ source, documents }, before)
})

test('canonical roots obey the actual host parent role as well as relative depth', () => {
  const source = group([block('yaml', 'frontmatter')])
  assert.doesNotThrow(() => validateSyncedWorkspaceGraph([{ documentId: '顶层', blocks: [ref(source)] }], [source]))
  assert.throws(() => validateSyncedWorkspaceGraph([{ documentId: '嵌套', blocks: [block('提示', 'callout'), ref(source, 1, '提示')] }], [source]),
    error => error instanceof SyncedValidationError && error.code === 'forest')
  const deep = group(Array.from({ length: 3 }, (_, index) => block(`group-${index}`, index === 2 ? 'paragraph' : 'toggle', index, index ? `group-${index - 1}` : null)))
  const nest = Array.from({ length: 5 }, (_, index) => block(`host-${index}`, 'toggle', index, index ? `host-${index - 1}` : null))
  assert.throws(() => validateSyncedWorkspaceGraph([{ documentId: '宿主', blocks: [ref(deep), ...nest, ref(deep, 5, 'host-4')] }], [deep]),
    error => error instanceof SyncedValidationError && error.code === 'depth')
})

test('orphan groups retain their canonical owner and creation metadata without creating host content', () => {
  const source = group(), graph = validateSyncedWorkspaceGraph([], [source])
  assert.deepEqual(graph.groups[0].blocks[0], source.blocks[0] as SyncedCanonicalWire)
  assert.deepEqual(graph.occurrences.get(source.id), [])
  assert.equal(graph.documents.length, 0)
  assert.equal(graph.owners.size, 1)
  assert.throws(() => [...expandSyncedGraphDocument(graph, '不存在')], SyncedValidationError)
})

test('transparent nested lists are accepted only when every canonical root fits the actual host list parent', () => {
  const source = group([block('同步列表', 'todo')]), parent = block('宿主列表', 'todo'), reference = ref(source, 1, parent.id)
  const host = { documentId: '宿主', blocks: [parent, reference] }
  assert.doesNotThrow(() => validateSyncedWorkspaceGraph([host], [source]))
  assert.throws(() => validateSyncedWorkspaceGraph([host], [{ ...source, blocks: [{ ...source.blocks[0], type: 'paragraph' }] }]), SyncedValidationError)
  const columns = [block('layout', 'columns'), { ...block('column', 'column', 1, 'layout'), content: '', markdownFormat: { columnWeight: 10000 } },
    { ...parent, depth: 2, parentBlockId: 'column' }, { ...reference, depth: 3 }]
  columns[0].content = ''
  assert.doesNotThrow(() => validateSyncedWorkspaceGraph([{ documentId: '宿主', blocks: columns }], [source]))
  assert.throws(() => validateSyncedWorkspaceGraph([{ documentId: '宿主', blocks: [{ ...columns[0] }, { ...reference, parentBlockId: 'layout' }] }], [source]), SyncedValidationError)
})
