import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { BACKUP_V3_MAX_ASSET_BYTES, buildBackupV3Files } from '../src/main/backup/v3-format'
import { KnowbookStore } from '../src/main/database/store'
import { canonicalRestoreRoot, copyRestoreInventory, restoreExists, restoreInventory, restorePaths } from '../src/main/database/restore-safety-files'
import { recoverControlledDatabaseRestore } from '../src/main/database/restore-safety'
import { validateCapsule2ManagedTree } from '../src/main/database/restore-knowledge-capsule2-assets-model'
import { prepareCapsule2AssetArchiveWithInstalledV3, readCapsule2AssetArchive, reopenCapsule2AssetArchive } from '../src/main/database/restore-knowledge-capsule2-asset-archive'
import { prepareDurableSqlCapsuleOriginal, reopenPreparedRawCapsuleOriginal } from '../src/main/database/restore-knowledge-capsule-files'
import { captureInstalledV3AssetContinuity } from '../src/main/database/restore-knowledge-installed-v3-assets'
import { captureSyncedBackupV3, readSyncedBackupV3Capture } from '../src/main/database/synced-backup-v3'
import { buildSyncedPortableAssetUri, syncedPortableAssetBackupPath } from '../src/shared/syncedBlockPortable'
import { randomUUID, withV3Fixture } from './helpers/synced-backup-v3-fixture'

const install = promisify(execFile), worker = fileURLToPath(new URL('./helpers/restore-installed-v3-first.cjs', import.meta.url))

test('next current capture reopens one actually installed 50 MiB V3 alias and refuses unrelated equal bytes', () => withV3Fixture(async f => {
  const captured = readSyncedBackupV3Capture(captureSyncedBackupV3(f.db))
  assert.ok(captured)
  const bytes = Buffer.alloc(BACKUP_V3_MAX_ASSET_BYTES, 0xb7), name = 'large original.bin'
  const hash = createHash('sha256').update(bytes).digest('hex')
  const uri = buildSyncedPortableAssetUri({ hash, name })
  const target = captured.documents.find(doc => doc.id === f.targetId)
  assert.ok(target)
  const documents = [{ ...target, summary: `![large](<${uri}>)` }]
  const assets = [{ relativePath: syncedPortableAssetBackupPath(uri), name, hash, bytes }]
  const first = join(f.root, 'first-v3')
  for (const file of buildBackupV3Files({ documents, catalog: { ...captured.catalog, entities: [] }, groups: [],
    standaloneDatabases: [], assets }, randomUUID())) {
    const destination = join(first, ...file.relativePath.split('/'))
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, file.bytes, { flag: 'wx' })
  }
  const requested = join(f.root, 'receiver')
  await mkdir(requested)
  const root = await canonicalRestoreRoot(requested), db = join(root, 'storage', 'knowbook.db')
  KnowbookStore.createEmptySyncedReceiver(db).destroy()
  const command = await install(process.execPath, ['--import','tsx',worker,root,first], {
    timeout: 100_000, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  })
  const one = JSON.parse(command.stdout) as { status: string; operationId: string }
  assert.equal(one.status, 'installed')
  await rename(first, first + '-moved')
  const folder = join(root, 'storage', 'assets', 'attachments', hash.slice(0, 2), hash)
  const live = join(folder, name), forged = join(folder, 'equal bytes but new name.bin')
  let reopenedInstall = 0
  const captureNext = async () => {
    const operationId = randomUUID(), p = restorePaths(root, operationId), capsuleId = randomUUID()
    await mkdir(p.recovery, { recursive: true })
    const current = await restoreInventory(p.storage)
    await copyRestoreInventory(p.storage, p.safety, current, root)
    const original = await prepareDurableSqlCapsuleOriginal({ profileRoot: root, recoveryDirectory: p.recovery, sealedDirectory: p.safety,
      capsuleId, label: 'test subsequent current with installed large V3 alias' })
    const handle = await prepareCapsule2AssetArchiveWithInstalledV3(original, async () => {
      reopenedInstall++
      return captureInstalledV3AssetContinuity(root, one.operationId)
    })
    const archive = await readCapsule2AssetArchive(handle)
    return { archive, operationId, capsuleId, current }
  }
  await copyFile(live, forged)
  await assert.rejects(captureNext(), /25MiB/)
  assert.equal(await restoreExists(forged), true)
  await rename(forged, join(f.root, 'forged-alias-held'))
  const capturedNext = await captureNext(), { archive } = capturedNext
  assert.equal(reopenedInstall, 2, 'Each capture authenticates the original installation once')
  const held = join(f.root, 'actual-installed-alias-held')
  await rename(live, held)
  await copyFile(held, live)
  await assert.rejects(captureNext(), /其他实际文件替换/)
  await rename(live, join(f.root, 'replaced-alias-held'))
  const small = await captureNext()
  assert.equal(small.archive.manifest.version, 2)
  assert.equal(reopenedInstall, 3, 'The legacy-sized tree does not reopen installed V3 originals')
  const raw = await reopenPreparedRawCapsuleOriginal({ profileRoot: root, operationId: capturedNext.operationId,
    capsuleId: capturedNext.capsuleId, expectedInventory: archive.manifest.sourceInventory })
  const cold = await reopenCapsule2AssetArchive(raw, archive.manifestHash)
  const current = (await readCapsule2AssetArchive(cold)).manifest
  assert.equal(current.version, 7)
  if (current.version !== 7) throw new Error('Expected installed-alias continuity archive')
  assert.equal(current.installedV3.root.operationId, one.operationId)
  assert.deepEqual(current.installedV3.aliases.map(alias => [alias.hash, alias.name, alias.bytes]), [[hash, name, bytes.length]])
  assert.throws(() => validateCapsule2ManagedTree(current.tree), /有限整数无效/)
  assert.equal(await recoverControlledDatabaseRestore(root, async () => { throw new Error('Unexpected legacy restore') }), true)
}))
