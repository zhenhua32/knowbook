import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { readdir,rmdir,mkdir } from 'node:fs/promises'
import { join,basename } from 'node:path'
import { withV3Fixture } from './helpers/synced-backup-v3-fixture'
import { captureMixedSource } from './helpers/mixed-required-source-fixture'
import { captureActualFirstRequiredSqlDag } from '../src/main/database/restore-knowledge-mixed-required-dag-read'
import { exportPreparedMixedOriginBundle,importPreparedMixedOriginBundle,readPreparedMixedOriginBundle } from '../src/main/database/restore-knowledge-mixed-origin-bundle-read'
import { mixedOriginBundleDirectories } from '../src/main/database/restore-knowledge-mixed-origin-bundle-model'

test('mixed capsule2 catalog retains both mandatory empty blob directories and rejects a missing empty directory',()=>withV3Fixture(source=>withV3Fixture(async receiver=>{
  const sides=[await captureMixedSource(source,2),await captureMixedSource(source,2)]
  const dag=await captureActualFirstRequiredSqlDag({profileRoot:source.userDataRoot,operationId:basename(sides[0].original.info.recoveryDirectory),dagId:randomUUID(),source:sides[0].handle,current:sides[1].handle})
  const exported=await exportPreparedMixedOriginBundle(dag,{operationId:randomUUID(),bundleId:randomUUID()}),operationId=randomUUID()
  const handle=await importPreparedMixedOriginBundle({profileRoot:receiver.userDataRoot,operationId,sourceDirectory:exported.directory}),value=await readPreparedMixedOriginBundle(handle)
  assert.equal(value.root.namespace.kind,'imported-bundle');assert.equal(value.managedOriginalBytes,0)
  const root=join(receiver.userDataRoot,'backups','database-restore',operationId,'mixed-origin-bundle-mounts',value.root.namespace.mountId,'original')
  const empty=mixedOriginBundleDirectories(exported.descriptor).filter(p=>p.endsWith('/files'));assert.equal(empty.length,2)
  for(const path of empty)assert.deepEqual(await readdir(join(root,...path.split('/'))),[])
  const path=join(root,...empty[0].split('/'));await rmdir(path)
  try {await assert.rejects(readPreparedMixedOriginBundle(handle),/缺失|catalog|目录/)} finally {await mkdir(path)}
  assert.deepEqual(await readPreparedMixedOriginBundle(handle),value)
})))
