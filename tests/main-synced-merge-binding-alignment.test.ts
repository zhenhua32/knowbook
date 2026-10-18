import assert from 'node:assert/strict'
import test from 'node:test'
import type { SyncedGroupWire } from '../src/shared/synced-blocks'
import { createUnchangedMergeRangeProjector, MERGE_DIFF_BUDGET_CELLS } from '../src/main/sync/merge-kernel'
import { mergeSyncedProtocol5Record } from '../src/main/sync/synced-merge'

const born = '2020-01-02T03:04:05+08:00'
const raw = 'Target.md', link = '[x](' + raw + ')'
const childId = ' alignment:原物理 child / 身份 '
function group(text: string, targetIds: string[]): SyncedGroupWire {
  const positions: number[] = []
  for (let from = text.indexOf(raw); from >= 0; from = text.indexOf(raw, from + raw.length)) positions.push(from)
  assert.equal(positions.length, targetIds.length, 'The independent fixture explicitly accounts for every known literal destination')
  return { kind: 'synced-group', id: '00000000-0000-0000-0000-000000000071', creationId: '00000000-0000-0000-0000-000000000072', createdAt: born,
    origin: { version: 1, documentId: ' alignment:原host ', pathAtCreation: 'Home/Host', firstInstanceId: '00000000-0000-0000-0000-000000000073' },
    blocks: [{ id: childId, type: 'paragraph', content: text, checked: false, depth: 0, parentBlockId: null, createdAt: born }],
    bindings: positions.map((from, index) => ({ blockId: childId, from, to: from + raw.length, raw, syntax: 'markdown' as const,
      target: { kind: 'document' as const, id: targetIds[index], state: 'live' as const } })).reverse() }
}
function merged(base: SyncedGroupWire, local: SyncedGroupWire, remote: SyncedGroupWire,
  choices: Parameters<typeof mergeSyncedProtocol5Record>[3] = {}) {
  const value = mergeSyncedProtocol5Record(base, local, remote, choices)
  assert.ok(value?.record.kind === 'synced-group', 'The strict pure merge returns the original group domain')
  if (!value || value.record.kind !== 'synced-group') throw new Error('Expected a strict group merge')
  return { ...value, record: value.record }
}
const budget = () => ({ cells: MERGE_DIFF_BUDGET_CELLS })

test('synced binding alignment refuses duplicate whole-link insertion plus separator before applying an independent target-only change', () => {
  const base = group(link, ['historical-A'])
  const local = group(link + ' ' + link, ['historical-A', 'historical-A'])
  const remote = group(link, ['historical-C'])
  const originals = structuredClone([base, local, remote])
  const preview = merged(base, local, remote)
  assert.deepEqual(preview.unresolved.map(part => part.id), ['blocks'])
  assert.equal(preview.unresolved[0].canEditText, false)
  assert.equal(createUnchangedMergeRangeProjector(base.blocks[0].content, local.blocks[0].content, budget()), null,
    'Even an equal first token cannot prove whether the original physical occurrence is the first or second duplicate')
  const selectedLocal = merged(base, local, remote, { blocks: { choice: 'local' } })
  assert.deepEqual(selectedLocal.unresolved, [])
  assert.deepEqual(selectedLocal.record.blocks, local.blocks)
  assert.deepEqual(selectedLocal.record.bindings, local.bindings)
  const selectedRemote = merged(base, local, remote, { blocks: { choice: 'remote' } })
  assert.deepEqual(selectedRemote.unresolved, [])
  assert.deepEqual(selectedRemote.record.blocks, remote.blocks)
  assert.deepEqual(selectedRemote.record.bindings, remote.bindings)
  assert.deepEqual([base, local, remote], originals, 'Pure preview and forest choices do not alter their original physical-Key evidence')
})

