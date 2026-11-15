import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import type { WebDavSyncConfig } from '../../shared/webdav-sync'
import { readCommittedRestoreCandidateSql, readRestoreKnowledgeInstallProof, assertRestoreKnowledgeInstalledSql } from '../database/restore-knowledge-install-proof'
import { assertInstalledRestoreRuntimeCoverage, readLiveInstalledRestoreRuntime } from '../database/restore-knowledge-runtime-authority'
import { readJointRestoreFence4, readJointRestoreIntent4 } from '../database/restore-joint-journal4'
import { readRawPriorKnowledgeCoverageOwned } from '../database/restore-knowledge-coverage-raw-read'
import { canonicalRestoreRoot, readRestoreText, restoreExists, restorePaths, writeRestoreJson } from '../database/restore-safety-files'
import { readInitialIncomingBaseline, readInitialIncomingWorkspace } from '../database/synced-initial-incoming-read'
import { readSyncedExchangeReceiptById } from '../database/synced-exchange-receipt'
import { readHistoricalSyncedExchangeState } from '../database/synced-exchange-read'
import { observationDatabasePath } from '../database/synced-remote-observation-pending'
import { decodeProtocol5Route, protocol5RouteKey } from './protocol5-service'
import { exchangeTargetFingerprint, validateExchangeRequest } from './synced-exchange-model'
import { deriveSyncedExchangeDependencyFacts } from './synced-exchange-plan'
import { initialIncomingPortableDigest, initialIncomingTargetFingerprint } from './synced-initial-incoming-model'
import { assertProtocol5ManifestLineage } from './synced-manifest-history'
import { validateSyncedProtocol5Record, validateSyncedProtocol5Snapshot } from './synced-protocol5-model'
import { decodePublicationJson, frozenPublicationFacts, protocol5HistoryTarget, publicationHash, publicationJson,
  PUBLICATION_RECORD_MAX_BYTES, validateInitialManifest5, type SyncedInitialManifest5 } from './synced-publication-model'
import { fetchProtocol5RemoteClosure, initialPublicationTargetFingerprint, type SyncedPublicationRuntime } from './synced-publication'
import { readRejoinPublicationSeed } from '../database/synced-exchange-rejoin-publication'
import { readRejoinedPublicationSnapshot } from './synced-exchange-rejoin-publication'
import { normalizeWebDavConfig, WebDavClient } from './webdav-client'
import { exchangeRejoinFile, exchangeRejoinKey, exchangeRejoinPin, exactExchangeRejoinRow,
  readActiveExchangeRejoin, readExchangeRejoinSql, validateExchangeRejoin } from '../database/synced-exchange-rejoin-model'

function fail(reason: string): never { throw new Error('WebDAV 恢复续接预检失败：' + reason) }
const same = (left: unknown, right: unknown) => publicationJson(left) === publicationJson(right)
type Request = ReturnType<typeof validateExchangeRequest>

function originalRouteState(db: Database.Database, request: Request, target: WebDavSyncConfig) {
  const setting = db.prepare('SELECT value,updated_at FROM app_settings WHERE key=?')
  const routeRow = setting.get(protocol5RouteKey(target)) as { value: string; updated_at: string } | undefined
  const route = decodeProtocol5Route(routeRow?.value ?? null, target)
  if (!route || route.pending || !route.lastSyncAt || !routeRow) return fail('缺原已结算且没有待办的同目标路由')
  const state = readHistoricalSyncedExchangeState(db, request, route.workspace)
  if (!state || state.value.lastSyncAt !== route.lastSyncAt || !state.value.currentOperationId
    || state.raw !== publicationJson(state.value)) return fail('原交换状态与路由不闭合')
  const latest = readSyncedExchangeReceiptById(db, state.value.currentOperationId)
  if (!latest || latest.version === 1 || !latest.provenance.afterManifestEtag) return fail('缺实际最后交换终态或远端 ETag')
  const acceptedEtag = latest.provenance.afterManifestEtag
  const { source } = state.value
  let initial: ReturnType<typeof readInitialIncomingBaseline> = null
  let publication: ReturnType<typeof readRejoinPublicationSeed> | undefined
  if (source.kind === 'initial-receipt') {
    initial = readInitialIncomingBaseline(db, { method: 'receiveInitialSyncedSnapshot', databasePath: request.databasePath,
      targetFingerprint: initialIncomingTargetFingerprint(target), operationId: request.operationId })
    if (!initial || initial.value.result.operationId !== source.operationId || initial.value.result.manifestHash !== source.manifestHash
      || initial.value.provenance.portableDigest !== source.portableDigest || initial.value.result.workspaceScope !== route.workspace.workspaceScope
      || initial.value.result.recoveryEpoch !== route.workspace.recoveryEpoch || initial.value.manifest.workspaceId !== state.value.remoteWorkspaceId)
      return fail('原接收种子与交换状态不闭合')
  } else if (source.kind === 'confirmed-publication') {
    publication = readRejoinPublicationSeed(db, source, initialPublicationTargetFingerprint(target))
  } else return fail('原交换没有可认证的发布或接收种子')
  const ids = new Set([latest.request.operationId, ...state.value.baseline.map(row => row.acceptedOperationId)])
  if (initial) ids.add(source.operationId!)
  if (publication) ids.delete(publication.exposure.id)
  const receiptRow = db.prepare('SELECT request_hash,result_json,created_at FROM synced_operations WHERE client_operation_id=?')
  const receiptPins = [...ids].sort().map(operationId => {
    const row = receiptRow.get(operationId)
    if (!row) return fail('缺原接收或交换回执字节')
    return { operationId, hash: publicationHash(publicationJson(row)) }
  })
  return { route, routeRow, state: state.value, rawState: state.raw, latest, acceptedEtag, initial: initial?.value, publication, receiptPins,
    oldRowsHash: publicationHash(publicationJson({ routeRow, state: state.raw, ...(initial ? { initial: initial.raw } : { publication: publication!.hash }), receiptPins })) }
}

