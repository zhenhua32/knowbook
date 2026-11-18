import type Database from 'better-sqlite3'
import { dirname, join } from 'node:path'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { assertSyncedShape, isSyncedUuid } from '../../shared/syncedBlockValidation'
import { exchangeStateKey, liftTombstoneExchangeState, parseExchangeStored, validateAnyExchangeState } from '../sync/synced-exchange-model'
import { publicationHash, publicationInvalid, publicationJson } from '../sync/synced-publication-model'
import { readRawPriorKnowledgeCoverageOwned } from './restore-knowledge-coverage-raw-read'
import { restorePaths } from './restore-safety-files'
import { assertInstalledRestoreRuntimeCoverage, attachInstalledRestoreRuntime, readInstalledRestoreRuntime,
  readLiveInstalledRestoreRuntime } from './restore-knowledge-runtime-authority'
import { readRejoinPublicationSeed } from './synced-exchange-rejoin-publication'

export const exchangeRejoinPrefix = 'sync.webdav.protocol5.exchange-rejoin.v1.'
const digest = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : invalid()
const uuid = (value: unknown) => isSyncedUuid(value) ? value : invalid()
const text = (value: unknown) => typeof value === 'string' && value.length > 0 ? value : invalid()
const invalid = (): never => publicationInvalid('恢复续接原记录损坏或缺少准确历史来源。')
const same = (a: unknown, b: unknown) => publicationJson(a) === publicationJson(b)

export function exchangeRejoinKey(targetFingerprint: string, operationId: string) {
  return exchangeRejoinPrefix + digest(targetFingerprint) + '.' + uuid(operationId)
}

export function exchangeRejoinFile(root: string, operationId: string, bridgeHash: string) {
  return join(restorePaths(root, uuid(operationId)).recovery, 'webdav-rejoin-' + digest(bridgeHash) + '.json')
}

export function exchangeRejoinPin(proof: ExchangeRejoin) {
  return { kind: 'synced-exchange-rejoin-pin', version: 1, restoreOperationId: proof.restoreOperationId,
    targetFingerprint: proof.targetFingerprint, originalRowsHash: proof.oldRowsHash, intentHash: proof.intentHash, proofHash: proof.proofHash,
    bridgeHash: publicationHash(publicationJson(proof)) }
}

function readSmallPin(file: string) {
  const named = lstatSync(file, { bigint: true, throwIfNoEntry: false })
  if (!named) return invalid()
  const expected = realpathSync.native(file), normalized = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path
  if (!named?.isFile() || named.isSymbolicLink() || named.nlink !== 1n || named.size > 4096n || normalized(expected) !== normalized(file)) return invalid()
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const initial = fstatSync(fd, { bigint: true })
    const matches = (stat: typeof initial) => stat.isFile() && stat.nlink === 1n && stat.ino > 0n && stat.ino === initial.ino
      && (stat.dev === initial.dev || process.platform === 'win32' && (!stat.dev || BigInt.asUintN(32, stat.dev) === initial.dev))
      && stat.size === initial.size && stat.mtimeNs === initial.mtimeNs && stat.ctimeNs === initial.ctimeNs
    if (!matches(named) || initial.size > 4096n) return invalid()
    const bytes = Buffer.alloc(Number(initial.size) + 1)
    let length = 0
    while (length < bytes.length) {
      const amount = readSync(fd, bytes, length, bytes.length - length, length)
      if (!amount) break
      length += amount
    }
    if (BigInt(length) !== initial.size || !matches(fstatSync(fd, { bigint: true })) || !matches(lstatSync(file, { bigint: true }))) return invalid()
    return bytes.subarray(0, length).toString('utf8')
  } finally { closeSync(fd) }
}

function head(value: unknown) {
  assertSyncedShape(value, ['hash', 'etag'])
  return { hash: digest(value.hash), etag: text(value.etag) }
}

