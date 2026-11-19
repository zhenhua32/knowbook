import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { MarkdownBackupService, writeBackupSnapshot } from '../../src/main/backup/exporter'
import { readBackupV3Archive } from '../../src/main/backup/v3-reader'
import { recoverControlledDatabaseRestore, restoreControlledBackupV3 } from '../../src/main/database/restore-safety'
import type { SecureStringStorage } from '../../src/main/credential-storage'
import { KnowbookStore } from '../../src/main/database/store'
import { readV3SourceGroupRetirementsOwned } from '../../src/main/database/v3-source-group-retirement'
import { confirmProtocol5RestoreRejoin, prepareProtocol5RestoreRejoin } from '../../src/main/sync/protocol5-restore-rejoin-read'
import { runProtocol5WebDav } from '../../src/main/sync/protocol5-service'
import { WebDavSyncService } from '../../src/main/sync/service'
import { protocol5HistoryLink, publicationHash, publicationJson, validateInitialManifest5 } from '../../src/main/sync/synced-publication-model'
import { applySyncedHostCommand, created, createRequest, freshBlock, snapshot } from './synced-publication-fixture'
import { runtime, withIncomingFixture } from './synced-initial-incoming-fixture'

interface RetirementTestRequest { profileRoot: string; backup: string; expectedSourceGroupIds: string[]; expectedLocalGroupIds?: string[] }
const credentials: SecureStringStorage = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(value, 'utf8'),
  decryptString: bytes => bytes.toString('utf8')
}
const legacy = { readCurrentIdentities: async () => [], recoverLegacy: async () => false }
const input = process.env.KNOWBOOK_V3_SOURCE_RETIREMENT_TEST

if (input) test('restore and confirm the exact planned V3 scope in a separate process', async t => {
  const request: RetirementTestRequest = JSON.parse(input)
  const started = performance.now()
  const database = join(request.profileRoot, 'storage', 'knowbook.db'), original = await readFile(database)
  const result = await restoreControlledBackupV3({ userDataRoot: request.profileRoot, backupDirectory: request.backup,
    stopProcesses: async () => [], retirementCredentials: credentials }, legacy, async preview => {
    const groups = preview.sourceGroupRetirements ?? []
    t.diagnostic(`Exact preview ready after ${Math.round(performance.now() - started)} ms`)
    assert.deepEqual(groups.map(group => group.sourceGroupId).sort(), [...request.expectedSourceGroupIds].sort())
    if (request.expectedLocalGroupIds) assert.deepEqual(groups.map(group => group.groupId), request.expectedLocalGroupIds)
    assert.deepEqual(await readFile(database), original, 'The exact preview leaves the live database intact until the user confirms')
    return true
  })
  assert.equal(result?.status, 'installed')
})

async function runRestore(request: RetirementTestRequest) {
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--test', '--test-timeout=120000',
      'tests/helpers/controlled-backup-v3-source-retirement-case.ts'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', KNOWBOOK_V3_SOURCE_RETIREMENT_TEST: JSON.stringify(request) },
      windowsHide: true, timeout: 125_000
    })
    process.stdout.write(stdout)
  } catch (error) {
    if (error && typeof error === 'object' && 'stdout' in error) process.stderr.write(String(error.stdout))
    throw error
  }
}

