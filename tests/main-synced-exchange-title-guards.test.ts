import assert from 'node:assert/strict'
import test from 'node:test'
import type { SyncedPortableHostRecord } from '../src/shared/syncedBlockPortable'
import type { SyncDatabases } from '../src/main/sync/model'
import type { ExchangeState } from '../src/main/sync/synced-exchange-model'
import { publicationHash, publicationJson } from '../src/main/sync/synced-publication-model'
import { validateSyncedProtocol5Snapshot, type SyncedProtocol5Record } from '../src/main/sync/synced-protocol5-model'
import { mergeSyncedProtocol5Record } from '../src/main/sync/synced-merge'
import { planSyncedExchange, type ExchangePlanInput } from '../src/main/sync/synced-exchange-plan'
import { KnowbookStore } from '../src/main/database/store'
import { withIncomingFixture, accepted, receiveInitialSyncedSnapshot, type Profile } from './helpers/synced-initial-incoming-fixture'
import { ready, component, mergeDecision, previewSyncedExchangeConflicts, resolveSyncedExchangeConflicts,
  exchangeSyncedSnapshot, completed, createRequest, created, applySyncedHostCommand, localPortable, remoteActual,
  executionRows, stateRow, readonlyRequests, rejected, randomUUID, runtime } from './helpers/synced-exchange-conflict-fixture'

const born = '2020-01-01T00:00:00.000Z'
const uuid = (n: number) => '00000000-0000-0000-0000-' + String(n).padStart(12, '0')
const hash = (value: unknown) => publicationHash(publicationJson(value))
const spacedTitle = '  chosen title  '
function document(): SyncedPortableHostRecord {
  return { kind: 'document', id: ' title:ordinary ', createdAt: born, parentId: null, sortOrder: 0,
    content: { title: 'Base title', summary: '', blocks: [{ id: ' title:body ', type: 'paragraph', content: 'unchanged body', checked: false, depth: 0, parentBlockId: null }] } }
}
const catalog: SyncDatabases = { kind: 'databases', id: 'databases', tables: {
  databases: [{ id: 'catalog', name: 'Default', description: 'Default database', created_at: born }],
  document_database_columns: [], database_saved_views: [], database_entities: [], database_entity_values: [], document_database_values: [] } }
function wire(records: SyncedProtocol5Record[], workspaceId: string) {
  const values = records.map(record => ({ key: record.kind === 'databases' ? 'databases' : 'doc:' + record.id, record }))
  return validateSyncedProtocol5Snapshot({ version: 5, workspaceId, entries: Object.fromEntries(values.map(row => [row.key, hash(row.record)])), syncedInstances: [] }, values)
}

test('pure title conflict keeps noncanonical custom whitespace unresolved instead of trimming or accepting it', () => {
  const base = document(), local = structuredClone(base), remote = structuredClone(base)
  local.content.title = 'Local title'; remote.content.title = 'Remote title'
  const originals = structuredClone([base, local, remote]), preview = mergeSyncedProtocol5Record(base, local, remote)
  assert.ok(preview?.unresolved.some(part => part.id === 'title' && part.canEditText), 'Both independently changed titles produce a genuine editable title conflict')
  const result = mergeSyncedProtocol5Record(base, local, remote, { title: { choice: 'custom', text: spacedTitle } })
  assert.ok(result?.record.kind === 'document', 'The pure result retains the exact original host record domain')
  assert.ok(result.unresolved.some(part => part.id === 'title'), 'Noncanonical title whitespace stays unresolved before any execution candidate can be minted')
  assert.equal(result.record.content.title, local.content.title, 'Rejected custom title text leaves the original fallback side, without silent trimming')
  assert.notEqual(result.record.content.title, spacedTitle.trim())
  assert.deepEqual([base, local, remote], originals)
})

test('pure exchange plan does not offer a legal-wire noncanonical remote title as an executable whole-component side', () => {
  const original = document(), base = wire([original, catalog], uuid(2)), local = wire([original, catalog], uuid(1)), changed = structuredClone(original)
  changed.content.title = '  Remote title  '
  const remote = wire([changed, catalog], uuid(2)), key = 'doc:' + original.id
  assert.equal(remote.records.find(row => row.key === key)?.hash, hash(changed), 'The strict portable wire accepts this exact untrimmed input; the execution candidate guard must reject its path semantics')
  const state: ExchangeState = { kind: 'synced-exchange-state', version: 1, databasePath: '/isolated/storage/knowbook.db', targetFingerprint: hash('title-target'),
    workspaceScope: uuid(1), recoveryEpoch: uuid(3), remoteWorkspaceId: uuid(2), generation: uuid(4), currentOperationId: null,
    source: { kind: 'current-equality', operationId: null, manifestHash: hash(base.manifest), portableDigest: hash(base.manifest.entries) },
    baseline: base.records.map(row => ({ key: row.key, localHash: row.hash, remoteHash: row.hash, commonHash: row.hash,
      dependencyKeys: [], dependencySignature: hash([]), acceptedOperationId: uuid(5) })), deferred: [], lastSyncAt: born }
  const input: ExchangePlanInput = { operationId: uuid(6), local, remote, baseRecords: base.records, state, localFingerprint: hash('title-local-guard'),
    authority: { catalogId: 'catalog', identities: original.content.blocks.map(block => ({ id: block.id, last_owner_kind: 'document' as const,
      last_owner_id: original.id, state: 'live' as const, created_at: born })), occupiedDocumentIds: [original.id], historyComponents: [], pinnedGroupIds: [], knownGroupIds: [] } }
  const plan = planSyncedExchange(input), blocked = plan.conflictPreviews?.find(row => row.keys.includes(key))
  assert.ok(plan.deferred.some(row => row.keys.includes(key)), 'The entire noncanonical-title component is deferred before publication or SQL')
  assert.ok(blocked, 'The real blocked component is displayed without fabricating an executable remote side')
  assert.deepEqual(blocked.choices, [])
  assert.equal(plan.incoming.includes(key), false)
  assert.equal(plan.writes.includes(key), false)
  assert.equal(plan.accepted.includes(key), false)
  const kept = plan.localFinal.records.find(row => row.key === key)
  assert.ok(kept?.record.kind === 'document', 'The actual retained local host remains present')
  assert.equal(kept.record.content.title, original.content.title)
})

