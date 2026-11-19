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
import { exchangeTargetFingerprint, parseExchangeStored, validateAnyExchangeState, validateExchangeRequest } from './synced-exchange-model'
import { deriveSyncedExchangeDependencyFacts } from './synced-exchange-plan'
import { initialIncomingPortableDigest, initialIncomingTargetFingerprint, initialIncomingTombstoneFacts } from './synced-initial-incoming-model'
import { assertProtocol5ManifestLineage } from './synced-manifest-history'
import { validateSyncedProtocol5Record, validateSyncedProtocol5Snapshot } from './synced-protocol5-model'
import { decodePublicationJson, frozenPublicationFacts, protocol5HistoryTarget, publicationHash, publicationJson,
  PUBLICATION_RECORD_MAX_BYTES, validateInitialManifest5, type SyncedInitialManifest5 } from './synced-publication-model'
import { fetchProtocol5RemoteClosure, initialPublicationTargetFingerprint, type SyncedPublicationRuntime } from './synced-publication'
import { readRejoinPublicationSeed } from '../database/synced-exchange-rejoin-publication'
import { readInitialPublicationRejoinSnapshot, readRejoinedPublicationSnapshot } from './synced-exchange-rejoin-publication'
import { normalizeWebDavConfig, WebDavClient } from './webdav-client'
import { assertExchangeRejoinPins, exchangeRejoinFile, exchangeRejoinKey, exchangeRejoinPin, exactExchangeRejoinRow, initialRejoinKey,
  readActiveExchangeRejoin, readActiveInitialRejoin, readExchangeRejoinSql, readInitialRejoinEvidence,
  readInitialRejoinSql, validateExchangeRejoin, validateInitialRejoin } from '../database/synced-exchange-rejoin-model'

function fail(reason: string): never { throw new Error('WebDAV 恢复续接预检失败：' + reason) }
const same = (left: unknown, right: unknown) => publicationJson(left) === publicationJson(right)
type Request = ReturnType<typeof validateExchangeRequest>