async function readOriginalB(client: WebDavClient, old: ReturnType<typeof originalRouteState>, manifest: SyncedInitialManifest5) {
  const records = new Map<string, Awaited<ReturnType<typeof readOne>>>()
  async function readOne(key: string, hash: string) {
    const response = await client.get(`objects/${hash}.json`, PUBLICATION_RECORD_MAX_BYTES)
    if (!response || publicationHash(response.bytes) !== hash) return fail('缺准确原 B 对象：' + key)
    return { key, hash, record: validateSyncedProtocol5Record(decodePublicationJson(response.bytes), key) }
  }
  async function read(key: string, hash: string) {
    const slot = publicationJson([key, hash]), existing = records.get(slot)
    if (existing) return existing
    const record = await readOne(key, hash)
    records.set(slot, record)
    return record
  }
  const initialRecords = []
  for (const [key, hash] of Object.entries(manifest.entries)) {
    const { record } = await read(key, hash)
    initialRecords.push({ key, record })
  }
  const checked = validateSyncedProtocol5Snapshot(manifest, initialRecords)
  const dependencies = new Map(deriveSyncedExchangeDependencyFacts(checked).map(item => [item.key, item]))
  if (initialIncomingPortableDigest(checked.manifest.entries, checked.manifest.syncedInstances) !== old.state.source.portableDigest)
    return fail('原接收种子的完整图摘要不同')
  const baseline = []
  for (const row of old.state.baseline) {
    const hash = row.commonHash
    if (!hash || row.remoteHash !== hash) return fail('原共同 B 不完整：' + row.key)
    const item = await read(row.key, hash)
    if (row.acceptedOperationId === old.state.source.operationId) {
      const dependency = dependencies.get(row.key), local = 'localHash' in row ? row.localHash : row.local.kind === 'live' ? row.local.hash : null
      if (manifest.entries[row.key] !== hash || local !== hash || !dependency
        || row.dependencySignature !== dependency.dependencySignature || !same(row.dependencyKeys, dependency.dependencyKeys))
        return fail('原种子 B 行与全图依赖不同：' + row.key)
    }
    baseline.push({ key: item.key, hash: item.hash, acceptedOperationId: row.acceptedOperationId, dependencySignature: row.dependencySignature })
  }
  return baseline
}

/** Main-only evidence probe. No local route/state/observation writes, no
 * remote mutation and no authorization to resume exchange. */
