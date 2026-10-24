import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { unlink,writeFile } from 'node:fs/promises'
import { join,resolve } from 'node:path'
import { withV3Fixture,mixedPair } from './helpers/mixed-required-source-fixture'
import { readCapsule2AssetArchive } from '../src/main/database/restore-knowledge-capsule2-asset-archive'
import { restoreInventory } from '../src/main/database/restore-safety-files'

test('actual mixed DAG K3 material fully reopens both capsule2 originals in a fresh hidden process after live assets vanish and old scratches are poisoned',()=>withV3Fixture(async f=>{
  const pair=await mixedPair(f,[2,2]),saved=await pair.capture(),archive=await readCapsule2AssetArchive(pair.sides[0].archive!)
  for(const alias of archive.manifest.tree.aliases)await unlink(join(f.assets.root,alias.relativePath))
  for(const side of pair.sides)await writeFile(side.original.info.databasePath,'poisoned prior scratch')
  const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx',resolve('tests/helpers/mixed-required-dag-process.cjs'),JSON.stringify(saved.reopen)],
    {env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},windowsHide:true,timeout:30_000,maxBuffer:32*1024*1024})
  const actual=JSON.parse(stdout);assert.notEqual(actual.pid,process.pid);assert.deepEqual(actual.material,saved.material)
  for(const side of pair.sides)assert.deepEqual(await restoreInventory(side.original.info.originalDirectory),side.original.inventory)
}))
