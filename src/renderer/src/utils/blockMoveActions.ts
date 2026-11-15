import type { DocumentBlockDraft, DocumentDetail, HomeData } from '@shared/contracts'
import type { ControlledDocumentBlockMove, DocumentBlockMoveHistoryEntry, DocumentBlockMoveResult, MoveDocumentBlocksInput, RestoreDocumentBlockMoveInput } from '@shared/document-block-moves'
import type { SyncedCrossHostMoveHistory } from '@shared/synced-editing-session'
import type { SyncedHostWorkingBefore, SyncedPlacement, SyncedStructureAction, SyncedStructureApplied } from '@shared/synced-blocks'
import { isListBlockType } from '@shared/blockTypes'
import { readSingleMovedSyncedReference, SYNCED_MAX_DEPTH } from '@shared/syncedBlockValidation'
import type { SyncedHostSourceCurrent } from '../features/synced-blocks/SyncedHostSourceDialog'
import type { CanonicalInlineFlushOptions } from '../features/synced-blocks/inlineBridge'
import type { EditorHistoryBookmark } from './editorHistoryFocus'
import { toDraftBlock } from './draftBlockShape'
import { normalizeDraftBlocks } from './draftTreeNormalization'
import { areDocumentDraftBlocksEqual } from './documentDraftComparison'

export type MoveTransition = { operationId: string; versions: Record<string, string> } &
  ({ cross?: undefined } | { cross: { token: string; groupIds: string[] } })
type MoveSnapshot = { blocks: DocumentBlockDraft[]; bookmark: EditorHistoryBookmark | null; move?: MoveTransition }
type Ref<T> = { current: T }
export type BlockMoveCompletionContext = {
  isCurrent: () => boolean
  mounted: Ref<boolean>
  busy: Ref<boolean>
  selectedId: Ref<string | null>
  selected: Ref<DocumentDetail | null>
  blocks: Ref<DocumentBlockDraft[]>
  title: Ref<string>
  summary: Ref<string>
  checkpointed: Ref<DocumentBlockDraft[] | null>
  history: Ref<MoveSnapshot[]>
  pointer: Ref<number>
  setBlocks: (blocks: DocumentBlockDraft[]) => void
  setTitle: (title: string) => void
  setSummary: (summary: string) => void
  clearFailure: (value: null) => void
  onDocument: (detail: DocumentDetail | null) => void
  onHome: (home: HomeData) => void
  onRevision: (updater: (value: number) => number) => void
}

function cloneBlocks(blocks: DocumentBlockDraft[]): DocumentBlockDraft[] {
  return blocks.map(block => ({ ...block, tags: block.tags ? [...block.tags] : undefined,
    markdownFormat: block.markdownFormat ? { ...block.markdownFormat } : undefined }))
}

function acceptResult(result: DocumentBlockMoveResult, context: BlockMoveCompletionContext): DocumentBlockDraft[] {
  const detail = result.source.id === context.selectedId.current ? result.source : result.target
  context.selected.current = detail
  const blocks = normalizeDraftBlocks(detail.blocks.map(toDraftBlock))
  context.blocks.current = blocks
  context.title.current = detail.title
  context.summary.current = detail.summary
  context.setBlocks(blocks)
  context.setTitle(detail.title)
  context.setSummary(detail.summary)
  context.clearFailure(null)
  context.onDocument(detail)
  for (const snapshot of context.history.current) if (snapshot.move) {
    for (const [id, version] of Object.entries(result.expectedUpdatedAtByDocument)) {
      if (Object.hasOwn(snapshot.move.versions, id)) snapshot.move.versions[id] = version
    }
  }
  context.checkpointed.current = blocks
  return blocks
}

async function refreshWorkspace(context: BlockMoveCompletionContext): Promise<void> {
  try {
    const home = await window.knowbook.getHomeData()
    if (context.mounted.current) context.onHome(home)
  } catch (error) { console.warn('Failed to refresh workspace after committing a block move.', error) }
}

function pushMove(blocks: DocumentBlockDraft[], bookmark: EditorHistoryBookmark | null, move: MoveTransition, context: BlockMoveCompletionContext) {
  const history = context.history.current.slice(0, context.pointer.current + 1)
  history.push({ blocks: cloneBlocks(blocks), bookmark, move })
  context.history.current = history.slice(-80)
  context.pointer.current = context.history.current.length - 1
  context.onRevision(value => value + 1)
}

