import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import type { DocumentBlockDraft } from '@shared/contracts'
import { findDocumentSection, getVisibleDocumentEntries, type DocumentFoldView, type DocumentSection } from '../utils/documentSections'

type Range = { start: number; end: number }
type Params = {
  documentId: string | null
  draftBlocks: DocumentBlockDraft[]
  sections: DocumentSection[]
  foldView: DocumentFoldView
  setFoldView: (view: DocumentFoldView) => void
  activeBlockIndex: number | null
  selectedBlockRange: Range | null
  blockTextareaRefs: { current: Array<HTMLTextAreaElement | null> }
  clearBlockSelection: () => void
  setActiveBlockIndex: (index: number | null) => void
  setActiveCursorPosition: (position: number) => void
  setSelectedBlockRange: (range: Range | null) => void
  setSelectionAnchorBlockId: (id: string | null) => void
  setPendingFocusBlockIndex: (index: number | null) => void
  clearEditorAssistSuggestions: () => void
  endBlockDrag: () => void
  onScrollToBlock: (index: number) => void
}

export function useDocumentFoldingActions(params: Params) {
  const parked = useRef<{
    documentId: string; anchorId: string; anchorContent: string; targetId: string; content: string
    start: number; end: number; range: { startId: string; endId: string } | null
  } | null>(null)
  const pendingFocus = useRef<{ documentId: string; blockId: string; start: number; end: number } | null>(null)
  useEffect(() => () => {
    parked.current = null
    pendingFocus.current = null
  }, [params.documentId])
  // Restore after visible rows mount, before another key can reach the previous editor.
  useLayoutEffect(() => {
    const request = pendingFocus.current
    pendingFocus.current = null
    if (!request || request.documentId !== params.documentId) return
    const index = params.draftBlocks.findIndex((block) => block.id === request.blockId)
    const textarea = params.blockTextareaRefs.current[index]
    if (textarea) {
      textarea.focus()
      textarea.setSelectionRange(request.start, request.end)
      params.setActiveCursorPosition(textarea.selectionEnd)
    }
  })
  const changeView = useCallback((next: DocumentFoldView, preferredIndex?: number) => {
    const { documentId, draftBlocks, sections, activeBlockIndex, selectedBlockRange, blockTextareaRefs } = params
    if (!documentId) return
    pendingFocus.current = null
    const entries = getVisibleDocumentEntries(draftBlocks, next, sections)
    const visible = new Set(entries.map(({ index }) => index))
    const activeIndex = activeBlockIndex ?? selectedBlockRange?.start ?? null
    const hidesSelection = selectedBlockRange && draftBlocks.some((_block, index) =>
      index >= selectedBlockRange.start && index <= selectedBlockRange.end && !visible.has(index))
    const hidesCursor = activeIndex !== null && !visible.has(activeIndex)
    const activeBlock = draftBlocks[activeIndex ?? -1]
    const activeTextarea = activeIndex === null ? null : blockTextareaRefs.current[activeIndex]
    const shouldFocusEditor = document.activeElement instanceof HTMLElement && Boolean(document.activeElement.closest('.block-editor-row'))
    const saved = parked.current
    const canRestore = saved?.documentId === documentId && activeBlock?.id === saved.anchorId
      && activeBlock.content === saved.anchorContent
      && (!activeTextarea || (activeTextarea.selectionStart === activeBlock.content.length && activeTextarea.selectionEnd === activeBlock.content.length))
    if (!canRestore) parked.current = null
    const focusAt = (index: number, start: number, end = start) => {
      params.setActiveBlockIndex(index)
      params.setActiveCursorPosition(end)
      const blockId = draftBlocks[index]?.id
      if (shouldFocusEditor && blockId) pendingFocus.current = { documentId, blockId, start, end }
    }
    params.endBlockDrag()
    params.clearEditorAssistSuggestions()
    params.setPendingFocusBlockIndex(null)
    if (hidesSelection || hidesCursor) {
      const target = draftBlocks[activeIndex ?? selectedBlockRange!.start]
      const fallback = entries.filter(({ index }) => index <= (preferredIndex ?? activeIndex ?? 0)).at(-1) ?? entries[0]
      const textarea = activeIndex === null ? null : blockTextareaRefs.current[activeIndex]
      if (target?.id && fallback?.block.id) {
        // Folding a parent of an already folded chapter keeps the original selection.
        parked.current = canRestore && saved
          ? { ...saved, anchorId: fallback.block.id, anchorContent: fallback.block.content }
          : { documentId, anchorId: fallback.block.id, anchorContent: fallback.block.content,
          targetId: target.id, content: target.content,
          start: textarea?.selectionStart ?? 0, end: textarea?.selectionEnd ?? 0,
          range: selectedBlockRange ? { startId: draftBlocks[selectedBlockRange.start].id!, endId: draftBlocks[selectedBlockRange.end].id! } : null }
      }
      // End composition while the editor is still connected; unmount alone may not emit blur.
      activeTextarea?.blur()
      params.clearBlockSelection()
      if (fallback) focusAt(fallback.index, fallback.block.content.length)
    } else {
      if (canRestore && saved) {
        const targetIndex = draftBlocks.findIndex((block) => block.id === saved.targetId && block.content === saved.content)
        const start = saved.range ? draftBlocks.findIndex((block) => block.id === saved.range!.startId) : -1
        const end = saved.range ? draftBlocks.findIndex((block) => block.id === saved.range!.endId) : -1
        const hasRange = start >= 0 && end >= start
        const rangeVisible = !hasRange || !draftBlocks.some((_block, index) => index >= start && index <= end && !visible.has(index))
        if (targetIndex >= 0 && visible.has(targetIndex) && rangeVisible) {
          focusAt(targetIndex, saved.start, saved.end)
          if (hasRange) {
            params.setSelectedBlockRange({ start, end })
            params.setSelectionAnchorBlockId(saved.range!.startId)
          }
          parked.current = null
        }
      }
    }
    params.setFoldView(next)
  }, [params])

  const toggleBlockCollapse = useCallback((id: string) => {
    const collapsedIds = new Set(params.foldView.collapsedIds)
    if (collapsedIds.has(id)) collapsedIds.delete(id)
    else collapsedIds.add(id)
    changeView({ ...params.foldView, collapsedIds }, params.draftBlocks.findIndex((block) => block.id === id))
  }, [changeView, params.draftBlocks, params.foldView])
  const collapseAllSections = useCallback(() => {
    changeView({ collapsedIds: new Set([...params.foldView.collapsedIds,
      ...params.sections.filter((section) => section.end > section.index + 1).map((section) => section.id)]), focusedHeadingId: null })
    const section = params.sections.find((item) => item.index <= (params.activeBlockIndex ?? 0) && item.end > (params.activeBlockIndex ?? 0)) ?? params.sections[0]
    if (section) params.onScrollToBlock(section.index)
  }, [changeView, params])
  const expandAllSections = useCallback(() => {
    const headings = new Set(params.sections.map((section) => section.id))
    changeView({ collapsedIds: new Set([...params.foldView.collapsedIds].filter((id) => !headings.has(id))), focusedHeadingId: null })
  }, [changeView, params.foldView.collapsedIds, params.sections])
  const focusSection = useCallback((index: number) => {
    const section = findDocumentSection(params.sections, index)
    if (!section) return
    const collapsedIds = new Set(params.foldView.collapsedIds)
    for (const child of params.sections) {
      if (child.index >= section.index && child.index < section.end) collapsedIds.delete(child.id)
    }
    changeView({ collapsedIds, focusedHeadingId: section.id }, section.index)
    params.onScrollToBlock(section.index)
  }, [changeView, params])
  const exitSectionFocus = useCallback(() => changeView({ ...params.foldView, focusedHeadingId: null }), [changeView, params.foldView])

  return { toggleBlockCollapse, collapseAllSections, expandAllSections, focusSection, exitSectionFocus }
}
