import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { DocumentBlockDraft, DocumentSuggestion } from '@shared/contracts'
import type { UiLanguage } from '../i18n'
import { getOpenLinkContext, getSlashCommandContext } from '../utils/editorAssist'
import { canBlockOwnChildren } from '@shared/blockTypes'
import { computeSlashPanelPosition } from '../utils/menuPosition'
import { useSlashCommandCatalog } from './useSlashCommandCatalog'

type UseEditorAssistStateParams = {
  activeBlockIndex: number | null
  activeCursorPosition: number
  blockTextareaRefs: { current: Array<HTMLTextAreaElement | null> }
  draftBlocks: DocumentBlockDraft[]
  isEditing: boolean
  selectedDocumentId: string | null
  selectedDocumentPresent: boolean
  setActiveBlockIndex: Dispatch<SetStateAction<number | null>>
  setActiveCursorPosition: Dispatch<SetStateAction<number>>
  setDraftBlocks: Dispatch<SetStateAction<DocumentBlockDraft[]>>
  uiLanguage: UiLanguage
}

type LinkSuggestionState = {
  contextKey: string | null
  requestId: number
  status: 'idle' | 'pending' | 'success' | 'error'
  items: DocumentSuggestion[]
}

const editorAssistBlockTypes = new Set(['paragraph', 'quote', 'heading-1', 'heading-2', 'heading-3',
  'heading-4', 'heading-5', 'heading-6', 'todo', 'numbered-todo', 'bulleted-list', 'numbered-list', 'callout', 'toggle'])