async function inspectProtocol5RestoreRejoin(db: Database.Database, userDataRoot: string,
  config: WebDavSyncConfig, credentials: SyncedPublicationRuntime) {
  const root = await canonicalRestoreRoot(userDataRoot), target = normalizeWebDavConfig(config)
  const database = join(root, 'storage', 'knowbook.db'), installed = readLiveInstalledRestoreRuntime(db, database)
  if (!installed?.operationId || !installed.intentHash || !installed.installationProofHash || db.inTransaction)
    return fail('缺实际已安装工作区的冷启动和连接证明')
  const paths = restorePaths(root, installed.operationId)
  const active = await readJointRestoreFence4(paths.fence)
  if (await restoreExists(paths.journal) || active.fence.phase !== 'installed' || active.fence.operationId !== installed.operationId
    || active.fence.intentHash !== installed.intentHash) return fail('当前已安装 fence 与连接不同或恢复尚未结束')
  const intent = await readJointRestoreIntent4(root, active.fence)
  if (intent.installationProofHash !== installed.installationProofHash) return fail('当前安装凭据不同')
  const proof = await readRestoreKnowledgeInstallProof(root, intent.operationId, installed.installationProofHash)
  const request = validateExchangeRequest({ method: 'exchangeSyncedSnapshot', operationId: randomUUID(),
    databasePath: observationDatabasePath(database), targetFingerprint: exchangeTargetFingerprint(target) })
  const readLocal = db.transaction(() => {
    if (readLiveInstalledRestoreRuntime(db, database) !== installed) return fail('当前数据库连接已变化')
    assertInstalledRestoreRuntimeCoverage(db, installed, readRawPriorKnowledgeCoverageOwned(db))
    const coverage = assertRestoreKnowledgeInstalledSql(db, proof, 'steady')
    const old = originalRouteState(db, request, target), local = readInitialIncomingWorkspace(db)
    if (old.route.workspace.workspaceScope !== coverage.target.workspaceScope
      || old.route.workspace.recoveryEpoch !== coverage.cut.beforeEpoch || old.route.workspace.recoveryEpoch === coverage.target.recoveryEpoch)
      return fail('原路由并非本次恢复之前的源世代')
    return { old, localFingerprint: local.fingerprint }
  })
  const before = readLocal()
  const sealed = await readCommittedRestoreCandidateSql(intent, candidate => originalRouteState(candidate, request, target))
  if (sealed.oldRowsHash !== before.old.oldRowsHash) return fail('原路由、状态或回执与精确安装原件不同')
  const { old } = before, client = new WebDavClient(target, credentials.password, credentials.signal)
  const got = await fetchProtocol5RemoteClosure(client)
  if (got.status !== 'ready') return fail('原目标缺完整 Protocol 5 远端')
  const { remote } = got, head = remote.facts.manifest
  if (head.workspaceId !== old.state.remoteWorkspaceId || !head.history)
    return fail('远端工作区或原历史链不同')

  const originalManifestHash = old.latest.provenance.afterManifestHash, originalEtag = old.acceptedEtag
  const manifestHash = publicationHash(remote.manifest)
  let anchor: SyncedInitialManifest5 = head
  if (manifestHash !== originalManifestHash) {
    const found = await client.get(`objects/manifest-${originalManifestHash}.json`, PUBLICATION_RECORD_MAX_BYTES)
    if (!found || publicationHash(found.bytes) !== originalManifestHash) return fail('远端缺初始承接 head 原字节')
    anchor = validateInitialManifest5(decodePublicationJson(found.bytes))
  } else if (remote.manifestEtag !== originalEtag) return fail('同一远端 head 的 ETag 已变化')
  await assertProtocol5ManifestLineage(client, target, head, originalManifestHash)
  await assertProtocol5ManifestLineage(client, target, anchor, old.state.source.manifestHash)
  const seedManifest = old.initial?.manifest ?? (await readRejoinedPublicationSnapshot(client, target, anchor, old.state, old.publication!, root)).manifest
  if (!seedManifest.history || seedManifest.history.previousHash !== null || seedManifest.history.targetFingerprint !== protocol5HistoryTarget(target))
    return fail('原发布或接收种子不是准确历史根')
  const baseline = await readOriginalB(client, old, seedManifest)
  const tail = await client.getVersioned('manifest.json', PUBLICATION_RECORD_MAX_BYTES)
  if (!tail || tail.etag !== remote.manifestEtag || publicationHash(tail.bytes) !== manifestHash)
    return fail('预检期间远端 head 变化')
  await readJointRestoreIntent4(root, active.fence)
  const sealedTail = await readCommittedRestoreCandidateSql(intent, candidate => originalRouteState(candidate, request, target))
  const after = readLocal()
  if (sealedTail.oldRowsHash !== sealed.oldRowsHash || after.localFingerprint !== before.localFingerprint || after.old.oldRowsHash !== old.oldRowsHash
    || publicationHash(await readRestoreText(paths.fence)) !== active.hash || await restoreExists(paths.journal))
    return fail('预检期间本地工作区或安装记录变化')
  const observation = frozenPublicationFacts({ kind: 'protocol5-restore-rejoin-observation' as const, operationId: intent.operationId,
    targetFingerprint: request.targetFingerprint, remoteWorkspaceId: head.workspaceId,
    originalManifestHash, originalEtag, manifestHash, etag: remote.manifestEtag,
    originalRecoveryEpoch: old.state.recoveryEpoch, installedRecoveryEpoch: installed.recoveryEpoch,
    oldRowsHash: old.oldRowsHash, baseline, executionAuthorized: false as const })
  return { observation, installed, intentHash: active.fence.intentHash, old, localFingerprint: before.localFingerprint,
    async assertObservedHead() {
      if (await readRestoreText(paths.fence) !== publicationJson(active.fence) || await restoreExists(paths.journal)) return fail('确认期间当前恢复身份变化')
      const tail = await client.getVersioned('manifest.json', PUBLICATION_RECORD_MAX_BYTES)
      if (!tail || tail.etag !== remote.manifestEtag || publicationHash(tail.bytes) !== manifestHash) return fail('确认期间远端版本变化')
    },
    assertLocal() {
      const current = readLocal()
      if (current.localFingerprint !== before.localFingerprint || current.old.oldRowsHash !== old.oldRowsHash) return fail('确认期间原恢复续接预案变化')
    } }
}

