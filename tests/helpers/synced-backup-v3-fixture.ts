import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { KnowbookStore } from '../../src/main/database/store'
import { AttachmentStore } from '../../src/main/attachments'
import { applySyncedHostCommand, applySyncedHostFinal } from '../../src/main/database/synced-host-final'
import { createDefaultDatabaseViewConfig } from '../../src/shared/database-workspace'
import type { SyncedGroupWire } from '../../src/shared/synced-blocks'
import { protocol5HistoryLink, publicationHash, publicationJson, type SyncedInitialManifest5 } from '../../src/main/sync/synced-publication-model'
import { ordinary } from './synced-content-fixture'
import { command as insertCommand, insertAck } from './synced-host-command-insert-fixture'
import { createRequest, created, born, request, applied, freshBlock, logical, snapshot,
  createRestoreInput, restoreSyncedHostOperation, allTables } from './synced-host-command-create-fixture'

export { applySyncedHostCommand, applySyncedHostFinal, createRequest, created, request, applied, freshBlock,
  logical, snapshot, createRestoreInput, restoreSyncedHostOperation, allTables, randomUUID }
export const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
export const oldChildId = ' old:备份 child\0 '

/** A small canonical witness for offline installation-proof tests. */
export function sourceGroupRetirementEvidence(group: SyncedGroupWire) {
  const workspaceId = randomUUID(), key = 'group:' + group.id
  const digest = (value: unknown) => publicationHash(publicationJson(value))
  const previous = { hash: digest(group), record: group }
  const tombstoneRecord = { kind: 'synced-group-deleted', id: group.id, creationId: group.creationId,
    previousHash: previous.hash, deletedAt: '2048-01-02T03:04:05.006Z' }
  const tombstone = { hash: digest(tombstoneRecord), record: tombstoneRecord }
  const beforeManifest: SyncedInitialManifest5 = { version: 5, workspaceId, entries: { databases: 'd'.repeat(64), [key]: previous.hash },
    syncedInstances: [], history: protocol5HistoryLink('a'.repeat(64), randomUUID(), null) }
  const before = { hash: digest(beforeManifest), manifest: beforeManifest }
  const deletedManifest = { ...beforeManifest, entries: { ...beforeManifest.entries, [key]: tombstone.hash },
    history: protocol5HistoryLink('a'.repeat(64), randomUUID(), before.hash) }
  const deleted = { hash: digest(deletedManifest), manifest: deletedManifest }
  return { kind: 'v3-restore-source-tombstone', version: 1, key, targetFingerprint: 'b'.repeat(64), remoteWorkspaceId: workspaceId,
    workspace: { workspaceScope: randomUUID(), recoveryEpoch: randomUUID() }, seedManifestHash: before.hash,
    acceptedManifestHash: before.hash, closureHash: 'c'.repeat(64), head: { ...deleted, etag: '"test-head"' },
    transition: { before, deleted }, previous, tombstone, executionAuthorized: false }
}

