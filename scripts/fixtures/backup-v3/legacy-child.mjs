import assert from 'node:assert/strict'
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {inventory,writeFresh,runChild} from './evidence.mjs'

const input=JSON.parse(readFileSync(process.argv[2],'utf8'))
assert.equal(input.oldCommit,'a62a69807b57375fb7b0e359102244d68795a657')
const {KnowbookStore}=await import(pathToFileURL(join(input.oldSource,'src/main/database/store.ts')).href)
const {MarkdownRestoreService}=await import(pathToFileURL(join(input.oldSource,'src/main/backup/importer.ts')).href)
const target=join(input.evidence,'old-target'),assets=join(input.evidence,'old-assets')
mkdirSync(target);mkdirSync(assets)
writeFileSync(join(assets,'preserved.bin'),Buffer.from([7,11,19,31]),{flag:'wx'})
const store=new KnowbookStore(join(target,'knowbook.db'))
try {
  store.createDocument(null)
  assert.equal(store.db.pragma('user_version',{simple:true}),25,'The actual old reader opens its supported original schema')
  const before=store.getExportWorkspaceSnapshot(),targetFiles=inventory(target),assetFiles=inventory(assets)
  const currentInput=join(input.evidence,'current-input.json')
  const archive=join(input.evidence,'actual-v3-archive')
  writeFresh(currentInput,{...input,archive})
  const currentProcess=await runChild({name:'current-main-producer',script:input.currentDriver,args:[currentInput],cwd:input.currentRoot,
    loader:input.loader,tsconfig:join(input.currentRoot,'tsconfig.test.json'),evidence:input.evidence})
  const produced=JSON.parse(readFileSync(join(input.evidence,'current-producer-result.json'),'utf8'))
  assert.equal(produced.status,'passed');assert.ok(produced.groups>0,'The real archive contains an actual canonical group')
  const archiveBefore=inventory(archive)
  const restore=new MarkdownRestoreService(store,assets),errors=[]
  for(const operation of ['previewFromDirectory','restoreFromDirectory']) {
    await assert.rejects(async()=>{
      try {await restore[operation](archive)} catch(error){errors.push({operation,name:error.name,message:error.message});throw error}
    },/unsupported backupFormatVersion/,'The complete genuine old backup reader must reject the actual V3 archive')
    assert.deepEqual(store.getExportWorkspaceSnapshot(),before,'Old rejection leaves every exported target row unchanged')
    assert.deepEqual(inventory(target),targetFiles,'Old rejection leaves exact target DB/WAL/SHM bytes unchanged')
    assert.deepEqual(inventory(assets),assetFiles,'Old rejection never stages or publishes incoming assets')
    assert.deepEqual(inventory(archive),archiveBefore,'The old reader does not modify the source archive')
  }
  writeFresh(join(input.evidence,'case-result.json'),{status:'passed',caseName:input.caseName,oldCommit:input.oldCommit,
    currentProcess,produced,errors,targetBefore:targetFiles,targetAfter:inventory(target),assetsBefore:assetFiles,assetsAfter:inventory(assets),
    archiveBefore,archiveAfter:inventory(archive),exactOldSchema:25})
} finally {store.destroy()}
