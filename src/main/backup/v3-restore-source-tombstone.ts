import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import type Database from 'better-sqlite3'
import type { WebDavSyncConfig } from '../../shared/webdav-sync'
import { canonicalRestoreRoot } from '../database/restore-safety-files'
import { readEditorRecoveryWorkspace } from '../database/synced-editing-fence'
import { readHistoricalSyncedExchangeState } from '../database/synced-exchange-read'
import { readSealedExchangeRejoin } from '../database/synced-exchange-rejoin-model'
import { readSyncedExchangeReceiptById } from '../database/synced-exchange-receipt'
import { readRejoinPublicationSeed } from '../database/synced-exchange-rejoin-publication'
import { readInitialIncomingBaseline } from '../database/synced-initial-incoming-read'
import { readOrdinaryPublicationAttempts } from '../database/synced-ordinary-publication-attempt'
import { observationDatabasePath } from '../database/synced-remote-observation-pending'
import { decodeProtocol5Route, protocol5RouteKey } from '../sync/protocol5-service'
import { exchangeStateKey, exchangeTargetFingerprint, type ExchangeSeedProof } from '../sync/synced-exchange-model'
import { readRejoinedPublicationSnapshot } from '../sync/synced-exchange-rejoin-publication'
import { initialIncomingPortableDigest, initialIncomingTargetFingerprint } from '../sync/synced-initial-incoming-model'
import { assertProtocol5ManifestLineage } from '../sync/synced-manifest-history'
import { validateSyncedProtocol5Record, type SyncedProtocol5Record } from '../sync/synced-protocol5-model'
import { fetchProtocol5RemoteClosure, initialPublicationTargetFingerprint, type SyncedPublicationRuntime } from '../sync/synced-publication'
import { decodePublicationJson, frozenPublicationFacts, protocol5HistoryLink, protocol5HistoryTarget, publicationCompare, publicationHash,
  publicationJson, PUBLICATION_RECORD_MAX_BYTES, type SyncedInitialManifest5 } from '../sync/synced-publication-model'
import { normalizeWebDavConfig, requireStrongEtag, WebDavClient } from '../sync/webdav-client'

type LiveGroup = Extract<SyncedProtocol5Record, { kind: 'synced-group' }>
type DeletedGroup = Extract<SyncedProtocol5Record, { kind: 'synced-group-deleted' }>
type ReadInput = { databasePath: string; config: WebDavSyncConfig; runtime: SyncedPublicationRuntime; group: LiveGroup }
type HistoricalManifest = { hash: string; manifest: SyncedInitialManifest5 }
type ObservedGroup = { key: string; group: LiveGroup; groupBytes: string; groupHash: string;
  deleted: { hash: string; record: DeletedGroup }; deletion?: HistoricalManifest;
  transition?: { before: HistoricalManifest; deleted: HistoricalManifest } }
const same = (left: unknown, right: unknown) => publicationJson(left) === publicationJson(right)