if (!input) void withIncomingFixture(async fixture => {
  const { A, B, server, targetConfig } = fixture
  const publisher = fixture.newPristine('v3-source-publisher')
  publisher.db.close()
  const source = KnowbookStore.openCanonicalRuntime(publisher.file)
  const backup = join(publisher.root, 'backups', 'markdown')
  try {
    const host = source.createDocument(null), body = freshBlock(randomUUID(), 'Independent shared content')
    source.updateDocument(host, { title: 'Temporary independent host', summary: '', blocks: [body] })
    const sourceDb = source.getUnsafeDatabaseHandle()
    const retainedId = created(applySyncedHostCommand(sourceDb,
      createRequest(sourceDb, { documentId: host, selectedRootIds: [body.id] }))).createdLifecycle.groupId
    source.deleteDocument(host)
    await runProtocol5WebDav(source, publisher.root, targetConfig, runtime)
    B.db.close()
    const receiver = KnowbookStore.openCanonicalRuntime(B.file)
    try {
      const service = new WebDavSyncService(receiver, B.root, credentials)
      service.saveConfig({ ...targetConfig, password: runtime.password })
      await service.stop()
      await runProtocol5WebDav(receiver, B.root, targetConfig, runtime)
      await runProtocol5WebDav(receiver, B.root, targetConfig, runtime)
    } finally { receiver.destroy() }

    const original = snapshot(A.db, fixture.orphanId!)
    const headPath = '/Incoming/manifest.json'
    const addedGroups = [original, { ...original, groupId: randomUUID(), creationId: randomUUID(),
      origin: { ...original.origin, firstInstanceId: randomUUID() },
      blocks: original.blocks.map(block => ({ ...block, id: randomUUID(), parentBlockId: null, content: 'Second independent source body' })) }]
    const firstBytes = server.files.get(headPath)!, firstHash = publicationHash(firstBytes)
    const firstHead = validateInitialManifest5(JSON.parse(firstBytes.toString()))
    const firstEntries = { ...firstHead.entries }
    for (const group of addedGroups) {
      const wire = { kind: 'synced-group', id: group.groupId, creationId: group.creationId, createdAt: group.createdAt,
        origin: group.origin, blocks: group.blocks, bindings: group.bindings }
      const bytes = Buffer.from(publicationJson(wire)), hash = publicationHash(bytes)
      server.files.set('/Incoming/objects/' + hash + '.json', bytes)
      firstEntries['group:' + group.groupId] = hash
    }
    server.files.set('/Incoming/objects/manifest-' + firstHash + '.json', firstBytes)
    server.files.set(headPath, Buffer.from(publicationJson({ ...firstHead, entries: firstEntries,
      history: protocol5HistoryLink(firstHead.history!.targetFingerprint, randomUUID(), firstHash) })))
    await runProtocol5WebDav(source, publisher.root, targetConfig, runtime)
    const service = new MarkdownBackupService(source, backup, undefined, async job => writeBackupSnapshot(job))
    await service.exportAll(true)
    assert.equal(readBackupV3Archive(backup).groups.length, 3)
    await runRestore({ profileRoot: B.root, backup, expectedSourceGroupIds: [] })
    await recoverControlledDatabaseRestore(B.root, legacy.recoverLegacy)
    const reopened = KnowbookStore.openCanonicalRuntime(B.file)
    let localGroupIds: string[]
    try {
      const db = reopened.getUnsafeDatabaseHandle()
      localGroupIds = db.prepare('SELECT id FROM synced_groups WHERE id<>? ORDER BY id').pluck().all(retainedId) as string[]
      assert.equal(localGroupIds.length, addedGroups.length)
      assert.ok(localGroupIds.every(id => !addedGroups.some(group => group.groupId === id)), 'V3 reassigns the direct source group identities')
      const rejoin = await prepareProtocol5RestoreRejoin(db, B.root, targetConfig, runtime)
      await confirmProtocol5RestoreRejoin(db, B.root, targetConfig, runtime, rejoin.owner)
      const unrelated = reopened.createDocument(null)
      reopened.updateDocument(unrelated, { title: 'Independent history [draft]', summary: '[reference](Never found.md)',
        blocks: [freshBlock(randomUUID(), 'Keep [[another page|unrelated link]]')] })
      reopened.documentRecovery.checkpoint(unrelated, 'edit', true)
      reopened.saveDocumentTemplate({ name: 'Independent template', title: 'Independent template',
        summary: '[documentation](https://example.test)', blocks: [freshBlock(randomUUID(), 'Keep this template')] })
    } finally { reopened.destroy() }

    const bytes = server.files.get(headPath)!, headHash = publicationHash(bytes)
    const head = validateInitialManifest5(JSON.parse(bytes.toString()))
    const deletionEntries = { ...head.entries }
    for (const group of addedGroups) {
      const key = 'group:' + group.groupId, previousHash = firstEntries[key]
      assert.equal(head.entries[key], previousHash)
      const deleted = Buffer.from(publicationJson({ kind: 'synced-group-deleted', id: group.groupId, creationId: group.creationId,
        previousHash, deletedAt: new Date().toISOString() }))
      const deletionHash = publicationHash(deleted)
      server.files.set('/Incoming/objects/' + deletionHash + '.json', deleted)
      deletionEntries[key] = deletionHash
    }
    server.files.set('/Incoming/objects/manifest-' + headHash + '.json', bytes)
    server.files.set(headPath, Buffer.from(publicationJson({ ...head, entries: deletionEntries,
      history: protocol5HistoryLink(head.history!.targetFingerprint, randomUUID(), headHash) })))
    await runProtocol5WebDav(source, publisher.root, targetConfig, runtime)
    await service.exportAll(true)
    assert.deepEqual(readBackupV3Archive(backup).groups.map(group => group.wire.id), [retainedId])

    await runRestore({ profileRoot: B.root, backup, expectedSourceGroupIds: addedGroups.map(group => group.groupId), expectedLocalGroupIds: localGroupIds })
    await rename(backup, backup + '-removed')
    const requestsBeforeCold = server.requests.length
    assert.equal(await recoverControlledDatabaseRestore(B.root, legacy.recoverLegacy), true)
    const cold = KnowbookStore.openCanonicalRuntime(B.file)
    try {
      assert.equal(server.requests.length, requestsBeforeCold, 'Cold reopening verifies the sealed evidence without a network request')
      const db = cold.getUnsafeDatabaseHandle()
      assert.deepEqual([...db.transaction(() => readV3SourceGroupRetirementsOwned(db))().keys()], localGroupIds)
      assert.ok(db.prepare('SELECT 1 FROM synced_group_blocks WHERE group_id=?').get(retainedId))
      const template = cold.listDocumentTemplates().find(template => template.name === 'Independent template')
      assert.ok(template)
      const existsInLedger = db.prepare('SELECT 1 FROM block_identities WHERE id=?')
      assert.ok(template.blocks.every(block => !existsInLedger.get(block.id)))
      assert.ok(db.prepare("SELECT 1 FROM document_history WHERE title='Independent history [draft]'").get())
      for (const localGroupId of localGroupIds) {
        assert.equal(db.prepare('SELECT 1 FROM synced_group_blocks WHERE group_id=?').get(localGroupId), undefined)
        assert.ok(db.prepare('SELECT 1 FROM block_identities WHERE last_owner_id=? AND state=?').get(localGroupId, 'retained'))
      }
      const headAfterRestore = Buffer.from(server.files.get(headPath)!)
      const rejoin = await prepareProtocol5RestoreRejoin(db, B.root, targetConfig, runtime)
      await confirmProtocol5RestoreRejoin(db, B.root, targetConfig, runtime, rejoin.owner)
      assert.deepEqual(server.files.get(headPath), headAfterRestore, 'Confirming the second restore never overwrites the remote head')
      const ordinaryId = cold.createDocument(null)
      assert.ok((await runProtocol5WebDav(cold, B.root, targetConfig, runtime)).uploaded > 0)
      const written = validateInitialManifest5(JSON.parse(server.files.get(headPath)!.toString()))
      assert.ok(written.entries['doc:' + ordinaryId])
      for (const group of addedGroups) {
        const key = 'group:' + group.groupId
        assert.equal(written.entries[key], deletionEntries[key], 'The next genuine exchange keeps each exact source tombstone')
      }
      assert.ok(template.blocks.every(block => !existsInLedger.get(block.id)), 'Confirmation and sync must not reserve draft-local IDs')
    } finally { cold.destroy() }
  } finally { source.destroy() }
}, { orphan: true }).catch(error => {
  console.error(error)
  process.exitCode = 1
})