const prepared = new WeakMap<Protocol5RestoreRejoinPreview, { db: Database.Database; digest: string }>()
export interface Protocol5RestoreRejoinPreview { readonly kind: 'protocol5-restore-rejoin-preview' }
const previewDigest = (value: Awaited<ReturnType<typeof inspectProtocol5RestoreRejoin>>) =>
  publicationHash(publicationJson([value.observation, value.localFingerprint, value.intentHash]))

export async function prepareProtocol5RestoreRejoin(db: Database.Database, userDataRoot: string,
  target: WebDavSyncConfig, credentials: SyncedPublicationRuntime) {
  const read = await inspectProtocol5RestoreRejoin(db, userDataRoot, target, credentials)
  const owner = Object.freeze({ kind: 'protocol5-restore-rejoin-preview' as const })
  prepared.set(owner, { db, digest: previewDigest(read) })
  return Object.freeze({ ...read.observation, owner })
}

/** Main calls this after confirmation of a genuinely prepared plan. Neither
 * old receipt nor WebDAV state is replaced by the bridge transaction. */
export async function confirmProtocol5RestoreRejoin(db: Database.Database, root: string, config: WebDavSyncConfig,
  credentials: SyncedPublicationRuntime, owner: Protocol5RestoreRejoinPreview) {
  const prior = prepared.get(owner)
  if (prior?.db !== db) return fail('缺真实确认所对应的原预检')
  prepared.delete(owner)
  const read = await inspectProtocol5RestoreRejoin(db, root, config, credentials)
  if (previewDigest(read) !== prior.digest) return fail('原恢复续接预案已变化，请重新读取')
  const { observation, installed, old, intentHash } = read
  const confirmedAt = new Date().toISOString()
  const proof = validateExchangeRejoin({ kind: 'synced-exchange-restore-rejoin', version: old.publication ? 2 : 1,
    restoreOperationId: observation.operationId, targetFingerprint: observation.targetFingerprint, intentHash,
    proofHash: installed.installationProofHash, oldRouteRaw: old.routeRow.value, oldRouteUpdatedAt: old.routeRow.updated_at,
    oldStateRaw: old.rawState, oldRowsHash: old.oldRowsHash, receiptPins: old.receiptPins,
    acceptedHead: { hash: observation.originalManifestHash, etag: observation.originalEtag },
    observedHead: { hash: observation.manifestHash, etag: observation.etag }, newEpoch: observation.installedRecoveryEpoch, confirmedAt,
    ...(old.publication ? { publicationSeed: { targetFingerprint: old.publication.exposure.target_fingerprint, rowHash: old.publication.hash } } : {}) })
  const pin = exchangeRejoinPin(proof), canonicalRoot = await canonicalRestoreRoot(root)
  const receiptFile = exchangeRejoinFile(canonicalRoot, proof.restoreOperationId, pin.bridgeHash)
  if (!await restoreExists(receiptFile)) {
    await writeRestoreJson(receiptFile, pin, canonicalRoot, true)
  }
  await read.assertObservedHead()
  credentials.signal?.throwIfAborted()
  const routeKey = protocol5RouteKey(normalizeWebDavConfig(config)), data = publicationJson(proof)
  db.transaction(() => {
    read.assertLocal()
    const current = exactExchangeRejoinRow(db, proof.targetFingerprint)
    if (current?.value !== old.rawState || current.updated_at !== old.state.lastSyncAt
      || readExchangeRejoinSql(db, proof.targetFingerprint, proof.restoreOperationId)) return fail('原路由或基线已续接或变化')
    db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)')
      .run(exchangeRejoinKey(proof.targetFingerprint, proof.restoreOperationId), data, confirmedAt)
    const route = { ...old.route, workspace: { workspaceScope: installed.workspaceScope, recoveryEpoch: installed.recoveryEpoch } }
    if (db.prepare('UPDATE app_settings SET value=?,updated_at=? WHERE key=? AND value=? AND updated_at=?')
      .run(JSON.stringify(route), confirmedAt, routeKey, old.routeRow.value, old.routeRow.updated_at).changes !== 1) return fail('恢复续接原路由变化')
    if (readActiveExchangeRejoin(db, db.name, proof.targetFingerprint)?.hash !== publicationHash(data))
      return fail('恢复续接没有持久读回原凭据')
  }).immediate()
  return Object.freeze({ operationId: observation.operationId, bridgeHash: publicationHash(data) })
}
