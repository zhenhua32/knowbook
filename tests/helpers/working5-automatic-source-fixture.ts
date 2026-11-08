import assert from 'node:assert/strict'
import { lstat, readFile, realpath, rename } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AttachmentStore } from '../../src/main/attachments'
import { buildSyncedPortableAssetUri, collectStoredMarkdownAssetDestinations } from '../../src/shared/syncedBlockPortable'
import { serializeDatabaseViewPayload } from '../../src/shared/databaseViewBlock'
import { createDefaultDatabaseViewConfig } from '../../src/shared/database-workspace'
import { publicationHash, publicationJson, publicationRecordKey } from '../../src/main/sync/synced-publication-model'
import { materializeSyncedExchangeLocal, readSyncedExchangeLocalMaterial } from '../../src/main/sync/synced-publication'
import { exchangeJobPrefix, validateExchangeJob, parseExchangeStored } from '../../src/main/sync/synced-exchange-model'
import { prepareCapsule2AssetArchiveWithWorkingProvenance5 } from '../../src/main/database/restore-knowledge-capsule2-asset-archive'
import { captureSealedCapsule2SourceFromArchiveWithWorking5, captureSealedCapsule2SourceWithWorkingOriginals5 } from '../../src/main/database/restore-knowledge-capsule2-source-seal'
import { proveContext4NativeSpoolRoots } from './settled-context4-native-spool-evidence'
import { assertRestorePath } from '../../src/main/database/restore-safety-files'
import { captureAssetOriginal } from './capsule2-assets-fixture'
import { withoutSettledSpoolProbes4 } from './settled-context4-fixture'
import { withTombstones, deleteDocument, assertAbsentKnowledge, count, request, applySyncedHostFinal, completed, randomUUID, readStrictHostDocument, allTables } from './synced-exchange-tombstone-fixture'
type Fixture=Parameters<Parameters<typeof withTombstones>[0]>[0]
type WorkingSourceOptions = { duplicateSummaryAlias?: boolean; prefixBodyNavigation?: boolean; includeRemoteOnlyMerge?: boolean;
  singleDocumentComponent?: boolean }
