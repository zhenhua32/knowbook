import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { lstat, mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { BACKUP_V3_MAX_ASSET_BYTES, buildBackupV3Files } from '../../src/main/backup/v3-format'
import { openBackupV3RestoreSource, readBackupV3RestoreSource } from '../../src/main/backup/v3-reader'
import { tryReadInstalledRestoreAsset4 } from '../../src/main/database/restore-asset-transfer4'
import { readJointRestoreFence4, readJointRestoreIntent4 } from '../../src/main/database/restore-joint-journal4'
import { readRawPriorKnowledgeCoverageOwned } from '../../src/main/database/restore-knowledge-coverage-raw-read'
import { readRestoreKnowledgeInstallProof } from '../../src/main/database/restore-knowledge-install-proof'
import { assertV3SettledPrivateSyncOriginals } from '../../src/main/database/restore-knowledge-settled-private-sync'
import { captureReopenedQualifiedOriginalContent5 } from '../../src/main/database/restore-knowledge-qualified-originals'
import { captureInstalledV3AssetContinuity, readInstalledV3AssetContinuity } from '../../src/main/database/restore-knowledge-installed-v3-assets'
import { assertRestorePath, canonicalRestoreRoot, readRestoreJson, restoreExists, writeRestoreJson } from '../../src/main/database/restore-safety-files'
import { recoverControlledDatabaseRestore, restoreControlledBackupV3 } from '../../src/main/database/restore-safety'
import { KnowbookStore } from '../../src/main/database/store'
import { captureSyncedBackupV3, readSyncedBackupV3Capture } from '../../src/main/database/synced-backup-v3'
import { buildSyncedPortableAssetUri, syncedPortableAssetBackupPath } from '../../src/shared/syncedBlockPortable'
import { settleControlledV3WorkingMany } from './controlled-v3-working-many-settled'

const [phase, destination] = process.argv.slice(2)
const names = ['first', 'second', 'third']
assert.ok(destination && isAbsolute(destination) && [...names, 'settled', 'cold'].includes(phase))
const requested = resolve(destination)
const temporary = await canonicalRestoreRoot(resolve(process.cwd(), '.tmp'))
assert.match(relative(temporary, requested), /^v3-working-many-[0-9a-f-]{36}$/)
await assertRestorePath(requested, temporary)
if (phase === 'first') {
  await mkdir(requested)
}
const root = await canonicalRestoreRoot(requested), profile = join(root, 'receiver')
const database = join(profile, 'storage', 'knowbook.db'), fencePath = join(profile, 'database-restore-fence.json')
const archiveNames = ['backup-first', 'backup-second', 'backup-third']
const titles = ['Original archive attachment', 'Independent second document', 'Independent third-plan document']
const legacy = async () => { throw new Error('Unexpected legacy recovery') }
const timestamp = () => new Date().toISOString()
const attachmentName = 'native large alias.bin'
const byteCount = BACKUP_V3_MAX_ASSET_BYTES
const load = (name: string) => readRestoreJson(join(root, name + '.json')) as Promise<{ operationId: string; hash: string }>
function attachmentPath(hash: string) {
  return join(profile, 'storage', 'assets', 'attachments', hash.slice(0, 2), hash, attachmentName)
}
async function largeIdentities() {
  const facts = await Promise.all(names.slice(0, 2).map(async name => {
    const { hash } = await load(name)
    const info = await lstat(attachmentPath(hash), { bigint: true })
    assert.equal(info.size, BigInt(byteCount))
    return { hash, ino: String(info.ino), dev: String(info.dev) }
  }))
  assert.notEqual(facts[0].ino, facts[1].ino)
  return facts
}

async function createArchive(index: number, archive: string) {
  const donorRoot = join(root, 'source-' + names[index])
  await mkdir(donorRoot)
  const donor = KnowbookStore.createEmptySyncedReceiver(join(donorRoot, 'storage', 'knowbook.db'))
  try {
    const id = donor.createDocument(null)
    donor.updateDocument(id, { title: titles[index], summary: '', blocks: [] })
    const capture = readSyncedBackupV3Capture(captureSyncedBackupV3(donor.getUnsafeDatabaseHandle()))
    assert.ok(capture)
    const bytes = index < 2 ? Buffer.alloc(byteCount, 0x91 + index) : null
    const hash = bytes ? createHash('sha256').update(bytes).digest('hex') : ''
    const uri = bytes ? buildSyncedPortableAssetUri({ hash, name: attachmentName }) : ''
    for (const file of buildBackupV3Files({ catalog: capture.catalog, groups: capture.groups,
      standaloneDatabases: capture.standaloneDatabases,
      documents: capture.documents.map(document => bytes ? { ...document, summary: `![actual](<${uri}>)` } : document),
      assets: bytes ? [{ hash, name: attachmentName, bytes, relativePath: syncedPortableAssetBackupPath(uri) }] : []
    }, randomUUID())) {
      const path = join(archive, ...file.relativePath.split('/'))
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, file.bytes, { flag: 'wx' })
    }
    return hash
  } finally { donor.destroy() }
}

