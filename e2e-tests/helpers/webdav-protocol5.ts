import { expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { validateSyncedProtocol5Record, validateSyncedProtocol5Snapshot } from '../../src/main/sync/synced-protocol5-model'
import { decodePublicationJson, protocol5HistoryLink, publicationHash, publicationJson,
  validateInitialManifest5 } from '../../src/main/sync/synced-publication-model'
import type { SyncedPortableHostRecord } from '../../src/shared/syncedBlockPortable'
import type { createWebDavServer } from '../../tests/helpers/webdav-server'

type Server = Awaited<ReturnType<typeof createWebDavServer>>
type DocumentEdit = { id: string; edit: (record: SyncedPortableHostRecord) => void }

/** Publish fixture peer edits through the same conditional writes and version chain as a protocol 5 workspace. */
export async function publishRemoteProtocol5Documents(server: Server, changes: readonly DocumentEdit[], directory = 'KnowBook') {
  const folder = '/' + directory + '/', manifestPath = folder + 'manifest.json'
  const previousBytes = server.files.get(manifestPath)
  if (!previousBytes) throw new Error('Missing actual first WebDAV publication')
  const previous = validateInitialManifest5(decodePublicationJson(previousBytes))
  if (!previous.history) throw new Error('Expected a chained protocol 5 manifest')
  const previousHash = publicationHash(previousBytes)
  const manifest = { ...previous, entries: { ...previous.entries },
    history: protocol5HistoryLink(previous.history.targetFingerprint, randomUUID(), previousHash) }
  const objects = new Map<string, string>(), updated = new Map<string, string>()
  const objectPath = (hash: string) => folder + 'objects/' + hash + '.json'
  for (const { id, edit } of changes) {
    const key = 'doc:' + id, original = server.files.get(objectPath(previous.entries[key]))
    if (!original || publicationHash(original) !== previous.entries[key]) throw new Error('Missing original protocol 5 document')
    const record = validateSyncedProtocol5Record(decodePublicationJson(original), key)
    if (record.kind !== 'document') throw new Error('The protocol 5 fixture peer requires a live document')
    edit(record)
    const bytes = publicationJson(record), hash = publicationHash(bytes)
    manifest.entries[key] = hash
    objects.set(objectPath(hash), bytes)
    updated.set(id, hash)
  }
  validateSyncedProtocol5Snapshot(manifest, Object.entries(manifest.entries).map(([key, hash]) => {
    const path = objectPath(hash)
    const bytes = objects.get(path) ?? server.files.get(path)
    if (!bytes) throw new Error('Missing record for fixture successor')
    return { key, record: decodePublicationJson(typeof bytes === 'string' ? Buffer.from(bytes) : bytes) }
  }))
  const authorization = 'Basic ' + Buffer.from('test:app-secret').toString('base64')
  async function put(path: string, body: string, condition: Record<string, string>) {
    return fetch(new URL(path.slice(1), server.url), { method: 'PUT', headers: { authorization, ...condition }, body })
  }
  for (const [path, bytes] of objects) {
    const existing = server.files.get(path)
    if (existing) expect(existing.toString()).toBe(bytes)
    else expect((await put(path, bytes, { 'If-None-Match': '*' })).ok).toBe(true)
  }
  const predecessorPath = objectPath('manifest-' + previousHash)
  const existing = server.files.get(predecessorPath)
  if (existing) expect(existing).toEqual(previousBytes)
  else expect((await put(predecessorPath, previousBytes.toString(), { 'If-None-Match': '*' })).ok).toBe(true)
  expect((await put(manifestPath, publicationJson(manifest), { 'If-Match': '"' + previousHash + '"' })).ok).toBe(true)
  return updated
}