async function setup(f:Fixture,options: WorkingSourceOptions = {}){
  const documentId=f.islands[0],deletedId=f.islands[2],definitionId=randomUUID(),opaque='knowbook-asset://'+'f'.repeat(64)+'/opaque-automatic-config.png'
  const remoteOnlyDocumentId = options.includeRemoteOnlyMerge ? f.islands[1] : undefined
  // withTombstones has an independent A receiver; its inherited assets object
  // belongs to sender S. All new definition/summary bytes must live in A.
  const assets=new AttachmentStore(join(f.A.root,'storage','assets'))
  const summaryBytes=Buffer.from('genuine automatic common summary '+randomUUID())
  const[summary,summaryAlias]=await assets.import([{name:'automatic whole W summary.png',bytes:summaryBytes},
    ...(options.duplicateSummaryAlias?[{name:'同一 W 摘要的第二名称.png',bytes:summaryBytes}]:[])])
  const summaryUri=buildSyncedPortableAssetUri({hash:publicationHash(await readFile(fileURLToPath(summary.url))),name:summary.name})
  const summaryAliasUri=summaryAlias?buildSyncedPortableAssetUri({hash:publicationHash(summaryBytes),name:summaryAlias.name}):undefined
  const config=createDefaultDatabaseViewConfig();config.query='opaque '+opaque
  const common=request(f.A.db,[documentId],sides=>{
    const use=sides[0].blocks.find(block=>block.type==='paragraph');assert.ok(use);use.content='Neutral common use text'
    sides[0].summary='Complete automatic summary ![common](<'+summary.url+'>)'+(summaryAlias?' ![second alias](<'+summaryAlias.url+'>)':'')
    sides[0].blocks.push({id:definitionId,type:'paragraph',content:'Neutral common definition text',checked:false,depth:0,parentBlockId:null})
    if (!options.singleDocumentComponent) sides[0].blocks.push({id:randomUUID(),type:'database-view',
      content:serializeDatabaseViewPayload({version:1,databaseId:f.A.defaultId,viewId:null,config}),checked:false,depth:0,parentBlockId:null})
    sides[0].blocks.push({id:randomUUID(),type:'code',content:'![opaque](<'+opaque+'>)',checked:false,depth:0,parentBlockId:null})
  })
  assert.equal(applySyncedHostFinal(f.A.db,common).status,'applied');completed(await f.exchange(f.A),'applied');completed(await f.exchange(f.B),'applied')
  const bytes=Buffer.from('genuine remote-only automatic definition bytes '+randomUUID()),digest=publicationHash(bytes)
  const[remoteAsset]=await assets.import([{name:'automatic remote-only definition.png',bytes}]),portable=buildSyncedPortableAssetUri({hash:digest,name:remoteAsset.name})
  const remote=request(f.A.db,[documentId],sides=>{const definition=sides[0].blocks.find(block=>block.id===definitionId);assert.ok(definition)
    definition.content=(options.prefixBodyNavigation?'[Stage target](./Target.md)\n\n':'')
      +'[auto-def]: <'+remoteAsset.url+'>\n\n[^auto-note]: ![nested](<'+remoteAsset.url+'>)'
  })
  assert.equal(applySyncedHostFinal(f.A.db,remote).status,'applied')
  if (remoteOnlyDocumentId) {
    const edit = request(f.A.db, [remoteOnlyDocumentId], sides => { sides[0].summary = 'Independent summary changed the same way on both peers' })
    assert.equal(applySyncedHostFinal(f.A.db, edit).status, 'applied')
  }
  assert.ok(collectStoredMarkdownAssetDestinations('[auto-def]: <'+portable+'>').some(item=>item.kind==='definition'&&item.url===portable),
    'An unused definition already contributes its physical destination; the missing source is the remote body, not unused-definition parsing')
  completed(await f.exchange(f.A),'applied')
  // The original independent doc has no group occurrence or changed local
  // body. A strict remote tombstone is protocol input, not a fabricated job or
  // receipt: this same B exchange must truly delete it and persist its proof.
  assert.notEqual(deletedId,documentId)
  assert.ok(f.B.db.prepare('SELECT 1 FROM documents WHERE id=?').get(deletedId))
  assert.equal(count(f.B.db,'synced_instances','host_document_id',deletedId),0)
  f.remoteFinal(records=>{deleteDocument(records,deletedId)})
  const local=request(f.B.db,[documentId],sides=>{const use=sides[0].blocks.find(block=>block.type==='paragraph'&&block.id!==definitionId);assert.ok(use)
    use.content='Genuine automatic use ![cross][auto-def] and footnote[^auto-note]'
  })
  assert.equal(applySyncedHostFinal(f.B.db,local).status,'applied')
  if (remoteOnlyDocumentId) {
    const edit = request(f.B.db, [remoteOnlyDocumentId], sides => {
      sides[0].summary = 'Independent summary changed the same way on both peers'
      sides[0].blocks[0].content = 'Additional ordinary body changed only on the publishing peer'
    })
    assert.equal(applySyncedHostFinal(f.B.db, edit).status, 'applied')
  }
  const operationId=randomUUID(),gate=f.gate(value=>value.method==='PUT'&&value.path.endsWith('/manifest.json')&&Boolean(value.ifMatch)),resolving=f.exchange(f.B,operationId)
  try {
  await gate.wait(resolving)
  const prefix=exchangeJobPrefix(operationId),rows=f.B.db.prepare('SELECT key,value FROM app_settings WHERE substr(key,1,?)=?').all(prefix.length,prefix)as Array<{key:string;value:string}>
  assert.equal(rows.length,1);const row=rows[0],job=validateExchangeJob(parseExchangeStored(row.value))
  assert.equal(job.version,4);if(job.version!==4)throw new Error('Actual Main job4 required')
  assert.equal(job.plannerVersion,'tombstones-v1')
  assert.equal(job.request.method,'exchangeSyncedSnapshot');assert.ok(job.merges.some(value=>value.key==='doc:'+documentId))
  assert.ok(job.deletions.some(value=>value.key==='doc:'+deletedId),'The same real job4 owns the independent original deletion intent')
  assert.ok(f.B.db.prepare('SELECT 1 FROM documents WHERE id=?').get(deletedId),'The gate precedes actual Main deletion')
  const spool=join(f.B.root,'storage','synced-exchanges-v1',operationId,job.attemptId),asset=job.descriptor.next.assets.find(value=>value.hash===digest)
  assert.ok(asset);assert.deepEqual(await readFile(join(spool,...asset.path.split('/'))),bytes)
  const managed=join(f.B.root,'storage','assets','attachments',digest.slice(0,2),digest,remoteAsset.name)
  await assert.rejects(lstat(managed),{code:'ENOENT'})
  assert.equal(f.B.db.prepare('SELECT 1 FROM synced_operations WHERE client_operation_id=?').get(operationId),undefined)
  assert.equal(readStrictHostDocument(f.B.db,documentId).content.blocks.some(block=>block.content.includes(digest)),false)
  return{f,documentId,deletedId,definitionId,remoteOnlyDocumentId,summaryUri,summaryAliasUri,opaque,bytes,digest,remoteAsset,portable,operationId,row,job,spool,managed,gate,resolving}
  } catch(error) { gate.release(); await Promise.allSettled([resolving]); throw error }
}

