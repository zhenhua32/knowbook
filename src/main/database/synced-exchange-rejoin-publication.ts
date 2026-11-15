import type Database from 'better-sqlite3'
import type { ExchangeSeedProof } from '../sync/synced-exchange-model'
import { publicationHash, publicationInvalid, publicationJson } from '../sync/synced-publication-model'
import { isSyncedUuid } from '../../shared/syncedBlockValidation'

const fail = (): never => publicationInvalid('恢复续接缺准确原发布确认与成员。')
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
type Exposure = { id: string; channel: string; state: string; request_hash: string; publication_hash: string;
  target_fingerprint: string; created_at: string; confirmed_at: string | null }
type Member = { attempt_id: string; group_id: string; creation_id: string; revision: string; topology_revision: string; semantic_hash: string }

export function readRejoinPublicationSeed(db: Database.Database, source: ExchangeSeedProof, targetFingerprint: string) {
  if (!db.open || !db.inTransaction || source.kind !== 'confirmed-publication' || !isSyncedUuid(source.operationId)) return fail()
  const exposure = db.prepare('SELECT * FROM synced_exposure_attempts WHERE id=?').get(source.operationId) as Exposure | undefined
  const members = db.prepare('SELECT * FROM synced_group_exposure_members WHERE attempt_id=? ORDER BY group_id').all(source.operationId) as Member[]
  if (!exposure || exposure.channel !== 'webdav-manifest5' || exposure.state !== 'confirmed' || !digest(exposure.request_hash)
    || !digest(exposure.publication_hash) || exposure.target_fingerprint !== targetFingerprint
    || !exposure.confirmed_at || !Number.isFinite(Date.parse(exposure.created_at)) || !Number.isFinite(Date.parse(exposure.confirmed_at))
    || Date.parse(exposure.confirmed_at) < Date.parse(exposure.created_at) || !members.length
    || members.some(row => row.attempt_id !== exposure.id || !isSyncedUuid(row.group_id) || !isSyncedUuid(row.creation_id)
      || !isSyncedUuid(row.revision) || !isSyncedUuid(row.topology_revision) || !digest(row.semantic_hash))) return fail()
  return { exposure, members, hash: publicationHash(publicationJson({ exposure, members })) }
}
