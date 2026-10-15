import type { DocumentBlockDraft, DocumentDetail, HomeData } from '@shared/contracts'
import type { DocumentBlockMoveHistoryEntry, DocumentBlockMoveResult, MoveDocumentBlocksInput, RestoreDocumentBlockMoveInput } from '@shared/document-block-moves'
import type { EditorHistoryBookmark } from './editorHistoryFocus'
import { toDraftBlock } from './draftBlockShape'
import { normalizeDraftBlocks } from './draftTreeNormalization'
import { areDocumentDraftBlocksEqual } from './documentDraftComparison'

type MoveSnapshot = { blocks: DocumentBlockDraft[]; bookmark: EditorHistoryBookmark | null;
  move?: { operationId: string; versions: Record<string, string> } }
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

/** Called only after the original source save and destination read completed. */
export async function completeDocumentBlockMove(input: MoveDocumentBlocksInput, bookmark: EditorHistoryBookmark | null,
  context: BlockMoveCompletionContext): Promise<boolean> {
  if (!context.isCurrent()) return false
  const result = await window.knowbook.moveDocumentBlocks(input)
  if (context.isCurrent()) {
    const blocks = acceptResult(result, context)
    const history = context.history.current.slice(0, context.pointer.current + 1)
    history.push({ blocks: cloneBlocks(blocks), bookmark,
      move: { operationId: result.operationId, versions: { ...result.expectedUpdatedAtByDocument } } })
    context.history.current = history.slice(-80)
    context.pointer.current = context.history.current.length - 1
    context.onRevision(value => value + 1)
  }
  await refreshWorkspace(context)
  return context.isCurrent()
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
