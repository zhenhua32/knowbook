// Real SQLite/Main history is created between the source and current captures.
// No prepared candidate, lifecycle flag or history row is manufactured here.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import Database from 'better-sqlite3'
import type { SyncedRestoreGroupInput, SyncedUpdateGroupInput } from '../../src/shared/synced-blocks'
import { capsuleJson } from '../../src/main/database/restore-knowledge-capsule-model'
import { rawRestoreSqlCell } from '../../src/main/database/restore-knowledge-sql-cell'
import type { Capsule2Encoding } from '../../src/main/database/restore-knowledge-capsule2-raw-model'
import { captureActualFirstRequiredSqlDag } from '../../src/main/database/restore-knowledge-mixed-required-dag-read'
import { exportPreparedMixedOriginBundle } from '../../src/main/database/restore-knowledge-mixed-origin-bundle-read'
import { captureMixedRootKnowledgeConservationPlan3 } from '../../src/main/database/restore-knowledge-root3-read'
import { tryReadCertifiedCapsule2SourceInputs } from '../../src/main/database/restore-knowledge-capsule2-source-certificate'
import { prepareRootRestoreIdentityPlan3 } from '../../src/main/database/restore-knowledge-identity3-read'
import { prepareRootRestoreReferencePlan3 } from '../../src/main/database/restore-knowledge-reference3-read'
import { restoreSyncedGroupOperation, updateSyncedBlockGroup } from '../../src/main/database/synced-blocks-content'
import { getSyncedHostHistory } from '../../src/main/database/synced-host-final'
import { captureMixedSource } from './mixed-required-source-fixture'
import { withV3Fixture, allTables, createRequest, created, applySyncedHostCommand, applySyncedHostFinal,
  restoreSyncedHostOperation, createRestoreInput, request, applied, snapshot, type V3Fixture } from './synced-backup-v3-fixture'
import { freshBlock, restoreInput, savedGroup } from './synced-host-final-fixture'

