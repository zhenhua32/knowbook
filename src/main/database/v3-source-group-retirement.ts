import type Database from 'better-sqlite3'
import type { SyncedGroupWire } from '../../shared/synced-blocks'
import { parseStrictJson } from '../../shared/strictJson'
import { assertSyncedShape, isSyncedUuid, validateSyncedGroupWire } from '../../shared/syncedBlockValidation'
import { capsuleBytesHash, capsuleJson } from './restore-knowledge-capsule-model'
import { readRawPriorKnowledgeCoverageOwned } from './restore-knowledge-coverage-raw-read'

export const V3_SOURCE_GROUP_RETIREMENT_PREFIX = 'restore.v3.source-group-retirement.v1.'
const FAMILY = 'restore.v3.source-group-retirement.'
const MAX_BYTES = 8 * 1024 * 1024
const digest = /^[a-f0-9]{64}$/

export interface V3SourceGroupRetirement {
  kind: 'v3-source-group-retirement'
  version: 1
  operationId: string
  group: SyncedGroupWire
  sourceGroupId: string
  sourceCreationId: string
  sourceSnapshotId: string
  successorSnapshotId: string
  publicationHeadHash: string
  remoteEvidenceHash: string
}

function invalid(message: string): never { throw new Error('V3 来源共享组退场证明无效：' + message) }
function owned(db: Database.Database) {
  if (!db.open || !db.inTransaction) return invalid('需要真实 SQLite 事务。')
}
export function v3SourceGroupRetirementKey(id: string) {
  if (!isSyncedUuid(id)) return invalid('组 ID 无效。')
  return V3_SOURCE_GROUP_RETIREMENT_PREFIX + id
}

export function validateV3SourceGroupRetirement(value: unknown): V3SourceGroupRetirement {
  assertSyncedShape(value, ['kind', 'version', 'operationId', 'group', 'sourceGroupId', 'sourceCreationId', 'sourceSnapshotId', 'successorSnapshotId',
    'publicationHeadHash', 'remoteEvidenceHash'])
  const { kind, version, operationId, sourceGroupId, sourceCreationId, sourceSnapshotId, successorSnapshotId, publicationHeadHash, remoteEvidenceHash } = value
  if (kind !== 'v3-source-group-retirement' || version !== 1 || !isSyncedUuid(operationId)
    || !isSyncedUuid(sourceGroupId) || !isSyncedUuid(sourceCreationId)
    || !isSyncedUuid(sourceSnapshotId) || !isSyncedUuid(successorSnapshotId) || sourceSnapshotId === successorSnapshotId
    || typeof publicationHeadHash !== 'string' || !digest.test(publicationHeadHash)
    || typeof remoteEvidenceHash !== 'string' || !digest.test(remoteEvidenceHash)) return invalid('原来源、后继或远端证据不完整。')
  const group = validateSyncedGroupWire(value.group)
  return { kind, version, operationId, group, sourceGroupId, sourceCreationId, sourceSnapshotId, successorSnapshotId, publicationHeadHash, remoteEvidenceHash }
}

export function v3SourceGroupRetirementHash(value: V3SourceGroupRetirement) {
  return capsuleBytesHash(capsuleJson(validateV3SourceGroupRetirement(value)))
}

