import { useCallback, useMemo, useState } from 'react'
import type { DocumentBlockDraft } from '@shared/contracts'
import { buildDocumentSections, readDocumentFoldView, revealDocumentBlock, saveDocumentFoldView, type DocumentFoldView } from '../utils/documentSections'

export function useBlockCollapseState({ draftBlocks, documentId }: { draftBlocks: DocumentBlockDraft[]; documentId: string | null }) {
  const [session, setSession] = useState<{ documentId: string | null; view: DocumentFoldView } | null>(null)
  const structure = useMemo(() => JSON.stringify(draftBlocks.map(({ id, type, parentBlockId, depth }) => [id, type, parentBlockId, depth])), [draftBlocks])
  // Text edits must not replace the shared collapse Set and rerender every row.
  const sections = useMemo(() => buildDocumentSections(draftBlocks), [structure])
  const storedView = useMemo(() => session?.documentId === documentId ? session.view
    : readDocumentFoldView(documentId ?? ''), [documentId, session])
  const foldableIds = useMemo(() => new Set([
    ...sections.filter((section) => section.end > section.index + 1).map((section) => section.id),
    ...draftBlocks.flatMap((block) => block.parentBlockId ? [block.parentBlockId] : [])
  ]), [structure, sections])
  const view = useMemo<DocumentFoldView>(() => ({
    collapsedIds: new Set([...storedView.collapsedIds].filter((id) => foldableIds.has(id))),
    focusedHeadingId: sections.some((section) => section.id === storedView.focusedHeadingId) ? storedView.focusedHeadingId : null
  }), [foldableIds, sections, storedView])
  const setFoldView = useCallback((next: DocumentFoldView) => {
    if (!documentId) return
    setSession({ documentId, view: next })
    saveDocumentFoldView(documentId, next)
  }, [documentId])
  const blockHasChildren = useCallback((index: number) => foldableIds.has(draftBlocks[index]?.id ?? ''), [draftBlocks, foldableIds])
  const revealBlockAncestors = useCallback((id: string) => {
    const next = revealDocumentBlock(draftBlocks, view, id, sections)
    if (next.focusedHeadingId !== view.focusedHeadingId || next.collapsedIds.size !== view.collapsedIds.size) setFoldView(next)
  }, [draftBlocks, sections, setFoldView, view])

  return { blockHasChildren, collapsedBlockIds: view.collapsedIds, focusedHeadingId: view.focusedHeadingId,
    focusedSection: sections.find((section) => section.id === view.focusedHeadingId) ?? null,
    sections, foldView: view, setFoldView, revealBlockAncestors }
}
