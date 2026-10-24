import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile,realpath } from 'node:fs/promises'
import { join,relative,isAbsolute } from 'node:path'
import { withMixedBundleFixture,readPreparedMixedOriginBundle } from './helpers/mixed-origin-bundle-fixture'
import { removeRequiredDagFixtureDirectory } from './helpers/required-sql-dag-fixture'

test('mixed capsule2 origin bundle independently restarts after source assets and exported catalog disappear and old verification SQL is poisoned',()=>withMixedBundleFixture([2,2],async f=>{
  for(const side of f.pair.sides)await writeFile(side.original.info.databasePath,'old scratch is not a mounted original')
  // Windows TEMP may use an 8.3 alias; Main exports use the real owner path.
  const sourceRoot=await realpath(f.source.userDataRoot)
  for(const path of [join(sourceRoot,'storage','assets'),f.exported.directory]){
    const child=relative(sourceRoot,path);assert.ok(child&&!child.startsWith('..')&&!isAbsolute(child))
    await removeRequiredDagFixtureDirectory(path,sourceRoot)
  }
  // A new process must create its own verification profile from the mounted originals.
  const {readdir}=await import('node:fs/promises')
  const mount=join(f.receiver.userDataRoot,'backups','database-restore',f.reopen.operationId,'mixed-origin-bundle-mounts',f.reopen.mountId)
  for(const entry of await readdir(join(mount,'verification-profiles'))) {
    const path=join(mount,'verification-profiles',entry)
    const node=f.captured.material.node
    for(const binding of [node.source,node.current])await writeFile(join(path,'backups','database-restore',binding.capsule.operationId,
      'knowledge-capsules',binding.capsule.capsuleId,'original','knowbook.db'),'poison old verification original')
  }
  await assert.rejects(readPreparedMixedOriginBundle(f.handle),/hash|原件|bytes|变化/)
  // This new mount-reopen case also copies a complete verification profile.
  // Bound the child within the unchanged 120s file limit and retain its actual
  // native exit details; this is a correctness guard, not a latency assertion.
  const childStarted=Date.now()
  const execution=promisify(execFile)(process.execPath,['--import','tsx','tests/helpers/mixed-origin-bundle-process.cjs',JSON.stringify(f.reopen)],
    {cwd:process.cwd(),env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},windowsHide:true,timeout:60_000,maxBuffer:32*1024*1024,encoding:'utf8'})
  const {stdout}=await execution.catch(error=>{
    console.error('[mixed-bundle-child-exit] '+JSON.stringify({pid:execution.child.pid,parentPid:process.pid,
      elapsedMs:Date.now()-childStarted,code:error.code,signal:error.signal,killed:error.killed,stderr:error.stderr,stdoutBytes:error.stdout?.length}))
    throw error
  })
  console.error('[mixed-bundle-child-complete] '+JSON.stringify({pid:execution.child.pid,parentPid:process.pid,elapsedMs:Date.now()-childStarted}))
  const result=JSON.parse(stdout);assert.notEqual(result.pid,process.pid);assert.deepEqual(result.value,f.value)
}))