export function assertV3SourceGroupRetirementPhysicalOwned(db: Database.Database, record: V3SourceGroupRetirement) {
  owned(db)
  const group = record.group
  const header = db.prepare(`SELECT g.id,g.creation_id,g.created_at,g.origin_json,g.bindings_json,g.history_position,l.state
    FROM main.synced_groups g JOIN main.synced_group_lifecycle l ON l.group_id=g.id AND l.creation_id=g.creation_id WHERE g.id=?`)
    .get(group.id) as { id: string; creation_id: string; created_at: string; origin_json: string; bindings_json: string;
      history_position: number; state: string } | undefined
  if (!header || header.creation_id !== group.creationId || header.created_at !== group.createdAt || header.state !== 'active'
    || header.history_position !== 0 || capsuleJson(parseStrictJson(header.origin_json, { maxBytes: MAX_BYTES, maxDepth: 32 })) !== capsuleJson(group.origin)
    || capsuleJson(parseStrictJson(header.bindings_json, { maxBytes: MAX_BYTES, maxDepth: 32 })) !== capsuleJson(group.bindings))
    return invalid('原物理组头或执行边界变化。')
  if (db.prepare(`SELECT 1 WHERE EXISTS(SELECT 1 FROM main.synced_group_blocks WHERE group_id=@id)
    OR EXISTS(SELECT 1 FROM main.synced_instances WHERE group_id=@id)
    OR EXISTS(SELECT 1 FROM main.synced_group_history WHERE group_id=@id)
    OR EXISTS(SELECT 1 FROM main.block_identities WHERE last_owner_kind='group' AND last_owner_id=@id AND state='live')
    OR EXISTS(SELECT 1 FROM main.blocks WHERE type='synced-block' AND CASE WHEN json_valid(content) THEN json_extract(content,'$.groupId') END=@id)`)
    .get({ id: group.id })) return invalid('退场组仍有正文、实例、活体身份或可执行历史。')
  const births = JSON.stringify(group.blocks.map(block => [block.id, block.createdAt]))
  if (db.prepare(`SELECT 1 FROM json_each(?) b LEFT JOIN main.block_identities i ON i.id=json_extract(b.value,'$[0]')
    WHERE i.state IS NOT 'retained' OR i.last_owner_kind IS NOT 'group' OR i.last_owner_id IS NOT ?
      OR i.created_at IS NOT json_extract(b.value,'$[1]')
      OR EXISTS(SELECT 1 FROM main.blocks WHERE id=i.id)
      OR EXISTS(SELECT 1 FROM main.synced_group_blocks WHERE id=i.id) LIMIT 1`).get(births, group.id)) {
    return invalid('原正文块的稳定身份、归属或出生时间变化。')
  }
}

function coverageTimes(db: Database.Database) {
  return new Map(readRawPriorKnowledgeCoverageOwned(db).entries.filter(entry => entry.cut.kind === 'synced-recovery-epoch-cut')
    .map(entry => [entry.operationId, entry.acceptedAt]))
}

/** Only a closed C/Receipt2 record and the exact absence of its original body count. */
export function readV3SourceGroupRetirementsOwned(db: Database.Database): Map<string, V3SourceGroupRetirement> {
  owned(db)
  const range = [FAMILY, FAMILY.slice(0, -1) + '/'] as const
  const result = new Map<string, V3SourceGroupRetirement>()
  if (!db.prepare('SELECT 1 FROM main.app_settings WHERE key>=? AND key<? LIMIT 1').get(...range)) return result
  if (db.pragma('main.user_version', { simple: true }) !== 27) return invalid('此 schema 没有正式 V3 裁剪覆盖。')
  const acceptance = coverageTimes(db)
  const rows = db.prepare(`SELECT key,substr(value,1,?),length(CAST(value AS BLOB)),updated_at FROM main.app_settings
    WHERE key>=? AND key<? ORDER BY key`).raw().iterate(MAX_BYTES + 1, ...range) as Iterable<[string, string, number, string]>
  for (const [key, text, bytes, updatedAt] of rows) {
    if (bytes < 1 || bytes > 2 * MAX_BYTES || Buffer.byteLength(text) > MAX_BYTES) return invalid('退场记录超出原格式预算。')
    const record = validateV3SourceGroupRetirement(parseStrictJson(text, { maxBytes: MAX_BYTES, maxDepth: 32 }))
    if (key !== v3SourceGroupRetirementKey(record.group.id) || text !== capsuleJson(record) || updatedAt !== acceptance.get(record.operationId))
      return invalid('原键、原 JSON 或正式安装覆盖不符。')
    assertV3SourceGroupRetirementPhysicalOwned(db, record)
    result.set(record.group.id, record)
  }
  return result
}

/** Called by the original installation transaction after writing the actual C/Receipt2. */
export function writeV3SourceGroupRetirementsOwned(db: Database.Database, records: readonly V3SourceGroupRetirement[]) {
  owned(db)
  if (!records.length) return
  const acceptance = coverageTimes(db)
  const insert = db.prepare('INSERT INTO main.app_settings(key,value,updated_at) VALUES(?,?,?)')
  for (const input of records) {
    const record = validateV3SourceGroupRetirement(input), acceptedAt = acceptance.get(record.operationId), text = capsuleJson(record)
    if (!acceptedAt || Buffer.byteLength(text) > MAX_BYTES) return invalid('缺少本次正式安装覆盖或超过可冷读预算。')
    assertV3SourceGroupRetirementPhysicalOwned(db, record)
    insert.run(v3SourceGroupRetirementKey(record.group.id), text, acceptedAt)
  }
}
