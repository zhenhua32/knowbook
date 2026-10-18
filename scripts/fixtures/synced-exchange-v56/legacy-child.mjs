import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {existsSync,readFileSync} from 'node:fs'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {causeMessages,copyTreeFresh,dumpRemote,dumpRequests,hash,hashFile,inventory,runChild,writeFresh} from './evidence.mjs'

const config=JSON.parse(readFileSync(process.argv[2],'utf8'))
const phases=['prepared','possible','remote-confirmed','published-local-deferred','committed-replay']
const mode=config.caseName.startsWith('conflicts-')?'conflicts':config.caseName.startsWith('both-')?'both':null
assert.ok(mode,'Only the two explicit delivered method domains are admitted')
const phaseCase=config.caseName.slice(mode.length+1)
assert.ok(phases.includes(phaseCase))
assert.equal(config.oldCommit,'9e9bc7d6f135b55bf37604466fe0867396b03a85')
assert.equal(process.env.ELECTRON_RUN_AS_NODE,'1')
assert.equal(process.cwd(),config.oldSource)
assert.equal(process.env.TSX_TSCONFIG_PATH,join(config.oldSource,'tsconfig.test.json'))
const old=await import(pathToFileURL(join(config.oldSource,'tests/helpers/synced-exchange-knowledge-fixture.ts')).href)
const oldProduct=await import(pathToFileURL(join(config.oldSource,'src/main/sync/synced-exchange.ts')).href)
const {runtime}=await import(pathToFileURL(join(config.oldSource,'tests/helpers/synced-exchange-fixture.ts')).href)
const version=mode==='conflicts'?5:6,plannerVersion=mode==='conflicts'?'knowledge-conflicts-v1':'knowledge-forks-v1'
const quote=value=>"'"+value.replaceAll("'","''")+"'"
let active=null,completed=null

function rows(db,operationId){
  const headKey='sync.webdav.protocol5.exchange-job-head.v1.'+operationId
  const headRow=db.prepare('SELECT key,value,updated_at FROM app_settings WHERE key=?').get(headKey);assert.ok(headRow)
  const head=JSON.parse(headRow.value),jobKey='sync.webdav.protocol5.exchange-job.v1.'+operationId+'.'+head.attemptId
  const jobRow=db.prepare('SELECT key,value,updated_at FROM app_settings WHERE key=?').get(jobKey);assert.ok(jobRow)
  const job=JSON.parse(jobRow.value)
  assert.equal(job.version,version);assert.equal(job.plannerVersion,plannerVersion)
  assert.equal(job.request.method,mode==='conflicts'?'resolveSyncedExchangeConflicts':'resolveSyncedExchangeBoth')
  assert.equal(Object.hasOwn(job,'deletions'),false,'Live selector jobs must not be disguised deletion producers')
  assert.equal(head.jobHash,hash(jobRow.value));assert.equal(head.requestHash,job.requestHash)
  const prefix='sync.webdav.protocol5.exchange-job-phase.v1.'+operationId+'.'+head.attemptId+'.'
  const phaseRows=db.prepare('SELECT key,value,updated_at FROM app_settings WHERE substr(key,1,?)=?').all(prefix.length,prefix).sort((a,b)=>JSON.parse(a.value).sequence-JSON.parse(b.value).sequence)
  let previous=null
  for(const [sequence,row]of phaseRows.entries()){
    const fact=JSON.parse(row.value)
    assert.equal(fact.version,version===5?1:2);assert.equal(fact.sequence,sequence);assert.equal(fact.previousFactHash,previous)
    assert.equal(fact.jobHash,head.jobHash);assert.equal(fact.requestHash,job.requestHash)
    assert.equal(fact.operationId,operationId);assert.equal(fact.attemptId,head.attemptId)
    if(version===6)assert.equal(fact.blocked,null)
    previous=hash(row.value)
  }
  const immutableSettings=db.prepare('SELECT key,value,updated_at FROM app_settings ORDER BY key').all().filter(row=>[
    'sync.webdav.protocol5.exchange-job.v1.','sync.webdav.protocol5.exchange-job-phase.v1.',
    'sync.webdav.protocol5.exchange-host-cut.v1.','sync.webdav.protocol5.exchange-history-row.v1.','sync.webdav.protocol5.exchange-history-index.v1.',
    'sync.webdav.protocol5.exchange-preview.v2.','sync.webdav.protocol5.exchange-both-preview.v2.'
  ].some(prefix=>row.key.startsWith(prefix)))
  return {headRow,head,jobRow,job,phaseRows,immutableSettings,
    receipt:db.prepare('SELECT * FROM synced_operations WHERE client_operation_id=?').get(operationId)??null,
    operations:db.prepare('SELECT * FROM synced_operations ORDER BY client_operation_id').all(),
    attempts:db.prepare('SELECT * FROM synced_exposure_attempts ORDER BY id').all(),
    members:db.prepare('SELECT * FROM synced_group_exposure_members ORDER BY attempt_id,group_id').all()}
}
function close(f){for(const p of new Set([f.S,f.A,f.B]))if(p.db.open)p.db.close();for(const p of new Set([f.S,f.A,f.B]))assert.equal(p.db.open,false)}

