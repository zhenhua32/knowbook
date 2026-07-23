import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { DocumentBlockDraft, DocumentSuggestion } from '@shared/contracts'
import { getUiText, type UiLanguage } from '../i18n'

type LinkContext = {
  query: string
  start: number
}

type SlashCommandContext = {
  query: string
  start: number
}

type BlockSlashCommand = {
  id: string
  label: string
  description: string
  keywords: string[]
} & (
  | {
      kind: 'type'
      type: DocumentBlockDraft['type']
    }
  | {
      kind: 'action'
      action: 'insert-above' | 'insert-below' | 'insert-child' | 'move-up' | 'move-down' | 'indent' | 'outdent' | 'duplicate' | 'delete'
    }
)

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
  const [linkSuggestions, setLinkSuggestions] = useState<DocumentSuggestion[]>([])
  const [blockSuggestions, setBlockSuggestions] = useState<DocumentBlockDraft[]>([])
  const blockSlashCommands = useMemo(() => buildBlockSlashCommands(uiLanguage), [uiLanguage])

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
    }).catch((error) => {
      if (mounted) {
        setLinkSuggestions([])
        console.warn('Failed to load document link suggestions.', error)
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

function getOpenLinkContext(content: string, cursorPosition: number): LinkContext | null {
  const safeCursor = Math.max(0, Math.min(cursorPosition, content.length))
  const beforeCursor = content.slice(0, safeCursor)
  const start = beforeCursor.lastIndexOf('[[')

  if (start === -1) {
    return null
  }

  const openSegment = beforeCursor.slice(start + 2)
  if (openSegment.includes(']]') || openSegment.includes('\n')) {
    return null
  }

  return {
    query: openSegment.trim(),
    start
  }
}

function getSlashCommandContext(content: string, cursorPosition: number): SlashCommandContext | null {
  const safeCursor = Math.max(0, Math.min(cursorPosition, content.length))
  const beforeCursor = content.slice(0, safeCursor)
  const lineStart = beforeCursor.lastIndexOf('\n') + 1
  const lineBeforeCursor = beforeCursor.slice(lineStart)
  const trimmedStart = lineBeforeCursor.trimStart()

  if (!trimmedStart.startsWith('/')) {
    return null
  }

  if (trimmedStart.includes(' ')) {
    return null
  }

  return {
    query: trimmedStart.slice(1),
    start: lineStart + lineBeforeCursor.indexOf('/')
  }
}

function buildBlockSlashCommands(language: UiLanguage): BlockSlashCommand[] {
  const ui = getUiText(language)

  return [
    {
      id: 'text',
      label: ui.blockTypeOptions.paragraph,
      description: language === 'zh-CN' ? '把当前块转换为普通段落。' : 'Convert the current block into a plain paragraph.',
      keywords: ['paragraph', 'plain', 'p', 'text', '文本', '段落'],
      kind: 'type',
      type: 'paragraph'
    },
    {
      id: 'h1',
      label: ui.blockTypeOptions['heading-1'],
      description: language === 'zh-CN' ? '把当前块提升为一级标题。' : 'Promote this block to a top-level heading.',
      keywords: ['title', 'heading-1', 'header', '标题', '一级'],
      kind: 'type',
      type: 'heading-1'
    },
    {
      id: 'h2',
      label: ui.blockTypeOptions['heading-2'],
      description: language === 'zh-CN' ? '把当前块转换为二级标题。' : 'Convert this block to a section heading.',
      keywords: ['subtitle', 'heading-2', 'section', '标题', '二级'],
      kind: 'type',
      type: 'heading-2'
    },
    {
      id: 'todo',
      label: ui.blockTypeOptions.todo,
      description: language === 'zh-CN' ? '把当前块转换为未勾选的待办项。' : 'Turn this block into an unchecked todo item.',
      keywords: ['task', 'checkbox', 'checklist', 'todo', '待办'],
      kind: 'type',
      type: 'todo'
    },
    {
      id: 'code',
      label: ui.blockTypeOptions.code,
      description: language === 'zh-CN' ? '把当前块切换成代码块。' : 'Switch this block into a code block.',
      keywords: ['snippet', 'pre', 'terminal', 'code', '代码'],
      kind: 'type',
      type: 'code'
    },
    {
      id: 'math',
      label: ui.blockTypeOptions.math,
      description: language === 'zh-CN' ? '把当前块渲染为 KaTeX 公式。' : 'Render this block as a KaTeX display equation.',
      keywords: ['latex', 'equation', 'formula', 'katex', '公式'],
      kind: 'type',
      type: 'math'
    },
    {
      id: 'quote',
      label: ui.blockTypeOptions.quote,
      description: language === 'zh-CN' ? '把当前块转换为引用块。' : 'Convert this block into a quoted callout.',
      keywords: ['blockquote', 'callout', 'cite', 'quote', '引用'],
      kind: 'type',
      type: 'quote'
    },
    {
      id: 'bullet',
      label: ui.blockTypeOptions['bulleted-list'],
      description: language === 'zh-CN' ? '把当前块转换为无序列表项。' : 'Turn this block into a bulleted list item.',
      keywords: ['unordered', 'list', 'dash', 'bullet', '列表', '无序'],
      kind: 'type',
      type: 'bulleted-list'
    },
    {
      id: 'numbered',
      label: ui.blockTypeOptions['numbered-list'],
      description: language === 'zh-CN' ? '把当前块转换为有序列表项。' : 'Turn this block into an ordered list item.',
      keywords: ['ordered', 'list', 'number', '列表', '有序'],
      kind: 'type',
      type: 'numbered-list'
    },
    {
      id: 'divider',
      label: ui.blockTypeOptions.divider,
      description: language === 'zh-CN' ? '插入一个水平分隔线块。' : 'Insert a horizontal divider block.',
      keywords: ['separator', 'rule', 'hr', 'divider', '分隔线'],
      kind: 'type',
      type: 'divider'
    },
    {
      id: 'above',
      label: language === 'zh-CN' ? '在上方插入' : 'Insert Above',
      description: language === 'zh-CN' ? '在当前块上方插入一个同级块。' : 'Insert a new sibling block above the current block.',
      keywords: ['insert', 'before', 'up', '上方', '插入'],
      kind: 'action',
      action: 'insert-above'
    },
    {
      id: 'below',
      label: language === 'zh-CN' ? '在下方插入' : 'Insert Below',
      description: language === 'zh-CN' ? '在当前块下方插入一个同级块。' : 'Insert a new sibling block below the current block.',
      keywords: ['insert', 'after', 'down', '下方', '插入'],
      kind: 'action',
      action: 'insert-below'
    },
    {
      id: 'child',
      label: language === 'zh-CN' ? '插入子块' : 'Insert Child',
      description: language === 'zh-CN' ? '在当前子树下方插入一个嵌套子块。' : 'Insert a nested child block below the current subtree.',
      keywords: ['child', 'sub-block', 'nested', 'descendant', '子块', '嵌套'],
      kind: 'action',
      action: 'insert-child'
    },
    {
      id: 'up',
      label: ui.moveUp,
      description: language === 'zh-CN' ? '把当前块子树移动到上一个同级子树之前。' : 'Move the current block subtree above the previous sibling subtree.',
      keywords: ['reorder', 'before', 'raise', '上移', '移动'],
      kind: 'action',
      action: 'move-up'
    },
    {
      id: 'down',
      label: ui.moveDown,
      description: language === 'zh-CN' ? '把当前块子树移动到下一个同级子树之后。' : 'Move the current block subtree below the next sibling subtree.',
      keywords: ['reorder', 'after', 'lower', '下移', '移动'],
      kind: 'action',
      action: 'move-down'
    },
    {
      id: 'indent',
      label: language === 'zh-CN' ? '增加缩进' : 'Indent Block',
      description: language === 'zh-CN' ? '增加待办和列表块的嵌套层级。' : 'Increase nesting for todo and list blocks.',
      keywords: ['nest', 'tab', 'right', 'depth', '缩进', '嵌套'],
      kind: 'action',
      action: 'indent'
    },
    {
      id: 'outdent',
      label: language === 'zh-CN' ? '减少缩进' : 'Outdent Block',
      description: language === 'zh-CN' ? '降低待办和列表块的嵌套层级。' : 'Decrease nesting for todo and list blocks.',
      keywords: ['shift-tab', 'left', 'unnest', 'depth', '取消缩进', '提升'],
      kind: 'action',
      action: 'outdent'
    },
    {
      id: 'duplicate',
      label: ui.duplicate,
      description: language === 'zh-CN' ? '在原块下方复制一份当前块子树。' : 'Clone the current block subtree below the original.',
      keywords: ['copy', 'clone', 'repeat', '复制', '克隆'],
      kind: 'action',
      action: 'duplicate'
    },
    {
      id: 'delete',
      label: ui.common.delete,
      description: language === 'zh-CN' ? '删除当前块子树。' : 'Remove the current block subtree.',
      keywords: ['remove', 'trash', 'del', 'delete', '删除'],
      kind: 'action',
      action: 'delete'
    }
  ]
}
