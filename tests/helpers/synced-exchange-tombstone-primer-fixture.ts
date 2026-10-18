import assert from 'node:assert/strict'
import { withIncomingFixture, accepted, receiveInitialSyncedSnapshot, seedLocalDocument, snapshot } from './synced-initial-incoming-fixture'
import { exchangeSyncedSnapshot, completed, randomUUID, encode, hash, runtime } from './synced-exchange-fixture'
import { validateSyncedProtocol5Snapshot, type SyncedProtocol5Record } from '../../src/main/sync/synced-protocol5-model'

export { completed, snapshot, encode, hash }
type Base = Parameters<Parameters<typeof withIncomingFixture>[0]>[0]
type Records = Map<string, SyncedProtocol5Record>
export async function withDeletionPrimer(run: (f: Base & { S: Base['A']; groupId: string; ordinaryId: string;
  original: ReturnType<typeof snapshot>; remoteFinal: (change: (records: Records) => void) => void;
  exchange: () => ReturnType<typeof exchangeSyncedSnapshot> }) => Promise<void>) {
  return withIncomingFixture(async f => {
    const S = f.A, A = f.newPristine('independent-primer-peer'), B = f.B
    const ordinaryId = ' primer:independent ordinary:' + randomUUID()
    seedLocalDocument(S.db, ordinaryId)
    assert.ok(f.orphanId, 'The real source Main create and explicit host-final dereference produced an orphan')
    const groupId = f.orphanId, original = snapshot(S.db, groupId)
    await f.send(S)
    accepted(await f.track(receiveInitialSyncedSnapshot(A.db, f.input(randomUUID(), A), runtime)))
    accepted(await f.receive())
    const exchangePeer = (profile: Base['B']) => f.track(exchangeSyncedSnapshot(profile.db, f.input(randomUUID(), profile), runtime))
    completed(await exchangePeer(A), 'noop'); completed(await exchangePeer(B), 'noop')
    assert.equal((B.db.prepare('SELECT count(*) AS n FROM synced_group_pins WHERE group_id=?').get(groupId) as { n: number }).n, 0)
    assert.equal(snapshot(B.db, groupId).instances.length, 0)
    const remoteFinal = (change: (records: Records) => void) => {
      const manifestPath = '/' + f.targetConfig.directory + '/manifest.json', bytes = f.server.files.get(manifestPath)
      assert.ok(bytes, 'The successful real sender has its original same-target manifest')
      const manifest = JSON.parse(bytes.toString()) as { version: 5; workspaceId: string; entries: Record<string, string>; syncedInstances: Array<{ documentId: string; instanceId: string; groupId: string; groupHash: string }> }
      const records: Records = new Map(Object.entries(manifest.entries).map(([key, digest]) => {
        const raw = f.server.files.get('/' + f.targetConfig.directory + '/objects/' + digest + '.json')
        assert.ok(raw, 'Each existing remote live record comes from the actual sender bytes'); assert.equal(hash(raw), digest)
        return [key, JSON.parse(raw.toString()) as SyncedProtocol5Record]
      }))
      change(records)
      manifest.entries = Object.fromEntries([...records].map(([key, record]) => [key, hash(encode(record))]))
      // These two independent primer deletions remove neither a referenced G nor a ref host.
      // The original actual instance closure is unchanged and strict full5 validation proves it.
      validateSyncedProtocol5Snapshot(manifest, [...records].map(([key, record]) => ({ key, record })))
      for (const [key, record] of records) f.server.files.set('/' + f.targetConfig.directory + '/objects/' + manifest.entries[key] + '.json', Buffer.from(encode(record)))
      f.server.files.set(manifestPath, Buffer.from(encode(manifest)))
    }
    await run({ ...f, S, A, B, groupId, ordinaryId, original, remoteFinal, exchange: () => exchangePeer(B) })
  }, { orphan: true })
}
