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
import { buildDocumentMarkdown } from '../src/renderer/src/utils/documentMarkdown'
import { withV3Fixture, allTables, randomUUID } from './helpers/synced-backup-v3-fixture'

test('the current WebDAV service reads and rejects obsolete remote manifests without mutation', t => withV3Fixture(async f => {
  const store = KnowbookStore.openCanonicalRuntime(f.file)
  const service = new WebDavSyncService(store, f.userDataRoot, createEphemeralCredentialStorage(randomUUID))
  let version = 1
  const requests: Array<{ path: string; method: string }> = []
  t.mock.method(globalThis, 'fetch', async (input: string, init?: RequestInit) => {
    requests.push({ path: new URL(input).pathname, method: init?.method ?? 'GET' })
    return new Response(JSON.stringify({ version }), { headers: { ETag: '"obsolete"' } })
  })
  try {
    service.saveConfig({ ...DEFAULT_WEBDAV_SYNC_CONFIG, enabled: true, url: 'https://example.invalid/webdav/', username: 'personal', password: 'kept-password' })
    const config = service.getStatus().config
    const before = allTables(store.getUnsafeDatabaseHandle())
    for (version = 1; version <= 4; version++) {
      requests.length = 0
      await assert.rejects(service.testConnection(), /同步协议不受支持/)
      await assert.rejects(service.sync(), /同步协议不受支持/)
      assert.deepEqual(requests, Array.from({ length: 2 }, () => ({ path: '/webdav/KnowBook/manifest.json', method: 'GET' })))
      assert.deepEqual(service.getStatus().config, config)
      assert.equal(service.getStatus().hasPassword, true)
      assert.equal(service.getStatus().lastSyncAt, null)
      assert.deepEqual(allTables(store.getUnsafeDatabaseHandle()), before)
    }
    assert.throws(() => store.getSyncRecords(), /旧 WebDAV/)
    assert.throws(() => store.applySyncRecords([]), /旧 WebDAV/)
  } finally { await service.stop(); store.destroy() }
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
