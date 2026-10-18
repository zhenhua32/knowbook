import type Database from 'better-sqlite3'
import { assertSyncedShape, isSyncedBlockId, isSyncedUuid } from '../../shared/syncedBlockValidation'
import { assertConflictData, conflictPreviewKey } from '../sync/synced-exchange-conflict-model'
import { bothPreviewKey } from '../sync/synced-exchange-both-model'
import { parseExchangeStored } from '../sync/synced-exchange-model'
import { publicationInvalid, publicationJson } from '../sync/synced-publication-model'

export type KnowledgePreviewMode = 'conflicts' | 'both'
export interface KnowledgePreviewIndex {
  kind: 'synced-exchange-conflict-preview-index' | 'synced-exchange-both-preview-index'
  version: 2; previewId: string; databasePath: string; targetFingerprint: string
  workspaceScope: string; recoveryEpoch: string; previewHash: string; createdAt: string
  plannerVersion: 'knowledge-conflicts-v1' | 'knowledge-forks-v1'; knowledgeHash: string
  allocationHash?: string
}
const digest = (value: unknown): string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : publicationInvalid('knowledge preview hash无效。')
const uuid = (value: unknown): string => isSyncedUuid(value) ? value : publicationInvalid('knowledge preview UUID无效。')
export function knowledgePreviewKey(mode: KnowledgePreviewMode, id: string): string {
  return (mode === 'both' ? 'sync.webdav.protocol5.exchange-both-preview.v2.' : 'sync.webdav.protocol5.exchange-preview.v2.') + uuid(id)
}
export function validateKnowledgePreviewIndex(value: unknown, mode: KnowledgePreviewMode): KnowledgePreviewIndex {
  assertConflictData(value)
  assertSyncedShape(value,['kind','version','previewId','databasePath','targetFingerprint','workspaceScope','recoveryEpoch','previewHash','createdAt','plannerVersion','knowledgeHash',...(mode==='both'?['allocationHash']:[])])
  const kind=mode==='both'?'synced-exchange-both-preview-index':'synced-exchange-conflict-preview-index'
  const plannerVersion=mode==='both'?'knowledge-forks-v1':'knowledge-conflicts-v1'
  if (value.kind !== kind || value.version!==2
    || value.plannerVersion!==plannerVersion || !isSyncedBlockId(value.databasePath)
    || typeof value.createdAt!=='string' || !Number.isFinite(Date.parse(value.createdAt))) return publicationInvalid('knowledge preview闭集/模式/path/时间无效。')
  return {kind,version:2,previewId:uuid(value.previewId),databasePath:value.databasePath,targetFingerprint:digest(value.targetFingerprint),
    workspaceScope:uuid(value.workspaceScope),recoveryEpoch:uuid(value.recoveryEpoch),previewHash:digest(value.previewHash),createdAt:value.createdAt,
    plannerVersion,knowledgeHash:digest(value.knowledgeHash),...(mode==='both'?{allocationHash:digest(value.allocationHash)}:{})}
}
/** Denial-only exact index read. No local row or caller DTO grants source authority. */
export function readKnowledgePreviewIndex(db: Database.Database, mode: KnowledgePreviewMode, previewId: string,
  context: {databasePath:string;targetFingerprint:string}): KnowledgePreviewIndex | null {
  if (!db.open || !db.inTransaction || db.pragma('foreign_keys',{simple:true})!==1) return publicationInvalid('knowledge index需要owned/FK只读快照。')
  const row=db.prepare('SELECT value,updated_at FROM app_settings WHERE key=?').get(knowledgePreviewKey(mode,previewId)) as {value:string;updated_at:string}|undefined
  if (!row) return null
  const oldKey=mode==='both'?bothPreviewKey(previewId):conflictPreviewKey(previewId)
  if (db.prepare('SELECT 1 FROM app_settings WHERE key=?').get(oldKey)) return publicationInvalid('同previewId存在旧/新两份来源。')
  const value=validateKnowledgePreviewIndex(parseExchangeStored(row.value),mode)
  if (row.value!==publicationJson(value) || row.updated_at!==value.createdAt || value.previewId!==previewId || value.databasePath!==context.databasePath
    || value.targetFingerprint!==context.targetFingerprint) return publicationInvalid('knowledge preview原index/路径/target/时间损坏。')
  return value
}