type Setup = Awaited<ReturnType<typeof setup>>
async function oracle(f: Setup) {
  const handle = await materializeSyncedExchangeLocal(f.f.B.db, { userDataRoot: f.f.B.root, target: f.f.targetConfig })
  const value = readSyncedExchangeLocalMaterial(handle); assert.ok(value)
  const record = value.records.find(item => publicationRecordKey(item) === 'doc:' + f.documentId); assert.ok(record)
  const merge = f.job.merges.find(item => item.key === 'doc:' + f.documentId); assert.ok(merge)
  assert.equal(publicationHash(publicationJson(record)), merge.resultHash)
  const deletion=assertAbsentKnowledge(f.f.B.db,'doc:'+f.deletedId)
  assert.equal(deletion.proof.application.operationId,f.operationId)
  assert.equal(deletion.receipt.version,4)
  return { record, merge }
}
async function packaged(original: Awaited<ReturnType<typeof captureAssetOriginal>>, sealed: Awaited<ReturnType<typeof captureSealedCapsule2SourceFromArchiveWithWorking5>>) {
  assert.equal(sealed.value.assetArchive.version, 5)
  if (sealed.value.assetArchive.version !== 5) throw new Error('The explicit producer must return archive5')
  const working = sealed.working; assert.ok(working)
  assert.deepEqual(working.pointer, sealed.value.assetArchive.workingOriginals)
  assert.equal(working.manifest.sourceContentHash, sealed.value.assetArchive.sourceContentHash)
  return { original, sealed, source: sealed.source, value: sealed.value, info: sealed.info, working,
    sourceInput: { profileRoot: original.info.profileRoot, operationId: sealed.info.manifest.operationId,
      capsuleId: sealed.info.manifest.capsuleId, expectedManifestHash: sealed.info.manifestHash } }
}
/** Only the archive copy runs while the real publication gate is held. The
 * later material/seal reads use those immutable bytes after Main has completed,
 * and cannot substitute its later receipt for the captured pending SQL. */
export function withPendingWorkingSource5(run: (value: Setup & Awaited<ReturnType<typeof packaged>> & {
  oracle: Awaited<ReturnType<typeof oracle>>; applied: ReturnType<typeof completed>
  spools: string[]; spoolProbeAttempts: Array<{method:string;path:string}>
}) => Promise<void>, options?: WorkingSourceOptions) {
  return withTombstones(async fixture => {
    const f = await setup(fixture, options)
    try {
      const before = allTables(f.f.B.db), original = await captureAssetOriginal({ userDataRoot: f.f.B.root, db: f.f.B.db })
      const roots = await proveContext4NativeSpoolRoots(f.f.B.root, original.info.profileRoot), spools = roots.spools(f.operationId, f.job.attemptId).aliases
      const observed = await withoutSettledSpoolProbes4([], () => prepareCapsule2AssetArchiveWithWorkingProvenance5(original.original), spools)
      assert.deepEqual(allTables(f.f.B.db), before)
      assert.equal(f.f.B.db.prepare('SELECT 1 FROM synced_operations WHERE client_operation_id=?').get(f.operationId), undefined)
      f.gate.release(); const applied = completed(await f.resolving, 'applied')
      const actual = await oracle(f), saved = await packaged(original, await captureSealedCapsule2SourceFromArchiveWithWorking5(observed.value))
      assert.equal(saved.working.baseCommitment.referenceUris.includes(f.portable), false)
      assert.equal(saved.working.baseCommitment.tree.files.some(file => file.hash === f.digest), false)
      assert.ok(observed.observations.some(item => item.method === 'open'), 'Pending originals must actually open the genuine spool')
      await run({ ...f, ...saved, oracle: actual, applied, spools, spoolProbeAttempts: observed.attempts })
    } finally { f.gate.release(); await Promise.allSettled([f.resolving]) }
  }, { assets: true, notes: true, catalog: true })
}
/** The absent-spool claim is observed under both native spellings after their
 * simultaneously opened DB descriptors have proved the same full dev/ino. */
export function withSettledWorkingSource5(run: (value: Setup & Awaited<ReturnType<typeof packaged>> & {
  oracle: Awaited<ReturnType<typeof oracle>>; spools: string[]; spoolProbeAttempts: Array<{method:string;path:string}>
}) => Promise<void>, options?: WorkingSourceOptions) {
  return withTombstones(async fixture => {
    const f = await setup(fixture, options)
    try {
      f.gate.release(); completed(await f.resolving, 'applied'); const actual = await oracle(f)
      const original = await captureAssetOriginal({ userDataRoot: f.f.B.root, db: f.f.B.db })
      const roots = await proveContext4NativeSpoolRoots(f.f.B.root, original.info.profileRoot), spools = roots.spools(f.operationId, f.job.attemptId).aliases
      const root = await realpath(f.f.folder), source = await realpath(roots.spools(f.operationId, f.job.attemptId).canonical)
      const retired = join(root, 'retired-working5-spool-' + f.job.attemptId)
      await assertRestorePath(source, root); assert.equal(dirname(retired), root); await assert.rejects(lstat(retired), { code: 'ENOENT' })
      await rename(source, retired); for (const path of spools) await assert.rejects(lstat(path), { code: 'ENOENT' })
      const captured = await withoutSettledSpoolProbes4(spools, async () => packaged(original,
        await captureSealedCapsule2SourceWithWorkingOriginals5(original.original)))
      assert.deepEqual(captured.attempts, [])
      await run({ ...f, ...captured.value, oracle: actual, spools, spoolProbeAttempts: captured.attempts })
    } finally { f.gate.release(); await Promise.allSettled([f.resolving]) }
  }, { assets: true, notes: true, catalog: true })
}