function readOriginalRoute(db: Database.Database, databasePath: string, target: WebDavSyncConfig) {
  const setting = db.prepare('SELECT value FROM app_settings WHERE key=?').pluck()
  const config = setting.get('sync.webdav.config') as string | undefined
  if (!config || !same(normalizeWebDavConfig(JSON.parse(config)), target)) return null
  const rawRoute = setting.get(protocol5RouteKey(target)) as string | undefined
  const route = decodeProtocol5Route(rawRoute ?? null, target)
  if (!route?.lastSyncAt || route.pending || !same(route.workspace, readEditorRecoveryWorkspace(db))) return null
  const request = { method: 'exchangeSyncedSnapshot' as const, operationId: randomUUID(), databasePath,
    targetFingerprint: exchangeTargetFingerprint(target) }
  const originalEpoch = db.prepare("SELECT json_extract(value,'$.recoveryEpoch') FROM app_settings WHERE key=?")
    .pluck().get(exchangeStateKey(request.targetFingerprint))
  const bridge = originalEpoch !== undefined && originalEpoch !== route.workspace.recoveryEpoch
    ? readSealedExchangeRejoin(db, databasePath, request.targetFingerprint) : null
  const seedWorkspace = bridge?.old ?? route.workspace
  const stored = readHistoricalSyncedExchangeState(db, request, seedWorkspace)
  const state = stored?.value
  const latest = state?.currentOperationId ? readSyncedExchangeReceiptById(db, state.currentOperationId) : null
  if (state && (stored?.raw !== publicationJson(state) || state.lastSyncAt !== route.lastSyncAt || !latest
    || latest.version === 1 || !latest.provenance.afterManifestEtag)) return null
  if (bridge && (stored?.raw !== bridge.value.oldStateRaw || bridge.value.newEpoch !== route.workspace.recoveryEpoch
    || bridge.old.workspaceScope !== route.workspace.workspaceScope)) return null
  const initial = !state || state.source.kind === 'initial-receipt' ? readInitialIncomingBaseline(db, {
    method: 'receiveInitialSyncedSnapshot', databasePath, operationId: request.operationId,
    targetFingerprint: initialIncomingTargetFingerprint(target)
  })?.value : undefined
  if (initial) {
    if (initial.result.workspaceScope !== seedWorkspace.workspaceScope || initial.result.recoveryEpoch !== seedWorkspace.recoveryEpoch
      || !initial.manifest.history || !state && initial.lastReceivedAt !== route.lastSyncAt
      || state && (initial.result.operationId !== state.source.operationId || initial.result.manifestHash !== state.source.manifestHash
        || initial.provenance.portableDigest !== state.source.portableDigest || initial.manifest.workspaceId !== state.remoteWorkspaceId)) return null
    return { request, route, bridge, latest, state, initial, publication: undefined }
  }
  if (state && state.source.kind !== 'confirmed-publication') return null
  const fingerprint = initialPublicationTargetFingerprint(target)
  const source: Pick<ExchangeSeedProof, 'kind' | 'operationId'> | undefined = state?.source ?? (() => {
    const grouped = db.prepare(`SELECT id FROM synced_exposure_attempts WHERE channel='webdav-manifest5'
      AND state='confirmed' AND target_fingerprint=? ORDER BY id`).pluck().all(fingerprint) as string[]
    const ordinary = readOrdinaryPublicationAttempts(db).map(({ attempt }) => attempt)
      .filter(row => row.target_fingerprint === fingerprint && row.state === 'confirmed').map(row => row.id)
    const ids = [...grouped, ...ordinary]
    return ids.length === 1 ? { kind: 'confirmed-publication', operationId: ids[0] } : undefined
  })()
  if (!source) return null
  const publication = readRejoinPublicationSeed(db, source, fingerprint)
  if (!state && Date.parse(publication.exposure.confirmed_at!) > Date.parse(route.lastSyncAt)) return null
  return { request, route, bridge, latest, state, initial: undefined, publication }
}

/** The sealed current database identifies a settled route. Only a complete
 * current closure with an exact live-to-deleted history transition is evidence. */
export async function readV3RestoreSourceTombstone(db: Database.Database, input: ReadInput) {
  const read = await readV3RestoreSourceTombstones(db, { databasePath: input.databasePath,
    config: input.config, runtime: input.runtime, groups: [input.group] })
  return read && { evidence: read.evidence[0], assertObservedHead: read.assertObservedHead }
}

