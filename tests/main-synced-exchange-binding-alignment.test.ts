import assert from 'node:assert/strict'
import test from 'node:test'
import type { SyncedBindingClaim, SyncedBindingKey, SyncedGroupSnapshot } from '../src/shared/synced-blocks'
import { captureSyncedGroupBindings } from '../src/main/database/synced-block-links'
import { updateSyncedBlockGroup } from '../src/main/database/synced-blocks-content'
import { withConflicts, completed, snapshot, ready, component, mergeDecision, localPortable, remoteActual,
  stateRow, randomUUID, converged } from './helpers/synced-exchange-conflict-fixture'
import type { Profile } from './helpers/synced-initial-incoming-fixture'

const raw = 'Target.md', link = '[x](' + raw + ')'
const key = ({ blockId, from, to, raw, syntax }: SyncedBindingKey): SyncedBindingKey => ({ blockId, from, to, raw, syntax })
type Blocks = SyncedGroupSnapshot['blocks']
function commit(profile: Profile, groupId: string,
  plan: (before: SyncedGroupSnapshot) => { blocks: Blocks; claims: SyncedBindingClaim[] }) {
  const before = snapshot(profile.db, groupId), value = plan(before), instance = before.instances[0]
  assert.ok(instance, 'Every binding edit uses the original real authorizing instance and current CAS')
  const result = updateSyncedBlockGroup(profile.db, { clientOperationId: randomUUID(), groupId,
    expectedRevision: before.revision, expectedTopologyRevision: before.topologyRevision,
    expectedInstanceBinding: { instanceId: instance.instanceId, hostDocumentId: instance.hostDocumentId, bindingVersion: instance.bindingVersion },
    blocks: value.blocks.map(({ createdAt: _readOnlyBirth, ...block }) => block), bindingClaims: [...value.claims].reverse() })
  assert.equal(result.status, 'saved')
  if (result.status !== 'saved') throw new Error('Expected a genuine Main binding edit')
  return result.snapshot
}
function destinations(profile: Profile, before: SyncedGroupSnapshot, blocks: Blocks, blockId: string) {
  return captureSyncedGroupBindings(profile.db, before.origin, blocks).filter(value => value.blockId === blockId && value.raw === raw)
    .sort((a, b) => a.from - b.from)
}

