import type Database from 'better-sqlite3'
import { assertSyncedShape, isSyncedBlockId, isSyncedUuid, syncedPlainRecord, validateSyncedGroupWire } from '../../shared/syncedBlockValidation'
import { decodeHostJournal, hostJournalKind, validateHostContent, validateHostSides } from './synced-host-journal'
import type { SyncedHostHistoryBranchRow } from './synced-host-history-branch'
import { parseInitialIncomingStored } from '../sync/synced-initial-incoming-model'
import { publicationHash, publicationInvalid, publicationJson } from '../sync/synced-publication-model'
import { capsuleBytesHash, capsuleJson, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { readRawCapsule2ContentOwned } from './restore-knowledge-capsule2-content-raw-read'
import { readRawCapsule2PhysicalGraphOwned } from './restore-knowledge-capsule2-physical-raw-read'
import { readRawCapsule2HistoricalEvidenceOwned } from './restore-knowledge-capsule2-history-read'
import { CAPSULE2_READER, CAPSULE2_RAW_MAX_JSON_BYTES } from './restore-knowledge-capsule2-raw-model'

interface InitialIncomingIdentity { id: string; last_owner_kind: 'document' | 'group' | 'reserved'; last_owner_id: string; state: 'live' | 'retained'; created_at: string | null }
export interface RawCapsule2WorkspaceHistoryObservation {
  readonly kind: 'capsule2-workspace-identity-history-observation'; readonly version: 1; readonly forReader: typeof CAPSULE2_READER
  readonly state: 'bounded-legacy-workspace-history-composite-only'; readonly certified: false; readonly semanticValidationComplete: false
  readonly accepted: false; readonly acceptedCoverage: false; readonly effective: false; readonly permit: false
  readonly schemaVersion: 26 | 27; readonly workspaceScope: string; readonly recoveryEpoch: string
  readonly sourceContentHash: string; readonly physicalObservationHash: string; readonly totalHistoricalObservationHash: string
  readonly rawIdentities: readonly InitialIncomingIdentity[]; readonly historyDocuments: readonly string[]; readonly historyBlocks: readonly string[]
  readonly groupIds: readonly string[]; readonly unregisteredTemplateBlocks: readonly string[]; readonly historyRows: readonly unknown[]
  readonly unresolved: readonly string[]; readonly observationHash: string
}
const id = (value: unknown): string => isSyncedBlockId(value) ? value : publicationInvalid('incoming 本机历史/身份中的稳定 ID 无效。')
function json(source: string): unknown { return parseInitialIncomingStored(source) }

/** Actual readonly owned SQL only. The bounded content preflight and complete
 * physical reader run before any historical kernel materialization. No caller
 * roots, IDs, attestation, mode, cache, skip or admission are accepted.
 *
 * This composes the exact former finite rawInitial history kernel with actual
 * total2 for reserved-family closure. Its content() is deliberately the old
 * partial identity checker, never a new complete ordinary-history codec. */
export function readRawCapsule2WorkspaceHistoryOwned(db: Database.Database): RawCapsule2WorkspaceHistoryObservation {
  const sourceContent = readRawCapsule2ContentOwned(db)
  const physical = readRawCapsule2PhysicalGraphOwned(db)
  const sourceContentHash = capsuleBytesHash('knowbook.capsule2.workspace-history-source-content.v1\0' + capsuleJson(sourceContent))
  const physicalObservationHash = capsuleBytesHash('knowbook.capsule2.workspace-history-physical-observation.v1\0' + capsuleJson(physical))
  const rawIdentities = db.prepare('SELECT id,last_owner_kind,last_owner_id,state,created_at FROM block_identities ORDER BY id').all() as InitialIncomingIdentity[]
  const identities = new Map<string, InitialIncomingIdentity>()
  for (const row of rawIdentities) {
    id(row.id); id(row.last_owner_id)
    if (!['document', 'group', 'reserved'].includes(row.last_owner_kind) || row.state !== 'live' && row.state !== 'retained'
      || row.created_at !== null && (typeof row.created_at !== 'string' || !Number.isFinite(Date.parse(row.created_at)))
      || row.last_owner_kind === 'reserved' && row.state !== 'retained'
      || row.state === 'live' && row.created_at === null) return publicationInvalid('incoming 本机 ledger 组合损坏。')
    identities.set(row.id, row)
  }
  const historyDocuments = new Set<string>(), historyBlocks = new Set<string>(), historyRows: unknown[] = []
  const unregisteredTemplateBlocks = new Set<string>()
  for (const proof of physical.deletions) if (proof.before.kind === 'document') historyDocuments.add(proof.before.id)
  for (const row of rawIdentities) if (row.last_owner_kind === 'document') historyDocuments.add(row.last_owner_id)
  const document = (value: unknown): string => { const key = id(value); historyDocuments.add(key); return key }
  const block = (value: unknown): void => {
    const key = id(value)
    if (!identities.has(key)) return publicationInvalid('本机历史块缺少原保留 ledger；不会重新回填或抢占。')
    historyBlocks.add(key)
  }
  const content = (value: unknown): void => {
    if (!syncedPlainRecord(value) || !Array.isArray(value.blocks)) return publicationInvalid('incoming 本机历史正文损坏。')
    for (const item of value.blocks) { if (!syncedPlainRecord(item)) return publicationInvalid('incoming 历史块不是对象。'); if (item.id !== undefined) block(item.id) }
  }
  const histories = db.prepare('SELECT * FROM document_history ORDER BY id').all() as Array<{ id: string; document_id: string; content_json: string }>
  historyRows.push(histories)
  for (const row of histories) { document(row.document_id); content(json(row.content_json)) }
  const trash = db.prepare('SELECT * FROM document_trash ORDER BY id').all() as Array<{ id: string; snapshot_json: string }>
  historyRows.push(trash)
  for (const row of trash) {
    document(row.id); const value = json(row.snapshot_json)
    if (!syncedPlainRecord(value) || !syncedPlainRecord(value.document) || value.document.id !== row.id) return publicationInvalid('incoming 回收站文档归属损坏。')
    content(value.content)
  }
  const moves = db.prepare('SELECT * FROM document_block_moves ORDER BY id').all() as Array<{ id: string; source_document_id: string; target_document_id: string; state: string; moved_ids_json: string; before_json: string; after_json: string; expected_versions_json: string; created_at: string; updated_at: string }>
  historyRows.push(moves)
  for (const row of moves) {
    document(row.source_document_id); document(row.target_document_id)
    if (row.state !== 'applied' && row.state !== 'undone' || row.source_document_id === row.target_document_id || !isSyncedUuid(row.id)
      || !Number.isFinite(Date.parse(row.created_at)) || !Number.isFinite(Date.parse(row.updated_at))) return publicationInvalid('incoming 原移动状态/身份/时间损坏。')
    const ids = json(row.moved_ids_json)
    if (!Array.isArray(ids) || !ids.length || new Set(ids.map(id)).size !== ids.length) return publicationInvalid('incoming 原移动 ID 闭集损坏。')
    ids.forEach(block)
    const sides: Array<{ documents: Set<string>; owners: Map<string, string> }> = []
    for (const source of [row.before_json, row.after_json]) {
      const side = json(source)
      if (!Array.isArray(side) || !side.length) return publicationInvalid('incoming 原移动 side 不是非空数组。')
      const seen = new Set<string>(), owners = new Map<string, string>()
      for (const item of side) {
        assertSyncedShape(item, ['documentId', 'path', 'updatedAt', 'content'])
        const key = document(item.documentId)
        if (seen.has(key)) return publicationInvalid('incoming 原移动文档重复。'); seen.add(key)
        const checked = validateHostContent(item.content)
        if (typeof item.path !== 'string' || !item.path || item.path.split('/').some(part => !part || part !== part.trim() || part === '.' || part === '..' || /[\\\x00-\x1f]/.test(part))
          || item.path.split('/').at(-1) !== checked.title || checked.title !== checked.title.trim() || !checked.title
          || typeof item.updatedAt !== 'string' || !Number.isFinite(Date.parse(item.updatedAt))) return publicationInvalid('incoming 原移动 snapshot path/title/updatedAt 损坏。')
        for (const child of checked.blocks) {
          block(child.id)
          if (owners.has(child.id)) return publicationInvalid('incoming 原移动同侧物理 ID 重复。')
          owners.set(child.id, key)
        }
      }
      if (!seen.has(row.source_document_id) || !seen.has(row.target_document_id)) return publicationInvalid('incoming 原移动 side 缺参与文档。')
      sides.push({ documents: seen, owners })
    }
    const before = sides[0], after = sides[1], expected = json(row.expected_versions_json)
    if (before.documents.size !== after.documents.size || [...before.documents].some(key => !after.documents.has(key))
      || !syncedPlainRecord(expected) || Object.keys(expected).length !== before.documents.size
      || Object.entries(expected).some(([key, value]) => !before.documents.has(key) || typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
      || ids.some(key => before.owners.get(key) !== row.source_document_id || after.owners.get(key) !== row.target_document_id)) return publicationInvalid('incoming 原移动 expectedVersions/两侧完整参与者或移动归属损坏。')
    // A legitimate undo/redo advances this map without changing frozen side timestamps. Never compare either to today's DB.
  }
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='document_templates'").get()) {
    const templates = db.prepare('SELECT id,blocks_json FROM document_templates ORDER BY id').all() as Array<{ id: string; blocks_json: string }>
    historyRows.push(templates)
    for (const row of templates) {
      const blocks = json(row.blocks_json)
      if (!Array.isArray(blocks)) return publicationInvalid('incoming 本机历史正文损坏。')
      for (const item of blocks) {
        if (!syncedPlainRecord(item)) return publicationInvalid('incoming 历史块不是对象。')
        if (item.id === undefined) continue
        const key = id(item.id)
        if (identities.has(key)) block(key)
        else { historyBlocks.add(key); unregisteredTemplateBlocks.add(key) }
      }
    }
  }
  const restore = db.prepare('SELECT * FROM backup_restore_identities ORDER BY lineage,kind,source_database_id,source_id,state').all() as Array<{ kind: string; target_id: string }>
  historyRows.push(restore)
  for (const row of restore) { if (row.kind === 'block') block(row.target_id); else if (row.kind === 'document') document(row.target_id) }
  const routes = db.prepare('SELECT document_path,block_id FROM document_block_routes ORDER BY document_path,block_id').all() as Array<{ block_id: string }>
  historyRows.push(routes); for (const row of routes) block(row.block_id)
  const hostRows = db.prepare('SELECT id,action_json,before_json,after_json,before_hash,after_hash,created_at FROM synced_host_history ORDER BY id').all() as SyncedHostHistoryBranchRow[]
  historyRows.push(hostRows)
  const participants = new Map<string, Set<string>>()
  for (const row of hostRows) {
    const kind = hostJournalKind(row)
    const sides = kind === 'bare-create' ? [...validateHostSides(json(row.before_json)), ...validateHostSides(json(row.after_json))]
      : (() => { const journal = decodeHostJournal(row); return [...journal.before, ...journal.after] })()
    const owners = new Set<string>(); participants.set(row.id, owners)
    for (const side of sides) { owners.add(document(side.documentId)); side.content.blocks.forEach(item => block(item.id)) }
    if (kind === 'bare-create') {
      const action = json(row.action_json)
      if (!syncedPlainRecord(action) || !Array.isArray(action.selectedRootIds)) return publicationInvalid('incoming 原 bare create 损坏。')
      owners.add(document(action.documentId)); action.selectedRootIds.forEach(block)
      if (!isSyncedUuid(row.id) || !Number.isFinite(Date.parse(row.created_at))) return publicationInvalid('incoming 原 bare create 日志身份/时间损坏。')
      if (publicationHash(publicationJson(json(row.before_json))) !== row.before_hash || publicationHash(publicationJson(json(row.after_json))) !== row.after_hash) return publicationInvalid('incoming 原 bare create side/hash 损坏。')
    }
  }
  const mappings = db.prepare('SELECT * FROM synced_host_history_documents ORDER BY document_id,position').all() as Array<{ history_id: string; document_id: string; position: number }>
  const states = db.prepare('SELECT * FROM synced_host_history_state ORDER BY document_id').all() as Array<{ document_id: string; cursor: string; position: number }>
  historyRows.push(mappings, states)
  const chains = new Map<string, { position: number; count: number }>(states.map(row => { document(row.document_id); if (!isSyncedUuid(row.cursor) || !Number.isSafeInteger(row.position) || row.position < 0) return publicationInvalid('incoming 原宿主 history state 损坏。'); return [row.document_id, { position: row.position, count: 0 }] as const }))
  const historyMapped = new Map<string, Set<string>>()
  for (const row of mappings) {
    document(row.document_id); const state = chains.get(row.document_id)
    if (!state || row.position !== ++state.count || !participants.get(row.history_id)?.has(row.document_id)) return publicationInvalid('incoming 原宿主历史链或参与映射损坏。')
    const members = historyMapped.get(row.history_id) ?? new Set<string>(); members.add(row.document_id); historyMapped.set(row.history_id, members)
  }
  for (const state of chains.values()) if (state.position > state.count) return publicationInvalid('incoming 原宿主历史位置越界。')
  // Detached/pruned immutable journals may legitimately have no mapping. A remaining mapping is always complete.
  for (const [key, mapped] of historyMapped) if (mapped.size !== participants.get(key)?.size) return publicationInvalid('incoming 原共享日志残留部分映射。')
  const groupHistory = db.prepare('SELECT * FROM synced_group_history ORDER BY group_id,position').all() as Array<{ group_id: string; before_json: string; after_json: string; before_hash: string; after_hash: string }>
  historyRows.push(groupHistory)
  for (const row of groupHistory) for (const [source, hash] of [[row.before_json, row.before_hash], [row.after_json, row.after_hash]]) {
    const wire = validateSyncedGroupWire(json(source))
    if (wire.id !== row.group_id || publicationHash(publicationJson(wire)) !== hash) return publicationInvalid('incoming 原 canonical history side/hash 损坏。')
    wire.blocks.forEach(item => block(item.id))
  }
  const pins = db.prepare('SELECT * FROM synced_group_pins ORDER BY group_id,kind,pin_id').all()
  historyRows.push(pins)
  const lifecycleTables = db.pragma('user_version', { simple: true }) === 27
    ? ['synced_group_lifecycle', 'synced_group_retirements', 'synced_exposure_attempts', 'synced_group_exposure_members'] : []
  for (const table of lifecycleTables) {
    const rows = db.prepare('SELECT * FROM ' + table).all()
    historyRows.push(rows.sort((a, b) => publicationJson(a) < publicationJson(b) ? -1 : publicationJson(a) > publicationJson(b) ? 1 : 0))
  }
  const groupIds = new Set((db.prepare('SELECT id FROM synced_groups ORDER BY id').all() as Array<{ id: string }>).map(row => row.id))
  // The kernel above preserves all rows, but does not classify reserved
  // operations/settings or prove pins/lifecycle business semantics. Those
  // checks come from this fixed actual total2 -> observer2 composition.
  // It repeats content/coverage/physical scans; peak memory/cost are unmeasured.
  const total = readRawCapsule2HistoricalEvidenceOwned(db)
  const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0
  const body = { kind: 'capsule2-workspace-identity-history-observation' as const, version: 1 as const, forReader: CAPSULE2_READER,
    state: 'bounded-legacy-workspace-history-composite-only' as const, certified: false as const, semanticValidationComplete: false as const,
    accepted: false as const, acceptedCoverage: false as const, effective: false as const, permit: false as const,
    schemaVersion: physical.schemaVersion, workspaceScope: physical.workspaceScope, recoveryEpoch: physical.recoveryEpoch,
    sourceContentHash, physicalObservationHash, totalHistoricalObservationHash: total.observationHash,
    rawIdentities, historyDocuments: [...historyDocuments].sort(compare), historyBlocks: [...historyBlocks].sort(compare),
    groupIds: [...groupIds].sort(compare), unregisteredTemplateBlocks: [...unregisteredTemplateBlocks].sort(compare), historyRows,
    unresolved: ['ordinary-document-tree-and-legacy-compatibility', 'complete-ordinary-history-codecs', 'ordinary-catalog-and-derived-semantics',
      'source-policy-and-assets', 'required-root-resolution', 'streaming-source-adapter', 'complete-private-capsule2-certifier-and-installer'] }
  const result = { ...body, observationHash: capsuleBytesHash('knowbook.capsule2.workspace-identity-history-observation.v1\0' + capsuleJson(body)) }
  if (Buffer.byteLength(capsuleJson(result)) > CAPSULE2_RAW_MAX_JSON_BYTES) return publicationInvalid('workspace history2完整JSON超准备预算，不截断。')
  return freezeCapsuleValue(result)
}
