import type Database from 'better-sqlite3'
import type { SyncedGroupSnapshot, SyncedGroupWire } from '../../shared/synced-blocks'
import { collectDocumentMarkdownLinks } from '../../shared/markdownLinkMaintenance'
import { collectStoredMarkdownAssetDestinations } from '../../shared/syncedBlockPortable'
import { serializeMarkdownHostSource } from '../../shared/markdownSource'
import { syncedCanonicalEdits } from '../../shared/syncedBlockValidation'
import { decodeSyncedGroupHistoryOriginal, readSyncedGroupHistoryOriginalOwned } from './synced-group-history-original'
import { hostEncode, hostEqual, hostHash } from './synced-host-journal'
import { projectSyncedMetadataGroupLinks2, projectSyncedMetadataStoredGroupLinksOwned2, type SyncedMetadataDocumentDestination2 } from './synced-metadata-group-links2'
import { projectTitle2GroupSide, TITLE2_MAX_HISTORY_BYTES, TITLE2_MAX_HISTORY_PROJECTIONS, TITLE2_MAX_HISTORY_ROWS,
  type Title2HistoryPredecessor, type Title2HistoryProjection } from './synced-host-title2-codec'
import { assertSyncedStoredBindings } from './synced-stored-binding-read'

type Destinations = ReadonlyMap<string, SyncedMetadataDocumentDestination2>
type Owners = ReadonlyMap<string, { documentId: string; createdAt: string }>
type Tail = { cursor: string; undoToken: string | null; redoToken: string | null }
type HistorySides = ReturnType<typeof decodeSyncedGroupHistoryOriginal>
export type Title2PriorHistory = { reference: Title2HistoryPredecessor; sides: readonly HistorySides[]; depth: number }
const invalid = (): never => { throw new Error('Metadata2 effective canonical history does not bind its original branch and destinations.') }
const originalHash = (row: ReturnType<typeof decodeSyncedGroupHistoryOriginal>['row']) => hostHash({ kind: 'metadata2-original-group-history-row', row })
const noAssets = (side: SyncedGroupWire): boolean => !collectDocumentMarkdownLinks(side.blocks).some(link => link.kind === 'image')
  && collectStoredMarkdownAssetDestinations(serializeMarkdownHostSource(syncedCanonicalEdits(side.blocks)).markdown).length === 0

function project(side: SyncedGroupWire, destinations: Destinations, owners: Owners, refuse: () => never): SyncedGroupWire {
  if (!noAssets(side)) return refuse()
  if (side.bindings.some(({ target }) => {
    if (target.kind !== 'heading') return false
    const destination = destinations.get(target.documentId)
    return destination && (destination.beforePath !== destination.afterPath || destination.headings.size > 0)
  })) return refuse()
  const projected = projectSyncedMetadataGroupLinks2(side, destinations, owners)
  if (projected.edits.some(edit => {
    const binding = side.bindings.find(item => item.blockId === edit.blockId && item.from === edit.key.from && item.to === edit.key.to)
    return !binding || binding.target.kind !== 'document' && binding.target.kind !== 'block' || binding.target.state !== 'live'
      || /^heading-[1-6]$/.test(side.blocks.find(block => block.id === edit.blockId)?.type ?? '')
  })) return refuse()
  if (!hostEqual(projectTitle2GroupSide(side, projected.edits), projected.after)) return refuse()
  return projected.after
}

function sourceSides(original: HistorySides, previous: ReadonlyMap<string, HistorySides>, refuse: () => never): HistorySides {
  const projected = previous.get(original.row.id)
  if (!projected) return original
  if (!hostEqual(projected.row, original.row)) return refuse()
  return projected
}

/** All original executable rows are retained as immutable evidence in the
 * title receipt, including a Redo suffix that may later be pruned. No history
 * row, cursor or branch position is rewritten by metadata maintenance. */
