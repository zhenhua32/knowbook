import assert from 'node:assert/strict'
import test from 'node:test'
import { assertRawSyncedExchangeHistoricalMetadataOwned } from '../src/main/database/synced-exchange-history-metadata-read'
import { readOrdinaryPublicationAttempt } from '../src/main/database/synced-ordinary-publication-attempt'
import { hasInitialSyncedPublicationAttempt } from '../src/main/database/synced-publication'
import { exchangeSyncedSnapshot } from '../src/main/sync/synced-exchange'
import { disposePreparedSyncedPublication, prepareInitialSyncedPublication, publishInitialSyncedPublication,
  readPreparedSyncedPublication, receiveInitialSyncedSnapshot, recoverInitialSyncedPublication } from '../src/main/sync/synced-publication'
import { validateInitialManifest5 } from '../src/main/sync/synced-publication-model'
import { randomUUID, readonlyRequests, runtime, seedLocalDocument, withIncomingFixture } from './helpers/synced-initial-incoming-fixture'
import { completed, hostEdit, readStrictHostDocument } from './helpers/synced-exchange-fixture'

for (const withDocument of [false, true]) {
  test(`current WebDAV publishes a ${withDocument ? 'document-only' : 'pristine'} workspace and reopens its exact zero-group seed`, () => withIncomingFixture(async fixture => {
    const publisher = fixture.newPristine('ordinary-publisher'), receiver = fixture.B
    const doc = randomUUID(), attemptId = randomUUID(), target = fixture.targetConfig
    if (withDocument) seedLocalDocument(publisher.db, doc)
    const input = { attemptId, userDataRoot: publisher.root, target }
    const head = '/' + target.directory + '/manifest.json'
    const prepared = await prepareInitialSyncedPublication(publisher.db, input, true)
    assert.ok(prepared.status === 'prepared')
    assert.deepEqual(readPreparedSyncedPublication(prepared.prepared)?.descriptor.members, [])
    assert.equal(hasInitialSyncedPublicationAttempt(publisher.db, attemptId), false)
    fixture.server.setHook(request => {
      if (request.method === 'PUT' && request.path === head) {
        assert.equal(readOrdinaryPublicationAttempt(publisher.db, attemptId)?.attempt.state, 'possible')
        assert.equal(request.ifNoneMatch, '*')
        return { kind: 'persist-then-disconnect' }
      }
    })
    await assert.rejects(publishInitialSyncedPublication(publisher.db, prepared.prepared, runtime), /Manifest/)
    fixture.server.setHook(undefined)
    disposePreparedSyncedPublication(prepared.prepared)
    assert.equal(publisher.db.prepare('SELECT count(*) FROM synced_exposure_attempts').pluck().get(), 0)
    publisher.db.close()
    publisher.db = fixture.connect(publisher)
    assert.equal(hasInitialSyncedPublicationAttempt(publisher.db, attemptId), true)
    const recovered = await recoverInitialSyncedPublication(publisher.db, input)
    const retryStart = fixture.server.requests.length
    try { assert.equal((await publishInitialSyncedPublication(publisher.db, recovered.prepared, runtime)).status, 'confirmed') }
    finally { disposePreparedSyncedPublication(recovered.prepared) }
    readonlyRequests(fixture.server.requests.slice(retryStart))
    assert.equal(readOrdinaryPublicationAttempt(publisher.db, attemptId)?.attempt.state, 'confirmed')
    const manifest = validateInitialManifest5(JSON.parse(fixture.server.files.get(head)!.toString()))
    assert.equal(manifest.history?.previousHash, null)
    assert.deepEqual(Object.keys(manifest.entries).sort(), withDocument ? ['databases', 'doc:' + doc] : ['databases'])
    const received = await receiveInitialSyncedSnapshot(receiver.db, fixture.input(randomUUID(), receiver), runtime)
    assert.equal(received.status, withDocument ? 'applied' : 'noop')
    if (!withDocument) seedLocalDocument(publisher.db, doc)
    hostEdit(publisher.db, doc, 'Ordinary change after cold boot')
    completed(await exchangeSyncedSnapshot(publisher.db, fixture.input(randomUUID(), publisher), runtime), 'applied')
    completed(await exchangeSyncedSnapshot(receiver.db, fixture.input(randomUUID(), receiver), runtime), 'applied')
    assert.equal(readStrictHostDocument(receiver.db, doc).content.blocks[0].content, 'Ordinary change after cold boot')
    const facts = publisher.db.transaction(() => assertRawSyncedExchangeHistoricalMetadataOwned(publisher.db))()
    const ordinary = facts.find(fact => fact.family === 'ordinary-publication')
    assert.ok(ordinary)
    assert.ok(facts.find(fact => fact.family === 'exchange-state')?.supports.some(support => support.rowHash === ordinary.locator.rowHash))
  }))
}
