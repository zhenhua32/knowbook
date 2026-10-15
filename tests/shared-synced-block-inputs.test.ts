import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import type { SyncedStructureInput, SyncedUpdateGroupInput } from '../src/shared/synced-blocks'
import { serializeSyncedBlockPayload, SyncedValidationError } from '../src/shared/syncedBlockValidation'
import { validateSyncedRestoreGroupInput, validateSyncedRestoreHostInput,
  validateSyncedStructureInput, validateSyncedUpdateGroupInput } from '../src/shared/syncedBlockInputs'

const groupId = randomUUID(), instanceId = randomUUID(), time = '2026-10-16T00:00:00+08:00'
const group = { groupId, expectedRevision: randomUUID(), expectedTopologyRevision: randomUUID() }
const instance = { instanceId, hostDocumentId: ' 宿主:甲 ', bindingVersion: randomUUID() }
const block = (id = '__proto__', content = '尚未保存的正文') => ({ id, type: 'paragraph', content,
  checked: false, depth: 0, parentBlockId: null })
function command(): SyncedStructureInput {
  return { mode: 'command', clientOperationId: randomUUID(), groups: [group], expectedInstances: [instance],
    hostsWorkingBefore: [{ documentId: instance.hostDocumentId, expectedPersistedUpdatedAt: time,
      workingBefore: { title: '未保存的标题', summary: '未保存的摘要', blocks: [block()] } }],
    action: { kind: 'create', documentId: instance.hostDocumentId, selectedRootIds: ['__proto__'], groupId, instanceId } }
}
function final(): SyncedStructureInput {
  const { action: _action, ...base } = command() as Extract<SyncedStructureInput, { mode: 'command' }>
  return { ...base, mode: 'host-final', reason: 'source-apply', newRefSources: [],
    finalAfter: [{ documentId: instance.hostDocumentId, title: '最终标题', summary: '最终摘要', blocks: [block('constructor', '最终正文')] }] }
}
function update(): SyncedUpdateGroupInput {
  return { ...group, clientOperationId: randomUUID(), expectedInstanceBinding: instance, blocks: [block()] }
}

test('command preserves complete pre-action working bytes and ordered root selections without mutation', () => {
  const input = command()
  if (input.mode !== 'command' || input.action.kind !== 'create') throw new Error('fixture')
  input.action.selectedRootIds = ['__proto__', '__proto__', ' 中文:子块 ']
  const original = structuredClone(input), result = validateSyncedStructureInput(input)
  assert.deepEqual(result, original)
  assert.notEqual(result, input)
  assert.notEqual(result.hostsWorkingBefore[0].workingBefore.blocks, input.hostsWorkingBefore[0].workingBefore.blocks)
  assert.deepEqual(input, original)
})

test('command and host-final authorities cannot be mixed, including ignored undefined keys', () => {
  const a = command(), b = final()
  assert.deepEqual(validateSyncedStructureInput(b), b)
  for (const input of [{ ...a, finalAfter: [] }, { ...a, newRefSources: [] }, { ...a, canonicalReplacement: undefined },
    { ...b, action: { kind: 'delete', selection: { documentId: 'x', selectedRootIds: ['y'] } } },
    { ...b, canonicalReplacement: [block()] }, { ...b, mode: 'combined' }]) {
    assert.throws(() => validateSyncedStructureInput(input), SyncedValidationError)
  }
})

test('host-final requires the exact participating host set once and preserves independent final authority', () => {
  const input = final()
  if (input.mode !== 'host-final') throw new Error('fixture')
  const other = { ...input.hostsWorkingBefore[0], documentId: '目标', workingBefore: { title: '目标脏标题', summary: '', blocks: [] } }
  input.hostsWorkingBefore.push(other)
  input.finalAfter.unshift({ documentId: '目标', title: '目标最终标题', summary: '', blocks: [] })
  assert.deepEqual(validateSyncedStructureInput(input), input)
  for (const finalAfter of [input.finalAfter.slice(1), [...input.finalAfter, input.finalAfter[0]],
    input.finalAfter.map((item, index) => index ? item : { ...item, documentId: '未参与' })]) {
    assert.throws(() => validateSyncedStructureInput({ ...input, finalAfter }), SyncedValidationError)
  }
  assert.throws(() => validateSyncedStructureInput({ ...input, hostsWorkingBefore: [...input.hostsWorkingBefore, other] }), SyncedValidationError)
})

test('raw forest errors in W or finalAfter are refused before normalizers can repair them', () => {
  const a = command(), b = final()
  const malformed = [{ ...block(), depth: 1, parentBlockId: '缺失父块' }]
  assert.throws(() => validateSyncedStructureInput({ ...a, hostsWorkingBefore: [{ ...a.hostsWorkingBefore[0],
    workingBefore: { ...a.hostsWorkingBefore[0].workingBefore, blocks: malformed } }] }), SyncedValidationError)
  if (b.mode !== 'host-final') throw new Error('fixture')
  assert.throws(() => validateSyncedStructureInput({ ...b, finalAfter: [{ ...b.finalAfter[0], blocks: malformed }] }), SyncedValidationError)
})