export function cutGroupEdit(db: Database.Database, groupId: string, suffix: string) {
  const before = snapshot(db, groupId), instance = before.instances[0]
  assert.ok(instance, 'The edit uses an actual current registered instance')
  const input: SyncedUpdateGroupInput = { clientOperationId: randomUUID(), groupId, expectedRevision: before.revision,
    expectedTopologyRevision: before.topologyRevision, expectedInstanceBinding: { instanceId: instance.instanceId,
      hostDocumentId: instance.hostDocumentId, bindingVersion: instance.bindingVersion },
    blocks: before.blocks.map(({ createdAt: _birth, ...block }) => ({ ...block, content: block.content + suffix })) }
  return { input, ack: savedGroup(updateSyncedBlockGroup(db, input)) }
}
export function cutGroupRestore(db: Database.Database, groupId: string, historyToken: string,
  direction: 'undo' | 'redo'): SyncedRestoreGroupInput {
  const before = snapshot(db, groupId), instance = before.instances[0]
  assert.ok(instance, 'Fresh guards are read from the final current instance')
  return { clientOperationId: randomUUID(), groupId, historyToken, direction, expectedRevision: before.revision,
    expectedTopologyRevision: before.topologyRevision, expectedHistoryCursor: before.history.cursor,
    expectedInstanceBinding: { instanceId: instance.instanceId, hostDocumentId: instance.hostDocumentId,
      bindingVersion: instance.bindingVersion } }
}
function newHost(f: V3Fixture, title: string) {
  const hostId = f.store.createDocument(null), ordinaryId = randomUUID(), canonicalId = randomUUID()
  f.store.updateDocument(hostId, { title, summary: 'Current-only complete host summary', blocks: [
    freshBlock(ordinaryId, title + ' ordinary survivor'), freshBlock(canonicalId, title + ' canonical body')
  ] })
  const input = createRequest(f.db, { documentId: hostId, selectedRootIds: [canonicalId] })
  const ack = created(applySyncedHostCommand(f.db, input))
  return { hostId, ordinaryId, canonicalId, groupId: input.action.groupId, instanceId: input.action.instanceId, input, ack }
}
function currentCases(f: V3Fixture) {
  const retained = newHost(f, 'R1 retained current-only host')
  const groupFirst = cutGroupEdit(f.db, retained.groupId, ' first genuine revision')
  const groupSecond = cutGroupEdit(f.db, retained.groupId, ' second genuine revision')
  assert.ok(groupSecond.ack.snapshot.history.undoToken)
  savedGroup(restoreSyncedGroupOperation(f.db,
    cutGroupRestore(f.db, retained.groupId, groupSecond.ack.snapshot.history.undoToken, 'undo')))
  const groupBefore = snapshot(f.db, retained.groupId)
  assert.ok(groupBefore.history.undoToken && groupBefore.history.redoToken,
    'Two real group writes followed by Undo leave both real executable tails')

  const sharedWrite = (suffix: string) => {
    const input = request(f.db, [f.hostId, retained.hostId], after => {
      after[0].blocks.find(block => block.id === f.hostBodyId)!.content += suffix
      after[1].blocks.find(block => block.id === retained.ordinaryId)!.content += suffix
    })
    const ack = applied(applySyncedHostFinal(f.db, input))
    assert.ok(ack.historyToken, 'A real shared journal is committed for both physical hosts')
    return { input, ack }
  }
  const sharedFirst = sharedWrite(' first genuine shared host revision')
  const sharedSecond = sharedWrite(' second genuine shared host revision')
  applied(restoreSyncedHostOperation(f.db, restoreInput(f.db, sharedSecond.ack, 'undo')))
  const hostHistory = [f.hostId, retained.hostId].map(documentId => ({ documentId,
    history: getSyncedHostHistory(f.db, { documentId }) }))
  for (const item of hostHistory) {
    assert.equal(item.history.undoToken, sharedFirst.ack.historyToken)
    assert.equal(item.history.redoToken, sharedSecond.ack.historyToken)
  }
  const retired = newHost(f, 'R1 retained retired-create host')
  const retiredAck = created(restoreSyncedHostOperation(f.db, createRestoreInput(f.db, retired.ack, 'undo').input))
  assert.equal(retiredAck.createdLifecycle.state, 'retired-create')
  const retiredRedo = createRestoreInput(f.db, retiredAck, 'redo').input
  const pins = f.db.prepare('SELECT * FROM synced_group_pins ORDER BY group_id,kind,pin_id').all()
  assert.ok(pins.length > 0, 'Only genuine Main create/host journals supply the retained pin evidence')
  return { retained, retired, retiredAck, retiredRedo, groupFirst, groupSecond, groupBefore,
    sharedFirst, sharedSecond, hostHistory, pins }
}