export function captureTitle2UserHistoryOwned(db: Database.Database, snapshot: SyncedGroupSnapshot, before: SyncedGroupWire,
  after: SyncedGroupWire, destinations: Destinations, owners: Owners, prior: Title2PriorHistory | undefined,
  refuse: () => never): Title2HistoryProjection | undefined {
  const rows = db.prepare('SELECT id,position FROM synced_group_history WHERE group_id=? ORDER BY position LIMIT ?')
    .all(snapshot.groupId, TITLE2_MAX_HISTORY_ROWS + 1) as Array<{ id: string; position: number }>
  if (!rows.length) return
  if (rows.length > TITLE2_MAX_HISTORY_ROWS) return refuse()
  const previous = new Map(prior?.sides.map(entry => [entry.row.id, entry]))
  const activePrior = prior && rows.some(row => previous.has(row.id)) ? prior : undefined
  if (activePrior && activePrior.depth >= TITLE2_MAX_HISTORY_PROJECTIONS) return refuse()
  const position = (db.prepare('SELECT history_position FROM synced_groups WHERE id=?').get(snapshot.groupId) as { history_position: number }).history_position
  let bytes = 0
  const original = rows.map(({ id, position: rowPosition }) => {
    const entry = readSyncedGroupHistoryOriginalOwned(db, snapshot, id, rowPosition) ?? invalid()
    bytes += Buffer.byteLength(hostEncode(entry.row)) + 288
    if (bytes > TITLE2_MAX_HISTORY_BYTES) return refuse()
    const source = sourceSides(entry, previous, refuse)
    assertSyncedStoredBindings(db, source.before.origin, source.before.blocks, source.before.bindings)
    assertSyncedStoredBindings(db, source.after.origin, source.after.blocks, source.after.bindings)
    const left = project(source.before, destinations, owners, refuse), right = project(source.after, destinations, owners, refuse)
    if (!hostEqual(left, projectSyncedMetadataStoredGroupLinksOwned2(db, source.before, destinations).after)
      || !hostEqual(right, projectSyncedMetadataStoredGroupLinksOwned2(db, source.after, destinations).after)) return refuse()
    return { original: entry.row, originalHash: originalHash(entry.row),
      beforeHash: hostHash(left), afterHash: hostHash(right) }
  })
  const captured = { position, rows: original, ...(activePrior ? { previous: activePrior.reference } : {}) }
  replayTitle2UserHistory(captured, before, after, snapshot.history, destinations, owners, activePrior, refuse)
  return captured
}

export function replayTitle2UserHistory(record: Title2HistoryProjection, before: SyncedGroupWire, after: SyncedGroupWire,
  tail: Tail, destinations: Destinations, owners: Owners, prior?: Title2PriorHistory, refuse: () => never = invalid) {
  const { position, rows } = record
  if (tail.undoToken !== (rows[position - 1]?.original.id ?? null) || tail.redoToken !== (rows[position]?.original.id ?? null)) return refuse()
  const previous = new Map(prior?.sides.map(entry => [entry.row.id, entry]))
  if (!hostEqual(record.previous ?? null, prior?.reference ?? null)
    || prior && (prior.depth >= TITLE2_MAX_HISTORY_PROJECTIONS || !rows.some(entry => previous.has(entry.original.id)))) return refuse()
  const identity = { ...before, groupId: before.id }
  const inputHashes: Array<{ before: string; after: string }> = []
  const projected = rows.map((entry, index) => {
    const original = decodeSyncedGroupHistoryOriginal(identity, entry.original)
    if (entry.originalHash !== originalHash(original.row) || original.row.position !== index + 1) return refuse()
    const source = sourceSides(original, previous, refuse)
    const hashes = { before: hostHash(source.before), after: hostHash(source.after) }
    if (index > 0 && inputHashes[index - 1].after !== hashes.before) return refuse()
    inputHashes.push(hashes)
    const left = project(source.before, destinations, owners, refuse), right = project(source.after, destinations, owners, refuse)
    if (hostHash(left) !== entry.beforeHash || hostHash(right) !== entry.afterHash || hostEqual(left, right)
      || index > 0 && rows[index - 1].afterHash !== entry.beforeHash) return refuse()
    return { row: original.row, before: left, after: right }
  })
  const sourceHash = position ? inputHashes[position - 1].after : inputHashes[0].before
  const projectedHash = position ? rows[position - 1].afterHash : rows[0].beforeHash
  if (sourceHash !== hostHash(before) || projectedHash !== hostHash(after)) return refuse()
  return projected
}
