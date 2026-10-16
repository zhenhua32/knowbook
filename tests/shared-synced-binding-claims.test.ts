import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import type { SyncedBindingClaim, SyncedBindingKey, SyncedUpdateGroupInput } from '../src/shared/synced-blocks'
import { validateSyncedBindingClaims, validateSyncedBindingKey, validateSyncedUpdateGroupInput } from '../src/shared/syncedBlockInputs'
import { SyncedValidationError } from '../src/shared/syncedBlockValidation'

function key(blockId = ' 旧块:甲 ', from = 0, raw = 'Target.md', syntax: SyncedBindingKey['syntax'] = 'markdown'): SyncedBindingKey {
  return { blockId, from, to: from + raw.length, raw, syntax }
}
function ticket() { return { kind: 'ticket' as const, ticketId: randomUUID(), entryId: randomUUID() } }
function update(): SyncedUpdateGroupInput {
  return { groupId: randomUUID(), expectedRevision: randomUUID(), expectedTopologyRevision: randomUUID(),
    clientOperationId: randomUUID(), expectedInstanceBinding: { instanceId: randomUUID(), hostDocumentId: ' 宿主:甲 ', bindingVersion: randomUUID() },
    blocks: [{ id: '__proto__', type: 'paragraph', content: '😀\r\n[x](Target.md)', checked: false, depth: 0, parentBlockId: null }] }
}

test('binding keys preserve opaque old IDs, including whitespace and prototype-shaped names', () => {
  for (const blockId of [' 旧块:甲 ', '__proto__', 'constructor']) {
    const input = key(blockId, 7), original = structuredClone(input), result = validateSyncedBindingKey(input)
    assert.deepEqual(result, original)
    assert.equal(result.blockId, blockId)
    assert.notEqual(result, input)
    assert.deepEqual(input, original)
  }
  const input = Object.assign(Object.create(null) as Record<string, unknown>, key('__proto__'))
  assert.deepEqual(validateSyncedBindingKey(input), key('__proto__'))
})

test('binding key ranges count exact UTF16 code units and preserve CRLF and emoji bytes', () => {
  const prefix = '😀\r\n链接:', raw = '../目标/🧩.md\r\n#章节', content = `${prefix}${raw}\r\n尾部`
  const input = key('constructor', prefix.length, raw), result = validateSyncedBindingKey(input)
  assert.notEqual(prefix.length, Array.from(prefix).length)
  assert.equal(result.from, prefix.length)
  assert.equal(result.to, prefix.length + raw.length)
  assert.equal(content.slice(result.from, result.to), raw)
  assert.deepEqual(result, input)
  assert.throws(() => validateSyncedBindingKey({ ...input, to: input.from + Array.from(raw).length }), SyncedValidationError)
})

test('empty destination points are allowed for Markdown and refused for Wiki', () => {
  const empty = key(' empty:点 ', 11, '')
  assert.deepEqual(validateSyncedBindingKey(empty), empty)
  assert.deepEqual(validateSyncedBindingClaims([{ kind: 'new', destination: empty }]), [{ kind: 'new', destination: empty }])
  assert.deepEqual(validateSyncedBindingClaims([{ kind: 'continue', source: empty, destination: key('next', 4, '') }]),
    [{ kind: 'continue', source: empty, destination: key('next', 4, '') }])
  assert.throws(() => validateSyncedBindingKey({ ...empty, syntax: 'wiki' }), SyncedValidationError)
  assert.throws(() => validateSyncedBindingClaims([{ kind: 'new', destination: { ...empty, syntax: 'wiki' } }]), SyncedValidationError)
  assert.deepEqual(validateSyncedBindingKey(key('wiki', 2, '目标#标题', 'wiki')), key('wiki', 2, '目标#标题', 'wiki'))
})

