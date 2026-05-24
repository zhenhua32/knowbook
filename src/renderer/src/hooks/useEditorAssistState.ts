import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { DocumentBlockDraft, DocumentSuggestion } from '@shared/contracts'

type LinkContext = {
  query: string
  start: number
}

type SlashCommandContext = {
  query: string
  start: number
}

type SlashCommandLike = {
  id: string
  label: string
  description: string
  keywords: string[]
}

type UseEditorAssistStateParams<TSlashCommand extends SlashCommandLike> = {
  activeBlockIndex: number | null
  activeCursorPosition: number
  blockSlashCommands: TSlashCommand[]
  blockTextareaRefs: { current: Array<HTMLTextAreaElement | null> }
  draftBlocks: DocumentBlockDraft[]
  getOpenLinkContext: (content: string, cursorPosition: number) => LinkContext | null
  getSlashCommandContext: (content: string, cursorPosition: number) => SlashCommandContext | null
  isEditing: boolean
  selectedDocumentId: string | null
  selectedDocumentPresent: boolean
  setActiveBlockIndex: Dispatch<SetStateAction<number | null>>
  setActiveCursorPosition: Dispatch<SetStateAction<number>>
  setDraftBlocks: Dispatch<SetStateAction<DocumentBlockDraft[]>>
}

export function useEditorAssistState<TSlashCommand extends SlashCommandLike>({
  activeBlockIndex,
  activeCursorPosition,
  blockSlashCommands,
  blockTextareaRefs,
  draftBlocks,
  getOpenLinkContext,
  getSlashCommandContext,
  isEditing,
  selectedDocumentId,
  selectedDocumentPresent,
  setActiveBlockIndex,
  setActiveCursorPosition,
  setDraftBlocks
}: UseEditorAssistStateParams<TSlashCommand>) {
  const [selectedSlashCommandIndex, setSelectedSlashCommandIndex] = useState(0)
  const [linkSuggestions, setLinkSuggestions] = useState<DocumentSuggestion[]>([])
  const [blockSuggestions, setBlockSuggestions] = useState<DocumentBlockDraft[]>([])

  const clearEditorAssistSuggestions = useCallback(() => {
    setLinkSuggestions([])
    setBlockSuggestions([])
  }, [])

  const captureBlockCursor = useCallback((index: number, element: HTMLTextAreaElement) => {
    setActiveBlockIndex(index)
    setActiveCursorPosition(element.selectionStart ?? element.value.length)
  }, [setActiveBlockIndex, setActiveCursorPosition])

  const activeLinkContext = useMemo(() => {
    return activeBlockIndex !== null
      ? getOpenLinkContext(draftBlocks[activeBlockIndex]?.content ?? '', activeCursorPosition)
      : null
  }, [activeBlockIndex, activeCursorPosition, draftBlocks, getOpenLinkContext])

  const insertAssistReplacement = useCallback((replacement: string) => {
    if (activeBlockIndex === null || !activeLinkContext) {
      return
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
    setActiveCursorPosition,
    setDraftBlocks
  ])

  const insertLinkSuggestion = useCallback((suggestion: DocumentSuggestion) => {
    insertAssistReplacement(`[[${suggestion.path}]]`)
  }, [insertAssistReplacement])

  const insertBlockSuggestion = useCallback((block: DocumentBlockDraft) => {
    if (!block.id) {
      return
    }

    insertAssistReplacement(`[[${block.id}]]`)
  }, [insertAssistReplacement])

  const activeSlashContext = useMemo(() => {
    if (activeLinkContext || activeBlockIndex === null) {
      return null
    }

    return getSlashCommandContext(draftBlocks[activeBlockIndex]?.content ?? '', activeCursorPosition)
  }, [activeBlockIndex, activeCursorPosition, activeLinkContext, draftBlocks, getSlashCommandContext])

  const filteredSlashCommands = useMemo(() => {
    const query = activeSlashContext?.query.trim().toLowerCase() ?? ''
    if (!query) {
      return blockSlashCommands
    }

    return blockSlashCommands.filter((command) => {
      return [command.id, command.label, ...command.keywords]
        .join(' ')
        .toLowerCase()
        .includes(query)
    })
  }, [activeSlashContext, blockSlashCommands])

  const activeSlashCommand = filteredSlashCommands[selectedSlashCommandIndex] ?? filteredSlashCommands[0] ?? null

  useEffect(() => {
    if (!activeSlashContext || filteredSlashCommands.length === 0) {
      setSelectedSlashCommandIndex(0)
      return
    }

    setSelectedSlashCommandIndex((previous) => Math.min(previous, filteredSlashCommands.length - 1))
  }, [activeBlockIndex, activeSlashContext?.query, filteredSlashCommands.length])

  useEffect(() => {
    if (!isEditing || !activeLinkContext) {
      clearEditorAssistSuggestions()
      return
    }

    let mounted = true

    window.knowbook.getDocumentSuggestions(activeLinkContext.query, selectedDocumentId).then((suggestions) => {
      if (mounted) {
        setLinkSuggestions(suggestions)
      }
    })

    if (selectedDocumentPresent) {
      const query = activeLinkContext.query.trim().toLowerCase()
      const blockSuggs = !query || draftBlocks.length === 0
        ? draftBlocks.slice(0, 5)
        : draftBlocks.filter((block) => {
          const content = block.content.toLowerCase()
          const type = block.type.toLowerCase()
          return content.includes(query) || type.includes(query)
        }).slice(0, 5)

      if (mounted) {
        setBlockSuggestions(blockSuggs)
      }
    }

    return () => {
      mounted = false
    }
  }, [activeLinkContext, draftBlocks, isEditing, selectedDocumentId, selectedDocumentPresent])

  const slashPanelPos = useMemo(() => {
    if (!activeSlashContext || activeBlockIndex === null) {
      return null
    }

    const textarea = blockTextareaRefs.current[activeBlockIndex]
    if (!textarea) {
      return null
    }

    const rect = textarea.getBoundingClientRect()
    const lineHeight = parseInt(window.getComputedStyle(textarea).lineHeight)
    const lines = textarea.value.substring(0, activeCursorPosition).split('\n')
    const currentLine = lines.length - 1
    const offsetX = lines[currentLine].length * 8

    return {
      x: rect.left + offsetX,
      y: rect.top + currentLine * lineHeight + lineHeight + 10
    }
  }, [activeBlockIndex, activeCursorPosition, activeSlashContext, blockTextareaRefs])

  return {
    activeLinkContext,
    activeSlashCommand,
    activeSlashContext,
    blockSuggestions,
    captureBlockCursor,
    clearEditorAssistSuggestions,
    filteredSlashCommands,
    insertBlockSuggestion,
    insertLinkSuggestion,
    linkSuggestions,
    selectedSlashCommandIndex,
    setSelectedSlashCommandIndex,
    slashPanelPos
  }
}