import assert from 'node:assert/strict'
import test from 'node:test'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { withV3Fixture, createRequest, created, applySyncedHostCommand, freshBlock, snapshot, randomUUID, allTables } from './helpers/synced-backup-v3-fixture'
import { request, restoreInput } from './helpers/synced-host-final-fixture'
import { withCapsule2RawCopy } from './helpers/capsule2-raw-fixture'
import { writeSyncedBackupV3 } from '../src/main/backup/v3-export'
import { readSyncedGroupLifecycles } from '../src/main/database/synced-lifecycle-state'
import { validateHostCreateOperationAck } from '../src/main/database/synced-host-operation-receipt'
import { readRawCapsule2HistoricalEvidenceOwned } from '../src/main/database/restore-knowledge-capsule2-history-read'
import { getSyncedHostHistory } from '../src/main/database/synced-blocks-read'
import { hostHash } from '../src/main/database/synced-host-journal'
import { readSyncedBaselineMetadataCaptureOwned2 } from '../src/main/database/synced-binding-sources'
import type { SyncedStructureApplied } from '../src/shared/synced-blocks'

type Fixture = Parameters<Parameters<typeof withV3Fixture>[0]>[0]
function setup(f: Fixture, twoGroups=false) {
  // The fixture's old bare heading group points at ANOTHER real document. It
  // must not be removed or relabelled to make this new positive appear valid.
  const targetId = f.store.createDocument(null), sourceId = f.store.createDocument(null)
  const headingId = randomUUID(), linkId = randomUUID(), secondId = randomUUID(),selfLinkId=randomUUID()
  f.store.updateDocument(targetId, { title: 'Fresh Heading Target', summary: 'Unchanged native summary',
    blocks: [{ ...freshBlock(headingId, 'Exact original heading'), type: 'heading-1' },
      freshBlock(selfLinkId,'[self doc](Fresh%20Heading%20Target.md) [self block](Fresh%20Heading%20Target.md#^'+headingId+') [[Fresh Heading Target|self wiki]]')] })
  f.store.updateDocument(sourceId, { title: 'Fresh Heading Source', summary: '', blocks: [
    freshBlock(linkId, '[first](Fresh%20Heading%20Target.md#exact-original-heading) and [second](Fresh%20Heading%20Target.md#exact-original-heading)'),
    freshBlock(secondId, '[[Fresh Heading Target#exact-original-heading|third]]')
  ] })
  const sender = Object.freeze({ frame: 'genuine fresh heading-title source' })
  const sourceSession = f.store.openSyncedEditingSession(sender, { kind: 'host', hostDocumentId: sourceId })
  assert.equal(sourceSession.status, 'ready')
  if (sourceSession.status !== 'ready') throw Error('The real source session must open')
  const input = createRequest(f.db, { documentId: sourceId, selectedRootIds: [linkId, secondId] })
  const result = f.store.invokeSyncedEditingSession(sender, { sessionId: sourceSession.session.sessionId, method: 'applySyncedHostStructure', input })
  const ack = validateHostCreateOperationAck(result, input.clientOperationId)
  const groupId = ack.createdLifecycle.groupId, original = snapshot(f.db, groupId)
  assert.equal(original.bindings.length, 3)
  assert.ok(original.bindings.every(binding => binding.target.kind === 'heading' && binding.target.documentId === targetId
    && binding.target.slug === 'exact-original-heading' && binding.target.state === 'live'))
  const business = f.db.prepare('SELECT client_operation_id,request_hash,result_json,created_at FROM synced_operations WHERE client_operation_id=?').get(input.clientOperationId)
  assert.ok(business)
  assert.equal(JSON.parse((business as { result_json: string }).result_json).kind, 'synced-host-create-heading-birth-operation')
  let buddy:{groupId:string;blockId:string;business:unknown;operationId:string}|null=null
  if(twoGroups){
    const buddyHost=f.store.createDocument(null),buddyBlock=randomUUID()
    f.store.updateDocument(buddyHost,{title:'Second Fresh Heading Source',summary:'',blocks:[freshBlock(buddyBlock,'[independent](Fresh%20Heading%20Target.md#exact-original-heading)')]})
    const buddySession=f.store.openSyncedEditingSession(sender,{kind:'host',hostDocumentId:buddyHost})
    assert.equal(buddySession.status,'ready');if(buddySession.status!=='ready')throw Error('Second genuine source must open')
    const buddyInput=createRequest(f.db,{documentId:buddyHost,selectedRootIds:[buddyBlock]})
    const buddyAck=validateHostCreateOperationAck(f.store.invokeSyncedEditingSession(sender,{sessionId:buddySession.session.sessionId,method:'applySyncedHostStructure',input:buddyInput}),buddyInput.clientOperationId)
    const buddyBusiness=f.db.prepare('SELECT client_operation_id,request_hash,result_json,created_at FROM synced_operations WHERE client_operation_id=?').get(buddyAck.operationId)
    assert.equal(JSON.parse((buddyBusiness as {result_json:string}).result_json).kind,'synced-host-create-heading-birth-operation')
    buddy={groupId:buddyAck.createdLifecycle.groupId,blockId:buddyBlock,business:buddyBusiness,operationId:buddyAck.operationId}
  }
  writeSyncedBackupV3(f.db, { userDataRoot: realpathSync(f.userDataRoot), destination: join(realpathSync(f.root), 'heading-title-initial-publication'), snapshotId: randomUUID() })
  assert.equal(readSyncedGroupLifecycles(f.db, [groupId]).get(groupId)?.exposure, 'confirmed')
  const targetSender = Object.freeze({ frame: 'only the real ordinary heading target opened' })
  const targetSession = f.store.openSyncedEditingSession(targetSender, { kind: 'host', hostDocumentId: targetId })
  assert.equal(targetSession.status, 'ready')
  if (targetSession.status !== 'ready') throw Error('The real target host session must open')
  const sessionId = targetSession.session.sessionId
  const titleInput = (title: string, dirty = false) => request(f.db, [targetId], (after, before) => {
    if (dirty) before[0].workingBefore.title = title
    after[0].title = title
  })
  const invoke = (input: ReturnType<typeof titleInput>) => f.store.invokeSyncedEditingSession(targetSender,
    { sessionId, method: 'applySyncedHostStructure', input })
  const apply = (input: ReturnType<typeof titleInput>): SyncedStructureApplied => {
    const saved = invoke(input)
    assert.equal(saved.status, 'applied', 'A genuine business-bound heading Key must survive an ordinary target title rename')
    if (saved.status !== 'applied') throw Error('Actual heading title business ACK required')
    return saved
  }
  const check = (title: string) => {
    assert.equal(f.store.getDocumentDetail(targetId)!.title, title)
    const current = snapshot(f.db, groupId), expected = title.split('/').map(encodeURIComponent).join('/') + '.md#exact-original-heading'
    assert.equal(current.blocks.find(block => block.id === linkId)!.content, '[first](' + expected + ') and [second](' + expected + ')')
    assert.equal(current.blocks.find(block => block.id === secondId)!.content, '[[' + title + '#exact-original-heading|third]]')
    assert.deepEqual(current.bindings.map(binding => binding.target), original.bindings.map(binding => binding.target))
    assert.deepEqual(current.blocks.map(block => [block.id, block.createdAt]), original.blocks.map(block => [block.id, block.createdAt]))
    assert.deepEqual(current.origin, original.origin)
    const ordinary=f.store.getDocumentDetail(targetId)!.blocks.find(block=>block.id===selfLinkId)!
    const ownPath=title.split('/').map(encodeURIComponent).join('/')+'.md'
    assert.equal(ordinary.content,'[self doc]('+ownPath+') [self block]('+ownPath+'#^'+headingId+') [['+title+'|self wiki]]',
      'Existing ordinary Main cell maintenance must remain supported beside canonical heading navigation')
    if(buddy){
      const other=snapshot(f.db,buddy.groupId)
      assert.equal(other.blocks.find(block=>block.id===buddy!.blockId)!.content,'[independent]('+expected+')')
      assert.deepEqual(f.db.prepare('SELECT client_operation_id,request_hash,result_json,created_at FROM synced_operations WHERE client_operation_id=?').get(buddy.operationId),buddy.business)
    }
    for (const binding of current.bindings) assert.equal(current.blocks.find(block => block.id === binding.blockId)!.content.slice(binding.from, binding.to), binding.raw)
    assert.deepEqual(f.db.prepare('SELECT client_operation_id,request_hash,result_json,created_at FROM synced_operations WHERE client_operation_id=?').get(input.clientOperationId), business)
  }
  const restore = (saved: SyncedStructureApplied, direction: 'undo' | 'redo') => {
    const result = f.store.invokeSyncedEditingSession(targetSender, { sessionId, method: 'restoreSyncedHostOperation', input: restoreInput(f.db, saved, direction) })
    assert.equal(result.status, 'applied')
    return result
  }
  return { targetId, sourceId, headingId, groupId, business, original, sender, targetSender, sessionId, titleInput, invoke, apply, check, restore,buddy }
}