if (phase === 'settled') {
  assert.equal((await readJointRestoreFence4(fencePath)).fence.operationId, (await load('second')).operationId)
  await settleControlledV3WorkingMany(root)
} else if (phase === 'cold') {
  const pins = await Promise.all(names.map(load))
  const settled = await readRestoreJson(join(root, 'settled.json')) as { id: string; operationId: string }
  for (const name of archiveNames) {
    assert.equal(await restoreExists(join(root, name)), false)
    assert.equal(await restoreExists(join(root, name + '-evidence')), true)
  }
  assert.equal(await restoreExists(join(profile, 'database-restore-pending.json')), false)
  const { fence } = await readJointRestoreFence4(fencePath)
  assert.equal(fence.operationId, pins[2].operationId)
  assert.equal(fence.phase, 'installed')
  assert.equal(await recoverControlledDatabaseRestore(profile, legacy), true)
  const store = KnowbookStore.openCanonicalRuntime(database)
  try {
    const docs = store.getDocumentIndex()
    for (const title of titles)
      assert.ok(docs.some(row => row.title === title), title)
    const combined = store.getDocumentDetail(settled.id)
    assert.ok(combined?.blocks.some(block => block.content === 'Settled local-side edit'))
    assert.ok(combined?.blocks.some(block => block.content === 'Settled remote-side edit'))
    const db = store.getUnsafeDatabaseHandle()
    const coverage = db.transaction(() => readRawPriorKnowledgeCoverageOwned(db))().entries
    assert.deepEqual(coverage.map(entry => entry.operationId).sort(), pins.map(pin => pin.operationId).sort())
    console.log(timestamp(), 'canonical Store, three original documents, and three C entries verified')
  } finally { store.destroy() }
  const identities = await largeIdentities()
  assert.deepEqual(identities, await readRestoreJson(join(root, 'third-asset-identities.json')))
  const expectedHashes = await Promise.all(identities.map(async ({ hash, ino, dev }) => {
    const digest = createHash('sha256')
    for await (const bytes of createReadStream(attachmentPath(hash))) digest.update(bytes)
    assert.equal(digest.digest('hex'), hash)
    console.log(timestamp(), '52,428,800-byte attachment original identity and SHA-256 verified', { hash, ino, dev })
    return hash
  }))
  const intent = await readJointRestoreIntent4(profile, fence)
  const proof = await readRestoreKnowledgeInstallProof(profile, pins[2].operationId, intent.installationProofHash)
  assert.equal(proof.version, 3)
  await assertV3SettledPrivateSyncOriginals(profile, pins[2].operationId, intent.currentInventory, proof.privateSync)
  const cold = await captureReopenedQualifiedOriginalContent5({ profileRoot: profile, operationId: pins[2].operationId,
    mountId: proof.mountId, expectedDescriptorHash: proof.descriptorHash })
  const archive = cold.pair.current.assetArchive
  if (archive.version !== 10) throw new Error('Expected archive10')
  assert.equal(archive.baseProjection.version, 3)
  assert.equal(cold.working.current?.manifest.version, 3)
  assert.ok(cold.working.current?.manifest.settledBindings.some(row => row.jobSettingKey.includes(settled.operationId)))
  assert.equal(archive.installedV3Many.root.operationId, pins[1].operationId)
  assert.deepEqual(archive.installedV3Many.aliases.map(row => row.alias.hash).sort(), expectedHashes.sort())
  assert.notDeepEqual(archive.installedV3Many.aliases[0].backupV3, archive.installedV3Many.aliases[1].backupV3)
  for (const { alias, identity } of archive.installedV3Many.aliases) {
    const live = await tryReadInstalledRestoreAsset4(profile, intent.operationId, intent.assetTransferId, intent.assetManifestHash,
      { hash: alias.hash, logicalName: alias.name, bytes: alias.bytes })
    assert.deepEqual(live, identity)
    if (process.platform === 'win32') assert.notEqual(live?.dev, '0')
    console.log(timestamp(), 'installed transfer open FD exactly agrees with Archive10', { hash: alias.hash, ...live })
  }
  console.log(timestamp(), 'installed archive10 qualified original reread with both settled WebDAV edits')
  const next = readInstalledV3AssetContinuity(await captureInstalledV3AssetContinuity(profile, fence.operationId), profile)
  assert.equal(next.requirement.operationId, fence.operationId)
  for (const { alias, identity } of archive.installedV3Many.aliases)
    assert.deepEqual(await next.readAlias(alias.relativePath), { alias, identity })
  console.log(timestamp(), 'archive10 admitted by the later current-capture path using the genuine installed proof v3')
} else {
  const index = names.indexOf(phase)
  if (index === 0) {
    await mkdir(profile)
    KnowbookStore.createEmptySyncedReceiver(database).destroy()
  } else {
    const parent = await load(names[index - 1])
    const { fence } = await readJointRestoreFence4(fencePath)
    assert.equal(fence.phase, 'installed')
    assert.equal(fence.operationId, parent.operationId)
  }
  const archive = join(root, archiveNames[index]), hash = await createArchive(index, archive)
  const newArchive = readBackupV3RestoreSource(openBackupV3RestoreSource(archive))
  const before = index === 2 ? await largeIdentities() : undefined
  const start = Date.now()
  console.log(new Date(start).toISOString(), 'starting production', phase, 'snapshot/inventory',
    newArchive.archive.manifest.snapshotId, newArchive.inventoryHash)
  const result = await restoreControlledBackupV3({ userDataRoot: profile, backupDirectory: archive,
    stopProcesses: async () => [] }, { readCurrentIdentities: async () => [], recoverLegacy: legacy })
  const end = Date.now()
  assert.equal(result.status, 'installed')
  const { fence } = await readJointRestoreFence4(fencePath)
  assert.equal(fence.operationId, result.operationId)
  assert.equal(fence.phase, 'installed')
  assert.equal(await restoreExists(join(profile, 'database-restore-pending.json')), false)
  if (before) {
    assert.deepEqual(await largeIdentities(), before)
    await writeRestoreJson(join(root, 'third-asset-identities.json'), before, root, true)
  }
  await writeRestoreJson(join(root, phase + '.json'), { operationId: result.operationId, hash, start, end,
    snapshotId: newArchive.archive.manifest.snapshotId, inventoryHash: newArchive.inventoryHash }, root, true)
  await rename(archive, archive + '-evidence')
  console.log(new Date(end).toISOString(), 'installed', phase, result.operationId, 'elapsedMs', end - start)
}