export function validateExchangeRejoin(value: unknown) {
  const version = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'version')?.value : undefined
  if (version !== 1 && version !== 2 && version !== 3) return invalid()
  const publication = version === 2 || version === 3 && Object.hasOwn(value as object, 'publicationSeed')
  assertSyncedShape(value, ['kind', 'version', 'restoreOperationId', 'targetFingerprint', 'intentHash', 'proofHash',
    'oldRouteRaw', 'oldRouteUpdatedAt', 'oldStateRaw', 'oldRowsHash', 'receiptPins', 'acceptedHead', 'observedHead', 'newEpoch', 'confirmedAt',
    ...(publication ? ['publicationSeed'] : []), ...(version === 3 ? ['predecessor'] : [])])
  if (value.kind !== 'synced-exchange-restore-rejoin' || !Array.isArray(value.receiptPins)
    || !Number.isFinite(Date.parse(text(value.confirmedAt))) || !Number.isFinite(Date.parse(text(value.oldRouteUpdatedAt)))) return invalid()
  const state = validateAnyExchangeState(parseExchangeStored(text(value.oldStateRaw)))
  const oldRoute = parseExchangeStored(text(value.oldRouteRaw))
  assertSyncedShape(oldRoute, ['workspace', 'lastSyncAt', 'pending'])
  assertSyncedShape(oldRoute.workspace, ['workspaceScope', 'recoveryEpoch'])
  if (oldRoute.workspace.workspaceScope !== state.workspaceScope || !isSyncedUuid(oldRoute.workspace.recoveryEpoch)
    || (version !== 3) !== (oldRoute.workspace.recoveryEpoch === state.recoveryEpoch)
    || oldRoute.workspace.recoveryEpoch === value.newEpoch || oldRoute.lastSyncAt !== state.lastSyncAt || oldRoute.pending !== null
    || state.recoveryEpoch === value.newEpoch
    || state.targetFingerprint !== value.targetFingerprint || value.oldStateRaw !== publicationJson(state)
    || !state.currentOperationId || state.source.kind !== (publication ? 'confirmed-publication' : 'initial-receipt')) return invalid()
  const seedId = state.source.operationId!, allIds = [seedId, state.currentOperationId, ...state.baseline.map(row => row.acceptedOperationId)]
  const receiptIds = [...new Set(publication ? allIds.filter(id => id !== seedId) : allIds)].sort()
  const receiptPins = value.receiptPins.map(pin => {
    assertSyncedShape(pin, ['operationId', 'hash'])
    return { operationId: uuid(pin.operationId), hash: digest(pin.hash) }
  })
  if (!same(receiptPins.map(pin => pin.operationId), receiptIds)) return invalid()
  const common = { kind: value.kind, restoreOperationId: uuid(value.restoreOperationId), targetFingerprint: digest(value.targetFingerprint),
    intentHash: digest(value.intentHash), proofHash: digest(value.proofHash), oldRouteRaw: text(value.oldRouteRaw), oldRouteUpdatedAt: text(value.oldRouteUpdatedAt),
    oldStateRaw: text(value.oldStateRaw), oldRowsHash: digest(value.oldRowsHash), receiptPins,
    acceptedHead: head(value.acceptedHead), observedHead: head(value.observedHead), newEpoch: uuid(value.newEpoch), confirmedAt: text(value.confirmedAt) }
  if (version === 1) return { ...common, version: 1 as const }
  const publicationFields = () => {
    assertSyncedShape(value.publicationSeed, ['targetFingerprint', 'rowHash'])
    return { publicationSeed: { targetFingerprint: digest(value.publicationSeed.targetFingerprint), rowHash: digest(value.publicationSeed.rowHash) } }
  }
  if (version === 2) return { ...common, version: 2 as const, ...publicationFields() }
  assertSyncedShape(value.predecessor, ['operationId', 'hash'])
  return { ...common, version: 3 as const, ...(publication ? publicationFields() : {}),
    predecessor: { operationId: uuid(value.predecessor.operationId), hash: digest(value.predecessor.hash) } }
}
export type ExchangeRejoin = ReturnType<typeof validateExchangeRejoin>
export const exchangeRejoinState = (value: ExchangeRejoin) => validateAnyExchangeState(parseExchangeStored(value.oldStateRaw))
function originalRouteEpoch(value: ExchangeRejoin) {
  return (parseExchangeStored(value.oldRouteRaw) as { workspace: { recoveryEpoch: string } }).workspace.recoveryEpoch
}