test('business-bound heading Keys follow repeated real title renames, dirty flushes and genuine Undo/Redo with immutable originals and cold historical support', () => withV3Fixture(async f => {
  const t = setup(f,true), firstInput = t.titleInput('First Heading Rename'), first = t.apply(firstInput)
  assert.ok(first.historyToken)
  t.check('First Heading Rename')
  const secondInput = t.titleInput('第二次 Heading Rename 🙂'), second = t.apply(secondInput)
  assert.ok(second.historyToken)
  t.check('第二次 Heading Rename 🙂')
  const committed = allTables(f.db), changes = (f.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
  assert.equal(t.apply(firstInput).replayed, true, 'Old nonce lookup returns the original first ACK after a later genuine rename')
  assert.deepEqual(allTables(f.db), committed)
  assert.equal((f.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n, changes)
  t.restore(second, 'undo'); t.check('First Heading Rename')
  t.restore(first, 'undo'); t.check('Fresh Heading Target')
  t.restore(first, 'redo'); t.check('First Heading Rename')
  t.restore(second, 'redo'); t.check('第二次 Heading Rename 🙂')
  const depth:SyncedStructureApplied[]=[],names:string[]=[]
  for(let index=3;index<=8;index++){
    const title='Heading chain '+index+' 中文',saved=t.apply(t.titleInput(title));assert.ok(saved.historyToken)
    depth.push(saved);names.push(title);t.check(title)
  }
  for(let index=depth.length-1;index>=0;index--){t.restore(depth[index],'undo');t.check(index?names[index-1]:'第二次 Heading Rename 🙂')}
  for(let index=0;index<depth.length;index++){t.restore(depth[index],'redo');t.check(names[index])}
  const history = getSyncedHostHistory(f.db, { documentId: t.targetId }), dirtyInput = t.titleInput('Dirty Heading Flush', true)
  const exactW = structuredClone(dirtyInput.hostsWorkingBefore[0].workingBefore), flushed = t.apply(dirtyInput)
  assert.equal(flushed.historyToken, null)
  assert.equal(flushed.hosts[0].logicalBeforeHash, hostHash(exactW))
  assert.deepEqual(getSyncedHostHistory(f.db, { documentId: t.targetId }), history)
  t.check('Dirty Heading Flush')
  await withCapsule2RawCopy(f, db => db.transaction(() => {
    const raw = readRawCapsule2HistoricalEvidenceOwned(db)
    assert.ok(raw.legacyFacts.some(fact => String(fact.family) === 'heading-title-transition'))
    assert.deepEqual(db.prepare('SELECT client_operation_id,request_hash,result_json,created_at FROM synced_operations WHERE client_operation_id=?')
      .get(JSON.parse((t.business as { result_json: string }).result_json).result.operationId), t.business)
    assert.equal((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n, 0)
  })())
}))

test('one actual old unproved incoming heading Key blocks the whole real rename even beside a newly proved group', () => withV3Fixture(f => {
  const t = setup(f), unprovedSource = f.store.createDocument(null), child = randomUUID()
  f.store.updateDocument(unprovedSource, { title: 'Old bare incoming source', summary: '', blocks: [freshBlock(child, '[old bare](Fresh%20Heading%20Target.md#exact-original-heading)')] })
  const old = created(applySyncedHostCommand(f.db, createRequest(f.db, { documentId: unprovedSource, selectedRootIds: [child] })))
  assert.equal(JSON.parse((f.db.prepare('SELECT result_json FROM synced_operations WHERE client_operation_id=?').get(old.operationId) as { result_json: string }).result_json).kind, 'synced-host-create-operation')
  writeSyncedBackupV3(f.db, { userDataRoot: realpathSync(f.userDataRoot), destination: join(realpathSync(f.root), 'old-bare-incoming-publication'), snapshotId: randomUUID() })
  assert.equal(readSyncedGroupLifecycles(f.db, [old.createdLifecycle.groupId]).get(old.createdLifecycle.groupId)?.exposure, 'confirmed',
    'The negative must reach missing old-Key lineage, rather than merely an unpublished activation refusal')
  const input = t.titleInput('Must retain this full candidate'), before = allTables(f.db), changes = (f.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
  const result = t.invoke(input)
  assert.equal(result.status, 'unsupported')
  assert.deepEqual(allTables(f.db), before)
  assert.equal((f.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n, changes)
  assert.equal(input.finalAfter[0].title, 'Must retain this full candidate')
  t.check('Fresh Heading Target')
}))

test('a deleted and newly born native heading at the same current slug cannot join the old Key continuity chain', () => withV3Fixture(f => {
  const t = setup(f), target = f.store.getDocumentDetail(t.targetId)!, newHeading = randomUUID()
  f.store.updateDocument(t.targetId, { expectedUpdatedAt: target.updatedAt, title: target.title, summary: target.summary,
    blocks: [{ ...freshBlock(newHeading, 'Exact original heading'), type: 'heading-1' }] })
  assert.notEqual(newHeading, t.headingId)
  const input = t.titleInput('No same-slug adoption'), before = allTables(f.db), changes = (f.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
  assert.equal(t.invoke(input).status, 'unsupported')
  assert.deepEqual(allTables(f.db), before)
  assert.equal((f.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n, changes)
}))


test('a real heading title envelope INSERT fault rolls back every point and maintenance row before the same original nonce commits once', () => withV3Fixture(f => {
  const t=setup(f,true),input=t.titleInput('Atomic heading title candidate'),before=allTables(f.db)
  const changes=(f.db.prepare('SELECT total_changes() AS n').get() as {n:number}).n
  f.db.exec("CREATE TEMP TRIGGER fail_heading_title3_business BEFORE INSERT ON main.synced_operations WHEN NEW.client_operation_id='"+input.clientOperationId+"' BEGIN SELECT RAISE(ABORT,'actual heading title3 envelope insert fault'); END")
  try {
    assert.throws(()=>t.invoke(input),/actual heading title3 envelope insert fault/)
    assert.deepEqual(allTables(f.db),before)
    assert.ok((f.db.prepare('SELECT total_changes() AS n').get() as {n:number}).n>changes,
      'Actual provisional writes rolled back; SQLite total_changes does not pretend they never occurred')
  } finally { f.db.exec('DROP TRIGGER temp.fail_heading_title3_business') }
  const saved=t.apply(input);assert.equal(saved.replayed,false);t.check('Atomic heading title candidate')
  const stable=allTables(f.db),settled=(f.db.prepare('SELECT total_changes() AS n').get() as {n:number}).n
  assert.equal(t.apply(input).replayed,true)
  assert.deepEqual(allTables(f.db),stable)
  assert.equal((f.db.prepare('SELECT total_changes() AS n').get() as {n:number}).n,settled)
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM synced_operations WHERE client_operation_id=?').get(input.clientOperationId) as {n:number}).n,1)
}))

test('a genuine later baseline Source observation never upgrades an old bare heading Key into business title lineage', () => withV3Fixture(f => {
  const sender=Object.freeze({frame:'genuine old source baseline then target rename'})
  const opened=f.store.openSyncedEditingSession(sender,{kind:'host',hostDocumentId:f.hostId})
  assert.equal(opened.status,'ready');if(opened.status!=='ready')throw Error('Actual original source session required')
  const observed=f.store.invokeSyncedEditingSession(sender,{sessionId:opened.session.sessionId,method:'captureBaseline',input:{groupId:f.groupId}})
  assert.equal(observed.status,'ready');if(observed.status!=='ready')throw Error('The real later current source point must be captured')
  const capture=f.db.transaction(()=>readSyncedBaselineMetadataCaptureOwned2(f.db,observed.readOwnerId))()
  assert.equal(capture.status,'captured');if(capture.status!=='captured')throw Error('The actual current point must reopen')
  assert.equal(capture.record.capture.originalCaptureBirthProved,false)
  assert.equal(capture.historicalKeyLineageComplete,false)
  writeSyncedBackupV3(f.db,{userDataRoot:realpathSync(f.userDataRoot),destination:join(realpathSync(f.root),'old-source-baseline-published'),snapshotId:randomUUID()})
  assert.equal(readSyncedGroupLifecycles(f.db,[f.groupId]).get(f.groupId)?.exposure,'confirmed')
  const target=f.store.openSyncedEditingSession(sender,{kind:'host',hostDocumentId:f.targetId})
  assert.equal(target.status,'ready');if(target.status!=='ready')throw Error('Actual original target session required')
  const input=request(f.db,[f.targetId],after=>{after[0].title='Never upgrade this old heading Key'})
  const before=allTables(f.db),changes=(f.db.prepare('SELECT total_changes() AS n').get() as {n:number}).n
  const result=f.store.invokeSyncedEditingSession(sender,{sessionId:target.session.sessionId,method:'applySyncedHostStructure',input})
  assert.equal(result.status,'unsupported')
  assert.deepEqual(allTables(f.db),before)
  assert.equal((f.db.prepare('SELECT total_changes() AS n').get() as {n:number}).n,changes)
  assert.equal(input.finalAfter[0].title,'Never upgrade this old heading Key')
}))
