import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {readFileSync,mkdirSync} from 'node:fs'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {inventory,hashFile,writeFresh} from './evidence.mjs'
const input=JSON.parse(readFileSync(process.argv[2],'utf8'))
const {KnowbookStore}=await import(pathToFileURL(join(input.currentRoot,'src/main/database/store.ts')).href)
const {restoreKnowbookDatabase,recoverInterruptedDatabaseRestore}=await import(pathToFileURL(join(input.currentRoot,'src/main/database/restore-maintenance.ts')).href)
const require=createRequire(pathToFileURL(join(input.currentRoot,'package.json'))),Database=require('better-sqlite3')
const profile=join(input.evidence,'current-profile'),storage=join(profile,'storage'),database=join(storage,'knowbook.db')
mkdirSync(profile);mkdirSync(storage)
const original=new KnowbookStore(database)
try {const id=original.createDocument(null);original.updateDocument(id,{title:'当前普通工作区',summary:'保真实原件',blocks:[]})} finally {original.destroy()}
function workspace(){const db=new Database(database,{readonly:true,fileMustExist:true});try{return db.prepare('SELECT workspace_scope,recovery_epoch FROM synced_workspace_state WHERE singleton=1').get()}finally{db.close()}}
function shape(value){return {id:value.id,title:value.title,summary:value.summary,blocks:value.blocks.map(b=>({id:b.id,type:b.type,content:b.content,checked:b.checked,depth:b.depth,parentBlockId:b.parentBlockId}))}}
const identity=workspace(),before=inventory(storage).filter(row=>['knowbook.db','knowbook.db-wal','knowbook.db-shm'].includes(row.path)),sourceBefore=inventory(input.source),sourceHash=hashFile(input.backup),rounds=[]
let previousEpoch=identity.recovery_epoch
for(let round=0;round<2;round++){
 const currentBefore=inventory(storage).filter(row=>['knowbook.db','knowbook.db-wal','knowbook.db-shm'].includes(row.path)),result=await restoreKnowbookDatabase({userDataRoot:profile,backupPath:input.backup,stopProcesses:async()=>[]})
 assert.equal(result.schemaVersion,25);assert.equal(result.installedSchemaVersion,27);assert.equal(result.continuity,'ordinary-verified')
 assert.equal(result.workspaceScope,identity.workspace_scope);assert.notEqual(result.recoveryEpoch,previousEpoch);assert.match(result.recoveryEpoch,/^[0-9a-f-]{36}$/i)
 const originals=inventory(join(result.recoveryDirectory,'original'))
 assert.deepEqual(originals,currentBefore,'Actual original DB/WAL/SHM set is preserved byte for byte')
 assert.deepEqual(inventory(input.source),sourceBefore);assert.equal(hashFile(input.backup),sourceHash)
 const installed=workspace();assert.equal(installed.workspace_scope,result.workspaceScope);assert.equal(installed.recovery_epoch,result.recoveryEpoch)
 const db=new Database(database,{readonly:true,fileMustExist:true});let receipt
 try{assert.equal(db.pragma('user_version',{simple:true}),27);receipt=db.prepare('SELECT value FROM app_settings WHERE key=?').get('database.restore.receipt.'+result.operationId);assert.ok(receipt);assert.doesNotThrow(()=>JSON.parse(receipt.value))}finally{db.close()}
 const reopened=new KnowbookStore(database)
 let detail
 try{
  detail=reopened.getDocumentDetail(input.expected.id);assert.ok(detail);assert.deepEqual(shape(detail),shape(input.expected));assert.notEqual(detail.updatedAt,input.expected.updatedAt)
  assert.throws(()=>reopened.updateDocument(detail.id,{title:detail.title,summary:detail.summary,blocks:detail.blocks,expectedUpdatedAt:input.expected.updatedAt}),/文档已被其他操作或同步更新/,'The original source update token cannot execute after restore')
  if(round===0)reopened.updateDocument(detail.id,{title:'恢复后真实普通写入',summary:detail.summary,blocks:detail.blocks,expectedUpdatedAt:detail.updatedAt})
 }finally{reopened.destroy()}
 assert.equal(await recoverInterruptedDatabaseRestore(profile),true)
 rounds.push({round,result,originals,installed,receipt:JSON.parse(receipt.value),document:shape(detail),updatedAt:detail.updatedAt})
 previousEpoch=result.recoveryEpoch
}
writeFresh(join(input.evidence,'current-result.json'),{status:'passed',sourceSchemaVersion:25,installedSchemaVersion:27,sourceHash,sourceBefore,sourceAfter:inventory(input.source),originalBefore:before,rounds,realRestores:2,oldSourceCasRejected:true,legitimatePostRestoreWriteAccepted:true})