/** Called only after the original source save and destination read completed. */
export async function completeDocumentBlockMove(input: MoveDocumentBlocksInput, bookmark: EditorHistoryBookmark | null,
  context: BlockMoveCompletionContext): Promise<boolean> {
  if (!context.isCurrent()) return false
  const result = await window.knowbook.moveDocumentBlocks(input)
  if (result.state === 'controlled-required') return false
  if (context.isCurrent()) {
    const blocks = acceptResult(result, context)
    pushMove(blocks, bookmark, { operationId: result.operationId, versions: { ...result.expectedUpdatedAtByDocument } }, context)
  }
  await refreshWorkspace(context)
  return context.isCurrent()
}

const hasReference = (blocks: readonly DocumentBlockDraft[]) => blocks.some(block => block.type === 'synced-block')
function initialWorking(page: DocumentDetail): SyncedHostWorkingBefore {
  return { documentId: page.id, expectedPersistedUpdatedAt: page.updatedAt,
    workingBefore: { title: page.title, summary: page.summary,
      blocks: page.blocks.map(block => ({ ...toDraftBlock(block), id: block.id, parentBlockId: block.parentBlockId ?? null })) } }
}
function matchesWorking(context: BlockMoveCompletionContext, content: SyncedHostWorkingBefore['workingBefore']) {
  return context.title.current === content.title && context.summary.current === content.summary
    && areDocumentDraftBlocksEqual(context.blocks.current, content.blocks)
}
function acceptCrossMove(result: SyncedStructureApplied, source: DocumentDetail, peers: readonly DocumentDetail[], context: BlockMoveCompletionContext) {
  const primary = result.hosts.find(host => host.documentId === source.id)
  if (!context.isCurrent() || !result.historyToken || result.hosts.length !== peers.length + 1 || !primary
    || primary.after.id !== source.id || !matchesWorking(context, primary.logicalBefore) || peers.some(peer => {
      const detail = result.hosts.find(host => host.documentId === peer.id)
      return !detail || detail.after.id !== peer.id || detail.logicalBefore.title !== peer.title || detail.logicalBefore.summary !== peer.summary
        || !areDocumentDraftBlocksEqual(detail.logicalBefore.blocks, peer.blocks)
    })) return null
  const versions = Object.fromEntries(result.hosts.map(host => [host.documentId, host.after.updatedAt]))
  const blocks = acceptResult({ operationId: result.operationId, state: 'applied', source: primary.after, target: primary.after,
    movedBlockIds: [], affectedDocumentIds: [], expectedUpdatedAtByDocument: versions }, context)
  void refreshWorkspace(context)
  return { blocks, versions, token: result.historyToken }
}

export type CrossPageMoveMode = 'stage' | 'batch'
type BatchDestination = { mode: CrossPageMoveMode; documentId: string }
type ListDestination = { mode: 'list'; documentId: string; parentBlockId: string; expectedUpdatedAt: string }
export type BlockMoveDestination = string | BatchDestination | ListDestination
type StagedMove = { source: DocumentDetail; target: DocumentDetail; selectedRootIds: string[]; workspaceScope: string; recoveryEpoch: string }
let stagedMove: StagedMove | null = null

export function readStagedCrossPageMove() {
  return stagedMove && { sourceId: stagedMove.source.id, sourceTitle: stagedMove.source.title, targetTitle: stagedMove.target.title }
}
export async function clearStagedCrossPageMove(): Promise<boolean> {
  const staged = stagedMove
  if (!staged) return true
  const { peekCanonicalInlineRuntime } = await import('../features/synced-blocks/inlineRuntime')
  if (staged !== stagedMove || peekCanonicalInlineRuntime()?.originalCrossMovePeer(staged.source.id)) return false
  stagedMove = null
  return true
}