function originalRouteState(db: Database.Database, request: Request, target: WebDavSyncConfig) {
  const setting = db.prepare('SELECT value,updated_at FROM app_settings WHERE key=?')
  const routeRow = setting.get(protocol5RouteKey(target)) as { value: string; updated_at: string } | undefined
  const route = decodeProtocol5Route(routeRow?.value ?? null, target)
  if (!route || route.pending || !route.lastSyncAt || !routeRow) return fail('缺原已结算且没有待办的同目标路由')
  const savedState = exactExchangeRejoinRow(db, request.targetFingerprint)
  if (!savedState) {
    if (db.prepare(`SELECT 1 FROM synced_operations WHERE json_extract(result_json,'$.kind')='synced-exchange-operation'
      AND json_extract(result_json,'$.request.targetFingerprint')=? LIMIT 1`).get(request.targetFingerprint))
      return fail('已有该目标的交换回执，但原交换状态缺失')
    const original = { databasePath: request.databasePath, oldRouteRaw: routeRow.value, oldRouteUpdatedAt: routeRow.updated_at }
    const incoming = { kind: 'receive' as const, targetFingerprint: initialIncomingTargetFingerprint(target) }
    const outgoing = { kind: 'publish' as const, targetFingerprint: initialPublicationTargetFingerprint(target) }
    const received = readInitialRejoinEvidence(db, { ...original, source: incoming })
    const published = readInitialRejoinEvidence(db, { ...original, source: outgoing })
    if (received && published) return fail('首同步路由对应多个真实接受凭据')
    const exact = received ?? published
    if (!exact) return fail('缺原已结算的交换状态或真实首同步回执')
    return { kind: 'initial' as const, route, routeRow, exact, oldRowsHash: exact.oldRowsHash, databasePath: request.databasePath,
      source: received ? incoming : outgoing }
  }
  const stored = validateAnyExchangeState(parseExchangeStored(savedState.value))
  const stateScope = { workspaceScope: stored.workspaceScope, recoveryEpoch: stored.recoveryEpoch }
  let predecessor: NonNullable<ReturnType<typeof readExchangeRejoinSql>> | undefined
  if (!same(stateScope, route.workspace)) {
    const cuts = readRawPriorKnowledgeCoverageOwned(db).entries.filter(item => item.cut.kind === 'synced-recovery-epoch-cut'
      && item.cut.workspaceScope === route.workspace.workspaceScope && item.cut.afterEpoch === route.workspace.recoveryEpoch)
    const previous = cuts.length === 1 ? readExchangeRejoinSql(db, request.targetFingerprint, cuts[0].operationId) : null
    if (!previous || previous.value.newEpoch !== route.workspace.recoveryEpoch || previous.value.oldStateRaw !== savedState.value
      || previous.old.workspaceScope !== route.workspace.workspaceScope) return fail('原路由与交换状态缺准确的前次续接')
    predecessor = previous
  }
  const state = readHistoricalSyncedExchangeState(db, request, stateScope)
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
      || initial.value.result.recoveryEpoch !== state.value.recoveryEpoch || initial.value.manifest.workspaceId !== state.value.remoteWorkspaceId)
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
  return { kind: 'exchange' as const, route, routeRow, state: state.value, rawState: state.raw, latest, acceptedEtag, initial: initial?.value, publication, receiptPins, predecessor,
    oldRowsHash: publicationHash(publicationJson({ routeRow, state: state.raw, ...(initial ? { initial: initial.raw } : { publication: publication!.hash }), receiptPins,
      ...(predecessor ? { predecessor: { operationId: predecessor.value.restoreOperationId, hash: predecessor.hash } } : {}) })) }
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
  const seedDigest = old.kind === 'initial' ? old.exact.portableDigest : old.state.source.portableDigest
  if (initialIncomingPortableDigest(checked.manifest.entries, checked.manifest.syncedInstances) !== seedDigest)
    return fail('原接收种子的完整图摘要不同')
  if (old.kind === 'initial') return checked.records.map(item => ({ key: item.key, hash: item.hash,
    acceptedOperationId: old.exact.operationId, dependencySignature: dependencies.get(item.key)!.dependencySignature }))
  const inherited = new Map(initialIncomingTombstoneFacts(old.initial ?? null).map(item => [item.key, item]))
  const baseline = []
  for (const row of old.state.baseline) {
    const hash = row.commonHash
    if (!hash || row.remoteHash !== hash) return fail('原共同 B 不完整：' + row.key)
    const item = await read(row.key, hash)
    if (row.acceptedOperationId === old.state.source.operationId) {
      const dependency = dependencies.get(row.key), deletion = inherited.get(row.key)
      const local = 'localHash' in row ? row.localHash : row.local.kind === 'live' ? row.local.hash
        : deletion && row.local.deletionOperationId === deletion.deletionOperationId && row.local.intentHash === deletion.intentHash
          && row.local.tombstoneHash === deletion.tombstoneHash ? row.local.tombstoneHash : null
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
    if (old.kind === 'exchange' && old.predecessor) assertExchangeRejoinPins(root, [old.predecessor, ...old.predecessor.ancestors])
    return { old, localFingerprint: local.fingerprint }
  })
  const before = readLocal()
  const sealed = await readCommittedRestoreCandidateSql(intent, candidate => originalRouteState(candidate, request, target))
  if (sealed.oldRowsHash !== before.old.oldRowsHash) return fail('原路由、状态或回执与精确安装原件不同')
  const { old } = before, client = new WebDavClient(target, credentials.password, credentials.signal)
  const got = await fetchProtocol5RemoteClosure(client)
  if (got.status !== 'ready') return fail('原目标缺完整 Protocol 5 远端')
  const { remote } = got, head = remote.facts.manifest
  const originalWorkspaceId = old.kind === 'initial' ? old.exact.remoteWorkspaceId : old.state.remoteWorkspaceId
  if (head.workspaceId !== originalWorkspaceId || !head.history)
    return fail('远端工作区或原历史链不同')

  const { hash: originalManifestHash, etag: originalEtag } = old.kind === 'initial' ? old.exact.acceptedHead
    : { hash: old.latest.provenance.afterManifestHash, etag: old.acceptedEtag }
  const manifestHash = publicationHash(remote.manifest)
  let anchor: SyncedInitialManifest5 = head
  if (manifestHash !== originalManifestHash) {
    const found = await client.get(`objects/manifest-${originalManifestHash}.json`, PUBLICATION_RECORD_MAX_BYTES)
    if (!found || publicationHash(found.bytes) !== originalManifestHash) return fail('远端缺初始承接 head 原字节')
    anchor = validateInitialManifest5(decodePublicationJson(found.bytes))
  } else if (remote.manifestEtag !== originalEtag) return fail('同一远端 head 的 ETag 已变化')
  await assertProtocol5ManifestLineage(client, target, head, originalManifestHash)
  if (old.kind === 'exchange' && old.predecessor) {
    const priorHead = old.predecessor.value.observedHead
    if (manifestHash === priorHead.hash && remote.manifestEtag !== priorHead.etag) return fail('前次续接观察版本的 ETag 已变化')
    await assertProtocol5ManifestLineage(client, target, head, priorHead.hash)
  }
  const seedHash = old.kind === 'initial' ? old.exact.acceptedHead.hash : old.state.source.manifestHash
  await assertProtocol5ManifestLineage(client, target, anchor, seedHash)
  const seedManifest = old.kind === 'initial' ? old.exact.kind === 'receive' ? old.exact.initial.manifest
    : (await readInitialPublicationRejoinSnapshot(client, target, anchor, old.exact, root)).manifest
    : old.initial?.manifest ?? (await readRejoinedPublicationSnapshot(client, target, anchor, old.state, old.publication!, root)).manifest
  const receiving = old.kind === 'initial' ? old.exact.kind === 'receive' : !!old.initial
  if (!seedManifest.history || !receiving && seedManifest.history.previousHash !== null || seedManifest.history.targetFingerprint !== protocol5HistoryTarget(target))
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
    originalRecoveryEpoch: old.kind === 'initial' ? old.exact.recoveryEpoch : old.state.recoveryEpoch,
    installedRecoveryEpoch: installed.recoveryEpoch,
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
  const common = {
    restoreOperationId: observation.operationId, targetFingerprint: observation.targetFingerprint, intentHash,
    proofHash: installed.installationProofHash, oldRouteRaw: old.routeRow.value, oldRouteUpdatedAt: old.routeRow.updated_at,
    oldRowsHash: old.oldRowsHash,
    acceptedHead: { hash: observation.originalManifestHash, etag: observation.originalEtag },
    observedHead: { hash: observation.manifestHash, etag: observation.etag }, newEpoch: observation.installedRecoveryEpoch, confirmedAt
  }
  const proof = old.kind === 'initial'
    ? validateInitialRejoin({ ...common, kind: 'synced-initial-restore-rejoin', version: 1, databasePath: old.databasePath, source: old.source })
    : validateExchangeRejoin({ ...common, kind: 'synced-exchange-restore-rejoin', version: old.predecessor ? 3 : old.publication ? 2 : 1,
      oldStateRaw: old.rawState, receiptPins: old.receiptPins,
      ...(old.predecessor ? { predecessor: { operationId: old.predecessor.value.restoreOperationId, hash: old.predecessor.hash } } : {}),
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
    const initialOnly = proof.kind === 'synced-initial-restore-rejoin'
    if ((old.kind === 'initial' ? !!current : current?.value !== old.rawState || current.updated_at !== old.state.lastSyncAt)
      || readExchangeRejoinSql(db, proof.targetFingerprint, proof.restoreOperationId)
      || readInitialRejoinSql(db, proof.targetFingerprint, proof.restoreOperationId)) return fail('原路由或基线已续接或变化')
    const proofKey = initialOnly ? initialRejoinKey : exchangeRejoinKey
    db.prepare('INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)').run(proofKey(proof.targetFingerprint, proof.restoreOperationId), data, confirmedAt)
    const route = { ...old.route, workspace: { workspaceScope: installed.workspaceScope, recoveryEpoch: installed.recoveryEpoch } }
    if (db.prepare('UPDATE app_settings SET value=?,updated_at=? WHERE key=? AND value=? AND updated_at=?')
      .run(JSON.stringify(route), confirmedAt, routeKey, old.routeRow.value, old.routeRow.updated_at).changes !== 1) return fail('恢复续接原路由变化')
    const readProof = initialOnly ? readActiveInitialRejoin : readActiveExchangeRejoin
    if (readProof(db, db.name, proof.targetFingerprint)?.hash !== publicationHash(data))
      return fail('恢复续接没有持久读回原凭据')
  }).immediate()
  return Object.freeze({ operationId: observation.operationId, bridgeHash: publicationHash(data) })
}