test('actual ordinary-host title resolution rejects noncanonical custom whitespace before any execution or remote content publication', () => withIncomingFixture(async f => {
  const A = f.newPristine('title-remote'), B = f.newPristine('title-local')
  // Match the existing approved cycle fixture: Store is opened while each DB is group-free.
  // This internal Main composition does not remove the production any-group admission gate.
  const remoteStore = new KnowbookStore(A.file), localStore = new KnowbookStore(B.file)
  try {
    const alpha = remoteStore.createDocument(null), groupHost = remoteStore.createDocument(null), ordinaryId = randomUUID(), canonicalId = randomUUID()
    remoteStore.updateDocument(alpha, { title: 'Base title', summary: '', blocks: [{ id: ordinaryId, type: 'paragraph', content: 'keep original ordinary body', checked: false, depth: 0, parentBlockId: null }] })
    remoteStore.updateDocument(groupHost, { title: 'Independent group host', summary: '', blocks: [{ id: canonicalId, type: 'paragraph', content: 'unrelated canonical body', checked: false, depth: 0, parentBlockId: null }] })
    created(applySyncedHostCommand(A.db, createRequest(A.db, { documentId: groupHost, selectedRootIds: [canonicalId] })))
    await f.send(A)
    accepted(await f.track(receiveInitialSyncedSnapshot(B.db, f.input(randomUUID(), B), runtime)))
    const exchange = (profile: Profile) => f.track(exchangeSyncedSnapshot(profile.db, f.input(randomUUID(), profile), runtime))
    completed(await exchange(A), 'noop'); completed(await exchange(B), 'noop')
    assert.deepEqual(localPortable(A).entries, localPortable(B).entries, 'The two genuine independent peers first settle the same authenticated common graph')
    const remoteBeforeEdit = remoteStore.getDocumentDetail(alpha), localBeforeEdit = localStore.getDocumentDetail(alpha)
    assert.ok(remoteBeforeEdit && localBeforeEdit, 'Both pre-opened real Main stores read the actual ordinary title host')
    remoteStore.updateDocument(alpha, { title: 'Remote title', summary: remoteBeforeEdit.summary, blocks: remoteBeforeEdit.blocks })
    completed(await exchange(A), 'applied')
    localStore.updateDocument(alpha, { title: 'Local title', summary: localBeforeEdit.summary, blocks: localBeforeEdit.blocks })
    const previewId = randomUUID(), preview = ready(await f.track(previewSyncedExchangeConflicts(B.db, { previewId, userDataRoot: B.root, target: f.targetConfig }, runtime)))
    const selected = component(preview, 'doc:' + alpha), decision = mergeDecision(selected, part => {
      assert.equal(part.id, 'title'); assert.equal(part.field, 'title'); assert.equal(part.canEditText, true)
      return { choice: 'custom', text: spacedTitle }
    })
    const beforeExecution = executionRows(B), beforeBaseline = stateRow(B.db).value, beforeLocal = localPortable(B).entries,
      beforeRemote = remoteActual(f).bytes, start = f.server.requests.length, operationId = randomUUID()
    await rejected(() => f.track(resolveSyncedExchangeConflicts(B.db, { ...f.input(operationId, B), previewId, decisions: [decision] }, runtime)), 'invalid')
    readonlyRequests(f.server.requests.slice(start))
    assert.deepEqual(remoteActual(f).bytes, beforeRemote, 'Invalid custom title never reaches object or content manifest publication')
    assert.deepEqual(executionRows(B), beforeExecution, 'No new execution job or receipt is minted for an unresolved custom title')
    assert.equal(stateRow(B.db).value, beforeBaseline, 'The exact original per-key baseline is not advanced')
    assert.deepEqual(localPortable(B).entries, beforeLocal)
    const kept = localStore.getDocumentDetail(alpha)
    assert.ok(kept, 'The original local host and its draft-side title remain available after refusal')
    assert.equal(kept.title, 'Local title'); assert.equal(kept.blocks[0].content, 'keep original ordinary body')
  } finally { localStore.destroy(); remoteStore.destroy() }
}))
