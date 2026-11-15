import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { KnowbookStore } from '../../src/main/database/store'
import { recoverControlledDatabaseRestore } from '../../src/main/database/restore-safety'
import { writeRestoreJson } from '../../src/main/database/restore-safety-files'
import { exchangeSyncedSnapshot } from '../../src/main/sync/synced-exchange'
import { disposePreparedSyncedPublication, prepareInitialSyncedPublication, publishInitialSyncedPublication, receiveInitialSyncedSnapshot }
  from '../../src/main/sync/synced-publication'
import { exchangeJobPrefix, parseExchangeStored, validateExchangeJob } from '../../src/main/sync/synced-exchange-model'
import { DEFAULT_WEBDAV_SYNC_CONFIG } from '../../src/shared/webdav-sync'
import { normalizeWebDavConfig } from '../../src/main/sync/webdav-client'
import { createPublicationHttpServer } from './synced-publication-http-fixture'
import { applySyncedHostCommand, applySyncedHostFinal, createRequest, created, freshBlock, request } from './synced-publication-fixture'
import { randomUUID } from 'node:crypto'
import { completed } from './synced-exchange-fixture'

export async function settleControlledV3WorkingMany(root: string) {
  const profile = join(root, 'receiver'), database = join(profile, 'storage', 'knowbook.db'), started = Date.now()
  await recoverControlledDatabaseRestore(profile, async () => { throw new Error('Expected joint recovery') })
  const local = KnowbookStore.openCanonicalRuntime(database)
  const remoteRoot = join(root, 'working-peer-' + randomUUID())
  await mkdir(remoteRoot)
  const peer = KnowbookStore.createEmptySyncedReceiver(join(remoteRoot, 'storage', 'knowbook.db'))
  const server = await createPublicationHttpServer()
  const target = normalizeWebDavConfig({ ...DEFAULT_WEBDAV_SYNC_CONFIG, enabled: true, url: server.url, username: 'test',
    directory: 'WorkingArchive8', allowInsecureHttp: true })
  const runtime = { password: 'app-secret' }, a = local.getUnsafeDatabaseHandle(), b = peer.getUnsafeDatabaseHandle()
  try {
    const originals = ['Original archive attachment', 'Independent second document'].map(title => {
      const document = local.getDocumentIndex().find(doc => doc.title === title)
      assert.ok(document)
      const original = local.getDocumentDetail(document.id)
      assert.ok(original)
      assert.match(original.summary, /native%20large%20alias.bin/)
      return { id: document.id, original }
    })
    // WebDAV still has its own 25 MiB limit. Temporarily unlink the large alias
    // from this unrelated document via normal Store editing, then restore that
    // link after the real small-asset Working job has settled.
    for (const { id, original } of originals) local.updateDocument(id, { ...original, summary: '' })
    const id = local.createDocument(null), left = freshBlock(randomUUID(), 'Common first block'), right = freshBlock(randomUUID(), 'Common second block')
    const group = freshBlock(randomUUID(), 'Actual synced group content')
    local.updateDocument(id, { title: 'Working8 settled editor host', summary: 'Common merge summary', blocks: [left, right, group] })
    created(applySyncedHostCommand(a, createRequest(a, { documentId: id, selectedRootIds: [group.id] })))
    const initial = await prepareInitialSyncedPublication(a, { attemptId: randomUUID(), userDataRoot: profile, target })
    assert.equal(initial.status, 'prepared')
    try { assert.equal((await publishInitialSyncedPublication(a, initial.prepared, runtime)).status, 'confirmed') }
    finally { disposePreparedSyncedPublication(initial.prepared) }
    assert.equal((await receiveInitialSyncedSnapshot(b, { operationId: randomUUID(), userDataRoot: remoteRoot, target }, runtime)).status, 'applied')
    const exchange = (db: typeof a, userDataRoot: string, operationId = randomUUID()) =>
      exchangeSyncedSnapshot(db, { operationId, userDataRoot, target }, runtime)
    completed(await exchange(a, profile), 'noop')
    completed(await exchange(b, remoteRoot), 'noop')
    assert.equal(applySyncedHostFinal(b, request(b, [id], sides => {
      const block = sides[0].blocks.find(item => item.id === right.id)
      assert.ok(block); block.content = 'Settled remote-side edit'
    })).status, 'applied')
    completed(await exchange(b, remoteRoot), 'applied')
    assert.equal(applySyncedHostFinal(a, request(a, [id], sides => {
      const block = sides[0].blocks.find(item => item.id === left.id)
      assert.ok(block); block.content = 'Settled local-side edit'
    })).status, 'applied')
    const operationId = randomUUID()
    completed(await exchange(a, profile, operationId), 'applied')
    const prefix = exchangeJobPrefix(operationId)
    const jobs = a.prepare('SELECT value FROM app_settings WHERE substr(key,1,?)=?').pluck().all(prefix.length, prefix)
    assert.equal(jobs.length, 1)
    const job = validateExchangeJob(parseExchangeStored(String(jobs[0])))
    assert.ok(job.version !== 1 && job.merges?.some(merge => merge.key === 'doc:' + id))
    const final = local.getDocumentDetail(id)
    assert.ok(final)
    assert.ok(final.blocks.some(block => block.content === 'Settled local-side edit'))
    assert.ok(final.blocks.some(block => block.content === 'Settled remote-side edit'))
    for (const { id, original } of originals) {
      local.updateDocument(id, { ...original, summary: original.summary })
      assert.equal(local.getDocumentDetail(id)?.summary, original.summary)
    }
    await writeRestoreJson(join(root, 'settled.json'), { id, operationId }, root, true)
    console.log(JSON.stringify({ id, operationId, elapsedMs: Date.now() - started }))
  } finally {
    local.destroy(); peer.destroy()
    server.assertNoHookErrors()
    await server.close()
  }
}
