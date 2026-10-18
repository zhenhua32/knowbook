import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {readFileSync,mkdirSync} from 'node:fs'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {inventory,writeFresh,runChild} from './evidence.mjs'
const input=JSON.parse(readFileSync(process.argv[2],'utf8'))
assert.equal(input.oldCommit,'a62a69807b57375fb7b0e359102244d68795a657')
const {KnowbookStore}=await import(pathToFileURL(join(input.oldSource,'src/main/database/store.ts')).href)
const owner=join(input.evidence,'legacy-producer'),source=join(input.evidence,'legacy-source')
mkdirSync(owner);mkdirSync(source)
const backup=join(source,'genuine-schema25.db'),store=new KnowbookStore(join(owner,'owner.db'))
let expected
try {
 assert.equal(store.db.pragma('user_version',{simple:true}),25)
 const documentId=store.createDocument(null),blockId=randomUUID()
 store.updateDocument(documentId,{title:'真实 schema25 备份',summary:'原版本生成的源',blocks:[{id:blockId,type:'paragraph',content:'genuine original schema25 body',checked:false,depth:0,parentBlockId:null}]})
 expected=store.getDocumentDetail(documentId)
 await store.backupDatabase(backup)
} finally {store.destroy()}
const before=inventory(source),currentInput=join(input.evidence,'current-input.json')
writeFresh(currentInput,{...input,backup,source,expected})
const currentProcess=await runChild({name:'current-controlled-restore',script:input.currentDriver,args:[currentInput],cwd:input.currentRoot,loader:input.loader,tsconfig:join(input.currentRoot,'tsconfig.test.json'),evidence:input.evidence})
const current=JSON.parse(readFileSync(join(input.evidence,'current-result.json'),'utf8'))
assert.equal(current.status,'passed');assert.equal(current.sourceSchemaVersion,25);assert.equal(current.installedSchemaVersion,27)
assert.deepEqual(inventory(source),before,'Current migration/restoration never modifies the real original schema25 backup or creates source sidecars')
writeFresh(join(input.evidence,'case-result.json'),{status:'passed',caseName:input.caseName,oldCommit:input.oldCommit,exactOldSchema:25,expected,currentProcess,current,sourceBefore:before,sourceAfter:inventory(source)})
