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
import { ordinary } from './synced-content-fixture'
import { createRequest, created, born, request, applied, freshBlock, logical, snapshot,
  createRestoreInput, restoreSyncedHostOperation, allTables } from './synced-host-command-create-fixture'

export { applySyncedHostCommand, applySyncedHostFinal, createRequest, created, request, applied, freshBlock,
  logical, snapshot, createRestoreInput, restoreSyncedHostOperation, allTables, randomUUID }
export const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
export const oldChildId = ' old:备份 child\0 '

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

export async function withV3Fixture(run: (fixture: V3Fixture) => void | Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-v3-backup-'))
  let fixture: V3Fixture | undefined
  try { fixture = createV3Fixture(root); await run(fixture) }
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
