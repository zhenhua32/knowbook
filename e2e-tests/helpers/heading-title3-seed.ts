// Creates and independently reopens actual Main heading-title originals.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import Database from 'better-sqlite3'
import { KnowbookStore } from '../../src/main/database/store'
import { assertCanonicalRuntimeReadableOwned } from '../../src/main/database/canonical-runtime-read'
import { assertRawSyncedHistoricalEvidenceOwned } from '../../src/main/database/synced-operation-history-read'
import { getSyncedGroupSnapshots } from '../../src/main/database/synced-blocks-read'
import { validateHostCreateOperationAck } from '../../src/main/database/synced-host-operation-receipt'
import { writeSyncedBackupV3 } from '../../src/main/backup/v3-export'
import { createRequest, freshBlock } from '../../tests/helpers/synced-backup-v3-fixture'

export interface HeadingTitle3Seed {
  version: 1; profile: string; hostId: string; targetId: string; hostTitle: string; targetTitle: string
  headingId: string; selfId: string; groups: Array<{ groupId: string; instanceId: string; heading: boolean }>
  original: ReturnType<typeof inspect>
}
const [profile, mode, output] = process.argv.slice(2)
if (!profile || !isAbsolute(profile) || realpathSync(profile) !== profile) throw Error('Independent canonical profile required')
const file = join(profile, 'storage', 'knowbook.db'), seedFile = join(profile, 'heading-title3-seed.json')
function inspect(db: Database.Database, seed: Pick<HeadingTitle3Seed, 'hostId' | 'targetId' | 'selfId' | 'groups'>) {
  if (!db.inTransaction) throw Error('Owned stopped SQL required')
  assertCanonicalRuntimeReadableOwned(db)
  assertRawSyncedHistoricalEvidenceOwned(db)
  const ordinarySelfLink = db.prepare(`SELECT s.url,s.target_path,d.id AS target_id FROM markdown_link_sources s
    LEFT JOIN documents d ON d.path=s.target_path WHERE s.source_document_id=? AND s.source_block_id=?`)
    .all(seed.targetId, seed.selfId) as Array<{ url: string; target_path: string | null; target_id: string | null }>
  assert.equal(ordinarySelfLink.length, 1)
  assert.equal(ordinarySelfLink[0].target_id, seed.targetId, 'The actual indexed self link must resolve to the original target')
  const groups = getSyncedGroupSnapshots(db, { groupIds: seed.groups.map(group => group.groupId) }).items.map(item => {
    assert.equal(item.status, 'ready'); if (item.status !== 'ready') throw Error('Actual group absent'); return item.snapshot
  })
  return {
    documents: db.prepare('SELECT id,title,path,created_at,updated_at,parent_id,summary FROM documents WHERE id IN (?,?) ORDER BY id')
      .all(seed.hostId, seed.targetId) as Array<{ id: string; title: string; path: string; created_at: string; updated_at: string; parent_id: string | null; summary: string }>,
    blocks: db.prepare('SELECT id,document_id,parent_block_id,type,content,created_at FROM blocks WHERE document_id IN (?,?) ORDER BY document_id,sort_order')
      .all(seed.hostId, seed.targetId) as Array<{ id: string; document_id: string; parent_block_id: string | null; type: string; content: string; created_at: string }>,
    identities: db.prepare('SELECT * FROM block_identities ORDER BY id').all() as Array<Record<string, unknown> & { id: string }>, groups, ordinarySelfLink,
    operations: db.prepare('SELECT client_operation_id,request_hash,result_json,created_at FROM synced_operations ORDER BY client_operation_id').all() as
      Array<{ client_operation_id: string; request_hash: string; result_json: string; created_at: string }>
  }
}
if (mode === 'inspect') {
  if (!output || basename(output) !== output || !/^heading-title3-inspect-[a-z0-9-]+\.json$/.test(output)) throw Error('Exclusive inspect filename required')
  const seed = JSON.parse(readFileSync(seedFile, 'utf8')) as HeadingTitle3Seed
  assert.equal(seed.profile, profile)
  const db = new Database(file, { readonly: true, fileMustExist: true })
  try {
    db.pragma('foreign_keys=ON'); db.pragma('query_only=ON')
    writeFileSync(join(profile, output), JSON.stringify(db.transaction(() => inspect(db, seed))()) + '\n', { flag: 'wx' })
  } finally { db.close() }
} else if (mode === 'create') {
  if (output || existsSync(file) || existsSync(seedFile)) throw Error('Seed requires a fresh profile')
  const store = new KnowbookStore(file)
  try {
    const db = store.getUnsafeDatabaseHandle(), hostId = store.createDocument(null), targetId = store.createDocument(hostId)
    const hostTitle = 'Heading lineage host', targetTitle = 'Heading lineage target', headingId = randomUUID(), selfId = randomUUID()
    store.updateDocument(hostId, { title: hostTitle, summary: 'Original host', blocks: [freshBlock(randomUUID(), 'Original host body')] })
    const url = encodeURIComponent(hostTitle) + '/' + encodeURIComponent(targetTitle) + '.md'
    store.updateDocument(targetId, { title: targetTitle, summary: 'Original target summary', blocks: [
      { ...freshBlock(headingId, 'Native exact heading'), type: 'heading-1' }, freshBlock(selfId, '[ordinary self](' + encodeURIComponent(targetTitle) + '.md)')
    ] })
    const groups: HeadingTitle3Seed['groups'] = [], sender = Object.freeze({ kind: 'real heading-title3 seed session' })
    // Two independent genuine heading births exercise shared predecessor DAGs;
    // the third group is an old-domain document/block-only mixed participant.
    // Each group intentionally starts with one actual instance. Existing
    // two-instance regressions remain separate; insert continuity is not faked.
    for (const heading of [true, true, false]) {
      const linkId = randomUUID(), session = store.openSyncedEditingSession(sender, { kind: 'host', hostDocumentId: hostId })
      assert.equal(session.status, 'ready'); if (session.status !== 'ready') throw Error('Actual session required')
      const input = createRequest(db, { documentId: hostId, selectedRootIds: [linkId], dirty(working) {
        working.blocks.push(freshBlock(linkId, heading ? '[heading](' + url + '#native-exact-heading)' : '[doc](' + url + ') [block](' + url + '#^' + headingId + ')'))
      } })
      const ack = validateHostCreateOperationAck(store.invokeSyncedEditingSession(sender,
        { sessionId: session.session.sessionId, method: 'applySyncedHostStructure', input }), input.clientOperationId)
      const row = db.prepare('SELECT result_json FROM synced_operations WHERE client_operation_id=?').get(ack.operationId) as { result_json: string }
      assert.equal(JSON.parse(row.result_json).kind, heading ? 'synced-host-create-heading-birth-operation' : 'synced-host-create-operation')
      groups.push({ groupId: ack.createdLifecycle.groupId, instanceId: input.action.instanceId, heading })
    }
    writeSyncedBackupV3(db, { userDataRoot: profile, destination: join(profile, 'published-heading-title3'), snapshotId: randomUUID() })
    const header = { version: 1 as const, profile, hostId, targetId, hostTitle, targetTitle, headingId, selfId, groups }
    const seed: HeadingTitle3Seed = { ...header, original: db.transaction(() => inspect(db, header))() }
    writeFileSync(seedFile, JSON.stringify(seed) + '\n', { flag: 'wx' })
  } finally { store.destroy() }
} else throw Error('Explicit seed or stopped inspect required')
