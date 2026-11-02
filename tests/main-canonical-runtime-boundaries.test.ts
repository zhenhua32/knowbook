import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store'
import { MarkdownRestoreService } from '../src/main/backup/importer'
import { writeSyncedBackupV3 } from '../src/main/backup/v3-export'
import { readBackupV3Archive } from '../src/main/backup/v3-reader'
import { WebDavSyncService } from '../src/main/sync/service'
import { createEphemeralCredentialStorage } from '../src/main/credential-storage'
import { DEFAULT_WEBDAV_SYNC_CONFIG } from '../src/shared/webdav-sync'
import { canonicalJson, emptySyncState, hashBytes, recordHash } from '../src/main/sync/model'
import { buildDocumentMarkdown } from '../src/renderer/src/utils/documentMarkdown'
import { withV3Fixture, allTables, randomUUID } from './helpers/synced-backup-v3-fixture'

test('complete runtime rejects legacy WebDAV before the first real transport call and preserves configured credentials and queued state', () => withV3Fixture(async f => {
  const store = KnowbookStore.openCanonicalRuntime(f.file)
  const service = new WebDavSyncService(store, f.assets, createEphemeralCredentialStorage(randomUUID))
  const originalFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = async () => { requests++; throw new Error('A forbidden preflight network request was attempted.') }
  try {
    service.saveConfig({ ...DEFAULT_WEBDAV_SYNC_CONFIG, enabled: true, url: 'https://example.invalid/webdav/', username: 'personal', password: 'kept-password' })
    // An existing ordinary pending resolution is inert persistence, never
    // permission to publish a canonical workspace through the old protocol.
    const config = service.getStatus().config
    const state = emptySyncState(), local = f.store.getSyncRecords().get('doc:' + f.targetId)
    assert.ok(local?.kind === 'document')
    const remote = { ...local, content: { ...local.content, summary: 'An older pending remote version' } }
    const localHash = recordHash(local), remoteHash = recordHash(remote), key = 'doc:' + f.targetId
    state.conflicts[key] = { local, remote, localHash, remoteHash }
    state.resolutions[key] = { localHash, remoteHash, choice: 'local' }
    const stateKey = 'sync.webdav.state.' + hashBytes(canonicalJson([config.url, config.username, config.directory]))
    store.saveSetting(stateKey, JSON.stringify(state))
    const before = allTables(store.getUnsafeDatabaseHandle())
    await assert.rejects(service.sync(), /旧 WebDAV|完整个人同步协议/)
    assert.equal(requests, 0, 'No OPTIONS/PROPFIND/capability/object request precedes the SQL capability guard')
    assert.deepEqual(service.getStatus().config, config)
    assert.equal(service.getStatus().config.enabled, true)
    assert.equal(service.getStatus().hasPassword, true)
    assert.equal(service.getStatus().conflicts[0].resolution, 'local')
    assert.deepEqual(allTables(store.getUnsafeDatabaseHandle()), before, 'No pending namespace/queue or configuration is removed')
    assert.throws(() => store.getSyncRecords(), /旧 WebDAV/)
    assert.throws(() => store.applySyncRecords([]), /旧 WebDAV/)
  } finally { globalThis.fetch = originalFetch; await service.stop(); store.destroy() }
}))

test('legacy restore refuses a real V3 source and a current canonical target before parsing or publishing attachments', () => withV3Fixture(async f => {
  const current = KnowbookStore.openCanonicalRuntime(f.file), ordinary = new KnowbookStore(join(f.root, 'ordinary.db'))
  let parserCalls = 0
  const parser = async (): Promise<never> => { parserCalls++; throw new Error('Legacy parse must never run for this source or target.') }
  try {
    const archiveRoot = join(realpathSync(f.root), 'archive')
    const snapshotId = randomUUID()
    writeSyncedBackupV3(f.db, {userDataRoot:realpathSync(f.userDataRoot),destination:archiveRoot,snapshotId})
    assert.equal(readBackupV3Archive(archiveRoot).manifest.snapshotId, snapshotId, 'The rejection input is an independently parsed complete real Main archive')
    const beforeCurrent = allTables(current.getUnsafeDatabaseHandle()), beforeOrdinary = allTables(ordinary.getUnsafeDatabaseHandle())
    await assert.rejects(new MarkdownRestoreService(ordinary, undefined, {}, parser).previewFromDirectory(archiveRoot), /V3/)
    await assert.rejects(new MarkdownRestoreService(ordinary, undefined, {}, parser).restoreFromDirectory(archiveRoot), /V3/)
    await assert.rejects(new MarkdownRestoreService(current, undefined, {}, parser).restoreFromDirectory(archiveRoot), /V3|同步块/)
    assert.equal(parserCalls, 0)
    assert.deepEqual(allTables(current.getUnsafeDatabaseHandle()), beforeCurrent)
    assert.deepEqual(allTables(ordinary.getUnsafeDatabaseHandle()), beforeOrdinary)
    assert.equal(readBackupV3Archive(archiveRoot).manifest.snapshotId, snapshotId)
  } finally { ordinary.destroy(); current.destroy() }
}))

test('single Markdown export rejects a real structural reference and ordinary Markdown keeps its existing serialization', () => withV3Fixture(f => {
  const host = f.store.getDocumentDetail(f.hostId)
  assert.ok(host)
  assert.equal(host.blocks.some(block => block.type === 'synced-block'), true)
  assert.throws(() => buildDocumentMarkdown(host), /同步块.*V3/)
  assert.equal(buildDocumentMarkdown({title:'Ordinary',blocks:[{id:'ordinary',type:'paragraph',content:'normal text',checked:false,depth:0,parentBlockId:null}]}), '# Ordinary\n\nnormal text')
}))
