import type { WebDavSyncConfig } from '../../shared/webdav-sync'
import type { readRejoinPublicationSeed } from '../database/synced-exchange-rejoin-publication'
import { initialPublicationSeed, type InitialPublicationReceipt } from '../database/synced-initial-publication-receipt'
import { observationDatabasePath } from '../database/synced-remote-observation-pending'
import type { AnyExchangeState } from './synced-exchange-model'
import { initialIncomingPortableDigest } from './synced-initial-incoming-model'
import { validateSyncedProtocol5Snapshot } from './synced-protocol5-model'
import { decodePublicationJson, protocol5HistoryLink, protocol5HistoryTarget, publicationHash, publicationInvalid, publicationJson,
  PUBLICATION_RECORD_MAX_BYTES, validateInitialManifest5, type SyncedInitialManifest5 } from './synced-publication-model'
import type { WebDavClient } from './webdav-client'
import { readFixedConfirmedPublicationSeed } from './synced-publication'

const fail = (): never => publicationInvalid('恢复续接缺准确原发布根、对象或已确认组。')

export function readInitialPublicationRejoinSnapshot(client: WebDavClient, target: WebDavSyncConfig, head: SyncedInitialManifest5,
  { receipt, publication }: { receipt: InitialPublicationReceipt; publication: ReturnType<typeof readRejoinPublicationSeed> }, root: string) {
  return readRejoinedPublicationSnapshot(client, target, head, { databasePath: receipt.databasePath, workspaceScope: receipt.workspaceScope,
    recoveryEpoch: receipt.recoveryEpoch, remoteWorkspaceId: receipt.workspaceScope, source: initialPublicationSeed(receipt) }, publication, root)
}

/** Match the exact installed SQL publication to the original descriptor and
 * remote immutable root. Local group hashes remain pinned by the descriptor. */
export async function readRejoinedPublicationSnapshot(client: WebDavClient, target: WebDavSyncConfig,
  head: SyncedInitialManifest5, state: Pick<AnyExchangeState, 'databasePath' | 'workspaceScope' | 'recoveryEpoch' | 'remoteWorkspaceId' | 'source'>,
  proof: ReturnType<typeof readRejoinPublicationSeed>, root: string) {
  const { source } = state, headHash = publicationHash(publicationJson(head))
  const original = await readFixedConfirmedPublicationSeed(root, proof.exposure.id)
  const { state: spool } = original, expected = spool.descriptor
  if (observationDatabasePath(spool.databasePath) !== state.databasePath || spool.requestHash !== proof.exposure.request_hash
    || spool.publicationHash !== proof.exposure.publication_hash || expected.targetFingerprint !== proof.exposure.target_fingerprint
    || expected.workspaceScope !== state.workspaceScope || expected.recoveryEpoch !== state.recoveryEpoch
    || expected.manifest.hash !== source.manifestHash || publicationHash(original.manifest) !== source.manifestHash
    || !Object.entries(spool.target).every(([name, value]) => value === target[name as keyof WebDavSyncConfig])
    || publicationJson(expected.members.map(({ groupId, creationId, revision, topologyRevision, semanticHash }) => ({
      attempt_id: proof.exposure.id, group_id: groupId, creation_id: creationId, revision, topology_revision: topologyRevision, semantic_hash: semanticHash
    }))) !== publicationJson(proof.members)) return fail()
  let manifest = head
  if (headHash !== source.manifestHash) {
    const object = await client.get(`objects/manifest-${source.manifestHash}.json`, PUBLICATION_RECORD_MAX_BYTES)
    if (!object || publicationHash(object.bytes) !== source.manifestHash) return fail()
    manifest = validateInitialManifest5(decodePublicationJson(object.bytes))
  }
  if (!source.operationId || !manifest.history
    || publicationJson(manifest.history) !== publicationJson(protocol5HistoryLink(protocol5HistoryTarget(target), source.operationId, null))
    || manifest.workspaceId !== state.remoteWorkspaceId
    || manifest.workspaceId !== state.workspaceScope || manifest.workspaceId !== head.workspaceId
    || initialIncomingPortableDigest(manifest.entries, manifest.syncedInstances) !== source.portableDigest) return fail()
  const records = []
  for (const [key, hash] of Object.entries(manifest.entries)) {
    const object = await client.get(`objects/${hash}.json`, PUBLICATION_RECORD_MAX_BYTES)
    if (!object || publicationHash(object.bytes) !== hash) return fail()
    records.push({ key, record: decodePublicationJson(object.bytes) })
  }
  const snapshot = validateSyncedProtocol5Snapshot(manifest, records)
  return snapshot
}
