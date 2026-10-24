import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile,writeFile,link,unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { withMixedBundleFixture,readPreparedMixedOriginBundle } from './helpers/mixed-origin-bundle-fixture'
import { mixedOriginBundleFiles } from '../src/main/database/restore-knowledge-mixed-origin-bundle-model'

test('mounted mixed original rejects late SQL and managed blob bytes and an outside hardlink without borrowing local originals',()=>withMixedBundleFixture([2,2],async f=>{
  const root=join(f.receiver.userDataRoot,'backups','database-restore',f.reopen.operationId,'mixed-origin-bundle-mounts',f.reopen.mountId,'original')
  const files=mixedOriginBundleFiles(f.exported.descriptor),selected=[files.find(f=>f.path.endsWith('/original/knowbook.db'))!,files.find(f=>/\/files\//.test(f.path))!]
  for(const file of selected){const path=join(root,...file.path.split('/')),bytes=await readFile(path),changed=Buffer.from(bytes);changed[changed.length-1]^=1
    try {await writeFile(path,changed);await assert.rejects(readPreparedMixedOriginBundle(f.handle),/hash|bytes|原件|变化/)}
    finally {await writeFile(path,bytes)}
    assert.deepEqual(await readFile(path),bytes)
  }
  const path=join(root,...selected[0].path.split('/')),other=join(f.receiver.root,'outside-catalog-hardlink')
  await link(path,other)
  try {await assert.rejects(readPreparedMixedOriginBundle(f.handle),/独立|原件|文件/)} finally {await unlink(other)}
  const extra=join(root,'caller-extra.json');await writeFile(extra,'{}')
  try {await assert.rejects(readPreparedMixedOriginBundle(f.handle),/额外|缺失|catalog/)} finally {await unlink(extra)}
  assert.deepEqual(await readPreparedMixedOriginBundle(f.handle),f.value)
}))
