import assert from 'node:assert/strict'
import {readFileSync,mkdirSync} from 'node:fs'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {randomUUID} from 'node:crypto'
import {writeFresh,inventory} from './evidence.mjs'

const input=JSON.parse(readFileSync(process.argv[2],'utf8'))
const {createV3Fixture,addV3Assets}=await import(pathToFileURL(join(input.currentRoot,'tests/helpers/synced-backup-v3-fixture.ts')).href)
const {writeSyncedBackupV3}=await import(pathToFileURL(join(input.currentRoot,'src/main/backup/v3-export.ts')).href)
const {readBackupV3Archive}=await import(pathToFileURL(join(input.currentRoot,'src/main/backup/v3-reader.ts')).href)
const source=join(input.evidence,'current-profile')
mkdirSync(source)
const f=createV3Fixture(source)
try {
  await addV3Assets(f)
  const result=writeSyncedBackupV3(f.db,{userDataRoot:f.userDataRoot,destination:input.archive,snapshotId:randomUUID()})
  const archive=readBackupV3Archive(input.archive)
  assert.ok(archive.groups.length>0);assert.ok(archive.assets.length>0)
  assert.equal(archive.manifest.snapshotId,result.snapshotId)
  writeFresh(join(input.evidence,'current-producer-result.json'),{status:'passed',result,groups:archive.groups.length,
    documents:archive.documents.length,assets:archive.assets.length,files:inventory(input.archive),source:'actual-current-Main-to-files-to-independent-strict-reader'})
} finally {f.close()}