test('binding keys refuse invalid ranges, nonexact raw lengths, missing fields and injected authority', () => {
  const valid = key(), { raw: _raw, ...withoutRaw } = valid
  const malformed: unknown[] = [null, [], 'key', withoutRaw,
    { ...valid, from: -1 }, { ...valid, from: 0.5 }, { ...valid, from: '0' },
    { ...valid, from: Number.NaN }, { ...valid, from: Number.POSITIVE_INFINITY },
    { ...valid, from: Number.MAX_SAFE_INTEGER + 1, to: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, to: -1 }, { ...valid, to: valid.from - 1 }, { ...valid, to: 1.5 },
    { ...valid, to: Number.MAX_SAFE_INTEGER + 1 }, { ...valid, to: Number.NaN },
    { ...valid, raw: undefined }, { ...valid, raw: null }, { ...valid, raw: 'different length' },
    { ...valid, from: 0, to: 1, raw: '😀' }, { ...valid, syntax: 'html' },
    { ...valid, blockId: '' }, { ...valid, blockId: ' \r\n ' }, { ...valid, blockId: null },
    { ...valid, target: { kind: 'document', id: 'forged', state: 'live' } }, { ...valid, target: undefined },
    Object.assign(Object.create({ blockId: 'inherited' }) as Record<string, unknown>, { from: 0, to: 0, raw: '', syntax: 'markdown' })]
  for (const input of malformed) assert.throws(() => validateSyncedBindingKey(input), SyncedValidationError)
})

test('claim unions and nested sources are closed and cannot carry typed targets', () => {
  const source = key('source'), destination = key('destination'), target = { kind: 'document', id: 'forged', state: 'live' }
  const malformed: unknown[] = [null, [], false, { kind: 'replace', source, destination },
    { kind: 'new' }, { kind: 'new', destination, source: undefined }, { kind: 'new', destination, target },
    { kind: 'continue', destination }, { kind: 'continue', source, destination, target: undefined },
    { kind: 'continue', source: { kind: 'current', key: source }, destination },
    { kind: 'copy', destination }, { kind: 'copy', source, destination },
    { kind: 'copy', source: null, destination }, { kind: 'copy', source: [], destination },
    { kind: 'copy', source: { kind: 'current', key: source, target }, destination },
    { kind: 'copy', source: { kind: 'current', key: { ...source, target } }, destination },
    { kind: 'copy', source: { ...ticket(), target: undefined }, destination },
    { kind: 'copy', source: ticket(), destination: { ...destination, target } },
    Object.assign(Object.create({ kind: 'new' }) as Record<string, unknown>, { destination })]
  for (const claim of malformed) assert.throws(() => validateSyncedBindingClaims([claim]), SyncedValidationError)
})

test('copy tickets require the exact known source kind and valid UUIDs for both IDs', () => {
  const source = ticket(), destination = key('destination')
  assert.deepEqual(validateSyncedBindingClaims([{ kind: 'copy', source, destination }]), [{ kind: 'copy', source, destination }])
  for (const invalid of ['', 'not-a-uuid', ` ${source.ticketId}`, `${source.entryId} `, null, undefined]) {
    assert.throws(() => validateSyncedBindingClaims([{ kind: 'copy', source: { ...source, ticketId: invalid }, destination }]), SyncedValidationError)
    assert.throws(() => validateSyncedBindingClaims([{ kind: 'copy', source: { ...source, entryId: invalid }, destination }]), SyncedValidationError)
  }
  for (const unknown of [{ ...source, kind: 'operation' }, { ...source, kind: 'history' },
    { kind: 'current' }, { kind: 'ticket', ticketId: source.ticketId }, { kind: 'ticket', entryId: source.entryId }]) {
    assert.throws(() => validateSyncedBindingClaims([{ kind: 'copy', source: unknown, destination }]), SyncedValidationError)
  }
})

test('claims accept an empty dense list and refuse nonarrays and sparse slots', () => {
  assert.deepEqual(validateSyncedBindingClaims([]), [])
  const sparse = new Array<unknown>(2)
  sparse[1] = { kind: 'new', destination: key('destination') }
  for (const input of [undefined, null, {}, 'claims', new Array(1), sparse]) {
    assert.throws(() => validateSyncedBindingClaims(input), SyncedValidationError)
  }
})

test('each exact destination can be claimed only once across all claim kinds', () => {
  const source = key('source'), destination = key('destination')
  const alternatives: SyncedBindingClaim[] = [{ kind: 'new', destination }, { kind: 'continue', source, destination },
    { kind: 'copy', source: { kind: 'current', key: source }, destination }, { kind: 'copy', source: ticket(), destination }]
  for (const claim of alternatives) {
    assert.throws(() => validateSyncedBindingClaims([{ kind: 'new', destination }, claim]), SyncedValidationError)
  }
  const different = [key('__proto__', 2), key('constructor', 2), key('__proto__', 20)]
  assert.deepEqual(validateSyncedBindingClaims(different.map(destination => ({ kind: 'new', destination }))),
    different.map(destination => ({ kind: 'new', destination })))
})