export function exchangeRejoinBaseline(state: ReturnType<typeof exchangeRejoinState>, version: 1 | 2) {
  const selected = version === 2 && state.version === 1 ? liftTombstoneExchangeState(state) : state
  return new Map(selected.baseline.map(entry => [entry.key, entry]))
}

/** Read an actual immutable bridge and its exact original SQL support. Historical
 * reads check the bridge shape and support without granting live authority. */
export function readExchangeRejoinSupport(db: Database.Database, value: ExchangeRejoin) {
  if (!db.open || !db.inTransaction) return invalid()
  const old = exchangeRejoinState(value), requirements = readRawPriorKnowledgeCoverageOwned(db)
  const entries = new Map(requirements.entries.map(entry => [entry.operationId, entry]))
  function matchingCut(bridge: ExchangeRejoin) {
    const entry = entries.get(bridge.restoreOperationId)
    if (!entry || entry.cut.kind !== 'synced-recovery-epoch-cut' || entry.cut.beforeEpoch !== originalRouteEpoch(bridge)
      || entry.cut.afterEpoch !== bridge.newEpoch || entry.cut.workspaceScope !== old.workspaceScope) return invalid()
    return entry
  }
  const requirement = matchingCut(value)
  const ancestors: Array<{ value: ExchangeRejoin; hash: string }> = []
  const seen = new Set([value.restoreOperationId])
  let current = value
  while (current.version === 3) {
    const { operationId, hash } = current.predecessor
    if (seen.has(operationId)) return invalid()
    const prior = readStoredExchangeRejoin(db, value.targetFingerprint, operationId)
    if (!prior || prior.hash !== hash || prior.value.newEpoch !== originalRouteEpoch(current)
      || prior.value.oldStateRaw !== value.oldStateRaw || !same(prior.value.acceptedHead, value.acceptedHead)) return invalid()
    matchingCut(prior.value)
    ancestors.push(prior); seen.add(operationId)
    current = prior.value
  }
  const op = db.prepare('SELECT request_hash,result_json,created_at FROM synced_operations WHERE client_operation_id=?')
  const receipts = value.receiptPins.map(pin => {
    const row = op.get(pin.operationId)
    if (!row || publicationHash(publicationJson(row)) !== pin.hash) return invalid()
    return { operationId: pin.operationId, row }
  })
  const seed = 'publicationSeed' in value ? value.publicationSeed : undefined
  const publication = seed ? readRejoinPublicationSeed(db, old.source, seed.targetFingerprint) : undefined
  if (seed && publication?.hash !== seed.rowHash) return invalid()
  const raw = receipts.find(receipt => receipt.operationId === old.currentOperationId)?.row as { result_json: string } | undefined
  const accepted = raw && parseExchangeStored(raw.result_json)
  if (!accepted || typeof accepted !== 'object' || !('provenance' in accepted) || !accepted.provenance
    || typeof accepted.provenance !== 'object' || !('afterStateHash' in accepted.provenance)
    || !('afterManifestHash' in accepted.provenance) || !('afterManifestEtag' in accepted.provenance)
    || accepted.provenance.afterStateHash !== publicationHash(value.oldStateRaw) || accepted.provenance.afterManifestHash !== value.acceptedHead.hash
    || accepted.provenance.afterManifestEtag !== value.acceptedHead.etag) return invalid()
  return { old, requirement, requirements, receipts, publication, ancestors }
}