try{
  await old.withKnowledge(async f=>{
    active=f
    try{
      const conflict=await old.divergeGroup(f)
      // An independent actual incoming host makes a late SQL failure a real
      // graph-application rollback, rather than a metadata-only assertion.
      const incoming='Actual old'+version+' incoming island '+config.caseName
      old.hostEdit(f.A.db,f.islands[1],incoming);old.completed(await f.exchange(f.A),'applied')
      const preview=mode==='conflicts'?old.ready(await f.preview()):old.readyBoth(await f.previewBoth())
      const component=mode==='conflicts'?old.component(preview,conflict.key):old.bothComponent(preview,conflict.key)
      const decision=mode==='conflicts'?old.side(component,'local'):old.selectBoth(component,{copies:[],hosts:'none'})
      assert.ok(component.keys.includes(f.denialKey),'The real component includes the fixed deleted Origin, not a disconnected mock denial')
      const originalDenial=old.captureDenial(f.B.db,f.denialKey)
      const operationId=randomUUID(),input={...f.input(operationId,f.B),previewId:preview.previewId,decisions:[decision]},controller=new AbortController()
      const call=()=>f.track(oldProduct[mode==='conflicts'?'resolveSyncedExchangeConflicts':'resolveSyncedExchangeBoth'](f.B.db,input,{...runtime,signal:controller.signal}))
      const beforeState=f.B.db.prepare("SELECT key,value,updated_at FROM app_settings WHERE key LIKE 'sync.webdav.protocol5.exchange.v1.%'").all()
      const beforePhysical=old.liveKnowledge(f.B.db),beforeRemote=f.remote()
      const beforeLocal=old.snapshot(f.B.db,conflict.id),beforeOriginal=old.snapshot(f.A.db,conflict.id)
      const fork=mode==='both'?component.groups.find(row=>row.sourceGroupId===conflict.id):null
      if(mode==='both')assert.ok(fork,'The original preview fixes a real orphan destination before any write')
      const phasePrefix='sync.webdav.protocol5.exchange-job-phase.v1.'+operationId+'.'
      const phaseWhen='substr(NEW.key,1,'+phasePrefix.length+')='+quote(phasePrefix)
      const trigger='compat_v56_'+config.caseName.replaceAll('-','_')
      let triggerSql=null,hits=0,failure=null,legacyResult=null
      const witnesses=[],requestStart=f.server.requests.length
      if(phaseCase==='prepared')triggerSql='CREATE TRIGGER '+trigger+' BEFORE INSERT ON app_settings WHEN '+phaseWhen+" AND json_extract(NEW.value,'$.phase')='possible' BEGIN SELECT RAISE(ABORT,'actual old56 prepared claim abort'); END"
      if(phaseCase==='possible')f.server.setHook(request=>{if(!hits&&request.method==='HEAD'&&request.path.includes('/objects/')){hits++;return {kind:'disconnect'}}})
      if(phaseCase==='remote-confirmed'){
        f.B.db.function('compat_v56_abort',()=>{hits++;controller.abort('old56 confirmed then abort');return 0})
        triggerSql='CREATE TRIGGER '+trigger+' AFTER INSERT ON app_settings WHEN '+phaseWhen+" AND json_extract(NEW.value,'$.phase')='remote-confirmed' BEGIN SELECT compat_v56_abort(); END"
      }
      if(phaseCase==='published-local-deferred'){
        f.B.db.function('compat_v56_scalar',(incoming,denials,forks)=>{witnesses.push({incoming,denials,forks});return 0})
        triggerSql='CREATE TRIGGER '+trigger+' BEFORE INSERT ON synced_operations WHEN NEW.client_operation_id='+quote(operationId)+
          ' BEGIN SELECT compat_v56_scalar((SELECT count(*) FROM blocks WHERE document_id='+quote(f.islands[1])+' AND content='+quote(incoming)+
          "),(SELECT count(*) FROM synced_exposure_attempts WHERE channel='logical-deletion-denial-v1'),"+
          (fork?'(SELECT count(*) FROM synced_group_blocks WHERE group_id='+quote(fork.groupId)+')':'0')+
          "); SELECT RAISE(ABORT,'actual old56 late receipt abort'); END"
      }
      if(triggerSql)f.B.db.exec(triggerSql)
      try{
        if(phaseCase==='committed-replay')legacyResult=old.completed(await call(),'applied')
        else{
          let error=null;try{await call()}catch(cause){error=cause}
          assert.ok(error,'The actual original writer must hit its requested real boundary')
          failure={name:error.name,code:error.code,messages:causeMessages(error),stack:error.stack??null}
          writeFresh(join(config.evidence,'original-boundary-error.json'),failure)
          assert.equal(error.code,phaseCase==='prepared'?'invalid':phaseCase==='published-local-deferred'?'database':'transport')
          if(triggerSql&&phaseCase!=='remote-confirmed')assert.ok(failure.messages.some(message=>message.includes(phaseCase==='prepared'?'actual old56 prepared claim abort':'actual old56 late receipt abort')))
        }
      }finally{f.server.setHook(undefined);if(triggerSql)f.B.db.exec('DROP TRIGGER '+trigger)}
      const saved=rows(f.B.db,operationId),expectedPhase=phaseCase==='committed-replay'?'settled':phaseCase
      assert.equal(JSON.parse(saved.phaseRows.at(-1).value).phase,expectedPhase,'Only a genuinely reached original phase is handed off')
      assert.ok(saved.job.descriptor.members.length>0,'The exposure claim contains only genuine current live groups')
      const spoolDirectory=join(f.B.root,'storage','synced-exchanges-v1',operationId,saved.head.attemptId)
      const privateInput=JSON.parse(readFileSync(join(spoolDirectory,'inputs.json'),'utf8'))
      assert.equal(privateInput.version,version);assert.equal(privateInput.plannerVersion,plannerVersion)
      assert.deepEqual(privateInput.request,saved.job.request);assert.deepEqual(privateInput.knowledgeSource,saved.job.knowledgeSource)
      assert.equal(hash(old.encode(privateInput.knowledgeSource)),saved.job.knowledgeHash)
      assert.equal(privateInput.knowledgeHash,saved.job.knowledgeHash)
      assert.deepEqual(privateInput.plan.knowledgeSource,saved.job.knowledgeSource)
      assert.equal(privateInput.plan.knowledgeHash,saved.job.knowledgeHash)
      assert.ok(privateInput.plan.componentFences.some(row=>row.keys.includes(conflict.key)&&row.fixedDenialKeys.includes(f.denialKey)), 'The original private plan authenticates the full live/fixed partition')
      assert.deepEqual(privateInput.plan.nextBaseline.filter(row=>row.key===f.denialKey),[originalDenial.baseline],'Old5/6 carry every original absence baseline field exactly')
      assert.equal(Object.hasOwn(privateInput.plan,'deletions'),false)
      if(version===6){assert.deepEqual(privateInput.plan.forks,saved.job.forks);assert.ok(privateInput.bothSelections.allocation&&privateInput.bothSelections.poolAllocation,'The original private inputs retain both fixed candidate pool and accepted allocation');assert.equal(privateInput.bothSelections.selections.length,1)}
      assert.equal(hash(readFileSync(join(spoolDirectory,'job.json'))),hash(saved.jobRow.value))
      const manifestBytes=readFileSync(join(spoolDirectory,'manifest.json')),expectedManifest=JSON.parse(manifestBytes.toString())
      assert.equal(hash(manifestBytes),saved.job.descriptor.next.manifestHash)
      assert.equal(expectedManifest.entries[f.denialKey],originalDenial.tombstoneHash)
      if(['prepared','possible'].includes(phaseCase))assert.deepEqual(f.remote().bytes,beforeRemote.bytes)
      else assert.deepEqual(f.remote().bytes,manifestBytes,'The original old5/6 remote publication is exact')
      if(phaseCase!=='committed-replay'){
        assert.equal(saved.receipt,null);assert.deepEqual(old.liveKnowledge(f.B.db),beforePhysical)
        assert.deepEqual(f.B.db.prepare("SELECT key,value,updated_at FROM app_settings WHERE key LIKE 'sync.webdav.protocol5.exchange.v1.%'").all(),beforeState)
      }else{
        assert.equal(JSON.parse(saved.receipt.result_json).version,version)
        old.hostEdit(f.B.db,f.islands[2],'Later live body survives the original5/6 ACK')
        f.server.files.delete('/'+f.targetConfig.directory+'/manifest.json')
      }
      if(phaseCase==='prepared')assert.equal(saved.attempts.some(row=>row.id===saved.head.attemptId),false)
      if(['possible','remote-confirmed'].includes(phaseCase))assert.equal(hits,1)
      if(phaseCase==='published-local-deferred')assert.ok(witnesses.some(row=>row.incoming===1&&row.denials>0&&(version===5||row.forks>0)),'Actual native SQL saw incoming state, old denial and the new fork, if any, before rollback')
      assert.deepEqual(old.captureDenial(f.B.db,f.denialKey),originalDenial)
      const handoff={caseName:config.caseName,phaseCase,mode,version,plannerVersion,operationId,input,runtime,oldCommit:config.oldCommit,
        profile:{root:f.B.root,file:f.B.file},expectedPhase,saved,expectedManifest,expectedBaseline:privateInput.plan.nextBaseline,
        expectedManifestHash:hash(manifestBytes),legacyResult,spoolDirectory,spoolFiles:inventory(spoolDirectory),
        previewDirectory:join(f.B.root,'storage',mode==='conflicts'?'synced-exchange-previews-v2':'synced-exchange-both-previews-v2',preview.previewId),
        denialKey:f.denialKey,originalDenial,groupId:conflict.id,beforeLocal,beforeOriginal,fork,component,decision,
        incomingDocumentId:f.islands[1],incoming,injection:{triggerSql,hits,failure,witnesses},requestStart}
      handoff.previewFiles=inventory(handoff.previewDirectory)
      writeFresh(join(config.evidence,'legacy-handoff.json'),handoff)
      dumpRequests(f.server.requests,join(config.evidence,'legacy-requests.json'));dumpRemote(f.server,join(config.evidence,'remote-before-current'))
      close(f);writeFresh(join(config.evidence,'profile-before-inventory.json'),copyTreeFresh(f.B.root,join(config.evidence,'profile-before-current')))
      writeFresh(join(config.evidence,'legacy-connections-closed.json'),{pid:process.pid,connectionsClosed:true,at:new Date().toISOString()})
      const currentStart=f.server.requests.length
      writeFresh(join(config.evidence,'current-input.json'),{currentRoot:config.currentRoot,handoffPath:join(config.evidence,'legacy-handoff.json'),evidence:config.evidence})
      const currentProcess=await runChild({name:'current',script:config.currentDriver,args:[join(config.evidence,'current-input.json')],cwd:config.currentRoot,loader:config.loader,tsconfig:join(config.currentRoot,'tsconfig.test.json'),evidence:config.evidence})
      assert.notEqual(currentProcess.pid,process.pid)
      const currentResult=JSON.parse(readFileSync(join(config.evidence,'current-result.json'),'utf8'))
      const profileAfter=copyTreeFresh(f.B.root,join(config.evidence,'profile-after-current'));writeFresh(join(config.evidence,'profile-after-inventory.json'),profileAfter)
      dumpRequests(f.server.requests,join(config.evidence,'all-requests.json'));dumpRemote(f.server,join(config.evidence,'remote-after-current'))
      if(phaseCase==='committed-replay'){assert.equal(f.server.requests.length,currentStart,'Historical5/6 ACK is zero HTTP');assert.deepEqual(profileAfter,currentResult.profileBeforeReplay)}
      else{
        assert.deepEqual(f.remote().bytes,manifestBytes);assert.equal(currentResult.result.afterManifestHash,hash(manifestBytes))
        if(['remote-confirmed','published-local-deferred'].includes(phaseCase))assert.deepEqual(f.server.requests.slice(currentStart).filter(row=>['PUT','MOVE','DELETE','MKCOL'].includes(row.method)),[])
      }
      f.server.assertNoHookErrors()
      completed={status:'passed',caseName:config.caseName,version,operationId,expectedPhase,originalAttemptId:saved.head.attemptId,originalJobHash:saved.head.jobHash,
        handoffSha256:hashFile(join(config.evidence,'legacy-handoff.json')),currentResultSha256:hashFile(join(config.evidence,'current-result.json')),
        originalPhaseCount:saved.phaseRows.length,currentHttpRequests:f.server.requests.length-currentStart,legacyPid:process.pid,currentPid:currentProcess.pid,currentProcess,completedAt:new Date().toISOString()}
      writeFresh(join(config.evidence,'case-result.json'),completed)
    }catch(error){f.server.setHook(undefined);close(f);if(!existsSync(join(config.evidence,'failure-profile')))copyTreeFresh(f.B.root,join(config.evidence,'failure-profile'));if(!existsSync(join(config.evidence,'failure-requests.json')))dumpRequests(f.server.requests,join(config.evidence,'failure-requests.json'));if(!existsSync(join(config.evidence,'failure-remote')))dumpRemote(f.server,join(config.evidence,'failure-remote'));throw error}
  },{assets:true})
  assert.ok(completed);process.stdout.write(JSON.stringify({status:'passed',caseName:config.caseName,operationId:completed.operationId})+'\n')
}catch(error){if(active)close(active);writeFresh(join(config.evidence,'legacy-failure.json'),{status:'failed',pid:process.pid,caseName:config.caseName,messages:causeMessages(error),stack:error instanceof Error?error.stack:null,at:new Date().toISOString()});process.stderr.write((error instanceof Error?error.stack:String(error))+'\n');process.exitCode=1}