function acceptCrossMoveHistory(result: SyncedStructureApplied, source: DocumentDetail, peers: readonly DocumentDetail[],
  bookmark: EditorHistoryBookmark | null, context: BlockMoveCompletionContext) {
  const moved = acceptCrossMove(result, source, peers, context)
  if (!moved) return false
  pushMove(moved.blocks, bookmark, { operationId: result.operationId, versions: moved.versions,
    cross: { token: moved.token, groupIds: result.groups.map(group => group.groupId) } }, context)
  return true
}

async function stageOrMoveBatch({ mode, documentId }: BatchDestination, blockIds: string[],
  bookmark: EditorHistoryBookmark | null, context: BlockMoveCompletionContext, working: () => SyncedHostSourceCurrent | null) {
  const source = context.selected.current, opening = working(), staged = stagedMove
  if (!context.isCurrent() || !source || !opening || opening.host.documentId !== source.id || source.id === documentId
    || opening.host.expectedPersistedUpdatedAt !== source.updatedAt) return false
  const sameOpening = () => context.isCurrent() && context.selected.current?.updatedAt === source.updatedAt
    && stagedMove === staged && matchesWorking(context, opening.host.workingBefore)
  const ready = await window.knowbook.openSyncedEditingSession({ kind: 'host', hostDocumentId: source.id })
  if (!sameOpening() || ready.status !== 'ready') return false
  const { workspaceScope, recoveryEpoch } = ready.session
  if (mode === 'stage') {
    if (staged || !matchesWorking(context, initialWorking(source).workingBefore)) return false
    const target = await window.knowbook.getDocumentDetail(documentId)
    if (!target || target.id !== documentId || !sameOpening()) return false
    stagedMove = { source, target, selectedRootIds: [...blockIds], workspaceScope, recoveryEpoch }
    return true
  }
  if (!staged || staged.source.id === source.id || staged.workspaceScope !== workspaceScope || staged.recoveryEpoch !== recoveryEpoch) return false
  const { getCanonicalInlineRuntime } = await import('../features/synced-blocks/inlineRuntime')
  const runtime = getCanonicalInlineRuntime()
  const ids = [...new Set([staged.source.id, staged.target.id, documentId])].filter(id => id !== source.id)
  const peers: DocumentDetail[] = []
  for (const id of ids) {
    const peer = runtime.originalCrossMovePeer(id) ?? await window.knowbook.getDocumentDetail(id)
    if (!peer || peer.id !== id || !sameOpening()) return false
    peers.push(peer)
  }
  const pages = new Map([source, ...peers].map(page => [page.id, page]))
  for (const original of [staged.source, staged.target]) {
    const actual = pages.get(original.id)
    if (!actual || actual.updatedAt !== original.updatedAt || actual.path !== original.path) return false
  }
  const placement = (documentId: string) => ({ documentId, parentBlockId: null, beforeBlockId: null, depth: 0 })
  const action: Extract<SyncedStructureAction, { kind: 'move-batch' }> = { kind: 'move-batch', moves: [
    { selection: { documentId: staged.source.id, selectedRootIds: staged.selectedRootIds }, target: placement(staged.target.id) },
    { selection: { documentId: source.id, selectedRootIds: blockIds }, target: placement(documentId) }
  ] }
  const completed = await runtime.moveBetweenHosts(opening, source, peers, { hostsWorkingBefore: [opening.host, ...peers.map(initialWorking)], action },
    sameOpening, (result, actualPeers) => acceptCrossMoveHistory(result, source, actualPeers, bookmark, context))
  if (completed && stagedMove === staged) stagedMove = null
  return completed
}

