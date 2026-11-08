import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { KnowbookStore } from '../../src/main/database/store'
import type { SyncedGroupSnapshot, SyncedStableBlockDraft, SyncedStructureAction, SyncedStructureInput } from '../../src/shared/synced-blocks'

export type CanonicalHostBody = {
  id: string; title: string; summary: string
  blocks: Array<{ id: string; type: string; content: string; checked: boolean; depth: number; parentBlockId: string | null }>
}
export type CanonicalInlineSeed = {
  version: 1; groupId: string; primaryId: string; secondaryId: string; query: string; primaryText: string; secondaryText: string
  hosts: [CanonicalHostBody, CanonicalHostBody]; instanceIds: [string, string, string]
}

// A stopped, new profile only. This process is Electron-as-Node so SQLite uses
// the same native ABI as the real app. No BrowserWindow or test IPC is created.
const profile = process.argv[2]
const bodyBlocks = Number(process.argv[3] ?? 2)
if (!Number.isSafeInteger(bodyBlocks) || bodyBlocks < 2 || bodyBlocks > 4000) throw new Error('Invalid canonical fixture size')
if (!profile || !isAbsolute(profile) || resolve(profile) !== profile || !existsSync(profile)
  || lstatSync(profile).isSymbolicLink()) {
  throw new Error('An existing, absolute, independent profile directory is required')
}
const databasePath = join(profile, 'storage', 'knowbook.db')
if (existsSync(databasePath)) throw new Error('Seed refuses an existing database; the app must not be running')
const output = join(profile, 'canonical-inline-seed.json')
if (existsSync(output)) throw new Error('Seed output already exists')
const store = new KnowbookStore(databasePath), sender = Object.freeze({ kind: 'prelaunch-canonical-fixture' })
let stopped = false
try {
  const groupId = randomUUID(), instanceIds: [string, string, string] = [randomUUID(), randomUUID(), randomUUID()]
  // Existing child identity is intentionally opaque, including NUL. It must
  // survive the real create command and cannot be interpolated into CSS.
  const primaryId = ' original canonical child\0 ' + randomUUID(), secondaryId = randomUUID()
  const query = 'CanonicalOrbit' + randomUUID().replaceAll('-', '').slice(0, 10)
  const primaryText = query + ' 正文🙂', secondaryText = 'Independent canonical tail'
  const hostIds = [store.createDocument(null), store.createDocument(null)] as const
  const titles = ['Inline origin host', 'Inline second host'] as const
  for (let index = 0; index < hostIds.length; index++) store.updateDocument(hostIds[index], {
    title: titles[index], summary: 'Isolated canonical Electron fixture', blocks: [{
      id: randomUUID(), type: 'paragraph', content: 'Ordinary host anchor ' + index, checked: false, depth: 0, parentBlockId: null
    }]
  })
  const open = (hostDocumentId: string) => {
    const result = store.openSyncedEditingSession(sender, { kind: 'host', hostDocumentId })
    assert.equal(result.status, 'ready')
    if (result.status !== 'ready') throw new Error('The genuine host session could not be opened')
    return result.session.sessionId
  }
  const logical = (documentId: string) => {
    const actual = store.getDocumentDetail(documentId)
    assert.ok(actual)
    const blocks: SyncedStableBlockDraft[] = actual.blocks.map(({ sortOrder: _sortOrder, ...block }) => ({ ...block, parentBlockId: block.parentBlockId ?? null }))
    return { documentId, expectedPersistedUpdatedAt: actual.updatedAt, workingBefore: { title: actual.title, summary: actual.summary, blocks } }
  }
  const read = (sessionId: string): SyncedGroupSnapshot => {
    const result = store.invokeSyncedEditingSession(sender, { sessionId, method: 'getSyncedGroupSnapshots', input: { groupIds: [groupId] } })
    const item = result.items[0]
    assert.ok(item && item.status === 'ready')
    if (!item || item.status !== 'ready') throw new Error('The actual group snapshot is missing')
    return item.snapshot
  }
  const apply = (sessionId: string, input: SyncedStructureInput) => {
    const result = store.invokeSyncedEditingSession(sender, { sessionId, method: 'applySyncedHostStructure', input })
    assert.equal(result.status, 'applied', JSON.stringify(result))
    if (result.status !== 'applied') throw new Error('A seed command did not commit')
    assert.ok(result.historyToken, 'The command produced its real Main history ACK')
    return result
  }
  const first = logical(hostIds[0])
  const canonical: SyncedStableBlockDraft[] = [
    { id: primaryId, type: 'paragraph', content: primaryText, checked: false, depth: 0, parentBlockId: null, tags: [] },
    ...Array.from({ length: bodyBlocks - 2 }, (_, index) => ({ id: randomUUID(), type: 'paragraph',
      content: `Canonical body ${index} · 源码编辑 ${'Markdown '.repeat(5)}Markdown`, checked: false, depth: 0, parentBlockId: null, tags: [] })),
    { id: secondaryId, type: 'paragraph', content: secondaryText, checked: false, depth: 0, parentBlockId: null, tags: [] }
  ]
  first.workingBefore.blocks.push(...canonical)
  apply(open(hostIds[0]), { clientOperationId: randomUUID(), mode: 'command', hostsWorkingBefore: [first], groups: [], expectedInstances: [],
    action: { kind: 'create', documentId: hostIds[0], selectedRootIds: canonical.map(block => block.id), groupId, instanceId: instanceIds[0] } })
  for (const [documentId, instanceId] of [[hostIds[0], instanceIds[1]], [hostIds[1], instanceIds[2]]] as const) {
    // Reopen captures actual post-command bindings. An ACK is never used to
    // manufacture a mount proof for the next command.
    const sessionId = open(documentId), snapshot = read(sessionId)
    const action: SyncedStructureAction = { kind: 'insert', groupId, instanceId,
      target: { documentId, parentBlockId: null, beforeBlockId: null, depth: 0 } }
    apply(sessionId, { clientOperationId: randomUUID(), mode: 'command', action, hostsWorkingBefore: [logical(documentId)],
      groups: [{ groupId, expectedRevision: snapshot.revision, expectedTopologyRevision: snapshot.topologyRevision }],
      expectedInstances: snapshot.instances.filter(item => item.hostDocumentId === documentId).map(({ instanceId, hostDocumentId, bindingVersion }) => ({ instanceId, hostDocumentId, bindingVersion })) })
  }
  const actual = read(open(hostIds[0]))
  assert.deepEqual(actual.blocks.map(block => [block.id, block.content]), canonical.map(block => [block.id, block.content]))
  assert.deepEqual(actual.instances.map(item => item.instanceId).sort(), [...instanceIds].sort())
  const bodies = hostIds.map(id => {
    const host = store.getDocumentDetail(id)!
    return { id: host.id, title: host.title, summary: host.summary, blocks: host.blocks.map(block => ({ id: block.id, type: block.type,
      content: block.content, checked: block.checked, depth: block.depth, parentBlockId: block.parentBlockId ?? null })) }
  }) as [CanonicalHostBody, CanonicalHostBody]
  assert.deepEqual(bodies.map(host => host.blocks.filter(block => block.type === 'synced-block').length), [2, 1])
  assert.equal(bodies.some(host => host.blocks.some(block => block.id === primaryId || block.id === secondaryId || block.content.includes(query))), false)
  const result: CanonicalInlineSeed = { version: 1, groupId, primaryId, secondaryId, query, primaryText, secondaryText, hosts: bodies, instanceIds }
  // Stop and release the real Store before publishing the launch metadata.
  store.destroy()
  stopped = true
  writeFileSync(output, JSON.stringify(result) + '\n', { flag: 'wx' })
} catch (error) {
  if (!stopped) {
    try { store.destroy() } catch { /* Preserve the original preparation failure. */ }
  }
  throw error
}
