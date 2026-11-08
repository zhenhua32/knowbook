import type { WebDavSyncConfig } from '../../shared/webdav-sync'
import { decodePublicationJson, protocol5HistoryTarget, publicationHash, publicationInvalid, publicationJson, PUBLICATION_RECORD_MAX_BYTES,
  validateInitialManifest5, type SyncedInitialManifest5 } from './synced-publication-model'
import { WebDavHttpError, type WebDavClient } from './webdav-client'

const predecessorPath = (hash: string) => 'objects/manifest-' + hash + '.json'
const MAX_NEW_PREDECESSORS = 1024

/** Walk only the new suffix to the device's already accepted, exact head. */
export async function assertProtocol5ManifestLineage(client: WebDavClient, target: WebDavSyncConfig,
  current: SyncedInitialManifest5, anchorHash: string): Promise<void> {
  const targetFingerprint = protocol5HistoryTarget(target), seen = new Set<string>()
  let manifest = current, digest = publicationHash(publicationJson(current))
  for (;;) {
    if (manifest.workspaceId !== current.workspaceId || manifest.history?.targetFingerprint !== targetFingerprint)
      return publicationInvalid('协议5历史链不属于原目标和远端工作区。')
    if (digest === anchorHash) return
    const previous = manifest.history.previousHash
    if (!previous || seen.has(previous) || seen.size >= MAX_NEW_PREDECESSORS)
      return publicationInvalid('远端历史没有到达本机已接受的版本，已暂停同步。')
    seen.add(digest)
    const object = await client.get(predecessorPath(previous), PUBLICATION_RECORD_MAX_BYTES)
    if (!object || publicationHash(object.bytes) !== previous) return publicationInvalid('远端历史前驱原字节缺失或损坏。')
    manifest = validateInitialManifest5(decodePublicationJson(object.bytes))
    digest = previous
  }
}

/** The caller has already durably claimed the original job and read this exact CAS version. */
export async function preserveProtocol5Predecessor(client: WebDavClient, bytes: Uint8Array, expectedHash: string): Promise<void> {
  if (publicationHash(bytes) !== expectedHash) return publicationInvalid('待发布的历史前驱不是原 CAS 字节。')
  const path = predecessorPath(expectedHash)
  try { await client.create(path, bytes) }
  catch (error) { if (!(error instanceof WebDavHttpError && error.status === 412)) throw error }
  const saved = await client.get(path, PUBLICATION_RECORD_MAX_BYTES)
  if (!saved || !Buffer.from(saved.bytes).equals(Buffer.from(bytes))) return publicationInvalid('不可变历史前驱与原 CAS 字节不同。')
}