function readStoredExchangeRejoin(db: Database.Database, targetFingerprint: string, restoreOperationId: string) {
  const key = exchangeRejoinKey(targetFingerprint, restoreOperationId)
  const row = db.prepare('SELECT value,updated_at FROM app_settings WHERE key=?').get(key) as { value: string; updated_at: string } | undefined
  if (!row) return null
  const value = validateExchangeRejoin(parseExchangeStored(row.value))
  if (row.value !== publicationJson(value) || row.updated_at !== value.confirmedAt || key !== exchangeRejoinKey(value.targetFingerprint, value.restoreOperationId)) return invalid()
  return { value, hash: publicationHash(row.value) }
}

export function readExchangeRejoinSql(db: Database.Database, targetFingerprint: string, restoreOperationId: string) {
  const row = readStoredExchangeRejoin(db, targetFingerprint, restoreOperationId)
  return row && { ...row, ...readExchangeRejoinSupport(db, row.value) }
}

export function assertExchangeRejoinPins(root: string, records: Iterable<{ value: ExchangeRejoin; hash: string }>) {
  for (const { value, hash } of records) {
    if (readSmallPin(exchangeRejoinFile(root, value.restoreOperationId, hash)) !== publicationJson(exchangeRejoinPin(value))) return invalid()
  }
}

export function readActiveExchangeRejoin(db: Database.Database, database: string, targetFingerprint: string) {
  if (!db.inTransaction) return invalid()
  return readRuntimeExchangeRejoin(db, targetFingerprint, readLiveInstalledRestoreRuntime(db, database))
}

/** The controlled restore owner opens its original as an isolated readonly
 * SQLite copy. Reuse the exact verified installed fence and bridge proof. */
export function readSealedExchangeRejoin(db: Database.Database, database: string, targetFingerprint: string) {
  if (!db.open || !db.readonly || !db.inTransaction) return invalid()
  attachInstalledRestoreRuntime(db, database)
  return readRuntimeExchangeRejoin(db, targetFingerprint, readInstalledRestoreRuntime(db))
}

function readRuntimeExchangeRejoin(db: Database.Database, targetFingerprint: string,
  installed: ReturnType<typeof readInstalledRestoreRuntime>) {
  if (!installed?.operationId) return null
  const selected = readExchangeRejoinSql(db, targetFingerprint, installed.operationId)
  if (!selected) return null
  const { value, old } = selected, root = dirname(dirname(installed.path)), paths = restorePaths(root, installed.operationId)
  assertInstalledRestoreRuntimeCoverage(db, installed, selected.requirements)
  if (value.intentHash !== installed.intentHash || value.proofHash !== installed.installationProofHash
    || value.newEpoch !== installed.recoveryEpoch || old.workspaceScope !== installed.workspaceScope
    || lstatSync(paths.journal, { throwIfNoEntry: false })) return invalid()
  const fence = readSmallPin(paths.fence)
  const fenceValue = parseExchangeStored(fence)
  assertSyncedShape(fenceValue, ['kind', 'version', 'operationId', 'intentHash', 'parentFenceHash', 'phase'])
  if (fence !== publicationJson(fenceValue) || fenceValue.kind !== 'controlled-joint-restore-fence' || fenceValue.version !== 2
    || fenceValue.phase !== 'installed' || fenceValue.operationId !== installed.operationId || fenceValue.intentHash !== installed.intentHash) return invalid()
  assertExchangeRejoinPins(root, [selected, ...selected.ancestors])
  return selected
}

export function exactExchangeRejoinRow(db: Database.Database, targetFingerprint: string) {
  return db.prepare('SELECT value,updated_at FROM app_settings WHERE key=?').get(exchangeStateKey(targetFingerprint)) as
    { value: string; updated_at: string } | undefined
}