test('a continue source is linear while current and ticket copy sources remain reusable', () => {
  const source = key('__proto__', 3), saved = ticket()
  const claims: SyncedBindingClaim[] = [{ kind: 'continue', source, destination: key('first') },
    { kind: 'copy', source: { kind: 'current', key: source }, destination: key('second') },
    { kind: 'copy', source: { kind: 'current', key: source }, destination: key('third') },
    { kind: 'copy', source: saved, destination: key('fourth') },
    { kind: 'copy', source: saved, destination: key('fifth') }]
  assert.deepEqual(validateSyncedBindingClaims(claims), claims)
  assert.throws(() => validateSyncedBindingClaims([...claims, { kind: 'continue', source, destination: key('sixth') }]), SyncedValidationError)
  const independent: SyncedBindingClaim[] = [{ kind: 'continue', source: key('__proto__'), destination: key('a') },
    { kind: 'continue', source: key('constructor'), destination: key('b') },
    { kind: 'continue', source: key(' __proto__ '), destination: key('c') }]
  assert.deepEqual(validateSyncedBindingClaims(independent), independent)
})

test('claim validation returns independent nested intent data without mutating the input', () => {
  const claims: SyncedBindingClaim[] = [{ kind: 'continue', source: key('source'), destination: key('continued') },
    { kind: 'copy', source: { kind: 'current', key: key('constructor') }, destination: key('copied') },
    { kind: 'copy', source: ticket(), destination: key('ticket-copy') }, { kind: 'new', destination: key('new') }]
  const original = structuredClone(claims), result = validateSyncedBindingClaims(claims)
  assert.deepEqual(result, original)
  assert.deepEqual(claims, original)
  assert.notEqual(result, claims)
  for (let index = 0; index < claims.length; index++) {
    assert.notEqual(result[index], claims[index])
    assert.notEqual(result[index].destination, claims[index].destination)
  }
  const before = claims[1], after = result[1]
  if (before.kind !== 'copy' || before.source.kind !== 'current' || after.kind !== 'copy' || after.source.kind !== 'current') throw new Error('fixture')
  assert.notEqual(after.source, before.source)
  assert.notEqual(after.source.key, before.source.key)
  after.source.key.raw = 'changed output'
  result[0].destination.blockId = 'changed output'
  assert.deepEqual(claims, original)
})

test('update inputs retain the legacy absent-claims form and distinguish explicit empty claims', () => {
  const input = update(), original = structuredClone(input), result = validateSyncedUpdateGroupInput(input)
  assert.deepEqual(result, original)
  assert.equal(Object.hasOwn(result, 'bindingClaims'), false)
  assert.deepEqual(input, original)
  const explicit = { ...input, bindingClaims: [] }, checked = validateSyncedUpdateGroupInput(explicit)
  assert.deepEqual(checked, explicit)
  assert.equal(Object.hasOwn(checked, 'bindingClaims'), true)
  assert.notEqual(checked.bindingClaims, explicit.bindingClaims)
  assert.throws(() => validateSyncedUpdateGroupInput({ ...input, bindingClaims: undefined }), SyncedValidationError)
  assert.throws(() => validateSyncedUpdateGroupInput({ ...input, claims: [] }), SyncedValidationError)
  assert.throws(() => validateSyncedUpdateGroupInput({ ...input, bindingClaims: new Array(1) }), SyncedValidationError)
})

test('update inputs preserve validated claims and working bytes without sharing or mutation', () => {
  const input = update(), content = input.blocks[0].content
  input.bindingClaims = [{ kind: 'copy', source: { kind: 'current', key: key(' 旧来源 ', 12) },
    destination: key('__proto__', content.indexOf('Target.md')) }]
  const original = structuredClone(input), result = validateSyncedUpdateGroupInput(input)
  assert.deepEqual(result, original)
  assert.deepEqual(input, original)
  assert.notEqual(result.blocks, input.blocks)
  assert.notEqual(result.bindingClaims, input.bindingClaims)
  assert.notEqual(result.bindingClaims![0].destination, input.bindingClaims[0].destination)
  result.bindingClaims![0].destination.raw = 'changed output'
  result.blocks[0].content = 'changed output'
  assert.deepEqual(input, original)
})
