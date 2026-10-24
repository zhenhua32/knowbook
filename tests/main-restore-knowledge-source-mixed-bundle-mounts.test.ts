import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile,writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withMixedBundleFixture,readPreparedMixedOriginBundle } from './helpers/mixed-origin-bundle-fixture'
import { capturePreparedMixedOriginBundle } from '../src/main/database/restore-knowledge-mixed-origin-bundle-read'
import { mixedOriginBundleFiles } from '../src/main/database/restore-knowledge-mixed-origin-bundle-model'

test('mixed mounts with identical original UUIDs cannot borrow each other after one mounted original changes',()=>withMixedBundleFixture([1,2],async f=>{
  const {bundle:second,value:before}=await capturePreparedMixedOriginBundle(f.input)
  const file=mixedOriginBundleFiles(f.exported.descriptor).find(f=>f.path.endsWith('/original/knowbook.db'))!
  const firstRoot=join(f.receiver.userDataRoot,'backups','database-restore',f.reopen.operationId,'mixed-origin-bundle-mounts',f.reopen.mountId,'original')
  const path=join(firstRoot,...file.path.split('/')),bytes=await readFile(path),changed=Buffer.from(bytes);changed[changed.length-1]^=1
  try {
    await writeFile(path,changed);await assert.rejects(readPreparedMixedOriginBundle(f.handle),/hash|bytes|变化/)
    assert.deepEqual(await readPreparedMixedOriginBundle(second),before)
  } finally {await writeFile(path,bytes)}
  assert.deepEqual(await readPreparedMixedOriginBundle(f.handle),f.value)
}))