test('synced binding alignment refuses repeated whole-link deletion instead of guessing which physical target survived', () => {
  const source = link + ' ' + link, destination = link
  assert.equal(createUnchangedMergeRangeProjector(source, destination, budget()), null,
    'Both complete original links can be the same optimal surviving anchor sequence')
  const base = group(source, ['historical-A', 'historical-B'])
  const local = group(destination, ['historical-B']), remote = group(source, ['historical-C', 'historical-B'])
  assert.deepEqual(merged(base, local, remote).unresolved.map(part => part.id), ['blocks'])
  const chosen = merged(base, local, remote, { blocks: { choice: 'local' } })
  assert.deepEqual(chosen.record.bindings, local.bindings)
})

test('synced binding alignment preserves both unique physical URLs when only moved context separators have ambiguous anchors', () => {
  const source = link + ' q ' + link, destination = link + ' ' + link + ' q'
  const project = createUnchangedMergeRangeProjector(source, destination, budget())
  assert.ok(project, 'Unrelated separator ambiguity does not remove mandatory uniquely mapped URL tokens')
  const from = [source.indexOf(raw), source.lastIndexOf(raw)], to = [destination.indexOf(raw), destination.lastIndexOf(raw)]
  for (let index = 0; index < from.length; index++) {
    assert.deepEqual(project({ from: from[index], to: from[index] + raw.length }), { from: to[index], to: to[index] + raw.length })
  }
  const base = group(source, ['historical-A', 'historical-B'])
  const local = group(destination, ['historical-A', 'historical-B']), remote = group(source, ['historical-C', 'historical-B'])
  const result = merged(base, local, remote), bindings = [...result.record.bindings].sort((a, b) => a.from - b.from)
  assert.deepEqual(result.unresolved, [])
  assert.equal(result.record.blocks[0].content, destination)
  assert.deepEqual(bindings.map(({ blockId, from, to, raw, syntax }) => [blockId, from, to, raw, syntax]),
    to.map(from => [childId, from, from + raw.length, raw, 'markdown']))
  assert.deepEqual(bindings.map(binding => binding.target), [
    { kind: 'document', id: 'historical-C', state: 'live' }, { kind: 'document', id: 'historical-B', state: 'live' }
  ])
})

test('synced binding alignment still maps reversed equal-URL Keys uniquely through independent real prefix and suffix edits', () => {
  const original = 'before [one](Target.md) between [two](Target.md) after'
  const base = group(original, ['historical-one', 'historical-two'])
  const local = group('LOCAL prefix ' + original, ['historical-one', 'historical-two'])
  const remote = group(original + ' REMOTE suffix', ['historical-one', 'historical-two'])
  const result = merged(base, local, remote)
  assert.deepEqual(result.unresolved, [])
  const text = 'LOCAL prefix ' + original + ' REMOTE suffix'
  assert.equal(result.record.blocks[0].content, text)
  const bindings = [...result.record.bindings].sort((a, b) => a.from - b.from)
  assert.deepEqual(bindings.map(({ blockId, from, to, raw, syntax }) => [blockId, from, to, raw, syntax]),
    [text.indexOf(raw), text.lastIndexOf(raw)].map(from => [childId, from, from + raw.length, raw, 'markdown']))
  assert.deepEqual(bindings.map(binding => binding.target), [
    { kind: 'document', id: 'historical-one', state: 'live' }, { kind: 'document', id: 'historical-two', state: 'live' }
  ])
})

test('synced binding alignment preserves identical-text identity and refuses ranges crossed by a new internal token', () => {
  const source = '甲乙丙丁', identity = createUnchangedMergeRangeProjector(source, source, budget())
  assert.ok(identity, 'Identical source bytes retain the original exact range fastpath')
  assert.deepEqual(identity({ from: 1, to: 3 }), { from: 1, to: 3 })
  const changed = createUnchangedMergeRangeProjector(source, '甲乙新丙丁', budget())
  assert.ok(changed, 'The complete nonrepeating token alignment is unique')
  assert.equal(changed({ from: 1, to: 3 }), null, 'An internal insertion breaks the contiguous physical source range')
  assert.deepEqual(changed({ from: 2, to: 4 }), { from: 3, to: 5 })
})