test('both new-reference proof branches are finite and cannot claim arbitrary provenance', () => {
  const input = final()
  if (input.mode !== 'host-final') throw new Error('fixture')
  const idA = randomUUID(), idB = randomUUID()
  input.newRefSources = [{ kind: 'working', instanceId: idA, sourceDocumentId: instance.hostDocumentId, sourceInstanceId: instanceId },
    { kind: 'internal', instanceId: idB, identity: { workspaceScope: randomUUID(), groupId, creationId: randomUUID() } }]
  input.finalAfter[0].blocks = [idA, idB].map(id => ({ ...block(id), type: 'synced-block', content: serializeSyncedBlockPayload({ version: 1, groupId }) }))
  assert.deepEqual(validateSyncedStructureInput(input), input)
  for (const newRefSources of [[{ ...input.newRefSources[0], identity: {} }],
    [{ kind: 'markdown', instanceId: idA, groupId }], [input.newRefSources[0], input.newRefSources[0]],
    [{ kind: 'internal', instanceId: idB, identity: { workspaceScope: 'foreign', groupId, creationId: randomUUID() } }]]) {
    assert.throws(() => validateSyncedStructureInput({ ...input, newRefSources }), SyncedValidationError)
  }
})

test('update and history requests bind content, topology, precise instance and independent history cursor', () => {
  const input = update()
  assert.deepEqual(validateSyncedUpdateGroupInput(input), input)
  for (const bad of [{ ...input, expectedRevision: '' }, { ...input, expectedTopologyRevision: 'old' },
    { ...input, expectedInstanceBinding: { ...instance, hostDocumentId: ' ' } },
    { ...input, blocks: [{ ...block(), createdAt: time }] }, { ...input, blocks: [] }]) {
    assert.throws(() => validateSyncedUpdateGroupInput(bad), SyncedValidationError)
  }
  const { blocks: _blocks, ...base } = input
  const restore = { ...base, historyToken: randomUUID(), expectedHistoryCursor: randomUUID(), direction: 'undo' as const }
  assert.deepEqual(validateSyncedRestoreGroupInput(restore), restore)
  assert.throws(() => validateSyncedRestoreGroupInput({ ...restore, expectedHistoryCursor: undefined }), SyncedValidationError)
  assert.throws(() => validateSyncedRestoreGroupInput({ ...restore, blocks: [block()] }), SyncedValidationError)
  const host = { clientOperationId: randomUUID(), historyToken: randomUUID(), direction: 'redo' as const,
    expectedHosts: [{ documentId: instance.hostDocumentId, expectedUpdatedAt: time }], groups: [group], expectedInstances: [instance] }
  assert.deepEqual(validateSyncedRestoreHostInput(host), host)
  assert.throws(() => validateSyncedRestoreHostInput({ ...host, expectedHosts: [...host.expectedHosts, ...host.expectedHosts] }), SyncedValidationError)
  assert.throws(() => validateSyncedRestoreHostInput({ ...host, direction: 'force' }), SyncedValidationError)
})

test('guards are unique and command targets use stable identities instead of index authority', () => {
  const base = command(), target = { documentId: instance.hostDocumentId, beforeBlockId: ' 前方:锚点 ', parentBlockId: null, depth: 0 }
  const move = { ...base, action: { kind: 'move', selection: { documentId: instance.hostDocumentId, selectedRootIds: ['__proto__'] }, target } }
  assert.deepEqual(validateSyncedStructureInput(move), move)
  for (const input of [{ ...base, groups: [group, group] }, { ...base, expectedInstances: [instance, instance] },
    { ...move, action: { ...move.action, target: { ...target, index: 2 } } },
    { ...move, action: { ...move.action, target: { ...target, depth: 7 } } },
    { ...move, action: { ...move.action, selection: { documentId: instance.hostDocumentId, selectedRootIds: [] } } }]) {
    assert.throws(() => validateSyncedStructureInput(input), SyncedValidationError)
  }
})

test('IPC sparse collections are rejected at every structural request array boundary', () => {
  const base = command(), sparse = structuredClone(new Array(1))
  for (const input of [
    { ...base, action: { kind: 'create', documentId: instance.hostDocumentId, groupId: group.groupId,
      instanceId: instance.instanceId, selectedRootIds: sparse } },
    { ...base, action: { kind: 'move-batch', moves: sparse } },
    { ...base, hostsWorkingBefore: sparse }, { ...base, groups: sparse },
    { ...base, expectedInstances: sparse }
  ]) assert.throws(() => validateSyncedStructureInput(input), SyncedValidationError)
})
