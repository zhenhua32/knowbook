import { useEffect, useMemo, useState } from 'react'
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
  selectedDocumentPresent
}: UseEditorAssistStateParams<TSlashCommand>) {
  const [selectedSlashCommandIndex, setSelectedSlashCommandIndex] = useState(0)
  const [linkSuggestions, setLinkSuggestions] = useState<DocumentSuggestion[]>([])
  const [blockSuggestions, setBlockSuggestions] = useState<DocumentBlockDraft[]>([])

  const clearEditorAssistSuggestions = () => {
    setLinkSuggestions([])
    setBlockSuggestions([])
  }

  const activeLinkContext = useMemo(() => {
    return activeBlockIndex !== null
      ? getOpenLinkContext(draftBlocks[activeBlockIndex]?.content ?? '', activeCursorPosition)
      : null
  }, [activeBlockIndex, activeCursorPosition, draftBlocks, getOpenLinkContext])

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
    clearEditorAssistSuggestions,
    filteredSlashCommands,
    linkSuggestions,
    selectedSlashCommandIndex,
    setSelectedSlashCommandIndex,
    slashPanelPos
  }
}