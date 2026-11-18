import assert from 'node:assert/strict'
import test from 'node:test'
import { readV3RestoreSourceTombstone } from '../src/main/backup/v3-restore-source-tombstone'
import { validateV3RestoreSourceTombstoneEvidence } from '../src/main/backup/v3-restore-source-tombstone-model'
import { createEphemeralCredentialStorage } from '../src/main/credential-storage'
import { KnowbookStore } from '../src/main/database/store'
import { WebDavSyncService } from '../src/main/sync/service'
import { validateSyncedProtocol5Record, type SyncedProtocol5Record } from '../src/main/sync/synced-protocol5-model'
import { protocol5HistoryLink, validateInitialManifest5 } from '../src/main/sync/synced-publication-model'
import { encode, hash, randomUUID, readonlyRequests, runtime, withIncomingFixture } from './helpers/synced-initial-incoming-fixture'

test('V3 trim evidence binds real publisher and receiver anchors to an exact WebDAV group deletion transition', () =>
  withIncomingFixture(async f => {
    const storeA = KnowbookStore.openCanonicalRuntime(f.A.file, false), storeB = KnowbookStore.openCanonicalRuntime(f.B.file, false)
    const publisher = new WebDavSyncService(storeA, f.A.root, createEphemeralCredentialStorage(randomUUID))
    const receiver = new WebDavSyncService(storeB, f.B.root, createEphemeralCredentialStorage(randomUUID))
    try {
      const config = { ...f.targetConfig, enabled: false }
      for (const service of [publisher, receiver]) service.saveConfig({ ...config, password: runtime.password })
      assert.ok((await publisher.sync()).lastSyncAt)
      assert.ok((await receiver.sync()).lastSyncAt)
      const a = f.connect(f.A, true), b = f.connect(f.B, true)
      const root = '/' + config.directory + '/', path = root + 'manifest.json', key = 'group:' + f.orphanId
      const originalBytes = f.server.files.get(path)!
      const original = validateInitialManifest5(JSON.parse(originalBytes.toString()))
      const groupHash = original.entries[key]
      assert.ok(groupHash && original.history)
      const group = validateSyncedProtocol5Record(JSON.parse(f.server.files.get(root + 'objects/' + groupHash + '.json')!.toString()), key)
      assert.equal(group.kind, 'synced-group')
      assert.equal(original.syncedInstances.some(row => row.groupId === group.id), false)
      const tombstone = { kind: 'synced-group-deleted' as const, id: group.id, creationId: group.creationId,
        previousHash: groupHash, deletedAt: new Date().toISOString() }
      const append = (previousBytes: Buffer, record: SyncedProtocol5Record) => {
        const manifest = validateInitialManifest5(JSON.parse(previousBytes.toString()))
        const bytes = Buffer.from(encode(record)), digest = hash(bytes), predecessor = hash(previousBytes)
        const next = Buffer.from(encode({ ...manifest, entries: { ...manifest.entries, [key]: digest },
          history: protocol5HistoryLink(manifest.history!.targetFingerprint, randomUUID(), predecessor) }))
        f.server.files.set(root + 'objects/' + digest + '.json', bytes)
        f.server.files.set(root + 'objects/manifest-' + predecessor + '.json', previousBytes)
        f.server.files.set(path, next)
        return next
      }
      const from = (profile: typeof f.A, db: typeof a) => readV3RestoreSourceTombstone(db, { databasePath: profile.file, config, runtime, group })
      const replacement = { ...group, blocks: group.blocks.map((block, index) => index ? block : { ...block, content: block.content + ' edited before deletion' }) }
      append(append(originalBytes, replacement), tombstone)
      assert.equal(await from(f.A, a), null, 'A plausible tombstone hash must occur directly after its authenticated live group')

      const deletion = append(originalBytes, tombstone), successor = append(deletion, tombstone)
      const requestStart = f.server.requests.length
      const publishProof = await from(f.A, a), receiveProof = await from(f.B, b)
      assert.ok(publishProof && receiveProof)
      for (const { evidence } of [publishProof, receiveProof]) {
        assert.equal(evidence.seedManifestHash, hash(originalBytes))
        assert.equal(evidence.head.hash, hash(successor))
        assert.equal(evidence.transition.before.hash, hash(originalBytes))
        assert.equal(evidence.transition.deleted.hash, hash(deletion))
        assert.deepEqual(evidence.previous.record, group)
        assert.deepEqual(evidence.tombstone.record, tombstone)
        assert.equal(evidence.executionAuthorized, false)
        assert.deepEqual(validateV3RestoreSourceTombstoneEvidence(evidence, { sourceGroupId: group.id, sourceCreationId: group.creationId }),
          { groupId: group.id, creationId: group.creationId, headHash: hash(successor), etag: evidence.head.etag })
        assert.throws(() => validateV3RestoreSourceTombstoneEvidence({ ...evidence, head: { ...evidence.head, etag: 'W/"weak"' } }), /ETag/)
        assert.throws(() => validateV3RestoreSourceTombstoneEvidence({ ...evidence,
          transition: { before: evidence.transition.deleted, deleted: { hash: evidence.head.hash, manifest: evidence.head.manifest } }
        }), /墓碑/)
      }
      await publishProof.assertObservedHead()
      append(successor, tombstone)
      await assert.rejects(receiveProof.assertObservedHead(), /清单已改变/)
      readonlyRequests(f.server.requests.slice(requestStart))
    } finally { await publisher.stop(); await receiver.stop(); storeA.destroy(); storeB.destroy() }
  }, { orphan: true }))