export async function moveDraftBlocksAcrossPages(target: BlockMoveDestination, blockIds: string[], bookmark: EditorHistoryBookmark | null,
  context: BlockMoveCompletionContext, working: () => SyncedHostSourceCurrent | null, flushOrdinary: (options: CanonicalInlineFlushOptions) => Promise<boolean>) {
  if (typeof target !== 'string' && target.mode !== 'list') return stageOrMoveBatch(target, blockIds, bookmark, context, working)
  const documentId = typeof target === 'string' ? target : target.documentId
  const { getCanonicalInlineRuntime, peekCanonicalInlineRuntime } = await import('../features/synced-blocks/inlineRuntime')
  const existingRuntime = peekCanonicalInlineRuntime()
  const originalDestination = existingRuntime?.originalCrossMovePeer(documentId)
  const destination = originalDestination ?? await window.knowbook.getDocumentDetail(documentId)
  const source = context.selected.current
  if (!context.isCurrent() || !source || !destination) return false
  let placement: SyncedPlacement | undefined
  if (typeof target !== 'string') {
    const selected = blockIds.length === 1 && readSingleMovedSyncedReference(source.blocks, blockIds[0])
    const parent = destination.blocks.find(block => block.id === target.parentBlockId)
    if (!selected || selected.depth === 0 || destination.updatedAt !== target.expectedUpdatedAt
      || !parent || !isListBlockType(parent.type) || parent.depth >= SYNCED_MAX_DEPTH) return false
    placement = { documentId, parentBlockId: parent.id, beforeBlockId: null, depth: parent.depth + 1 }
  }
  const moveControlled = (source: DocumentDetail, destination: DocumentDetail, dependencies?: ControlledDocumentBlockMove['dependencies']) => {
    const opening = working()
    if (!opening || opening.host.documentId !== source.id) return false
    const runtime = existingRuntime ?? getCanonicalInlineRuntime()
    return runtime.moveBetweenHosts(opening, source, [destination],
      { hostsWorkingBefore: [opening.host, initialWorking(destination)], selection: blockIds, ...(placement ? { placement } : {}) }, context.isCurrent,
      (result, peers) => acceptCrossMoveHistory(result, source, peers, bookmark, context), dependencies)
  }
  if (originalDestination || hasReference(source.blocks) || hasReference(context.blocks.current) || hasReference(destination.blocks))
    return moveControlled(source, destination)
  const admission = await window.knowbook.readControlledDocumentBlockMoveDependencies({ fromDocumentId: source.id, toDocumentId: documentId, blockIds,
    expectedFromUpdatedAt: source.updatedAt, expectedToUpdatedAt: destination.updatedAt })
  if (!context.isCurrent() || context.selected.current?.updatedAt !== source.updatedAt) return false
  if (admission) return moveControlled(source, destination, admission.dependencies)
  if (!await flushOrdinary({ purpose: 'move' }) || !context.isCurrent() || !context.selected.current) return false
  const ordinaryDestination = await window.knowbook.getDocumentDetail(documentId)
  const savedSource = context.selected.current
  if (!ordinaryDestination || !savedSource || !context.isCurrent() || hasReference(ordinaryDestination.blocks)) return false
  return completeDocumentBlockMove({ fromDocumentId: source.id, toDocumentId: documentId, blockIds,
    expectedFromUpdatedAt: savedSource.updatedAt, expectedToUpdatedAt: ordinaryDestination.updatedAt }, bookmark, context)
}

export async function restoreDraftBlockMove(move: MoveTransition, state: 'applied' | 'undone', context: BlockMoveCompletionContext,
  working: () => SyncedHostSourceCurrent | null, flushOrdinary: () => Promise<boolean>) {
  if (!move.cross) {
    if (!await flushOrdinary() || !context.isCurrent()) return false
    return completeDocumentBlockMoveRestore({ operationId: move.operationId, expectedUpdatedAtByDocument: { ...move.versions } }, state, context)
  }
  const source = context.selected.current, opening = working()
  if (!context.isCurrent() || !source || !opening || source.updatedAt !== move.versions[source.id]
    || !matchesWorking(context, initialWorking(source).workingBefore)) return false
  const others = Object.keys(move.versions).filter(id => id !== source.id)
  if (!others.length || !Object.hasOwn(move.versions, source.id)) return false
  const { getCanonicalInlineRuntime } = await import('../features/synced-blocks/inlineRuntime')
  const runtime = getCanonicalInlineRuntime()
  const peers = await Promise.all(others.map(id => runtime.originalCrossMovePeer(id) ?? window.knowbook.getDocumentDetail(id)))
  if (peers.some(peer => !peer || peer.updatedAt !== move.versions[peer.id])) return false
  return runtime.moveBetweenHosts(opening, source, peers.filter(peer => peer !== null), { historyToken: move.cross.token,
    groupIds: move.cross.groupIds, direction: state === 'undone' ? 'undo' : 'redo' }, context.isCurrent,
    (result, acceptedPeers) => Boolean(acceptCrossMove(result, source, acceptedPeers, context)))
}