export async function withStage3CutFixture(run: (fixture: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  await withV3Fixture(source => withV3Fixture(receiver => setup(source, receiver).then(run)))
}
async function setup(source: V3Fixture, receiver: V3Fixture) {
  const left = await captureMixedSource(source, 2)
  const sourcePacket = (await tryReadCertifiedCapsule2SourceInputs(left.handle))!.value
  const cases = currentCases(source)
  const right = await captureMixedSource(source, 2)
  const currentPacket = (await tryReadCertifiedCapsule2SourceInputs(right.handle))!.value
  const dag = await captureActualFirstRequiredSqlDag({ profileRoot: source.userDataRoot,
    operationId: basename(left.original.info.recoveryDirectory), dagId: randomUUID(), source: left.handle, current: right.handle })
  const exported = await exportPreparedMixedOriginBundle(dag, { operationId: randomUUID(), bundleId: randomUUID() })
  const saved = await captureMixedRootKnowledgeConservationPlan3({ profileRoot: receiver.userDataRoot,
    operationId: randomUUID(), sourceDirectory: exported.directory })
  const base = await prepareRootRestoreIdentityPlan3(saved.knowledgePlan)
  const prepared = await prepareRootRestoreReferencePlan3(base.plan, { originPolicy: 'isolate-incoming', anonymousValues: 'source' })
  assert.deepEqual(prepared.value.candidate.conflicts, [], 'The actual current-only history fixture must pass the unchanged reference admission')
  assert.equal(prepared.value.candidate.candidateConflictFree, true)
  return { source, receiver, left, right, sourcePacket, currentPacket, cases, dag, exported, saved, base, prepared,
    beforeSource: allTables(source.db), beforeReceiver: allTables(receiver.db), currentNative: cutNativeSnapshot(source.db) }
}

const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"'
export function cutNativeTable(db: Database.Database, name: string) {
  const encoding = db.pragma('encoding', { simple: true }) as Capsule2Encoding
  const columns = db.prepare('SELECT * FROM main.' + quote(name) + ' LIMIT 0').columns().map(column => column.name)
  const sql = (db.prepare("SELECT sql FROM main.sqlite_master WHERE type='table' AND name=?").get(name) as { sql: string }).sql
  const rowid = !/\bWITHOUT\s+ROWID\b/i.test(sql), project = columns.flatMap(column => [
    'typeof(' + quote(column) + ')', 'CASE WHEN typeof(' + quote(column) + ")='text' THEN CAST(" + quote(column) + ' AS BLOB) ELSE ' + quote(column) + ' END'
  ]).join(',')
  const rows = (db.prepare('SELECT ' + (rowid ? '_rowid_,' : '') + project + ' FROM main.' + quote(name) + (rowid ? ' ORDER BY _rowid_' : ''))
    .safeIntegers(true).raw(true).all() as unknown[][]).map(row => ({ sourceRowId: rowid ? String(row[0]) : '',
      cells: columns.map((_column, index) => rawRestoreSqlCell(row[index * 2 + (rowid ? 1 : 0)], row[index * 2 + (rowid ? 2 : 1)], encoding)) }))
  if (!rowid) rows.sort((a, b) => capsuleJson(a.cells) < capsuleJson(b.cells) ? -1 : capsuleJson(a.cells) > capsuleJson(b.cells) ? 1 : 0)
  return { columns, rows }
}
export function cutNativeSnapshot(db: Database.Database) {
  const schema = db.prepare('SELECT type,name,tbl_name,sql FROM main.sqlite_master ORDER BY type,name').all()
  const tables = (db.prepare("SELECT name FROM main.sqlite_master WHERE type='table' AND substr(name,1,7)<>'sqlite_' ORDER BY name").all() as Array<{ name: string }>)
    .map(row => ({ name: row.name, ...cutNativeTable(db, row.name) }))
  return { schema, userVersion: db.pragma('user_version', { simple: true }), encoding: db.pragma('encoding', { simple: true }), tables }
}
export async function cutDiskInventory(directory: string) {
  const entries: Array<{ name: string; bytes: Buffer | null }> = []
  for (const name of ['knowbook.db', 'knowbook.db-wal', 'knowbook.db-shm']) {
    try { entries.push({ name, bytes: await readFile(join(directory, name)) }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; entries.push({ name, bytes: null }) }
  }
  return entries
}
export async function cutProbe<T>(sourceDirectory: string, probeRoot: string, run: (db: Database.Database) => T,
  writable = false): Promise<T> {
  const before = await cutDiskInventory(sourceDirectory), target = join(probeRoot, 'stage3-cut-probe-' + randomUUID())
  await mkdir(target)
  for (const file of before) if (file.bytes !== null)
    await copyFile(join(sourceDirectory, file.name), join(target, file.name), constants.COPYFILE_EXCL)
  assert.deepEqual(await cutDiskInventory(target), before)
  const db = new Database(join(target, 'knowbook.db'), { readonly: !writable, fileMustExist: true })
  try {
    db.pragma('foreign_keys=ON')
    if (!writable) db.pragma('query_only=ON')
    return writable ? run(db) : db.transaction(() => run(db))()
  } finally {
    db.close()
    assert.deepEqual(await cutDiskInventory(sourceDirectory), before, 'All SQL oracles use independent copies; the sealed stage is never opened')
  }
}
