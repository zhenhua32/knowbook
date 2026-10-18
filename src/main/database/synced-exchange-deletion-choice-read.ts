import type Database from 'better-sqlite3'
import { assertSyncedShape, isSyncedUuid, isSyncedBlockId } from '../../shared/syncedBlockValidation'
import { assertConflictData } from '../sync/synced-exchange-conflict-model'
import { parseExchangeStored, type ExchangeRequest } from '../sync/synced-exchange-model'
import { publicationInvalid, publicationJson } from '../sync/synced-publication-model'

export interface DeletionChoicePreviewIndex {
  kind:'synced-exchange-deletion-preview-index';version:1;previewId:string;databasePath:string;targetFingerprint:string
  workspaceScope:string;recoveryEpoch:string;previewHash:string;decisionSourceHash:string;createdAt:string
}
const hash=(value:unknown):string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)?value:publicationInvalid('删除选择index hash无效。')
const uuid=(value:unknown):string=>isSyncedUuid(value)?value:publicationInvalid('删除选择index UUID无效。')
export function deletionChoicePreviewKey(id:string):string{return 'sync.webdav.protocol5.exchange-deletion-preview.v1.'+uuid(id)}
export function validateDeletionChoicePreviewIndex(value:unknown):DeletionChoicePreviewIndex {
  assertConflictData(value);assertSyncedShape(value,['kind','version','previewId','databasePath','targetFingerprint','workspaceScope','recoveryEpoch','previewHash','decisionSourceHash','createdAt'])
  if(value.kind!=='synced-exchange-deletion-preview-index'||value.version!==1||!isSyncedBlockId(value.databasePath)||typeof value.createdAt!=='string'||!Number.isFinite(Date.parse(value.createdAt)))return publicationInvalid('删除选择index版本/path/time无效。')
  return {kind:'synced-exchange-deletion-preview-index',version:1,previewId:uuid(value.previewId),databasePath:value.databasePath,targetFingerprint:hash(value.targetFingerprint),workspaceScope:uuid(value.workspaceScope),recoveryEpoch:uuid(value.recoveryEpoch),previewHash:hash(value.previewHash),decisionSourceHash:hash(value.decisionSourceHash),createdAt:value.createdAt}
}
export function readDeletionChoicePreviewIndex(db:Database.Database,id:string,request:ExchangeRequest):DeletionChoicePreviewIndex|null {
  if(!db.open||!db.inTransaction||db.pragma('foreign_keys',{simple:true})!==1)return publicationInvalid('删除选择index只允许owned/FK读取。')
  const row=db.prepare('SELECT value,updated_at FROM app_settings WHERE key=?').get(deletionChoicePreviewKey(id))as{value:string;updated_at:string}|undefined
  if(!row)return null
  const value=validateDeletionChoicePreviewIndex(parseExchangeStored(row.value))
  if(value.previewId!==id||value.databasePath!==request.databasePath||value.targetFingerprint!==request.targetFingerprint||row.value!==publicationJson(value)||row.updated_at!==value.createdAt)return publicationInvalid('删除选择index准确原件损坏。')
  return value
}