/** Every group is checked against the same strong ETag and immutable history reads. */
export async function readV3RestoreSourceTombstones(db: Database.Database, input: Omit<ReadInput, 'group'> & { groups: readonly LiveGroup[] }) {
  input.runtime.signal?.throwIfAborted()
  if (!input.groups.length || !db.open || !db.readonly || db.inTransaction || db.pragma('foreign_keys', { simple: true }) !== 1) return null
  try {
    const target = normalizeWebDavConfig(input.config)
    const root = await canonicalRestoreRoot(dirname(dirname(input.databasePath)))
    const databasePath = observationDatabasePath(join(root, 'storage', 'knowbook.db'))
    if (observationDatabasePath(input.databasePath) !== databasePath) return null
    const local = db.transaction(() => readOriginalRoute(db, databasePath, target))()
    if (!local) return null
    const client = new WebDavClient(target, input.runtime.password, input.runtime.signal)
    const got = await fetchProtocol5RemoteClosure(client)
    if (got.status !== 'ready') return null
    const { remote } = got, head = remote.facts.manifest
    const remoteRecords = new Map(remote.facts.records.map(row => [row.key, row]))
    const groups = new Map<string, ObservedGroup>()
    for (const wire of input.groups) {
      const key = 'group:' + wire.id, group = validateSyncedProtocol5Record(wire, key), deleted = remoteRecords.get(key)
      if (groups.has(key) || group.kind !== 'synced-group' || deleted?.record.kind !== 'synced-group-deleted') return null
      const groupBytes = publicationJson(group), groupHash = publicationHash(groupBytes)
      if (deleted.record.creationId !== group.creationId || deleted.record.previousHash !== groupHash) return null
      groups.set(key, { key, group, groupBytes, groupHash, deleted: { hash: deleted.hash, record: deleted.record } })
    }
    const headHash = publicationHash(remote.manifest), etag = remote.manifestEtag
    requireStrongEtag(etag)
    const requiredWorkspace = local.state?.remoteWorkspaceId ?? local.initial?.manifest.workspaceId ?? local.route.workspace.workspaceScope
    if (head.workspaceId !== requiredWorkspace) return null
    const seedHash = local.state?.source.manifestHash ?? local.initial?.result.manifestHash
    const settledHash = local.latest?.provenance.afterManifestHash
    const acceptedHash = local.bridge?.value.observedHead.hash ?? settledHash ?? seedHash
    const acceptedEtag = local.bridge?.value.observedHead.etag
      ?? (local.latest && local.latest.version !== 1 ? local.latest.provenance.afterManifestEtag : local.initial?.provenance.manifestEtag)
    if (acceptedHash === headHash && acceptedEtag !== undefined && acceptedEtag !== etag) return null

    let acceptedFound = acceptedHash === undefined
    let settledFound = !local.bridge
    let seed: HistoricalManifest | undefined
    const expectedGenesis = local.publication && protocol5HistoryLink(protocol5HistoryTarget(target), local.publication.exposure.id, null)
    await assertProtocol5ManifestLineage(client, target, head, null, (manifest, hash) => {
      if (hash === acceptedHash) acceptedFound = true
      if (hash === settledHash && acceptedFound) settledFound = true
      if (seedHash ? hash === seedHash : expectedGenesis && same(manifest.history, expectedGenesis)) seed = { hash, manifest }
      for (const group of groups.values()) {
        if (group.transition) continue
        if (manifest.entries[group.key] === group.deleted.hash) group.deletion = { hash, manifest }
        else if (group.deletion) group.transition = { before: { hash, manifest }, deleted: group.deletion }
      }
    })
    if (!acceptedFound || !settledFound || !seed) return null
    if (local.initial && !same(local.initial.manifest, seed.manifest)) return null
    if (local.publication) {
      const source: ExchangeSeedProof = { kind: 'confirmed-publication', operationId: local.publication.exposure.id,
        manifestHash: seed.hash, portableDigest: initialIncomingPortableDigest(seed.manifest.entries, seed.manifest.syncedInstances) }
      if (local.state && !same(local.state.source, source)) return null
      const seedWorkspace = local.bridge?.old ?? local.route.workspace
      await readRejoinedPublicationSnapshot(client, target, seed.manifest, { databasePath, workspaceScope: seedWorkspace.workspaceScope,
        recoveryEpoch: seedWorkspace.recoveryEpoch, remoteWorkspaceId: requiredWorkspace, source }, local.publication, root)
    }

    const closureHash = publicationHash(publicationJson({ kind: 'synced-remote-initial-closure', version: 1,
      manifest: { hash: headHash, bytes: remote.manifest.length },
      records: remote.facts.records.map(({ key, hash, bytes }) => ({ key, hash, bytes })).sort((a, b) => publicationCompare(a.key, b.key)),
      assets: remote.facts.assets }))
    const assertObservedHead = async () => {
      const tail = await client.getVersioned('manifest.json', PUBLICATION_RECORD_MAX_BYTES)
      if (!tail || tail.etag !== etag || publicationHash(tail.bytes) !== headHash) throw new Error('恢复裁剪预检期间 WebDAV 当前清单已改变。')
    }
    const evidence = []
    for (const { key, group, groupHash, groupBytes, deleted, transition } of groups.values()) {
      if (!transition || transition.before.manifest.entries[key] !== groupHash
        || transition.deleted.manifest.history?.previousHash !== transition.before.hash) return null
      const previous = await client.get('objects/' + groupHash + '.json', PUBLICATION_RECORD_MAX_BYTES)
      if (!previous || !Buffer.from(previous.bytes).equals(Buffer.from(groupBytes))) return null
      const original = validateSyncedProtocol5Record(decodePublicationJson(previous.bytes), key)
      if (original.kind !== 'synced-group' || original.creationId !== group.creationId) return null
      const tombstoneBytes = remote.objects.get(key)
      if (!tombstoneBytes || publicationHash(tombstoneBytes) !== deleted.hash) return null
      evidence.push(frozenPublicationFacts({ kind: 'v3-restore-source-tombstone' as const, version: 1 as const, key,
        targetFingerprint: local.request.targetFingerprint, workspace: local.route.workspace, remoteWorkspaceId: head.workspaceId,
        seedManifestHash: seed.hash, acceptedManifestHash: acceptedHash ?? seed.hash, closureHash,
        ...(local.bridge ? { rejoinHash: local.bridge.hash } : {}),
        head: { hash: headHash, etag, manifest: head }, transition, tombstone: deleted,
        previous: { hash: groupHash, record: original }, executionAuthorized: false as const }))
    }
    await assertObservedHead()
    return { evidence, assertObservedHead }
  } catch {
    input.runtime.signal?.throwIfAborted()
    return null
  }
}