export async function readPairedBlockMoveHistory(documentId: string, context: BlockMoveCompletionContext) {
  const ipc = window.knowbook
  const ordinary = await ipc.getDocumentBlockMoveHistory(documentId)
  if (!context.isCurrent()) return
  // Check the synchronized history first. A previously ordinary page may no
  // longer contain the reference once its paired move was undone.
  let entries: SyncedCrossHostMoveHistory[] = []
  if (typeof ipc.openSyncedEditingSession === 'function' && typeof ipc.invokeSyncedEditingSession === 'function'
    && typeof ipc.onSyncedBlocksChanged === 'function' && typeof ipc.onWorkspaceMutated === 'function') {
    try {
      const { getCanonicalInlineRuntime } = await import('../features/synced-blocks/inlineRuntime')
      if (context.isCurrent()) entries = await getCanonicalInlineRuntime().crossMoveHistory(documentId, context.isCurrent)
    } catch (error) { console.warn('Synchronized block move history is unavailable.', error) }
  }
  if (!context.isCurrent() || context.busy.current || context.history.current.length !== 1 || context.pointer.current !== 0) return
  const detail = context.selected.current
  if (!detail) return
  const marker = (entry: SyncedCrossHostMoveHistory): MoveTransition => ({ operationId: entry.operationId, versions: entry.versions,
    cross: { token: entry.historyToken, groupIds: entry.groupIds } })
  const undo = entries.find(entry => entry.direction === 'undo' && detail.updatedAt === entry.versions[documentId] && matchesWorking(context, entry.after))
  const redo = entries.find(entry => entry.direction === 'redo' && detail.updatedAt === entry.versions[documentId] && matchesWorking(context, entry.before))
  if (!undo && !redo) { if (ordinary) acceptDocumentBlockMoveHistory(ordinary, context); return }
  const take = (blocks: DocumentBlockDraft[]) => cloneBlocks(normalizeDraftBlocks(blocks))
  const history: MoveSnapshot[] = []
  if (undo) history.push({ blocks: take(undo.before.blocks), bookmark: null })
  const position = history.length
  history.push({ blocks: take(context.blocks.current), bookmark: null, ...(undo ? { move: marker(undo) } : {}) })
  if (redo) history.push({ blocks: take(redo.after.blocks), bookmark: null, move: marker(redo) })
  context.history.current = history
  context.pointer.current = position
  context.onRevision(value => value + 1)
}

export async function completeDocumentBlockMoveRestore(input: RestoreDocumentBlockMoveInput, state: 'applied' | 'undone',
  context: BlockMoveCompletionContext): Promise<boolean> {
  if (!context.isCurrent()) return false
  const result = state === 'undone' ? await window.knowbook.undoDocumentBlockMove(input) : await window.knowbook.redoDocumentBlockMove(input)
  if (context.isCurrent()) acceptResult(result, context)
  await refreshWorkspace(context)
  return context.isCurrent()
}

/** A read acknowledgement may arrive after typing, navigation, or a new session. */
export function acceptDocumentBlockMoveHistory(entry: DocumentBlockMoveHistoryEntry, context: BlockMoveCompletionContext): void {
  if (!context.isCurrent() || context.busy.current || context.history.current.length !== 1 || context.pointer.current !== 0) return
  const expected = normalizeDraftBlocks(entry.state === 'applied' ? entry.afterBlocks : entry.beforeBlocks)
  const detail = context.selected.current
  if (!detail || !areDocumentDraftBlocksEqual(expected, context.blocks.current)
    || context.title.current !== detail.title || context.summary.current !== detail.summary) return
  context.history.current = [
    { blocks: cloneBlocks(normalizeDraftBlocks(entry.beforeBlocks)), bookmark: null },
    { blocks: cloneBlocks(normalizeDraftBlocks(entry.afterBlocks)), bookmark: null,
      move: { operationId: entry.operationId, versions: { ...entry.expectedUpdatedAtByDocument } } }
  ]
  context.pointer.current = entry.state === 'applied' ? 1 : 0
  context.checkpointed.current = context.blocks.current
  context.onRevision(value => value + 1)
}
