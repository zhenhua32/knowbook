import { useEffect, useRef, useState } from 'react'
import { planDocumentBlockTransfer } from '@shared/documentBlockTransfer'
import type { DocumentTreeNode } from '@shared/contracts'
import type { UiText } from '../i18n'
import type { DocumentsDomainState } from '../types/appDomains'
import type { DocumentBlockActionTarget } from './useDocumentEditorState'
import type { BlockContextMenuProps } from '../components/BlockContextMenu'
import type { DocumentBlockMoveDialogProps } from '../components/DocumentBlockMoveDialog'
import { blockConversionLabels } from '../utils/blockConversionTypes'
import { planBlockAction } from '../utils/documentBlockActions'
import { captureEditorHistoryBookmark, restoreEditorHistoryBookmark } from '../utils/editorHistoryFocus'
import { getErrorMessage } from '../utils/errorMessage'
import { createColdBlockPopup, type ColdBlockPopup } from '../utils/coldBlockPopup'

type Opening = { target: DocumentBlockActionTarget; opener: HTMLElement | null; x: number; y: number; cold?: ColdBlockPopup }
export function useDocumentBlockActions({ documents, documentTree, isZh, ui, onOpenAiEdit }: {
  documents: DocumentsDomainState; documentTree: DocumentTreeNode[]; isZh: boolean; ui: UiText; onOpenAiEdit?: () => void
}) {
  const live = useRef(documents), currentMenu = useRef<Opening | null>(null), currentMove = useRef<Opening | null>(null)
  live.current = documents
  const pendingRestores = useRef(new Map<number, { opening: Opening; waiting: ColdBlockPopup }>())
  const aiOpening = useRef(onOpenAiEdit); aiOpening.current = onOpenAiEdit
  const [menu, setMenu] = useState<Opening | null>(null), [move, setMove] = useState<Opening | null>(null)
  const [copying, setCopying] = useState(false), copyLock = useRef(false)
  const [moveError, setMoveError] = useState<string | null>(null)
  currentMenu.current = menu; currentMove.current = move
  const sameSession = (target: DocumentBlockActionTarget) => {
    const current = live.current.getRenameTarget()
    return current?.documentId === target.documentId && current.session === target.session
  }
  const attention = (opening: Opening) => {
    if (document.activeElement !== opening.opener || !opening.target.bookmark) return true
    const current = captureEditorHistoryBookmark(live.current.getDraftBlocks())
    return !current || JSON.stringify(current) === JSON.stringify(opening.target.bookmark)
  }
  const restore = (opening: Opening) => {
    if (opening.cold && !opening.cold.canRestore()) return
    const scope = document.querySelector<HTMLElement>('.block-context-menu, .document-block-move-dialog')
    const waiting = createColdBlockPopup(opening.opener, scope)
    const frame = requestAnimationFrame(() => {
      pendingRestores.current.delete(frame)
      const allowed = !waiting.vetoed() && document.hasFocus() && sameSession(opening.target)
        && !currentMove.current && !currentMenu.current && attention(opening)
        && ![...document.querySelectorAll<HTMLElement>('dialog[open], [aria-modal="true"][role="dialog"], [aria-modal="true"][role="alertdialog"]')]
          .some(modal => modal !== scope && modal.isConnected && modal.getClientRects().length > 0)
      waiting.dispose()
      if (!allowed) return
      const active = document.activeElement
      if (active !== document.body && active !== opening.opener && !(active instanceof HTMLElement && scope?.contains(active))) return
      if (opening.target.bookmark) restoreEditorHistoryBookmark(opening.target.bookmark, live.current.getDraftBlocks())
    })
    pendingRestores.current.set(frame, { opening, waiting })
  }
  const closeMenu = () => {
    const closing = currentMenu.current
    closing?.cold?.dispose()
    currentMenu.current = null; setMenu(null)
    if (closing && !currentMove.current) restore(closing)
  }
  const closeMove = () => {
    if (live.current.isBlockMoveBusy) return
    const closing = currentMove.current
    closing?.cold?.dispose()
    currentMove.current = null; setMove(null); setMoveError(null)
    if (closing) restore(closing)
  }
  const selectedBlockActionIds = () => {
    const current = live.current, range = current.selectedBlockRange
    if (!range || !current.isSelectionCoherent(range)) return []
    return current.getVisibleBlockEntries(current.getDraftBlocks())
      .filter(entry => entry.index >= range.start && entry.index <= range.end)
      .flatMap(entry => entry.block.id ? [entry.block.id] : [])
  }
  const openingFor = (blockIds: string[], x = 0, y = 0): Opening | null => {
    const target = live.current.getBlockActionTarget(blockIds)
    return target ? { target, x, y, opener: document.activeElement instanceof HTMLElement ? document.activeElement : null } : null
  }
  const openBlockActions = (input: { blockIds: string[]; x: number; y: number }) => {
    if (copyLock.current || currentMove.current || live.current.isBlockMoveBusy) return
    const opening = openingFor(input.blockIds, input.x, input.y)
    if (!opening) return
    live.current.checkpointDraft()
    currentMenu.current?.cold?.dispose()
    const guarded = { ...opening, cold: createColdBlockPopup(opening.opener) }
    currentMenu.current = guarded; setMenu(guarded)
  }
  const apply = (opening: Opening, action: 'convert' | 'duplicate' | 'delete', type?: string, preserveSelection = false) => {
    const current = live.current
    if (!current.isBlockActionTargetCurrent(opening.target) || current.isBlockMoveBusy) return
    const next = planBlockAction(opening.target.blocks, opening.target.blockIds, action, type)
    if (!next) return
    const selected = preserveSelection ? current.selectedBlockRange : null
    const selectedIds = selected ? selectedBlockActionIds() : []
    const keepRange = selected && selectedIds.length === opening.target.blockIds.length
      && opening.target.blockIds.every(id => selectedIds.includes(id))
    const endpoints = keepRange ? [opening.target.blocks[selected.start]?.id, opening.target.blocks[selected.end]?.id] : null
    current.pushToHistory(opening.target.blocks, opening.target.bookmark)
    if (!keepRange) current.clearBlockSelection()
    current.setDraftBlocks(next)
    if (endpoints) {
      const first = next.findIndex(block => block.id === endpoints[0]), last = next.findIndex(block => block.id === endpoints[1])
      if (first >= 0 && last >= 0) current.setSelectedBlockRange({ start: Math.min(first, last), end: Math.max(first, last) })
      else current.clearBlockSelection()
      // Keep the existing stable anchor/focus IDs so reverse range extension
      // continues from the same endpoint after the converted rows rerender.
    }
    current.pushToHistory(next, opening.target.bookmark)
    restore(opening)
  }
  const copy = async (opening: Opening) => {
    if (copyLock.current || !live.current.isBlockActionTargetCurrent(opening.target)) return
    copyLock.current = true; setCopying(true)
    try {
      if (!await live.current.flushPendingChanges() || !sameSession(opening.target)) return
      const detail = await window.knowbook.getDocumentDetail(opening.target.documentId)
      if (!detail || !sameSession(opening.target) || !live.current.isBlockActionTargetCurrent(opening.target)) return
      const selected = new Set(opening.target.blockIds), persisted = new Set(detail.blocks.map(block => block.id))
      const roots = opening.target.blocks.flatMap(block => block.id && selected.has(block.id) ? [block.id] : [])
      if (!roots.length || roots.some(id => !persisted.has(id))) return
      const label = detail.title.replace(/[\\[\]*_`]/g, '\\$&')
      const path = '/' + detail.path.split('/').map(encodeURIComponent).join('/') + '.md'
      await window.knowbook.writeClipboardText(roots.map(id => '[' + label + '](<' + path + '#^' + encodeURIComponent(id) + '>)').join('\n'))
      live.current.notifyBlockAction(isZh ? '已复制块链接' : 'Block links copied')
    } catch (error) { live.current.notifyBlockAction(getErrorMessage(error, isZh ? '复制链接失败' : 'Could not copy links'), 'error') }
    finally { copyLock.current = false; setCopying(false) }
  }
  const moveReason = (opening: Opening) => planDocumentBlockTransfer({ from: opening.target.blocks, to: [],
    selectedIds: opening.target.blockIds }) ? null
    : isZh ? '请选择连续同级的完整内容块；子块会一起移动。' : 'Select consecutive sibling blocks; children move with them.'
  const openMove = (opening: Opening) => {
    if (!live.current.isBlockActionTargetCurrent(opening.target) || moveReason(opening)) return
    currentMove.current?.cold?.dispose()
    const guarded = { ...opening, cold: createColdBlockPopup(opening.opener, document.querySelector<HTMLElement>('.block-context-menu')) }
    currentMove.current = guarded; setMove(guarded); setMoveError(null); closeMenu()
  }
  const convertSelectedBlocks = (type: string) => { const opening = openingFor(selectedBlockActionIds()); if (opening) apply(opening, 'convert', type, true) }
  const copySelectedBlockLinks = () => { const opening = openingFor(selectedBlockActionIds()); if (opening) void copy(opening) }
  const openSelectedBlocksMove = () => { const opening = openingFor(selectedBlockActionIds()); if (opening) openMove(opening) }
  useEffect(() => {
    if (documents.isBlockMoveBusy) return
    if (menu && !documents.isBlockActionTargetCurrent(menu.target)) { menu.cold?.dispose(); currentMenu.current = null; setMenu(null) }
    if (move && !documents.isBlockActionTargetCurrent(move.target)) { move.cold?.dispose(); currentMove.current = null; setMove(null) }
  }, [documents.draftBlocks, documents.selectedDocumentId, documents.isBlockMoveBusy, menu, move])
  useEffect(() => () => {
    currentMenu.current?.cold?.dispose(); currentMove.current?.cold?.dispose()
    for (const [frame, { waiting }] of pendingRestores.current) { cancelAnimationFrame(frame); waiting.dispose() }
    pendingRestores.current.clear()
  }, [])
  const canReturnFocus = (opening: Opening) => document.hasFocus() && sameSession(opening.target)
    && (opening.cold?.canRestore() ?? true)
    && ![...pendingRestores.current.values()].some(entry => entry.opening === opening && entry.waiting.vetoed())
  const canOpen = (opening: Opening) => {
    const scope = document.querySelector<HTMLElement>(opening === currentMove.current ? '.document-block-move-dialog' : '.block-context-menu')
    const foreignModal = [...document.querySelectorAll<HTMLElement>('dialog[open], [aria-modal="true"][role="dialog"], [aria-modal="true"][role="alertdialog"]')]
      .some(modal => modal !== scope && modal.isConnected && modal.getClientRects().length > 0)
    return document.hasFocus() && !foreignModal && sameSession(opening.target)
      && live.current.isBlockActionTargetCurrent(opening.target) && attention(opening)
    && (document.activeElement === document.body || document.activeElement === opening.opener
      || document.activeElement instanceof HTMLElement && !!document.activeElement.closest('.block-context-menu'))
    && (opening.cold?.claim(scope) ?? true)
  }
  const contextMenuProps: BlockContextMenuProps | null = menu ? {
    x: menu.x, y: menu.y, blockType: menu.target.blockIds.length === 1
      ? menu.target.blocks.find(block => block.id === menu.target.blockIds[0])?.type ?? '' : '',
    selectedBlockCount: menu.target.blockIds.length, onTypeChange: type => apply(menu, 'convert', type, true),
    onDuplicate: () => apply(menu, 'duplicate'), onDelete: () => apply(menu, 'delete'), onClose: closeMenu,
    onCopyBlockLinks: () => { void copy(menu) }, onMoveToDocument: () => openMove(menu),
    disabled: copying || documents.isBlockMoveBusy, moveDisabledReason: moveReason(menu),
    currentHighlight: menu.target.blockIds.length === 1 ? menu.target.blocks.find(block => block.id === menu.target.blockIds[0])?.highlight : undefined,
    onHighlightChange: color => {
      if (!live.current.isBlockActionTargetCurrent(menu.target)) return
      const ids = new Set(menu.target.blockIds), next = menu.target.blocks.map(block => ids.has(block.id ?? '') ? { ...block, highlight: color } : block)
      live.current.pushToHistory(menu.target.blocks, menu.target.bookmark)
      live.current.setDraftBlocks(next); live.current.pushToHistory(next, menu.target.bookmark)
    },
    onOpenAiEdit: () => {
      if (!live.current.isBlockActionTargetCurrent(menu.target)) return
      const indices = menu.target.blockIds.map(id => menu.target.blocks.findIndex(block => block.id === id))
      live.current.setSelectedBlockRange({ start: Math.min(...indices), end: Math.max(...indices) })
      requestAnimationFrame(() => { if (sameSession(menu.target)) aiOpening.current?.() })
    },
    typeOptions: blockConversionLabels(ui.blockTypeOptions), isZh, ui, canOpen: () => canOpen(menu),
    canReturnFocus: () => canReturnFocus(menu)
  } : null
  const moveDialogProps: DocumentBlockMoveDialogProps | null = move ? {
    documents: documentTree, sourceDocumentId: move.target.documentId,
    sourceDocumentTitle: documents.selectedDocument?.title ?? '',
    selectedBlockCount: planDocumentBlockTransfer({ from: move.target.blocks, to: [], selectedIds: move.target.blockIds })?.movedIds.length ?? move.target.blockIds.length,
    isZh, busy: documents.isBlockMoveBusy, error: moveError, opener: move.opener,
    canOpen: () => canOpen(move), canReturnFocus: () => canReturnFocus(move),
    onClose: closeMove, onMove: async targetId => {
      const completed = await live.current.moveDraftBlocksToDocument(move.target, targetId)
      if (completed) {
        live.current.clearBlockSelection()
        move.cold?.dispose()
        currentMove.current = null; setMove(null); setMoveError(null)
        restore(move)
        return true
      }
      if (sameSession(move.target)) setMoveError(isZh ? '移动未完成，请检查文档是否已变化后重试。' : 'Move was not completed; check whether a document changed.')
      return false
    }
  } : null
  const selectedOpening = openingFor(selectedBlockActionIds())
  const selectedMoveDisabledReason = selectedOpening ? moveReason(selectedOpening) : null
  return { selectedMoveDisabledReason, convertSelectedBlocks, openBlockActions, copySelectedBlockLinks, openSelectedBlocksMove, selectedBlockActionIds, contextMenuProps, moveDialogProps }
}
