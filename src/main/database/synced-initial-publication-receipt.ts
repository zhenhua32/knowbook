import type Database from 'better-sqlite3'
import { assertSyncedShape, isSyncedUuid } from '../../shared/syncedBlockValidation'
import { decodePublicationJson, publicationInvalid, publicationJson } from '../sync/synced-publication-model'
import { requireStrongEtag } from '../sync/webdav-client'
import { readRejoinPublicationSeed } from './synced-exchange-rejoin-publication'

export const INITIAL_PUBLICATION_RECEIPT_KIND = 'synced-initial-publication-operation'
const fail = () => publicationInvalid('首发原回执、尝试或远端版本证据损坏。')
const uuid = (value: unknown) => isSyncedUuid(value) ? value : fail()
const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : fail()

export function validateInitialPublicationReceipt(value: unknown) {
  assertSyncedShape(value, ['kind', 'version', 'operationId', 'databasePath', 'workspaceScope', 'recoveryEpoch', 'targetFingerprint',
    'requestHash', 'publicationHash', 'manifestHash', 'manifestEtag', 'portableDigest', 'acceptedAt'])
  if (value.kind !== INITIAL_PUBLICATION_RECEIPT_KIND || value.version !== 1 || typeof value.databasePath !== 'string' || !value.databasePath
    || typeof value.acceptedAt !== 'string' || !Number.isFinite(Date.parse(value.acceptedAt)) || typeof value.manifestEtag !== 'string') return fail()
  requireStrongEtag(value.manifestEtag)
  return { kind: value.kind, version: value.version, operationId: uuid(value.operationId), databasePath: value.databasePath,
    workspaceScope: uuid(value.workspaceScope), recoveryEpoch: uuid(value.recoveryEpoch), targetFingerprint: digest(value.targetFingerprint),
    requestHash: digest(value.requestHash), publicationHash: digest(value.publicationHash), manifestHash: digest(value.manifestHash),
    manifestEtag: value.manifestEtag, portableDigest: digest(value.portableDigest), acceptedAt: value.acceptedAt }
}
export type InitialPublicationReceipt = ReturnType<typeof validateInitialPublicationReceipt>

export function initialPublicationSeed(receipt: InitialPublicationReceipt) {
  return { kind: 'confirmed-publication' as const, operationId: receipt.operationId, manifestHash: receipt.manifestHash,
    portableDigest: receipt.portableDigest }
}

export function readInitialPublicationReceipt(db: Database.Database, operationId: string) {
  if (!db.open || !db.inTransaction) return fail()
  const row = db.prepare('SELECT client_operation_id,request_hash,result_json,created_at FROM synced_operations WHERE client_operation_id=?')
    .get(operationId) as { client_operation_id: string; request_hash: string; result_json: string; created_at: string } | undefined
  if (!row) return null
  const receipt = validateInitialPublicationReceipt(decodePublicationJson(Buffer.from(row.result_json)))
  const publication = readRejoinPublicationSeed(db, { kind: 'confirmed-publication', operationId }, receipt.targetFingerprint)
  if (receipt.operationId !== row.client_operation_id || receipt.requestHash !== row.request_hash || receipt.acceptedAt !== row.created_at
    || receipt.requestHash !== publication.exposure.request_hash || receipt.publicationHash !== publication.exposure.publication_hash
    || receipt.acceptedAt !== publication.exposure.confirmed_at || publicationJson(receipt) !== row.result_json) return fail()
  return { receipt, row, publication }
}