/** Import has no effects. This ordinary Store is opened before the first real Main create. */
export function createV3Fixture(root: string) {
  assert.ok(isAbsolute(root), 'The V3 fixture uses an absolute isolated root supplied by its owner')
  const userDataRoot = join(root, 'profile'), file = join(userDataRoot, 'storage', 'knowbook.db')
  mkdirSync(dirname(file), { recursive: true })
  const store = new KnowbookStore(file), connections: Database.Database[] = []
  try {
    const hostId = store.createDocument(null), targetId = store.createDocument(null)
    const hostBodyId = randomUUID(), targetBodyId = randomUUID()
    store.updateDocument(hostId, { title: 'V3 Host', summary: 'A complete source summary', blocks: [
      { id: hostBodyId, type: 'paragraph', content: 'Ordinary host body', checked: false, depth: 0, parentBlockId: null }
    ] })
    store.updateDocument(targetId, { title: 'V3 Target', summary: 'Independent target summary', blocks: [
      { id: targetBodyId, type: 'heading-1', content: 'Target heading', checked: false, depth: 0, parentBlockId: null }
    ] })
    const catalog = store.getDatabases().find(row => row.kind === 'document-catalog')
    assert.ok(catalog, 'The real source Store has an actual document catalog')
    const catalogColumn = store.createDocumentDatabaseColumn({ databaseId: catalog.id, name: 'Backup catalog value', type: 'text' })
    store.updateDocumentDatabaseValue({ documentId: hostId, columnId: catalogColumn.id, value: 'catalog actual value' })
    const custom = store.createDatabase({ name: 'V3 Custom', description: 'The literal knowbook-asset:// text is opaque' })
    const customColumn = store.createDocumentDatabaseColumn({ databaseId: custom.id, name: 'Custom value', type: 'text' })
    const config = createDefaultDatabaseViewConfig('table', [customColumn.id])
    config.query = 'literal file:///opaque/config and knowbook-asset://not-a-semantic-asset'
    const view = store.createDatabaseSavedView({ databaseId: custom.id, name: 'Actual saved view', config })
    const entity = store.createDatabaseEntity({ databaseId: custom.id, title: 'Standalone actual entity', fieldValues: { [customColumn.id]: 'original custom value' } })
    const db = store.getUnsafeDatabaseHandle()
    // Pre-existing ordinary identity only: no forged group, ACK, or exposure row.
    ordinary(db, oldChildId, { owner: hostId, type: 'paragraph', sort: 1 })
    const raw = '[target](V3%20Target.md#target-heading)'
    db.prepare("UPDATE blocks SET content=?,tags_json='[]' WHERE id=?").run(raw, oldChildId)
    const sourceBirth = (db.prepare('SELECT created_at FROM blocks WHERE id=?').get(oldChildId) as { created_at: string }).created_at
    const input = createRequest(db, { documentId: hostId, selectedRootIds: [oldChildId] })
    const ack = created(applySyncedHostCommand(db, input))
    assert.equal(ack.createdLifecycle.state, 'active', 'The group is produced by the true Main create writer')
    const groupId = input.action.groupId, instanceId = input.action.instanceId
    const assets = new AttachmentStore(join(userDataRoot, 'storage', 'assets'))
    const sourceDocumentIds = (db.prepare('SELECT id FROM documents ORDER BY id').all() as Array<{ id: string }>).map(row => row.id)
    let closed = false
    return { root, userDataRoot, file, store, db, assets, hostId, targetId, hostBodyId, targetBodyId, sourceBirth,
      groupId, instanceId, created: ack, createInput: input, raw, catalogId: catalog.id, catalogColumn,
      customId: custom.id, customColumn, view, entity, sourceDocumentIds, destination: join(root, 'archive'),
      connect() { const connection = new Database(file); connection.pragma('foreign_keys=ON'); connections.push(connection); return connection },
      close() { if (closed) return; closed = true; for (const connection of connections) if (connection.open) connection.close(); store.destroy() } }
  } catch (error) { for (const connection of connections) if (connection.open) connection.close(); store.destroy(); throw error }
}
export type V3Fixture = ReturnType<typeof createV3Fixture>

export function addV3SameGroupReference(fixture: V3Fixture, documentId: string) {
  const input = insertCommand(fixture.db, { documentId, groupId: fixture.groupId })
  insertAck(applySyncedHostCommand(fixture.db, input))
  return input.action.instanceId
}

export function addV3OrdinaryListBranch(fixture: V3Fixture) {
  const { db, hostId } = fixture, root = randomUUID(), inner = randomUUID(), leaf = randomUUID()
  const input = request(db, [hostId], ([after]) => after.blocks.push(
    { id: root, type: 'bulleted-list', content: 'Ordinary list root', checked: false, depth: 0, parentBlockId: null },
    { id: inner, type: 'bulleted-list', content: 'Ordinary list child', checked: false, depth: 1, parentBlockId: root },
    { id: leaf, type: 'bulleted-list', content: 'Ordinary list grandchild', checked: false, depth: 2, parentBlockId: inner }
  ))
  assert.equal(applySyncedHostFinal(db, input).status, 'applied')
  return { root, inner, leaf }
}

export function keepOnlyV3SourceReference(fixture: V3Fixture): void {
  const sender = Object.freeze({})
  const { store, hostId, groupId, instanceId, hostBodyId, db } = fixture
  const opened = store.openSyncedEditingSession(sender, { kind: 'instance', hostDocumentId: hostId, groupId, instanceId })
  assert.equal(opened.status, 'ready')
  const before = request(db, [hostId]), { title, summary, blocks } = before.hostsWorkingBefore[0].workingBefore
  const result = store.invokeSyncedEditingSession(sender, { sessionId: opened.session.sessionId, method: 'applySyncedHostStructure',
    input: { ...before, mode: 'host-final', reason: 'selection-edit', newRefSources: [],
      finalAfter: [{ documentId: hostId, title, summary, blocks: blocks.filter(block => block.id !== hostBodyId) }] } })
  assert.equal(result.status, 'applied', JSON.stringify(result))
  assert.deepEqual(store.getDocumentDetail(hostId)?.blocks.map(block => block.id), [instanceId])
}

