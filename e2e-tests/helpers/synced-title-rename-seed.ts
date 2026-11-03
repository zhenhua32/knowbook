import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { KnowbookStore } from '../../src/main/database/store'
import { writeSyncedBackupV3 } from '../../src/main/backup/v3-export'
import { assertCanonicalRuntimeReadableOwned } from '../../src/main/database/canonical-runtime-read'
import { assertRawSyncedHistoricalEvidenceOwned } from '../../src/main/database/synced-operation-history-read'
import { getSyncedGroupSnapshots } from '../../src/main/database/synced-blocks-read'
import { readTitle2OriginalOperationOwned } from '../../src/main/database/synced-host-title2-read'
import { TITLE2_OPERATION_KIND } from '../../src/main/database/synced-host-title2-codec'
import { readSyncedGroupLifecycles } from '../../src/main/database/synced-lifecycle-state'
import type { SyncedGroupSnapshot, SyncedStableBlockDraft, SyncedStructureApplied, SyncedStructureInput } from '../../src/shared/synced-blocks'

// Integrate this file at e2e-tests/helpers/. This preparer is source-backed and
// only runs with the current local build, in Electron-as-Node with its SQLite ABI.
// No BrowserWindow, test-only IPC, live DB replacement, or fake exposure is used.
export type TitleRenameSeed = {
  version: 1; scenario: 'published' | 'canonical-history'; profile: string
  hostId: string; childId: string; observerId: string; groupId: string
  hostTitle: string; childTitle: string; observerTitle: string; missingTitle: string
  hostInstanceId: string; observerInstanceId: string
  targetBlockId: string; documentLinkId: string; blockLinkId: string; unresolvedLinkId: string
  hostOrdinaryLinkId: string; observerOrdinaryLinkId: string; originalOperationIds: string[]
  original: TitleRenameAudit
}
export type TitleRenameAudit = ReturnType<typeof inspectOwned>
type OperationRow = { client_operation_id: string; request_hash: string; result_json: string; created_at: string }

const [profileInput, mode, outputName] = process.argv.slice(2)
if (!profileInput || !isAbsolute(profileInput) || resolve(profileInput) !== profileInput || !existsSync(profileInput)
  || lstatSync(profileInput).isSymbolicLink() || realpathSync(profileInput) !== profileInput) {
  throw new Error('An existing independent canonical profile directory is required')
}
const profile = profileInput, databasePath = join(profile, 'storage', 'knowbook.db')
const seedPath = join(profile, 'synced-title-rename-seed.json')
const bare = (id: string, content: string): SyncedStableBlockDraft => ({ id, type: 'paragraph', content, checked: false, depth: 0, parentBlockId: null })

function inspectOwned(db: Database.Database, seed: Pick<TitleRenameSeed, 'hostId' | 'childId' | 'observerId' | 'groupId' | 'originalOperationIds'>) {
  if (!db.inTransaction) throw new Error('Actual owned observation required')
  assertCanonicalRuntimeReadableOwned(db)
  const facts = assertRawSyncedHistoricalEvidenceOwned(db)
  const groupItem = getSyncedGroupSnapshots(db, { groupIds: [seed.groupId] }).items[0]
  assert.ok(groupItem && groupItem.status === 'ready')
  if (!groupItem || groupItem.status !== 'ready') throw new Error('The actual canonical group is missing')
  const documents = db.prepare(`SELECT id,title,path,parent_id,created_at,updated_at,summary,link_count FROM documents
    WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id`).all(JSON.stringify([seed.hostId, seed.childId, seed.observerId])) as Array<{
      id: string; title: string; path: string; parent_id: string | null; created_at: string; updated_at: string; summary: string; link_count: number
    }>
  const blocks = db.prepare(`SELECT id,document_id,parent_block_id,sort_order,type,content,checked,depth,created_at FROM blocks
    WHERE document_id IN (SELECT value FROM json_each(?)) ORDER BY document_id,sort_order`).all(JSON.stringify([seed.hostId, seed.childId, seed.observerId])) as Array<{
      id: string; document_id: string; parent_block_id: string | null; sort_order: number; type: string; content: string; checked: number; depth: number; created_at: string
    }>
  const identities = db.prepare(`SELECT * FROM block_identities WHERE id IN
    (SELECT id FROM blocks WHERE document_id IN (SELECT value FROM json_each(?)) UNION SELECT id FROM synced_group_blocks WHERE group_id=?) ORDER BY id`)
    .all(JSON.stringify([seed.hostId, seed.childId, seed.observerId]), seed.groupId)
  const originalOperations = seed.originalOperationIds.map(id => {
    const row = db.prepare('SELECT client_operation_id,request_hash,result_json,created_at FROM synced_operations WHERE client_operation_id=?').get(id) as OperationRow | undefined
    assert.ok(row); return row!
  })
  const titles = db.prepare(`SELECT client_operation_id FROM synced_operations WHERE json_extract(result_json,'$.kind')=? ORDER BY client_operation_id`)
    .all(TITLE2_OPERATION_KIND) as Array<{ client_operation_id: string }>
  const titleOperations = titles.map(row => {
    const value = readTitle2OriginalOperationOwned(db, row.client_operation_id)
    assert.ok(value); if (!value) throw new Error('The genuine title operation did not reopen')
    return { row: value.row, envelope: value.envelope, companion: value.companion,
      captures: value.materials.map(item => ({ groupId: item.group.groupId, recordHash: item.sourcePoint.recordHash, targets: item.sourcePoint.capture.targets })) }
  })
  const hostHistory = db.prepare('SELECT document_id,cursor,position FROM synced_host_history_state WHERE document_id=?').get(seed.hostId)
  const hostMappings = db.prepare('SELECT history_id,document_id,position FROM synced_host_history_documents WHERE document_id=? ORDER BY position').all(seed.hostId)
  const links = db.prepare('SELECT source_document_id,target_document_id,label FROM links ORDER BY source_document_id,target_document_id,label').all()
  for (const row of documents) assert.equal(row.link_count,
    (db.prepare('SELECT count(*) AS n FROM links WHERE source_document_id=?').get(row.id) as { n: number }).n)
  return { documents, blocks, identities, originalOperations, group: groupItem.snapshot, hostHistory, hostMappings, links, titleOperations,
    titleFacts: facts.facts.filter(fact => fact.family === 'metadata2-title-operation') }
}

