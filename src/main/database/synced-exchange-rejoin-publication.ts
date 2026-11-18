import type Database from 'better-sqlite3'
import type { ExchangeSeedProof } from '../sync/synced-exchange-model'
import { publicationHash, publicationInvalid, publicationJson } from '../sync/synced-publication-model'
import { isSyncedUuid } from '../../shared/syncedBlockValidation'
import { readOrdinaryPublicationAttempt, type SyncedPublicationAttemptRow } from './synced-ordinary-publication-attempt'

const fail = (): never => publicationInvalid('恢复续接缺准确原发布确认与成员。')
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
type Member = { attempt_id: string; group_id: string; creation_id: string; revision: string; topology_revision: string; semantic_hash: string }

export function readRejoinPublicationSeed(db: Database.Database, source: Pick<ExchangeSeedProof, 'kind' | 'operationId'>, targetFingerprint: string) {
  if (!db.open || !db.inTransaction || source.kind !== 'confirmed-publication' || !isSyncedUuid(source.operationId)) return fail()
  const grouped = db.prepare('SELECT * FROM synced_exposure_attempts WHERE id=?').get(source.operationId) as SyncedPublicationAttemptRow | undefined
  const ordinary = readOrdinaryPublicationAttempt(db, source.operationId), exposure = grouped ?? ordinary?.attempt
  const members = db.prepare('SELECT * FROM synced_group_exposure_members WHERE attempt_id=? ORDER BY group_id').all(source.operationId) as Member[]
  if (grouped && ordinary || !exposure || exposure.channel !== 'webdav-manifest5' || exposure.state !== 'confirmed' || !digest(exposure.request_hash)
    || !digest(exposure.publication_hash) || exposure.target_fingerprint !== targetFingerprint
    || !exposure.confirmed_at || !Number.isFinite(Date.parse(exposure.created_at)) || !Number.isFinite(Date.parse(exposure.confirmed_at))
    || Date.parse(exposure.confirmed_at) < Date.parse(exposure.created_at) || Boolean(members.length) !== Boolean(grouped)
    || members.some(row => row.attempt_id !== exposure.id || !isSyncedUuid(row.group_id) || !isSyncedUuid(row.creation_id)
      || !isSyncedUuid(row.revision) || !isSyncedUuid(row.topology_revision) || !digest(row.semantic_hash))) return fail()
  return { exposure, members, ordinarySetting: ordinary?.row,
    hash: publicationHash(publicationJson(ordinary ? { ordinary: ordinary.row } : { exposure, members })) }
}