export function addV3CrossMoveDependency(fixture: V3Fixture, syntax: 'wiki' | 'markdown' | 'reference' | 'html' = 'wiki',
  options: { title?: string; stationary?: boolean; targetBlockId?: string } = {}) {
  const { store, db } = fixture, documentId = store.createDocument(null), blockId = randomUUID()
  const targetId = options.targetBlockId ?? fixture.instanceId
  const title = options.title ?? 'V6 Wiki dependency'
  const content = (target: string) => syntax === 'wiki'
    ? `Keep [[${target}#${targetId}|original label]].`
    : syntax === 'reference' ? `Keep [original label][ref].\n\n[ref]: <${encodeURIComponent(target)}.md#^${targetId}> "original title"`
    : syntax === 'html' ? `<a title="original title" href="${encodeURIComponent(target)}.md#^${targetId}">original label</a>`
    : `Keep [original label](${encodeURIComponent(target)}.md#^${targetId}).`
  const before = content('V3 Host'), after = content('V3 Target')
  const childId = randomUUID()
  const blocks = [{ id: blockId, type: 'paragraph' as const, content: before, checked: false, depth: 0 }]
  if (options.stationary) blocks.push({ id: childId, type: 'paragraph', content: 'An unrelated shared body', checked: false, depth: 0 })
  store.updateDocument(documentId, { title, summary: '', blocks })
  const create = options.stationary ? createRequest(db, { documentId, selectedRootIds: [childId] }) : undefined
  if (create) assert.equal(applySyncedHostCommand(db, create).status, 'applied')
  const stationary = create ? { instanceId: create.action.instanceId, groupId: create.action.groupId } : undefined
  return { documentId, blockId, title, before, after, stationary }
}

export async function withV3Fixture(run: (fixture: V3Fixture) => void | Promise<void>,
  encoding?: 'UTF-8' | 'UTF-16le' | 'UTF-16be') {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-v3-backup-'))
  let fixture: V3Fixture | undefined
  try {
    if (encoding) {
      const file = join(root, 'profile', 'storage', 'knowbook.db')
      mkdirSync(dirname(file), { recursive: true })
      const initial = new Database(file)
      try {
        initial.pragma("encoding='" + encoding + "'")
        initial.exec('CREATE TABLE v3_encoding_anchor(value TEXT); DROP TABLE v3_encoding_anchor')
      } finally { initial.close() }
    }
    fixture = createV3Fixture(root)
    if (encoding) assert.equal(fixture.db.pragma('encoding', { simple: true }), encoding)
    await run(fixture)
  }
  finally {
    fixture?.close()
    assert.equal(dirname(resolve(root)), resolve(tmpdir()), 'Only the isolated V3 test root is removed')
    assert.ok(basename(root).startsWith('knowbook-v3-backup-'), 'The cleanup target has its dedicated V3 prefix')
    rmSync(root, { recursive: true, force: true })
  }
}

export async function addV3Assets(f: V3Fixture) {
  const bytes = Buffer.from('V3 original alias bytes\0with UTF-8 中文', 'utf8')
  const attachments = await f.assets.import([{ name: 'first +@,.png', bytes }, { name: 'second [alias]~.png', bytes }])
  const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()]
  const input = createRequest(f.db, { documentId: f.hostId, selectedRootIds: ids, dirty(working) {
    working.summary = '![summary](<' + attachments[1].url + '>)'
    working.blocks.push(freshBlock(ids[0], '![asset][backup-image] and note[^backup-note]'),
      freshBlock(ids[1], '[backup-image]: <' + attachments[0].url + '>'),
      freshBlock(ids[2], '[^backup-note]: ![inside note](<' + attachments[1].url + '>)'),
      freshBlock(ids[3], '![direct](<' + attachments[0].url + '>) [target](V3%20Target.md#target-heading)'),
      freshBlock(ids[4], '`file:///opaque/code` and `knowbook-asset://opaque text`'))
  } })
  const ack = created(applySyncedHostCommand(f.db, input))
  return { bytes, hash: sha256(bytes), attachments, ids, ack, groupId: input.action.groupId }
}

/** Real P!=W=A Main save removes the leaf without minting a new journal pin. */
export function makeV3Orphan(f: V3Fixture, instanceId = f.instanceId) {
  const input = request(f.db, [f.hostId], (after, before) => {
    before[0].workingBefore.blocks = before[0].workingBefore.blocks.filter(block => block.id !== instanceId)
    after[0].blocks = structuredClone(before[0].workingBefore.blocks)
  })
  const ack = applied(applySyncedHostFinal(f.db, input))
  assert.equal(ack.status, 'applied', 'The orphan comes from a real save of the already-edited working host')
  assert.equal(ack.historyToken, null, 'The P!=W=A save does not mint a fictitious new host journal')
  assert.equal(f.db.prepare('SELECT 1 FROM synced_instances WHERE instance_id=?').get(instanceId), undefined,
    'The registered instance is removed by the Main writer')
  return ack
}

export function fileInventory(root: string) {
  const rows: Array<{ path: string; bytes: number; hash: string }> = []
  function visit(folder: string) {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      assert.equal(entry.isSymbolicLink(), false, 'The positive archive has no symbolic links')
      if (entry.isDirectory()) visit(path)
      else {
        assert.ok(entry.isFile(), 'Every positive archive leaf is a regular file')
        const bytes = readFileSync(path)
        rows.push({ path: relative(root, path).split('\\').join('/'), bytes: bytes.length, hash: sha256(bytes) })
      }
    }
  }
  visit(root)
  return rows.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}
export const fixtureBorn = born
