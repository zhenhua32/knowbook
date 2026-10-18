import assert from 'node:assert/strict'
import { existsSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { cleanupSystemPluginsForApplicationUninstall } from '../src/main/system-plugin/uninstall-cleanup'
import type { FullTrustElectronLoginItemApplication } from '../src/main/system-plugin/os-persistence'
import { withControlledRestore, restoreKnowbookDatabase, noProcesses } from './helpers/controlled-restore-fixture'

test('Windows uninstall cleanup authenticates an existing controlled restore fence even when current DB and pending journal are missing', { skip: process.platform !== 'win32' }, () => withControlledRestore(async f => {
  f.sealCurrent()
  const result = await restoreKnowbookDatabase({ userDataRoot: f.profile, backupPath: f.backup, stopProcesses: noProcesses })
  assert.equal(result.continuity, 'ordinary-verified')
  const fencePath = join(f.profile, 'database-restore-fence.json'), fence = Buffer.from(readFileSync(fencePath)), archived = join(f.root, 'removed-real-current.db')
  const installed = Buffer.from(readFileSync(f.database))
  renameSync(f.database, archived)
  assert.equal(existsSync(f.database), false)
  assert.equal(existsSync(join(f.profile, 'database-restore-pending.json')), false)
  let writes = 0, reads = 0
  const app: FullTrustElectronLoginItemApplication = {
    setLoginItemSettings() { writes++ },
    getLoginItemSettings() { reads++; return { openAtLogin: false } }
  }
  await assert.rejects(cleanupSystemPluginsForApplicationUninstall({ userDataRoot: f.profile,
    executable: join(f.root, 'KnowBook.exe'), app, discoverProfiles: async () => [] }))
  assert.equal(writes, 0)
  assert.equal(reads, 0)
  assert.equal(existsSync(f.database), false)
  assert.deepEqual(readFileSync(archived), installed)
  assert.deepEqual(readFileSync(fencePath), fence)
  assert.deepEqual(readFileSync(f.backup), f.sourceBytes)
}))
