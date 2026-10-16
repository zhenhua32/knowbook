import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import type { SyncedBindingClaim, SyncedBindingKey, SyncedCanonicalEdit } from '../src/shared/synced-blocks'
import { composeSyncedBindingClaims, syncedBindingClaimsAreIdentity, validateSyncedWorkingClaims } from '../src/renderer/src/features/synced-blocks/bindingClaims'
import { SyncedValidationError } from '../src/shared/syncedBlockValidation'

const key = (blockId: string, from: number, raw = 'Target.md'): SyncedBindingKey => ({ blockId, from, to: from + raw.length, raw, syntax: 'markdown' })
const paragraph = (id: string, content: string): SyncedCanonicalEdit => ({ id, content, type: 'paragraph', checked: false, depth: 0, parentBlockId: null })

test('split and join composition tracks exact source occurrences even when both have the same URL', () => {
  const a = key('original-a', 4), b = key('original-b', 4), splitA = key('split', 4), splitB = key('split', 24)
  const middle: SyncedBindingClaim[] = [{ kind: 'continue', source: a, destination: splitA }, { kind: 'continue', source: b, destination: splitB }]
  const finalA = key('joined', 30), finalB = key('joined', 10)
  const after: SyncedBindingClaim[] = [{ kind: 'continue', source: splitB, destination: finalB }, { kind: 'continue', source: splitA, destination: finalA }]
  assert.deepEqual(composeSyncedBindingClaims(middle, after), [
    { kind: 'continue', source: b, destination: finalB }, { kind: 'continue', source: a, destination: finalA }
  ])
  assert.ok(middle[0].kind === 'continue')
  assert.deepEqual(middle[0].source, a)
})

test('copy-of-copy flattens exact current and ticket sources while unacknowledged new links remain new', () => {
  const original = key('original', 4), copied = key('middle', 4), ticketCopy = key('middle', 24), fresh = key('middle', 44)
  const ticket = { kind: 'ticket' as const, ticketId: randomUUID(), entryId: randomUUID() }
  const before: SyncedBindingClaim[] = [{ kind: 'continue', source: original, destination: copied },
    { kind: 'copy', source: ticket, destination: ticketCopy }, { kind: 'new', destination: fresh }]
  const destinations = [key('after', 4), key('after', 24), key('after', 44)]
  const after: SyncedBindingClaim[] = [
    { kind: 'copy', source: { kind: 'current', key: copied }, destination: destinations[0] },
    { kind: 'continue', source: ticketCopy, destination: destinations[1] },
    { kind: 'copy', source: { kind: 'current', key: fresh }, destination: destinations[2] }
  ]
  assert.deepEqual(composeSyncedBindingClaims(before, after), [
    { kind: 'copy', source: { kind: 'current', key: original }, destination: destinations[0] },
    { kind: 'copy', source: ticket, destination: destinations[1] }, { kind: 'new', destination: destinations[2] }
  ])
})

test('missing lineage and duplicate destinations refuse rather than use an equal URL as the source', () => {
  const source = key('source', 4), middle = key('middle', 4), final = key('final', 4)
  const old: SyncedBindingClaim[] = [{ kind: 'continue', source, destination: middle }]
  assert.throws(() => composeSyncedBindingClaims(old, [{ kind: 'continue', source: key('foreign', 4), destination: final }]), SyncedValidationError)
  assert.throws(() => composeSyncedBindingClaims(old, [{ kind: 'continue', source: middle, destination: final },
    { kind: 'new', destination: final }]), SyncedValidationError)
})

test('working claims preserve opaque IDs and UTF16 empty points, validate both sides and never erase same-text new intent', () => {
  const id = ' __proto__:正文\0 ', before = [paragraph(id, '🙂 [self]()')], after = [paragraph(id, 'prefix 🙂 [self]()')]
  const point = before[0].content.indexOf(')'), destinationPoint = after[0].content.indexOf(')')
  const source = key(id, point, ''), destination = key(id, destinationPoint, '')
  const claim: SyncedBindingClaim = { kind: 'continue', source, destination }
  assert.deepEqual(validateSyncedWorkingClaims([claim], before, after), [claim])
  assert.throws(() => validateSyncedWorkingClaims([{ ...claim, source: key('absent', point, '') }], before, after), SyncedValidationError)
  assert.throws(() => validateSyncedWorkingClaims([{ ...claim, destination: key(id, after[0].content.length + 1, '') }], before, after), SyncedValidationError)
  assert.equal(syncedBindingClaimsAreIdentity([{ kind: 'continue', source, destination: source }]), true)
  assert.equal(syncedBindingClaimsAreIdentity([{ kind: 'new', destination: source }]), false)
  assert.equal(syncedBindingClaimsAreIdentity([{ kind: 'copy', source: { kind: 'current', key: source }, destination: source }]), false)
})