export function useEditorAssistState({
  activeBlockIndex,
  activeCursorPosition,
  blockTextareaRefs,
  draftBlocks,
  isEditing,
  selectedDocumentId,
  selectedDocumentPresent,
  setActiveBlockIndex,
  setActiveCursorPosition,
  setDraftBlocks,
  uiLanguage
}: UseEditorAssistStateParams) {
  const [selectedSlashCommandIndex, setSelectedSlashCommandIndex] = useState(0)
  const [linkSuggestionState, setLinkSuggestionState] = useState<LinkSuggestionState>({
    contextKey: null, requestId: 0, status: 'idle', items: []
  })
  const [linkSuggestionRetryRevision, setLinkSuggestionRetryRevision] = useState(0)
  const linkSuggestionRequestId = useRef(0)
  const currentLinkSuggestionContextKey = useRef<string | null>(null)
  const linkSuggestionTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingLinkFocus = useRef<{ index: number; documentId: string | null; content: string; position: number } | null>(null)

  const captureBlockCursor = useCallback((index: number, element: HTMLTextAreaElement) => {
    setActiveBlockIndex(index)
    setActiveCursorPosition(element.selectionStart ?? element.value.length)
  }, [setActiveBlockIndex, setActiveCursorPosition])

  useLayoutEffect(() => {
    const pending = pendingLinkFocus.current
    if (!pending) return
    if (pending.documentId !== selectedDocumentId) { pendingLinkFocus.current = null; return }
    const textarea = blockTextareaRefs.current[pending.index]
    if (!textarea || textarea.value !== pending.content) return
    pendingLinkFocus.current = null
    textarea.focus()
    textarea.setSelectionRange(pending.position, pending.position)
    captureBlockCursor(pending.index, textarea)
  })

  const activeBlock = activeBlockIndex !== null ? draftBlocks[activeBlockIndex] : undefined
  const activeAssistBlock = isEditing && selectedDocumentPresent && selectedDocumentId && activeBlock
    && editorAssistBlockTypes.has(activeBlock.type) ? activeBlock : null
  const activeLinkContext = useMemo(() => {
    return activeAssistBlock ? getOpenLinkContext(activeAssistBlock.content, activeCursorPosition) : null
  }, [activeAssistBlock, activeCursorPosition])

  const linkSuggestionQuery = activeLinkContext?.query ?? ''
  const linkSuggestionContextKey = activeLinkContext && activeAssistBlock
    ? JSON.stringify([selectedDocumentId, activeAssistBlock.id ?? null, activeBlockIndex, activeLinkContext.start, linkSuggestionQuery])
    : null
  const hasCurrentLinkSuggestionState = linkSuggestionState.contextKey === linkSuggestionContextKey
    && linkSuggestionState.requestId === linkSuggestionRequestId.current
  const linkSuggestions = hasCurrentLinkSuggestionState && linkSuggestionState.status === 'success'
    ? linkSuggestionState.items : []
  const linkSuggestionsLoading = linkSuggestionContextKey !== null
    && (!hasCurrentLinkSuggestionState || linkSuggestionState.status === 'pending')
  const linkSuggestionsError = hasCurrentLinkSuggestionState && linkSuggestionState.status === 'error'
    ? (uiLanguage === 'zh-CN' ? '无法加载文档建议，请重试。' : 'Could not load document suggestions. Please retry.')
    : null
  const suggestionsCleared = hasCurrentLinkSuggestionState && linkSuggestionState.status === 'idle'
  const blockSuggestions = useMemo(() => {
    if (!linkSuggestionContextKey || suggestionsCleared) return []
    const query = linkSuggestionQuery.toLowerCase()
    return (query
      ? draftBlocks.filter(block => block.content.toLowerCase().includes(query) || block.type.toLowerCase().includes(query))
      : draftBlocks).slice(0, 5)
  }, [draftBlocks, linkSuggestionContextKey, linkSuggestionQuery, suggestionsCleared])

  const clearEditorAssistSuggestions = useCallback(() => {
    const requestId = ++linkSuggestionRequestId.current
    if (linkSuggestionTimer.current !== null) clearTimeout(linkSuggestionTimer.current)
    linkSuggestionTimer.current = null
    setLinkSuggestionState({ contextKey: currentLinkSuggestionContextKey.current, requestId, status: 'idle', items: [] })
  }, [])

  const retryLinkSuggestions = useCallback(() => {
    if (!linkSuggestionContextKey || currentLinkSuggestionContextKey.current !== linkSuggestionContextKey
      || linkSuggestionState.requestId !== linkSuggestionRequestId.current) return
    const requestId = ++linkSuggestionRequestId.current
    if (linkSuggestionTimer.current !== null) clearTimeout(linkSuggestionTimer.current)
    linkSuggestionTimer.current = null
    setLinkSuggestionState({ contextKey: linkSuggestionContextKey, requestId, status: 'pending', items: [] })
    setLinkSuggestionRetryRevision(previous => previous + 1)
  }, [linkSuggestionContextKey, linkSuggestionState.requestId])

  useLayoutEffect(() => {
    const requestId = ++linkSuggestionRequestId.current
    currentLinkSuggestionContextKey.current = linkSuggestionContextKey
    setLinkSuggestionState({ contextKey: linkSuggestionContextKey, requestId,
      status: linkSuggestionContextKey ? 'pending' : 'idle', items: [] })
    const isCurrentRequest = () => linkSuggestionRequestId.current === requestId
      && currentLinkSuggestionContextKey.current === linkSuggestionContextKey

    if (linkSuggestionContextKey) {
      linkSuggestionTimer.current = setTimeout(() => {
        linkSuggestionTimer.current = null
        if (!isCurrentRequest()) return
        void (async () => {
          try {
            const items = await window.knowbook.getDocumentSuggestions(linkSuggestionQuery, selectedDocumentId)
            if (isCurrentRequest()) setLinkSuggestionState({ contextKey: linkSuggestionContextKey, requestId, status: 'success', items })
          } catch {
            if (isCurrentRequest()) setLinkSuggestionState({ contextKey: linkSuggestionContextKey, requestId, status: 'error', items: [] })
          }
        })()
      }, 120)
    }

    return () => {
      ++linkSuggestionRequestId.current
      currentLinkSuggestionContextKey.current = null
      if (linkSuggestionTimer.current !== null) clearTimeout(linkSuggestionTimer.current)
      linkSuggestionTimer.current = null
    }
  }, [linkSuggestionContextKey, linkSuggestionQuery, selectedDocumentId, linkSuggestionRetryRevision])

  const insertAssistReplacement = useCallback((replacement: string) => {
    if (activeBlockIndex === null || !activeLinkContext || !linkSuggestionContextKey
      || currentLinkSuggestionContextKey.current !== linkSuggestionContextKey
      || linkSuggestionState.requestId !== linkSuggestionRequestId.current) {
      return
    }

    const current = draftBlocks[activeBlockIndex]
    if (!current) return
    pendingLinkFocus.current = {
      index: activeBlockIndex, documentId: selectedDocumentId,
      content: `${current.content.slice(0, activeLinkContext.start)}${replacement}${current.content.slice(activeCursorPosition)}`,
      position: activeLinkContext.start + replacement.length
    }

    setDraftBlocks((previous) =>
      previous.map((block, index) => {
        if (index !== activeBlockIndex) {
          return block
        }

        return {
          ...block,
          content: `${block.content.slice(0, activeLinkContext.start)}${replacement}${block.content.slice(activeCursorPosition)}`
        }
      })
    )
    setActiveCursorPosition(activeLinkContext.start + replacement.length)
    clearEditorAssistSuggestions()
  }, [
    activeBlockIndex,
    activeCursorPosition,
    activeLinkContext,
    clearEditorAssistSuggestions,
    draftBlocks,
    linkSuggestionContextKey,
    linkSuggestionState.requestId,
    selectedDocumentId,
    setActiveCursorPosition,
    setDraftBlocks
  ])

  const insertLinkSuggestion = useCallback((suggestion: DocumentSuggestion) => {
    if (linkSuggestionState.status !== 'success' || linkSuggestionState.contextKey !== linkSuggestionContextKey
      || !linkSuggestions.some(item => item.id === suggestion.id && item.path === suggestion.path)) return
    insertAssistReplacement(`[[${suggestion.path}]]`)
  }, [insertAssistReplacement, linkSuggestionContextKey, linkSuggestionState, linkSuggestions])

  const insertBlockSuggestion = useCallback((block: DocumentBlockDraft) => {
    if (!block.id) {
      return
    }

    insertAssistReplacement(`[[${block.id}]]`)
  }, [insertAssistReplacement])

  const activeSlashContext = useMemo(() => {
    if (activeLinkContext || !activeAssistBlock) {
      return null
    }

    return getSlashCommandContext(activeAssistBlock.content, activeCursorPosition)
  }, [activeAssistBlock, activeCursorPosition, activeLinkContext])

  const slashContextKey = activeSlashContext && activeAssistBlock
    ? JSON.stringify([selectedDocumentId, activeAssistBlock.id ?? null, activeBlockIndex, activeSlashContext.start, uiLanguage])
    : null
  const { commands: blockSlashCommands, loading: slashCommandsLoading, error: slashCommandsError,
    retry: retrySlashCommands } = useSlashCommandCatalog(uiLanguage, slashContextKey)

  const filteredSlashCommands = useMemo(() => {
    if (!activeSlashContext || !activeAssistBlock) return []
    const availableCommands = blockSlashCommands.filter(command =>
      command.kind !== 'action' || command.action !== 'insert-child'
      || (canBlockOwnChildren(activeAssistBlock.type) && activeAssistBlock.depth < 6))
    const query = activeSlashContext.query.trim().toLowerCase()
    if (!query) {
      return availableCommands
    }

    return availableCommands.filter((command) => {
      return [command.id, command.label, ...command.keywords]
        .join(' ')
        .toLowerCase()
        .includes(query)
    }).sort((first, second) => Number(second.id === query) - Number(first.id === query))
  }, [activeAssistBlock, activeSlashContext, blockSlashCommands])

  const activeSlashCommand = filteredSlashCommands[selectedSlashCommandIndex] ?? filteredSlashCommands[0] ?? null

  useEffect(() => {
    if (!activeSlashContext || filteredSlashCommands.length === 0) {
      setSelectedSlashCommandIndex(0)
      return
    }

    setSelectedSlashCommandIndex(0)
  }, [activeBlockIndex, activeSlashContext?.query, filteredSlashCommands.length])

  const slashPanelPos = useMemo(() => {
    if (!activeSlashContext || activeBlockIndex === null) {
      return null
    }

    const textarea = blockTextareaRefs.current[activeBlockIndex]
    if (!textarea) {
      return null
    }

    const rect = textarea.getBoundingClientRect()
    const computedStyle = window.getComputedStyle(textarea)
    const lines = textarea.value.substring(0, activeCursorPosition).split('\n')
    const currentLine = lines.length - 1

    return computeSlashPanelPosition(rect, computedStyle.lineHeight, computedStyle.fontSize, lines[currentLine])
  }, [activeBlockIndex, activeCursorPosition, activeSlashContext, blockTextareaRefs])

  return {
    activeLinkContext,
    activeSlashCommand,
    activeSlashContext,
    blockSuggestions,
    captureBlockCursor,
    clearEditorAssistSuggestions,
    filteredSlashCommands,
    slashCommandsLoading,
    slashCommandsError,
    retrySlashCommands,
    insertBlockSuggestion,
    insertLinkSuggestion,
    linkSuggestionContextKey,
    linkSuggestions,
    linkSuggestionsLoading,
    linkSuggestionsError,
    retryLinkSuggestions,
    selectedSlashCommandIndex,
    setSelectedSlashCommandIndex,
    slashPanelPos
  }
}