if (mode === 'inspect') {
  if (!outputName || basename(outputName) !== outputName || !/^synced-title-rename-inspect-[a-z0-9-]+\.json$/.test(outputName)) throw new Error('An exclusive fixed inspect filename is required')
  const seed = JSON.parse(readFileSync(seedPath, 'utf8')) as TitleRenameSeed, output = join(profile, outputName)
  if (seed.version !== 1 || seed.profile !== profile || existsSync(output)) throw new Error('Wrong stopped profile or existing inspect output')
  const db = new Database(databasePath, { readonly: true, fileMustExist: true })
  try {
    db.pragma('foreign_keys=ON'); db.pragma('query_only=ON')
    const result = db.transaction(() => inspectOwned(db, seed))()
    db.close()
    writeFileSync(output, JSON.stringify(result) + '\n', { flag: 'wx' })
  } finally { if (db.open) db.close() }
} else if (mode === 'published' || mode === 'canonical-history') {
  if (outputName !== undefined || existsSync(databasePath) || existsSync(seedPath)) throw new Error('Seed refuses an existing database or extra arguments')
  mkdirSync(join(profile, 'storage', 'assets'), { recursive: true })
  const store = new KnowbookStore(databasePath), sender = Object.freeze({ kind: 'stopped-title-rename-seed' })
  let stopped = false
  try {
    const hostId = store.createDocument(null), childId = store.createDocument(hostId), observerId = store.createDocument(null)
    const hostTitle = 'Title original host', childTitle = 'Title child', observerTitle = 'Title observer', missingTitle = 'Title missing original'
    const targetBlockId = randomUUID(), hostOrdinaryLinkId = randomUUID(), observerOrdinaryLinkId = randomUUID()
    const documentLinkId = randomUUID(), blockLinkId = randomUUID(), unresolvedLinkId = randomUUID()
    const groupId = randomUUID(), hostInstanceId = randomUUID(), observerInstanceId = randomUUID(), originalOperationIds: string[] = []
    const hostUrl = encodeURIComponent(hostTitle) + '.md', childUrl = encodeURIComponent(hostTitle) + '/' + encodeURIComponent(childTitle) + '.md'
    store.updateDocument(hostId, { title: hostTitle, summary: 'Original host summary retained', blocks: [bare(hostOrdinaryLinkId, '[Ordinary child](' + childUrl + ')')] })
    store.updateDocument(childId, { title: childTitle, summary: 'Original child summary retained', blocks: [bare(targetBlockId, 'Original ordinary block target 中文🙂')] })
    store.updateDocument(observerId, { title: observerTitle, summary: 'Independent original observer summary', blocks: [
      bare(documentLinkId, '[Original document](' + hostUrl + ')'),
      bare(blockLinkId, '[Original block](' + childUrl + '#^' + targetBlockId + ')'),
      bare(unresolvedLinkId, '[Unavailable original](' + encodeURIComponent(missingTitle) + '.md)'),
      bare(observerOrdinaryLinkId, '[Ordinary original](' + hostUrl + ')')
    ] })
    const open = (documentId: string) => {
      const result = store.openSyncedEditingSession(sender, { kind: 'host', hostDocumentId: documentId })
      assert.equal(result.status, 'ready'); if (result.status !== 'ready') throw new Error('A genuine host session is required')
      return result.session.sessionId
    }
    const working = (documentId: string) => {
      const value = store.getDocumentDetail(documentId)!
      return { documentId, expectedPersistedUpdatedAt: value.updatedAt, workingBefore: { title: value.title, summary: value.summary,
        blocks: value.blocks.map(({ sortOrder: _sortOrder, ...block }) => ({ ...block, parentBlockId: block.parentBlockId ?? null })) } }
    }
    const apply = (sessionId: string, input: SyncedStructureInput): SyncedStructureApplied => {
      const result = store.invokeSyncedEditingSession(sender, { sessionId, method: 'applySyncedHostStructure', input })
      assert.equal(result.status, 'applied'); if (result.status !== 'applied') throw new Error('The actual structure command must commit')
      assert.ok(result.historyToken); originalOperationIds.push(result.operationId); return result
    }
    apply(open(observerId), { clientOperationId: randomUUID(), mode: 'command', hostsWorkingBefore: [working(observerId)], groups: [], expectedInstances: [],
      action: { kind: 'create', documentId: observerId, selectedRootIds: [documentLinkId, blockLinkId, unresolvedLinkId], groupId, instanceId: observerInstanceId } })
    const hostSession = open(hostId), captured = store.invokeSyncedEditingSession(sender, { sessionId: hostSession, method: 'getSyncedGroupSnapshots', input: { groupIds: [groupId] } }).items[0]
    assert.ok(captured && captured.status === 'ready'); if (!captured || captured.status !== 'ready') throw new Error('The created group must be read independently')
    const beforeGroup: SyncedGroupSnapshot = captured.snapshot
    assert.deepEqual(beforeGroup.bindings.find(item => item.blockId === documentLinkId)!.target, { kind: 'document', id: hostId, state: 'live' })
    assert.deepEqual(beforeGroup.bindings.find(item => item.blockId === blockLinkId)!.target, { kind: 'block', id: targetBlockId, documentId: childId, state: 'live' })
    assert.equal(beforeGroup.bindings.find(item => item.blockId === unresolvedLinkId)!.target.kind, 'unresolved-url')
    apply(hostSession, { clientOperationId: randomUUID(), mode: 'command', hostsWorkingBefore: [working(hostId)],
      groups: [{ groupId, expectedRevision: beforeGroup.revision, expectedTopologyRevision: beforeGroup.topologyRevision }], expectedInstances: [],
      action: { kind: 'insert', groupId, instanceId: hostInstanceId, target: { documentId: hostId, parentBlockId: null, beforeBlockId: null, depth: 0 } } })
    writeSyncedBackupV3(store.getUnsafeDatabaseHandle(), { userDataRoot: profile, destination: join(profile, 'seed-genuine-publication'), snapshotId: randomUUID() })
    assert.equal(readSyncedGroupLifecycles(store.getUnsafeDatabaseHandle(), [groupId]).get(groupId)?.exposure, 'confirmed')
    if (mode === 'canonical-history') {
      // The real app publishes a V3 backup on startup. A real user-history
      // refusal remains valid after that publication; a stopped never flag does not.
      const editSession = open(hostId)
      const fresh = store.invokeSyncedEditingSession(sender, { sessionId: editSession, method: 'getSyncedGroupSnapshots', input: { groupIds: [groupId] } }).items[0]
      assert.ok(fresh && fresh.status === 'ready')
      if (!fresh || fresh.status !== 'ready') throw new Error('The actual editable group must be ready')
      const instance = fresh.snapshot.instances.find(item => item.hostDocumentId === hostId)!
      assert.ok(instance)
      const edited = store.invokeSyncedEditingSession(sender, { sessionId: editSession, method: 'updateSyncedBlockGroup', input: {
        clientOperationId: randomUUID(), groupId, expectedRevision: fresh.snapshot.revision, expectedTopologyRevision: fresh.snapshot.topologyRevision,
        expectedInstanceBinding: { instanceId: instance.instanceId, hostDocumentId: hostId, bindingVersion: instance.bindingVersion },
        blocks: fresh.snapshot.blocks.map(({ createdAt: _createdAt, ...block }) => block.id === documentLinkId
          ? { ...block, content: block.content + ' retained canonical edit' } : block)
      } })
      assert.equal(edited.status, 'saved')
      if (edited.status !== 'saved') throw new Error('The real canonical edit must save')
      assert.notEqual(edited.snapshot.history.undoToken, null)
      originalOperationIds.push(edited.operationId)
    }
    const partial: Omit<TitleRenameSeed, 'original'> = { version: 1 as const, scenario: mode, profile, hostId, childId, observerId, groupId,
      hostTitle, childTitle, observerTitle, missingTitle, hostInstanceId, observerInstanceId, targetBlockId, documentLinkId, blockLinkId, unresolvedLinkId,
      hostOrdinaryLinkId, observerOrdinaryLinkId, originalOperationIds }
    const original = store.runInTransaction(() => inspectOwned(store.getUnsafeDatabaseHandle(), partial))
    assert.equal(original.titleOperations.length, 0)
    const result: TitleRenameSeed = { ...partial, original }
    store.releaseAllSyncedEditingSessions(); store.destroy(); stopped = true
    assert.equal(dirname(seedPath), profile)
    writeFileSync(seedPath, JSON.stringify(result) + '\n', { flag: 'wx' })
  } catch (error) {
    if (!stopped) { try { store.destroy() } catch { /* Preserve the original preparation failure. */ } }
    throw error
  }
} else throw new Error('published|canonical-history|inspect is required')