test('real duplicated complete link and a remote target-only edit require an exact whole-forest choice without guessing the original occurrence', () => withConflicts(async f => {
  const id = f.ack.createdLifecycle.groupId, groupKey = 'group:' + id
  const initial = snapshot(f.A.db, id), old = initial.bindings.filter(binding => binding.raw === raw).sort((a, b) => a.from - b.from)
  assert.equal(old.length, 2)
  assert.deepEqual(old.map(binding => binding.target), [
    { kind: 'document', id: f.target, state: 'live' }, { kind: 'document', id: f.other, state: 'live' }
  ], 'The existing real historical-source fixture starts with two equal URLs and different captured stable targets')
  const mainId = initial.blocks[0].id, sourceId = randomUUID()
  const seeded = commit(f.A, id, before => {
    const sources = before.bindings.filter(binding => binding.raw === raw).sort((a, b) => a.from - b.from)
    const blocks: Blocks = [{ ...structuredClone(before.blocks[0]), content: link },
      { id: sourceId, type: 'paragraph', content: '[retained source](' + raw + ')', checked: false, depth: 0,
        parentBlockId: null, createdAt: before.blocks[0].createdAt }]
    const first = destinations(f.A, before, blocks, mainId), second = destinations(f.A, before, blocks, sourceId)
    assert.equal(first.length, 1); assert.equal(second.length, 1)
    // The temporary read projection has a shape birth only. commit strips all
    // createdAt values; actual Main assigns the fresh source child's real birth.
    return { blocks, claims: [{ kind: 'continue', source: key(sources[0]), destination: key(first[0]) },
      { kind: 'copy', source: { kind: 'current', key: key(sources[1]) }, destination: key(second[0]) }] }
  })
  assert.equal(seeded.blocks.length, 2)
  completed(await f.exchange(f.A), 'applied'); completed(await f.exchange(f.B), 'applied')
  const commonA = localPortable(f.A), commonB = localPortable(f.B), common = stateRow(f.B.db).state.baseline.find(row => row.key === groupKey)
  assert.equal(commonA.entries[groupKey], commonB.entries[groupKey])
  assert.equal(common?.commonHash, commonA.entries[groupKey], 'B has an authenticated real common object before both edits')
  const beforeBoth = snapshot(f.B.db, id), births = beforeBoth.blocks.map(block => [block.id, block.createdAt])
  const local = commit(f.B, id, before => {
    const blocks = structuredClone(before.blocks), source = before.bindings.find(binding => binding.blockId === mainId)
    const kept = before.bindings.find(binding => binding.blockId === sourceId)
    assert.ok(source && kept, 'L has the actual original main occurrence and the independent retained historical source')
    blocks.find(block => block.id === mainId)!.content = link + ' ' + link
    const main = destinations(f.B, before, blocks, mainId), second = destinations(f.B, before, blocks, sourceId)
    assert.equal(main.length, 2); assert.equal(second.length, 1)
    return { blocks, claims: [
      { kind: 'copy', source: { kind: 'current', key: key(source) }, destination: key(main[0]) },
      { kind: 'continue', source: key(source), destination: key(main[1]) },
      { kind: 'continue', source: key(kept), destination: key(second[0]) }
    ] }
  })
  const remote = commit(f.A, id, before => {
    const blocks = structuredClone(before.blocks), source = before.bindings.find(binding => binding.blockId === sourceId)
    assert.ok(source, 'R copies an actual current historical C source rather than resolving the same URL again')
    const main = destinations(f.A, before, blocks, mainId), second = destinations(f.A, before, blocks, sourceId)
    assert.equal(main.length, 1); assert.equal(second.length, 1)
    return { blocks, claims: [
      { kind: 'copy', source: { kind: 'current', key: key(source) }, destination: key(main[0]) },
      { kind: 'continue', source: key(source), destination: key(second[0]) }
    ] }
  })
  assert.deepEqual(remote.blocks, seeded.blocks, 'R changes only the actual captured target, keeping all canonical source text and births')
  const localMain = local.bindings.filter(binding => binding.blockId === mainId).sort((a, b) => a.from - b.from)
  assert.deepEqual(localMain.map(binding => binding.target), [
    { kind: 'document', id: f.target, state: 'live' }, { kind: 'document', id: f.target, state: 'live' }
  ])
  assert.deepEqual(remote.bindings.find(binding => binding.blockId === mainId)?.target, { kind: 'document', id: f.other, state: 'live' })
  completed(await f.exchange(f.A), 'applied')
  const remoteBefore = remoteActual(f), baselineBefore = stateRow(f.B.db).state.baseline.find(row => row.key === groupKey)
  const automatic = completed(await f.exchange(f.B))
  assert.ok(automatic.deferred.some(row => row.keys.includes(groupKey)), 'The real auto-merge withdraws the ambiguous complete group component')
  assert.equal(automatic.acceptedKeys.includes(groupKey), false)
  assert.equal(automatic.publishedKeys.includes(groupKey), false)
  assert.equal(automatic.appliedKeys.includes(groupKey), false)
  assert.deepEqual(snapshot(f.B.db, id), local, 'No guessed occurrence can change the actual local content/bindings/CAS')
  assert.deepEqual(stateRow(f.B.db).state.baseline.find(row => row.key === groupKey), baselineBefore)
  assert.deepEqual(remoteActual(f).bytes, remoteBefore.bytes, 'The original remote target-only change remains the published graph')
  const preview = ready(await f.preview()), selected = component(preview, groupKey), record = selected.records.find(row => row.key === groupKey)
  assert.ok(record?.merge, 'The actual service exposes a pure merge preview for the authenticated common object')
  assert.deepEqual(record.merge.unresolved.map(part => part.id), ['blocks'])
  assert.equal(record.merge.unresolved[0].canEditText, false)
  const result = completed(await f.resolve(preview, [mergeDecision(selected, part => {
    assert.equal(part.id, 'blocks'); return { choice: 'local' }
  })]))
  assert.ok(result.acceptedKeys.includes(groupKey), 'The actual explicit forest selector is the authority to resolve this conflict')
  const resolved = snapshot(f.B.db, id)
  assert.deepEqual(resolved.blocks, local.blocks); assert.deepEqual(resolved.bindings, local.bindings)
  assert.deepEqual(resolved.blocks.map(block => [block.id, block.createdAt]), births)
  completed(await f.exchange(f.A), 'applied'); converged(f)
}, { sameUrl: true }))
