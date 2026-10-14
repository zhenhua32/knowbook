import { lazy, Suspense, useContext, useLayoutEffect, useRef, useState } from 'react'
import { Fragment, Slice, type Node as RichNode } from 'prosemirror-model'
import { EditorState, NodeSelection, Plugin, Selection, TextSelection, type Command, type Transaction } from 'prosemirror-state'
import { Decoration, DecorationSet, EditorView } from 'prosemirror-view'
import { createRoot, type Root } from 'react-dom/client'
import { createPortal } from 'react-dom'
import { MarkdownBlockNodesContext, MarkdownDocumentContext } from '../components/MarkdownDocumentContext'
import { baseKeymap, chainCommands, createParagraphNear, splitBlockAs, toggleMark } from 'prosemirror-commands'
import { keymap } from 'prosemirror-keymap'
import { InputRule, inputRules } from 'prosemirror-inputrules'
import type { DocumentBlockDraft } from '@shared/contracts'
import { markdownEngine, type MarkdownEnvironment } from '@shared/markdownEngine'
import { serializeBlocksToMarkdown } from '@shared/markdown'
import { htmlClipboardToMarkdown } from '@shared/htmlClipboard'
import { draftBlocksToRichDoc, reconcileRichTextBlockIds, richDocToDraftBlocks } from './model'
import { richTextSchema } from './schema'
import { registerRichTextHistoryBridge } from './history'
import { planRichTextTreePaste } from './paste'
import { planMarkdownImageDisplays, replaceMarkdownImageOccurrence } from '@shared/markdownMediaOccurrences'
import { captureAsyncHistoryFocusPermission, type EditorHistoryBookmark } from '../utils/editorHistoryFocus'
import { areDocumentDraftBlocksEqual } from '../utils/documentDraftComparison'
import { createColdBlockPopup } from '../utils/coldBlockPopup'
import { createDraftBlockId } from '../utils/draftTreeFragment'
import { normalizeDraftBlocks } from '../utils/draftTreeNormalization'
import { getMarkdownShortcut, parsePastedMarkdown } from '../utils/markdownInput'
import { isImeKeyboardEvent } from '../utils/imeKeyboard'
import { attachmentMarkdown } from '@shared/attachments'
import { importAttachmentFiles } from '../utils/attachments'
import { prepareDraftBlockTypeChange } from '../utils/draftTreeTextEditing'
import { isContainerBlockType } from '@shared/blockTypes'
import { normalizeMarkdownFormat } from '@shared/markdownFormat'
import { BLOCK_CONVERSION_TYPES } from '../utils/blockConversionTypes'
import { nativeContainerPresentation } from '../utils/nativeContainerPresentation'
import { toBlockRichMediaPreviewUrl } from '../utils/blockRichMedia'
import { INLINE_TEXT_COLORS, type InlineTextColor } from '@shared/inlineTextPresentation'
import { selectedRichTextColor, setRichTextColor } from './presentation'
import './rich-text.css'
import '../styles/inline-text-presentation.css'

const NativeContainerControls = lazy(() => import('../components/NativeContainerControls').then(module => ({ default: module.NativeContainerControls })))
const NativeContainerStyle = lazy(() => import('../components/NativeContainerStyle'))
const MarkdownTableEditor = lazy(() => import('../components/MarkdownTableEditor').then(module => ({ default: module.MarkdownTableEditor })))

type Props = {
  blocks: DocumentBlockDraft[]
  visibleIndices: number[]
  documentId: string
  isZh: boolean
  references?: MarkdownEnvironment['references']
  onChange: (blocks: DocumentBlockDraft[]) => void
  checkpoint: () => void
  onUndo: () => void
  onRedo: () => void
  onEditSource: () => void
  onRevealBlock: (id: string) => void
  onOpenBlockActions?: (request: { blockIds: string[]; x: number; y: number }) => void
  collapsedBlockIds?: Set<string>
  onToggleCollapse?: (id: string) => void
  onAddContainerChild?: (id: string, type: typeof BLOCK_CONVERSION_TYPES[number]) => string | void
}

export function richTextSelectionBlockIds(state: EditorState): string[] {
  const { selection } = state, ids: string[] = []
  state.doc.forEach((node, position) => {
    const id = node.attrs.block?.id
    if (!id) return
    if (selection.empty ? selection.from >= position && selection.from <= position + node.nodeSize
      : selection.from < position + node.nodeSize && selection.to > position
        && !(node.type === richTextSchema.nodes.text_block && selection.to === position + 1)) ids.push(id)
  })
  return ids
}

type Endpoint = NonNullable<EditorHistoryBookmark['richText']>['anchor']
function endpoint(doc: RichNode, position: number): Endpoint {
  let result: Endpoint = { index: 0, offset: 0 }
  doc.forEach((node, offset, index) => {
    if (position >= offset && position <= offset + node.nodeSize) {
      result = { blockId: node.attrs.block?.id, index, offset: Math.max(0, Math.min(node.content.size, position - offset - 1)) }
    }
  })
  return result
}
function positionOf(doc: RichNode, point: Endpoint): number {
  let result = 1, matched = false
  doc.forEach((node, offset, index) => {
    if ((!matched && index === point.index) || (point.blockId && node.attrs.block?.id === point.blockId)) {
      result = offset + 1 + Math.min(point.offset, node.content.size)
      if (point.blockId && node.attrs.block?.id === point.blockId) matched = true
    }
  })
  return Math.min(result, doc.content.size)
}
function sliceMarkdown(slice: Slice): string {
  return serializeBlocksToMarkdown(richDocToDraftBlocks(richTextSchema.nodes.doc.create(null, slice.content)))
}

function clipboardHtml(markdown: string): string {
  const environment: MarkdownEnvironment = {}
  const tokens = markdownEngine.parse(markdown, environment)
  const html = markdownEngine.renderer.render(tokens, markdownEngine.options, environment)
  // Only strict parsed container/layout tokens claim the existing source-copy
  // fallback. Literal fenced examples and external HTML keep their old path.
  const nativeSource = tokens.some(token => token.type === 'native_container_open' && Boolean(token.meta?.nativeContainer)
    || token.type === 'knowbook_table_layout' && token.meta?.boundTableLayout === true)
  return nativeSource ? `<div data-knowbook-markdown-source="true">${html}</div>` : html
}

const types: readonly string[] = BLOCK_CONVERSION_TYPES
const labelsZh = ['正文', '标题 1', '标题 2', '标题 3', '标题 4', '标题 5', '标题 6', '待办', '有序待办', '代码', '公式', '引用', '无序列表', '有序列表', '表格', '分割线', '提示块', '折叠块']
const labelsEn = ['Text', 'Heading 1', 'Heading 2', 'Heading 3', 'Heading 4', 'Heading 5', 'Heading 6', 'To-do', 'Numbered to-do', 'Code', 'Math', 'Quote', 'Bullet list', 'Numbered list', 'Table', 'Divider', 'Callout', 'Toggle']

export function DocumentRichTextEditor(props: Props) {
  const mount = useRef<HTMLDivElement>(null), viewRef = useRef<EditorView | null>(null)
  const latest = useRef(props), emitted = useRef<DocumentBlockDraft[]>(props.blocks)
  latest.current = props
  const [revision, setRevision] = useState(0)
  const [message, setMessage] = useState('')
  const [linkUrl, setLinkUrl] = useState<string | null>(null)
  const [palette, setPalette] = useState<'textColor' | 'backgroundColor' | null>(null)
  const [tableHosts, setTableHosts] = useState<Array<{ id: string; dom: HTMLElement; node: () => RichNode; position: () => number | undefined }>>([])
  const markdownDocument = useContext(MarkdownDocumentContext)
  const paletteRef = useRef(palette)
  paletteRef.current = palette
  const linkSelection = useRef<{ from: number; to: number; doc: RichNode } | null>(null)
  const [slashIndex, setSlashIndex] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState<string | null>(null)
  const boundary = useRef(false), importing = useRef(false)
  const pendingSelection = useRef<EditorHistoryBookmark | null>(null)
  const pendingChildFocus = useRef<{ editor: EditorView; documentId: string; id?: string; parentId: string; type: string;
    before: DocumentBlockDraft[]; permission: ReturnType<typeof captureAsyncHistoryFocusPermission> } | null>(null)
  const parkedFoldSelection = useRef<{ doc: RichNode; anchor: Endpoint; head: Endpoint; fallback: { anchor: Endpoint; head: Endpoint } } | null>(null)
  const sourceRefresh = useRef(new Set<() => void>())
  const pendingContextMenu = useRef<(() => void) | null>(null)
  const view = viewRef.current
  const selection = view?.state.selection
  const currentBlock = selection && view ? view.state.doc.child(Math.min(selection.$from.index(0), view.state.doc.childCount - 1)).attrs.block as DocumentBlockDraft | undefined : undefined
  const currentType = currentBlock?.type ?? 'paragraph'
  const currentText = selection?.$from.parent.textContent ?? ''
  const slashMatch = selection?.empty ? /^\/([^\s]*)$/.exec(currentText) : null
  const slashQuery = slashMatch?.[1].toLowerCase()
  const slashCommands = slashQuery === undefined || slashDismissed === currentText ? []
    : types.map((type, index) => ({ type, label: (props.isZh ? labelsZh : labelsEn)[index] }))
      .filter(item => `${item.type} ${item.label}`.toLowerCase().includes(slashQuery))
  const slashRef = useRef({ commands: slashCommands, index: slashIndex })
  slashRef.current = { commands: slashCommands, index: Math.min(slashIndex, Math.max(0, slashCommands.length - 1)) }
  void revision

  const cancelChildFocus = () => {
    pendingChildFocus.current?.permission.dispose()
    pendingChildFocus.current = null
  }
  const focusAddedChild = (readyId?: string, readyCell?: HTMLElement | null) => {
    const request = pendingChildFocus.current, editor = viewRef.current, current = latest.current
    if (!request || !request.id || readyId && readyId !== request.id) return
    if (editor !== request.editor || current.documentId !== request.documentId || editor.composing || !request.permission.canRestore()) { cancelChildFocus(); return }
    const index = current.blocks.findIndex(block => block.id === request.id)
    if (index < 0) {
      if (!areDocumentDraftBlocksEqual(current.blocks, request.before)) cancelChildFocus()
      return
    }
    const child = current.blocks[index]
    if (child.type !== request.type || child.parentBlockId !== request.parentId || !current.visibleIndices.includes(index)
      || !areDocumentDraftBlocksEqual(current.blocks.filter(block => block.id !== request.id), request.before)) { cancelChildFocus(); return }
    let position = -1
    editor.state.doc.forEach((node, offset) => { if (node.attrs.block?.id === request.id) position = offset })
    const node = position >= 0 ? editor.state.doc.nodeAt(position) : null
    if (!node || node.attrs.block?.type !== request.type) return
    const row = editor.nodeDOM(position) as HTMLElement | null
    const cell = readyCell ?? row?.querySelector<HTMLElement>('.markdown-table-editor [data-row="0"][data-column="0"]')
    // A cold, valid table waits for its actual portal mount, never a timed frame.
    if (child.type === 'table' && child.content.trim() && !cell && readyCell === undefined) return
    const source = row?.querySelector<HTMLElement>('[data-rich-source-entry]')
    cancelChildFocus()
    const selection = node.type.name === 'text_block' ? TextSelection.create(editor.state.doc, position + 1) : NodeSelection.create(editor.state.doc, position)
    editor.updateState(editor.state.apply(editor.state.tr.setSelection(selection)))
    if (cell) cell.focus()
    else if (node.type.name === 'source_block' && child.type !== 'divider' && source) source.focus()
    else editor.focus()
    setRevision(value => value + 1)
    current.checkpoint()
  }
  const addContainerChild = (parentId: string, type: typeof BLOCK_CONVERSION_TYPES[number]) => {
    const editor = viewRef.current, current = latest.current
    if (!editor || editor.composing || !current.onAddContainerChild) return
    cancelChildFocus()
    const request = { editor, documentId: current.documentId, parentId, type, before: current.blocks,
      id: undefined as string | undefined, permission: captureAsyncHistoryFocusPermission() }
    pendingChildFocus.current = request
    try {
      request.id = current.onAddContainerChild(parentId, type) || undefined
      if (!request.id) cancelChildFocus()
    } catch (error) { cancelChildFocus(); throw error }
  }

  const openBlockActions = (id: string, x: number, y: number) => {
    const editor = viewRef.current
    if (!editor || editor.composing || !latest.current.onOpenBlockActions) return
    const visible = new Set(latest.current.visibleIndices), visibleIds = new Set<string>()
    editor.state.doc.forEach((node, _position, index) => { if (visible.has(index) && node.attrs.block?.id) visibleIds.add(node.attrs.block.id) })
    if (!visibleIds.has(id)) return
    const selected = richTextSelectionBlockIds(editor.state).filter(blockId => visibleIds.has(blockId))
    latest.current.onOpenBlockActions({ blockIds: selected.includes(id) ? selected : [id], x, y })
  }

  // Chromium may target the first widget for clipboard events on an editor-wide range.
  // Keep body clipboard handlers reachable while retaining a focused control's own boundary.
  const blockActionStopsEvent = (event: Event) => !['copy', 'cut', 'paste'].includes(event.type) || !viewRef.current?.hasFocus()

  const openContextBlockActions = (id: string, x: number, y: number) => {
    const editor = viewRef.current
    if (!editor || editor.composing || !latest.current.onOpenBlockActions) return
    pendingContextMenu.current?.()
    const doc = editor.state.doc, original = editor.state.selection
    const selected = richTextSelectionBlockIds(editor.state)
    const preserveSelection = selected.includes(id) && (selected.length > 1 || !(original instanceof TextSelection))
    const attention = createColdBlockPopup(editor.dom)
    const owner = editor.dom.ownerDocument.defaultView!
    const cancel = () => {
      owner.cancelAnimationFrame(frame)
      attention.dispose()
      if (pendingContextMenu.current === cancel) pendingContextMenu.current = null
    }
    // Chromium can finish placing its native right-click caret after contextmenu.
    // Freeze the bookmark only after that gesture, while recording any later activity.
    const frame = owner.requestAnimationFrame(() => {
      if (viewRef.current !== editor || editor.composing || !editor.state.doc.eq(doc) || attention.vetoed()) { cancel(); return }
      try {
        if (preserveSelection) {
          editor.dispatch(editor.state.tr.setSelection(Selection.fromJSON(editor.state.doc, original.toJSON())))
          editor.focus()
        } else {
          const native = editor.dom.ownerDocument.getSelection()
          if (native?.anchorNode && native.focusNode && editor.dom.contains(native.anchorNode) && editor.dom.contains(native.focusNode)) {
            const anchor = editor.posAtDOM(native.anchorNode, native.anchorOffset)
            const head = editor.posAtDOM(native.focusNode, native.focusOffset)
            const next = TextSelection.between(editor.state.doc.resolve(anchor), editor.state.doc.resolve(head))
            if (!next.eq(editor.state.selection)) editor.dispatch(editor.state.tr.setSelection(next))
          }
        }
      } finally { cancel() }
      openBlockActions(id, x, y)
    })
    pendingContextMenu.current = cancel
  }

  const blockActionButton = (id: string): HTMLButtonElement => {
    const button = document.createElement('button')
    button.type = 'button'; button.className = 'rich-text-block-actions'; button.contentEditable = 'false'
    button.setAttribute('aria-label', latest.current.isZh ? '块操作' : 'Block actions')
    button.addEventListener('mousedown', event => event.preventDefault())
    button.addEventListener('contextmenu', event => {
      event.preventDefault(); event.stopPropagation()
      openContextBlockActions(id, event.clientX, event.clientY)
    })
    button.addEventListener('click', () => {
      const rect = button.getBoundingClientRect()
      openBlockActions(id, rect.left, rect.bottom)
    })
    return button
  }

  const convert = (type: string, removeSlash = false): void => {
    const editor = viewRef.current
    if (!editor || editor.composing) return
    latest.current.checkpoint()
    let tr = editor.state.tr
    if (removeSlash) tr = tr.delete(editor.state.selection.$from.start(), editor.state.selection.$from.end())
    const anchor = endpoint(tr.doc, tr.selection.anchor), head = endpoint(tr.doc, tr.selection.head)
    let blocks = richDocToDraftBlocks(tr.doc)
    const selected = richTextSelectionBlockIds(EditorState.create({ doc: tr.doc, selection: tr.selection }))
      .filter(id => latest.current.visibleIndices.some(index => blocks[index]?.id === id))
    for (const id of selected) {
      const index = blocks.findIndex(block => block.id === id)
      blocks = prepareDraftBlockTypeChange(blocks, index, type)
      blocks[index] = { ...blocks[index], checked: false, content: type === 'divider' ? '' : blocks[index].content,
        markdownFormat: normalizeMarkdownFormat(type, blocks[index].markdownFormat) }
    }
    tr = tr.replaceWith(0, tr.doc.content.size, draftBlocksToRichDoc(blocks).content)
    tr.setSelection(TextSelection.between(tr.doc.resolve(positionOf(tr.doc, anchor)), tr.doc.resolve(positionOf(tr.doc, head))))
    boundary.current = true; editor.dispatch(tr.scrollIntoView())
    setSlashDismissed(null); setSlashIndex(0); editor.focus()
  }

  useLayoutEffect(() => {
    if (!mount.current) return
    const identities = new Plugin({
      appendTransaction(transactions, _old, state) {
        if (!transactions.some(transaction => transaction.docChanged)) return null
        const normalized = reconcileRichTextBlockIds(state.doc)
        let tr: Transaction | null = null
        state.doc.forEach((node, pos, index) => {
          const next = normalized.child(index)
          if (next === node) return
          tr ??= state.tr
          tr.setNodeMarkup(pos, undefined, next.attrs)
        })
        return tr
      },
      filterTransaction(transaction, state) {
        if (!transaction.docChanged || transaction.getMeta('external')) return true
        const visible = new Set(latest.current.visibleIndices)
        const hidden = richDocToDraftBlocks(state.doc).filter((_block, index) => !visible.has(index))
        if (!hidden.length) return true
        const next = richDocToDraftBlocks(transaction.doc)
        const safe = hidden.every(block => next.some(candidate => candidate.id === block.id && areDocumentDraftBlocksEqual([candidate], [block])))
        if (!safe) setMessage(latest.current.isZh ? '选区包含折叠内容，请先展开后编辑。' : 'Expand the hidden content before editing this selection.')
        return safe
      },
      props: {
        decorations(state) {
          const decorations: Decoration[] = [], visible = new Set(latest.current.visibleIndices)
          state.doc.forEach((node, pos, index) => {
            const highlight = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'].includes(node.attrs.block?.highlight) ? node.attrs.block.highlight : null
            decorations.push(Decoration.node(pos, pos + node.nodeSize, {
              'data-block-index': String(index), 'data-block-id': node.attrs.block?.id ?? '',
              ...(highlight || !visible.has(index) ? { style: `${highlight ? `background:var(--highlight-${highlight});` : ''}${visible.has(index) ? '' : 'display:none'}` } : {}),
              ...(visible.has(index) ? {} : { 'aria-hidden': 'true' })
            }))
            if (node.type === richTextSchema.nodes.text_block && visible.has(index) && latest.current.onOpenBlockActions) {
              decorations.push(Decoration.widget(pos + 1, () => blockActionButton(node.attrs.block.id),
                { side: -1, key: `actions:${node.attrs.block.id}:${latest.current.isZh}`, stopEvent: blockActionStopsEvent }))
            }
            if (node.type === richTextSchema.nodes.text_block && visible.has(index) && isContainerBlockType(node.attrs.block?.type)) {
              const block = node.attrs.block as DocumentBlockDraft, presentation = nativeContainerPresentation(block.type, block.markdownFormat)
              const collapsed = Boolean(latest.current.collapsedBlockIds?.has(block.id!))
              decorations.push(Decoration.widget(pos + 1, () => {
                const control = document.createElement(block.type === 'toggle' ? 'button' : 'span')
                control.contentEditable = 'false'
                if (block.type === 'toggle') {
                  ;(control as HTMLButtonElement).type = 'button'; control.className = 'native-toggle-control'
                  control.setAttribute('aria-expanded', String(!collapsed))
                  control.setAttribute('aria-label', latest.current.isZh ? collapsed ? '展开块' : '折叠块' : collapsed ? 'Expand block' : 'Collapse block')
                  control.addEventListener('mousedown', event => event.preventDefault())
                  control.addEventListener('click', () => { if (!viewRef.current?.composing) latest.current.onToggleCollapse?.(block.id!) })
                } else {
                  control.className = 'native-container-icon'; control.dataset.nativeContainerIcon = presentation.icon
                  control.setAttribute('aria-hidden', 'true')
                }
                return control
              }, { side: -1, key: `container:${block.id}:${presentation.icon}:${collapsed}:${latest.current.isZh}`, stopEvent: blockActionStopsEvent }))
            }
            if (['todo', 'numbered-todo'].includes(node.attrs.block?.type) && visible.has(index)) {
              decorations.push(Decoration.widget(pos + 1, () => {
                const checkbox = document.createElement('input')
                checkbox.type = 'checkbox'; checkbox.checked = Boolean(node.attrs.block.checked)
                checkbox.contentEditable = 'false'; checkbox.setAttribute('aria-label', latest.current.isZh ? '完成待办' : 'Complete task')
                checkbox.addEventListener('change', () => {
                  const editor = viewRef.current
                  if (!editor) return
                  latest.current.checkpoint()
                  editor.state.doc.forEach((current, position) => {
                    if (current.attrs.block?.id === node.attrs.block.id) {
                      boundary.current = true
                      editor.dispatch(editor.state.tr.setNodeMarkup(position, undefined, { ...current.attrs, block: { ...current.attrs.block, checked: checkbox.checked } }))
                    }
                  })
                })
                return checkbox
              }, { side: -1, key: `${node.attrs.block.id}:${node.attrs.block.checked}` }))
            }
          })
          return DecorationSet.create(state.doc, decorations)
        }
      }
    })
    const split: Command = (state, dispatch, editor) => {
      const node = state.selection.$from.parent
      const block: DocumentBlockDraft | undefined = node.attrs.block
      if (node.type.name === 'text_block' && !node.content.size && block?.type !== 'paragraph' && !isContainerBlockType(block?.type ?? '')) {
        const blocks = richDocToDraftBlocks(state.doc), index = state.selection.$from.index(0)
        const promoted = prepareDraftBlockTypeChange(blocks, index, 'paragraph')
        promoted[index] = { ...promoted[index], checked: false, markdownFormat: undefined }
        const tr = state.tr.replaceWith(0, state.doc.content.size, draftBlocksToRichDoc(promoted).content)
        let pos = 1; for (let i = 0; i < index; i++) pos += tr.doc.child(i).nodeSize
        dispatch?.(tr.setSelection(TextSelection.create(tr.doc, pos)))
        return true
      }
      if (node.type.name === 'text_block' && block && isContainerBlockType(block.type)) {
        const tr = state.tr.deleteSelection(), index = tr.selection.$from.index(0), from = tr.selection.$from.parentOffset
        const current = tr.selection.$from.parent, children: RichNode[] = []
        tr.doc.forEach(child => children.push(child))
        children[index] = current.copy(current.content.cut(0, from))
        const right = richTextSchema.nodes.text_block.create({ block: { id: createDraftBlockId(), type: 'paragraph', content: '', checked: false,
          depth: block.depth < 6 ? block.depth + 1 : block.depth, parentBlockId: block.depth < 6 ? block.id : block.parentBlockId }, originalInline: null }, current.content.cut(from))
        let insertion = index + 1
        if (block.depth >= 6) while (insertion < children.length && children[insertion].attrs.block?.depth > block.depth) insertion++
        children.splice(insertion, 0, right)
        tr.replaceWith(0, tr.doc.content.size, Fragment.fromArray(children))
        const pos = 1 + children.slice(0, insertion).reduce((sum, child) => sum + child.nodeSize, 0)
        latest.current.onRevealBlock(block.id!)
        if (latest.current.collapsedBlockIds?.has(block.id!)) latest.current.onToggleCollapse?.(block.id!)
        dispatch?.(tr.setSelection(TextSelection.create(tr.doc, pos)).scrollIntoView())
        return true
      }
      if (node.type.name === 'text_block' && ['bulleted-list', 'numbered-list', 'todo', 'numbered-todo'].includes(block?.type ?? '')) {
        const tr = state.tr.deleteSelection(), index = tr.selection.$from.index(0), from = tr.selection.$from.parentOffset
        const current = tr.selection.$from.parent, children: RichNode[] = []
        tr.doc.forEach(child => children.push(child))
        const left = current.copy(current.content.cut(0, from))
        const right = current.type.create({ ...current.attrs, originalInline: null, block: { ...current.attrs.block,
          id: createDraftBlockId(), content: '', checked: false, tags: undefined, highlight: undefined, listStart: undefined } }, current.content.cut(from))
        let end = index + 1
        while (end < children.length && (children[end].attrs.block?.depth ?? 0) > (block?.depth ?? 0)) end++
        children[index] = left; children.splice(end, 0, right)
        tr.replaceWith(0, tr.doc.content.size, Fragment.fromArray(children))
        const pos = 1 + children.slice(0, end).reduce((sum, child) => sum + child.nodeSize, 0)
        dispatch?.(tr.setSelection(TextSelection.create(tr.doc, pos)).scrollIntoView())
        return true
      }
      return splitBlockAs((original, atEnd) => ({ type: richTextSchema.nodes.text_block, attrs: {
        ...original.attrs,
        originalInline: null,
        block: { ...original.attrs.block, id: createDraftBlockId(), content: '',
          type: atEnd && /^heading-/.test(original.attrs.block?.type) ? 'paragraph' : original.attrs.block?.type ?? 'paragraph',
          checked: false, tags: undefined, highlight: undefined, markdownFormat: undefined }
      } }))(state, dispatch, editor)
    }
    const run = (command: Command): Command => (state, dispatch, editor) => {
      latest.current.checkpoint(); boundary.current = true
      return command(state, dispatch, editor)
    }
    const downgrade: Command = (state, dispatch) => {
      const { $from, empty } = state.selection, block = $from.parent.attrs.block as DocumentBlockDraft | null
      if (!empty || $from.parentOffset || $from.parent.type.name !== 'text_block' || !block || block.type === 'paragraph') return false
      latest.current.checkpoint(); boundary.current = true
      const blocks = prepareDraftBlockTypeChange(richDocToDraftBlocks(state.doc), $from.index(0), 'paragraph')
      blocks[$from.index(0)] = { ...blocks[$from.index(0)], checked: false, markdownFormat: undefined }
      const tr = state.tr.replaceWith(0, state.doc.content.size, draftBlocksToRichDoc(blocks).content)
      dispatch?.(tr.setSelection(TextSelection.create(tr.doc, $from.start())).scrollIntoView())
      return true
    }
    const shortcuts = keymap({
      ...baseKeymap,
      Enter: run(chainCommands(createParagraphNear, split)),
      Backspace: run(chainCommands(downgrade, baseKeymap.Backspace)),
      Delete: run(baseKeymap.Delete),
      'Shift-Enter': (state, dispatch) => { dispatch?.(state.tr.replaceSelectionWith(richTextSchema.nodes.hard_break.create()).scrollIntoView()); return true },
      'Mod-b': run(toggleMark(richTextSchema.marks.strong)), 'Mod-i': run(toggleMark(richTextSchema.marks.em)),
      'Mod-u': run(toggleMark(richTextSchema.marks.underline)),
      'Mod-e': run(toggleMark(richTextSchema.marks.code)), 'Mod-Shift-x': run(toggleMark(richTextSchema.marks.strike)),
      'Mod-Shift-h': run(toggleMark(richTextSchema.marks.highlight)),
      'Mod-z': () => { latest.current.onUndo(); return true },
      'Mod-y': () => { latest.current.onRedo(); return true },
      'Mod-Shift-z': () => { latest.current.onRedo(); return true }
    })
    const insertFiles = async (files: File[], position?: number) => {
      if (importing.current) return
      importing.current = true
      const doc = editor.state.doc, selected = editor.state.selection
      setMessage(latest.current.isZh ? '正在导入附件…' : 'Importing attachments…')
      try {
        const attachments = await importAttachmentFiles(files)
        if (viewRef.current !== editor) return
        if (!editor.state.doc.eq(doc)) { setMessage(latest.current.isZh ? '正文已变化，请重新插入附件。' : 'The text changed. Insert the attachments again.'); return }
        const blocks = normalizeDraftBlocks(attachments.map(attachment => ({ id: createDraftBlockId(), type: 'paragraph', content: attachmentMarkdown(attachment), checked: false, depth: 0 })))
        latest.current.checkpoint(); boundary.current = true
        let tr = editor.state.tr
        if (position !== undefined) tr.setSelection(TextSelection.near(tr.doc.resolve(position)))
        else tr.setSelection(selected)
        const treePaste = planRichTextTreePaste(tr.doc, tr.selection, blocks)
        if (treePaste) {
          tr.replaceWith(0, tr.doc.content.size, treePaste.doc.content)
          tr.setSelection(Selection.fromJSON(tr.doc, treePaste.selection.toJSON()))
        } else tr.replaceSelection(new Slice(draftBlocksToRichDoc(blocks).content, 0, 0))
        editor.dispatch(tr.scrollIntoView())
        setMessage('')
      } catch (error) { if (viewRef.current === editor) setMessage(error instanceof Error ? error.message : String(error)) }
      finally { importing.current = false }
    }
    const inlineRules = inputRules({ rules: ([
      [/\*\*([^*]+)\*\*$/, 'strong'], [/(?<![\\*])\*([^*]+)\*$/, 'em'], [/~~([^~]+)~~$/, 'strike'],
      [/==([^=]+)==$/, 'highlight'], [/`([^`]+)`$/, 'code']
    ] as const).map(([pattern, mark]) => new InputRule(pattern, (state, match, start, end) => {
      latest.current.checkpoint(); boundary.current = true
      return state.tr.insertText(match[1], start, end).addMark(start, start + match[1].length, richTextSchema.marks[mark].create())
        .removeStoredMark(richTextSchema.marks[mark])
    })) })
    const editor = new EditorView(mount.current, {
      state: EditorState.create({ doc: draftBlocksToRichDoc(props.blocks), plugins: [identities, inlineRules, shortcuts] }),
      attributes: { class: 'knowbook-rich-text-editor', role: 'textbox', 'aria-multiline': 'true',
        'aria-label': props.isZh ? '文档正文（富文本）' : 'Document body (rich text)', spellcheck: 'true' },
      clipboardTextSerializer: sliceMarkdown,
      dispatchTransaction(transaction) {
        const result = editor.state.applyTransaction(transaction)
        editor.updateState(result.state)
        if (result.transactions.some(item => item.docChanged)) {
          const blocks = richDocToDraftBlocks(result.state.doc)
          emitted.current = blocks
          latest.current.onChange(blocks)
        }
        setRevision(value => value + 1)
      },
      handleKeyDown(_editor, event) {
        if (isImeKeyboardEvent(event) || editor.composing) return false
        if (event.key === 'Escape' && paletteRef.current) { setPalette(null); return true }
        if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') {
          const id = richTextSelectionBlockIds(editor.state)[0]
          if (id && latest.current.onOpenBlockActions) {
            const coordinates = editor.coordsAtPos(editor.state.selection.from)
            openBlockActions(id, coordinates.left, coordinates.bottom); return true
          }
        }
        const slash = slashRef.current
        if (slash.commands.length && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            const delta = event.key === 'ArrowDown' ? 1 : -1
            setSlashIndex((slash.index + delta + slash.commands.length) % slash.commands.length); return true
          }
          if (event.key === 'Enter') { convert(slash.commands[slash.index].type, true); return true }
          if (event.key === 'Escape') { setSlashDismissed(editor.state.selection.$from.parent.textContent); return true }
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
          linkSelection.current = { from: editor.state.selection.from, to: editor.state.selection.to, doc: editor.state.doc }
          const link = editor.state.selection.$from.marks().find(mark => mark.type === richTextSchema.marks.link)
          setLinkUrl(link?.attrs.href ?? 'https://'); return true
        }
        return false
      },
      handleDOMEvents: {
        contextmenu(_editor, event) {
          const target = event.target instanceof Element ? event.target : null
          if (!target || target.closest('input,textarea,select') || !latest.current.onOpenBlockActions || editor.composing) return false
          const id = target.closest<HTMLElement>('[data-block-id]')?.dataset.blockId
          if (!id) return false
          event.preventDefault(); openContextBlockActions(id, event.clientX, event.clientY); return true
        },
        copy(_editor, event) {
          if (!event.clipboardData || editor.state.selection.empty) return false
          const slice = editor.state.selection.content(), markdown = sliceMarkdown(slice)
          event.clipboardData.setData('text/plain', markdown)
          event.clipboardData.setData('text/html', clipboardHtml(markdown))
          event.clipboardData.setData('application/x-knowbook-markdown', markdown)
          event.preventDefault(); return true
        },
        cut(_editor, event) {
          if (!event.clipboardData || editor.state.selection.empty || editor.composing) return false
          const slice = editor.state.selection.content(), markdown = sliceMarkdown(slice)
          event.clipboardData.setData('text/plain', markdown); event.clipboardData.setData('text/html', clipboardHtml(markdown))
          event.clipboardData.setData('application/x-knowbook-markdown', markdown)
          latest.current.checkpoint(); boundary.current = true
          editor.dispatch(editor.state.tr.deleteSelection().scrollIntoView())
          event.preventDefault(); return true
        },
        keydown(_editor, event) {
          if (!isImeKeyboardEvent(event) && !editor.composing) return false
          // The native IME retains Enter/Escape. Skip every editor keymap and
          // application shortcut without cancelling candidate confirmation.
          event.stopPropagation()
          return true
        }
      },
      handlePaste(_editor, event) {
        if (event.clipboardData?.files.length) { void insertFiles(Array.from(event.clipboardData.files)); return true }
        const html = event.clipboardData?.getData('text/html')
        const plain = event.clipboardData?.getData('text/plain') ?? ''
        const internal = event.clipboardData?.getData('application/x-knowbook-markdown')
        const sourceCopy = html?.includes('data-knowbook-markdown-source="true"')
        const markdown = internal || (sourceCopy ? plain : html ? htmlClipboardToMarkdown(html) : plain)
        if (!markdown) return false
        const fragment = normalizeDraftBlocks(parsePastedMarkdown(markdown).map(block => ({ ...block, id: createDraftBlockId() })))
        if (!fragment.length) return false
        latest.current.checkpoint(); boundary.current = true
        const treePaste = planRichTextTreePaste(editor.state.doc, editor.state.selection, fragment)
        if (treePaste) {
          const tr = editor.state.tr.replaceWith(0, editor.state.doc.content.size, treePaste.doc.content)
          editor.dispatch(tr.setSelection(Selection.fromJSON(tr.doc, treePaste.selection.toJSON())).scrollIntoView())
          return true
        }
        const document = draftBlocksToRichDoc(fragment)
        const oneInline = document.childCount === 1 && document.firstChild?.type.name === 'text_block' && fragment[0].type === 'paragraph'
        const onlyParagraphs = fragment.every(block => block.type === 'paragraph') && Array.from({ length: document.childCount }, (_, index) => document.child(index)).every(node => node.type.name === 'text_block')
        const slice = oneInline ? new Slice(document.firstChild!.content, 0, 0) : new Slice(document.content, onlyParagraphs ? 1 : 0, onlyParagraphs ? 1 : 0)
        editor.dispatch(editor.state.tr.replaceSelection(slice).scrollIntoView())
        return true
      },
      handleDrop(_editor, event) {
        if (!event.dataTransfer?.files.length) return false
        const position = editor.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
        void insertFiles(Array.from(event.dataTransfer.files), position)
        return true
      },
      handleTextInput(_editor, from, to, text) {
        if (editor.composing) return false
        const { $from } = editor.state.selection
        if ($from.parent.type.name !== 'text_block' || !$from.parent.attrs.block || from !== to) return false
        if (isContainerBlockType($from.parent.attrs.block.type)) return false
        const content = $from.parent.textContent.slice(0, $from.parentOffset) + text + $from.parent.textContent.slice($from.parentOffset)
        const patch = getMarkdownShortcut($from.parent.attrs.block, content)
        if (!patch || patch.type === 'paragraph') return false
        // Prefix shortcuts convert only plain text, so they cannot erase marks or inline objects.
        if ($from.parent.content.content.some(node => node.marks.length || !node.isText)) return false
        latest.current.checkpoint(); boundary.current = true
        const block = draftBlocksToRichDoc([{ ...patch, id: $from.parent.attrs.block.id }]).firstChild!
        editor.dispatch(editor.state.tr.replaceWith($from.before(), $from.after(), block).scrollIntoView())
        return true
      },
      nodeViews: {
        source_block(node, _view, getPos) {
          const dom = document.createElement('div')
          dom.className = 'rich-text-source-block block-editor-row'
          dom.contentEditable = 'false'
          if (node.attrs.block?.type === 'table') {
            let current = node
            const host = document.createElement('div'), id = node.attrs.block.id as string
            host.className = 'rich-text-table-host'
            const editSource = document.createElement('button')
            editSource.type = 'button'; editSource.className = 'secondary-button'
            editSource.dataset.richSourceEntry = 'true'
            editSource.textContent = latest.current.isZh ? '编辑源码' : 'Edit source'
            editSource.addEventListener('click', () => latest.current.onEditSource())
            dom.append(host, editSource)
            if (latest.current.onOpenBlockActions) dom.prepend(blockActionButton(id))
            setTableHosts(previous => [...previous.filter(item => item.id !== id), { id, dom: host, node: () => current, position: getPos }])
            dom.addEventListener('contextmenu', event => {
              if (host.contains(event.target as Node) || !latest.current.onOpenBlockActions || viewRef.current?.composing) return
              event.preventDefault(); event.stopPropagation(); openContextBlockActions(id, event.clientX, event.clientY)
            })
            return { dom,
              stopEvent: event => event.target === editSource || event.target instanceof HTMLElement
                && (host.contains(event.target) || Boolean(event.target.closest('.rich-text-block-actions'))) && blockActionStopsEvent(event),
              ignoreMutation: record => record.type !== 'selection',
              update(next) {
                if (next.type !== current.type || next.attrs.block?.id !== id || next.attrs.block?.type !== 'table') return false
                current = next; return true
              }, destroy() { if (viewRef.current) setTableHosts(previous => previous.filter(item => item.dom !== host)) }
            }
          }
          const preview = document.createElement('div')
          preview.className = 'rich-text-source-preview'
          const mediaHost = document.createElement('div')
          mediaHost.className = 'rich-text-source-media'
          let current = node, disposed = false, mediaLoading = false, mediaRoot: Root | null = null
          let mediaModule: typeof import('../components/BlockImagePresentations') | null = null
          const renderPreview = () => {
            preview.innerHTML = markdownEngine.render(serializeBlocksToMarkdown([current.attrs.block]), { references: { ...latest.current.references } })
            const displays = planMarkdownImageDisplays(current.attrs.block.content, latest.current.references, preview.innerHTML)
            const occurrences = displays.flatMap(display => display.occurrence ? [display.occurrence] : [])
            const managed = new Set(displays.filter(display => display.occurrence).map(display => display.renderedIndex))
            for (const [index, image] of Array.from(preview.querySelectorAll('img[src]')).entries()) {
              const url = toBlockRichMediaPreviewUrl(image.getAttribute('src')!)
              image.setAttribute('src', url)
              if (mediaModule && managed.has(index)) {
                ;((image.closest('figure,[data-knowbook-align]') ?? image) as HTMLElement).style.display = 'none'
              }
            }
            if (!mediaModule) {
              if (occurrences.length && !mediaLoading) {
                mediaLoading = true
                void import('../components/BlockImagePresentations').then(module => {
                  if (disposed) return
                  mediaModule = module; renderPreview()
                })
              }
              return
            }
            mediaRoot ??= createRoot(mediaHost)
            mediaRoot.render(<mediaModule.BlockImagePresentations content={current.attrs.block.content} references={latest.current.references} occurrences={occurrences} isZh={latest.current.isZh}
              onBegin={() => latest.current.checkpoint()} onCommit={(occurrence, next) => {
                const editor = viewRef.current
                if (!editor || editor.composing) return
                editor.state.doc.forEach((candidate, position) => {
                  if (candidate.attrs.block?.id !== current.attrs.block.id) return
                  const content = replaceMarkdownImageOccurrence(candidate.attrs.block.content, occurrence, next, latest.current.references)
                  if (content === null) { setMessage(latest.current.isZh ? '正文已变化，请重新选择图片。' : 'The text changed. Select the image again.'); return }
                  latest.current.checkpoint(); boundary.current = true
                  editor.dispatch(editor.state.tr.setNodeMarkup(position, undefined, { ...candidate.attrs,
                    block: { ...candidate.attrs.block, content } }))
                })
              }} />)
          }
          sourceRefresh.current.add(renderPreview)
          renderPreview()
          const button = document.createElement('button')
          button.type = 'button'; button.className = 'secondary-button'
          button.dataset.richSourceEntry = 'true'
          button.textContent = latest.current.isZh ? '编辑源码' : 'Edit source'
          button.addEventListener('click', () => latest.current.onEditSource())
          dom.append(preview, mediaHost, button)
          if (latest.current.onOpenBlockActions) dom.prepend(blockActionButton(current.attrs.block.id))
          dom.addEventListener('contextmenu', event => {
            if (event.target instanceof Element && event.target.closest('input,textarea,select') || !latest.current.onOpenBlockActions || viewRef.current?.composing) return
            event.preventDefault(); event.stopPropagation()
            openContextBlockActions(current.attrs.block.id, event.clientX, event.clientY)
          })
          return { dom, stopEvent: event => event.target === button || event.target instanceof HTMLElement && (mediaHost.contains(event.target) || Boolean(event.target.closest('.rich-text-block-actions')) && blockActionStopsEvent(event)),
            update(next) {
              if (next.type !== current.type || next.attrs.block?.id !== current.attrs.block.id) return false
              current = next; renderPreview(); return true
            }, destroy() { disposed = true; sourceRefresh.current.delete(renderPreview); const root = mediaRoot; if (root) queueMicrotask(() => root.unmount()) } }
        }
      }
    })
    viewRef.current = editor
    const unregister = registerRichTextHistoryBridge(editor.dom, {
      capture() {
        const anchor = endpoint(editor.state.doc, editor.state.selection.anchor)
        const head = endpoint(editor.state.doc, editor.state.selection.head)
        return { blockId: anchor.blockId, index: anchor.index, start: anchor.offset, end: head.offset,
          direction: editor.state.selection.anchor > editor.state.selection.head ? 'backward' : 'forward', richText: { anchor, head } }
      },
      restore(bookmark) {
        if (!bookmark.richText) return
        const visible = new Set(latest.current.visibleIndices)
        const missing = [bookmark.richText.anchor, bookmark.richText.head].filter(point => {
          let index = point.index
          editor.state.doc.forEach((node, _pos, position) => { if (point.blockId && node.attrs.block?.id === point.blockId) index = position })
          return !visible.has(index)
        })
        if (missing.length) {
          pendingSelection.current = bookmark
          for (const point of missing) if (point.blockId) latest.current.onRevealBlock(point.blockId)
          return
        }
        const anchor = positionOf(editor.state.doc, bookmark.richText.anchor), head = positionOf(editor.state.doc, bookmark.richText.head)
        editor.dispatch(editor.state.tr.setSelection(TextSelection.between(editor.state.doc.resolve(anchor), editor.state.doc.resolve(head))))
        editor.focus()
      }
    })
    setRevision(value => value + 1)
    return () => { cancelChildFocus(); pendingContextMenu.current?.(); unregister(); parkedFoldSelection.current = null; viewRef.current = null; editor.destroy() }
  }, [props.documentId])

  const referenceSignature = JSON.stringify(props.references ?? {})
  useLayoutEffect(() => { for (const refresh of sourceRefresh.current) refresh() }, [referenceSignature, props.isZh])

  useLayoutEffect(() => {
    const editor = viewRef.current
    if (!editor || editor.composing) return
    if (!areDocumentDraftBlocksEqual(emitted.current, props.blocks)) {
      const bookmark = endpoint(editor.state.doc, editor.state.selection.anchor)
      const head = endpoint(editor.state.doc, editor.state.selection.head)
      const doc = draftBlocksToRichDoc(props.blocks)
      const tr = editor.state.tr.replaceWith(0, editor.state.doc.content.size, doc.content).setMeta('external', true)
      tr.setSelection(TextSelection.between(tr.doc.resolve(positionOf(tr.doc, bookmark)), tr.doc.resolve(positionOf(tr.doc, head))))
      emitted.current = props.blocks
      editor.updateState(editor.state.apply(tr))
      setRevision(value => value + 1)
    } else {
      // Visibility and task widgets are derived from the current folding state.
      editor.updateState(editor.state)
    }
    const visible = new Set(props.visibleIndices), doc = editor.state.doc
    const anchor = endpoint(doc, editor.state.selection.anchor), head = endpoint(doc, editor.state.selection.head)
    const parked = parkedFoldSelection.current
    if (parked && (!doc.eq(parked.doc) || JSON.stringify({ anchor, head }) !== JSON.stringify(parked.fallback))) parkedFoldSelection.current = null
    if (!visible.has(anchor.index) || !visible.has(head.index)) {
      const focusOwned = editor.hasFocus()
      const index = [...visible].filter(index => index <= Math.min(anchor.index, head.index)).at(-1) ?? props.visibleIndices[0]
      if (index !== undefined) {
        const node = doc.child(index), fallback = { index, blockId: node.attrs.block?.id, offset: node.content.size }
        const next = Selection.near(doc.resolve(positionOf(doc, fallback)), -1)
        editor.updateState(editor.state.apply(editor.state.tr.setSelection(next)))
        parkedFoldSelection.current = { doc, anchor, head, fallback: { anchor: endpoint(doc, next.anchor), head: endpoint(doc, next.head) } }
        if (focusOwned) editor.focus()
        setRevision(value => value + 1)
      }
    } else if (parkedFoldSelection.current && visible.has(parkedFoldSelection.current.anchor.index) && visible.has(parkedFoldSelection.current.head.index)) {
      const restore = parkedFoldSelection.current, focusOwned = editor.hasFocus()
      parkedFoldSelection.current = null
      editor.updateState(editor.state.apply(editor.state.tr.setSelection(TextSelection.between(doc.resolve(positionOf(doc, restore.anchor)), doc.resolve(positionOf(doc, restore.head))))))
      if (focusOwned) editor.focus()
      setRevision(value => value + 1)
    }
    if (boundary.current) { boundary.current = false; props.checkpoint() }
    if (pendingSelection.current?.richText) {
      const { anchor, head } = pendingSelection.current.richText
      pendingSelection.current = null
      editor.dispatch(editor.state.tr.setSelection(TextSelection.between(editor.state.doc.resolve(positionOf(editor.state.doc, anchor)), editor.state.doc.resolve(positionOf(editor.state.doc, head)))))
      editor.focus()
    }
    focusAddedChild()
  }, [props.blocks, props.visibleIndices, props.collapsedBlockIds])

  const format = (name: string) => {
    const editor = viewRef.current
    if (!editor || editor.composing) return
    editor.focus(); props.checkpoint()
    boundary.current = true; toggleMark(richTextSchema.marks[name])(editor.state, editor.dispatch, editor)
    editor.focus()
  }
  const applyColor = (name: 'textColor' | 'backgroundColor', color?: InlineTextColor) => {
    const editor = viewRef.current
    if (!editor || editor.composing) return
    editor.focus(); props.checkpoint(); boundary.current = true
    setRichTextColor(name, color)(editor.state, editor.dispatch, editor)
    setPalette(null); editor.focus()
  }
  const saveLink = () => {
    const editor = viewRef.current, selected = linkSelection.current
    if (!editor || !selected || linkUrl === null) return
    if (!editor.state.doc.eq(selected.doc)) { setMessage(props.isZh ? '正文已变化，请重新选择链接文字。' : 'The text changed. Select the link text again.'); return }
    let url: URL
    try { url = new URL(linkUrl) } catch { setMessage(props.isZh ? '请输入完整链接地址。' : 'Enter a complete URL.'); return }
    if (!['http:', 'https:', 'mailto:', 'file:'].includes(url.protocol)) { setMessage(props.isZh ? '不支持此链接类型。' : 'Unsupported link type.'); return }
    props.checkpoint(); boundary.current = true
    const tr = editor.state.tr
    if (selected.from === selected.to) tr.insertText(linkUrl, selected.from).addMark(selected.from, selected.from + linkUrl.length, richTextSchema.marks.link.create({ href: url.toString() }))
    else tr.addMark(selected.from, selected.to, richTextSchema.marks.link.create({ href: url.toString() }))
    editor.dispatch(tr); setLinkUrl(null); setMessage(''); editor.focus()
  }
  return <div className="rich-text-document" onKeyDown={event => {
    if (palette && event.key === 'Escape' && !isImeKeyboardEvent(event) && !viewRef.current?.composing) {
      event.preventDefault(); event.stopPropagation(); setPalette(null); viewRef.current?.focus()
    }
  }}>
    {props.blocks.some(block => isContainerBlockType(block.type)) ? <Suspense fallback={null}><NativeContainerStyle /></Suspense> : null}
    <div className="rich-text-toolbar" role="toolbar" aria-label={props.isZh ? '正文格式' : 'Body formatting'}>
      <label><span className="sr-only">{props.isZh ? '块类型' : 'Block type'}</span><select aria-label={props.isZh ? '块类型' : 'Block type'} value={types.includes(currentType) ? currentType : 'paragraph'}
        onChange={event => convert(event.target.value)}>{types.map((type, index) => <option key={type} value={type}>{(props.isZh ? labelsZh : labelsEn)[index]}</option>)}</select></label>
      {([['strong', 'B', '加粗', 'Bold'], ['em', 'I', '斜体', 'Italic'], ['strike', 'S', '删除线', 'Strikethrough'],
        ['underline', 'U', '下划线', 'Underline'], ['highlight', '▧', '高亮', 'Highlight'], ['code', '</>', '行内代码', 'Inline code']] as const).map(([name, symbol, zh, en]) =>
        <button key={name} type="button" aria-label={props.isZh ? zh : en} title={props.isZh ? zh : en}
          aria-pressed={Boolean(view && selection && (selection.empty ? (view.state.storedMarks ?? selection.$from.marks()).some(mark => mark.type === richTextSchema.marks[name]) : view.state.doc.rangeHasMark(selection.from, selection.to, richTextSchema.marks[name])))}
          onMouseDown={event => event.preventDefault()} onClick={() => format(name)}>{symbol}</button>)}
      {(['textColor', 'backgroundColor'] as const).map(name => <button key={name} type="button" aria-haspopup="dialog" aria-expanded={palette === name}
        aria-label={props.isZh ? name === 'textColor' ? '文字颜色' : '背景颜色' : name === 'textColor' ? 'Text color' : 'Background color'}
        onMouseDown={event => event.preventDefault()} onClick={() => { if (!viewRef.current?.composing) setPalette(value => value === name ? null : name) }}>
        {props.isZh ? name === 'textColor' ? '文字颜色' : '背景颜色' : name === 'textColor' ? 'Text color' : 'Background color'}
      </button>)}
      <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => {
        const editor = viewRef.current
        if (!editor || editor.composing) return
        linkSelection.current = { from: editor.state.selection.from, to: editor.state.selection.to, doc: editor.state.doc }; setLinkUrl('https://')
      }}>{props.isZh ? '链接' : 'Link'}</button>
    </div>
    {currentBlock?.id && isContainerBlockType(currentType) && <Suspense fallback={null}>
      <NativeContainerControls key={currentBlock.id} type={currentType as 'callout' | 'toggle'} format={currentBlock.markdownFormat}
        isZh={props.isZh} typeOptions={Object.fromEntries(types.map((type, index) => [type, (props.isZh ? labelsZh : labelsEn)[index]]))}
        onChange={format => {
          const editor = viewRef.current
          if (!editor || editor.composing) return
          editor.state.doc.forEach((node, position, index) => {
            if (node.attrs.block?.id !== currentBlock.id || !latest.current.visibleIndices.includes(index)) return
            latest.current.checkpoint(); boundary.current = true
            editor.dispatch(editor.state.tr.setNodeMarkup(position, undefined, { ...node.attrs,
              block: { ...node.attrs.block, markdownFormat: normalizeMarkdownFormat(currentType, format) } }))
          })
        }} onAddChild={props.onAddContainerChild ? type => addContainerChild(currentBlock.id!, type) : undefined} onReturnToTitle={() => viewRef.current?.focus()} />
    </Suspense>}
    {palette && <div className="rich-text-color-palette" role="dialog" aria-label={props.isZh ? palette === 'textColor' ? '选择文字颜色' : '选择背景颜色' : palette === 'textColor' ? 'Choose text color' : 'Choose background color'}
      onKeyDown={event => { if (event.key === 'Escape' && !isImeKeyboardEvent(event)) { event.preventDefault(); event.stopPropagation(); setPalette(null); viewRef.current?.focus() } }}>
      <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => applyColor(palette)}>{props.isZh ? '恢复默认' : 'Default'}</button>
      {INLINE_TEXT_COLORS.map((color, index) => <button key={color} type="button" data-palette-color={color}
        aria-label={(props.isZh ? ['灰色', '棕色', '橙色', '黄色', '绿色', '蓝色', '紫色', '粉色', '红色'] : ['Gray', 'Brown', 'Orange', 'Yellow', 'Green', 'Blue', 'Purple', 'Pink', 'Red'])[index]}
        aria-pressed={Boolean(view && selectedRichTextColor(view.state, palette) === color)} onMouseDown={event => event.preventDefault()} onClick={() => applyColor(palette, color)}>
        <span aria-hidden="true" data-palette-swatch={palette}>A</span>{(props.isZh ? ['灰', '棕', '橙', '黄', '绿', '蓝', '紫', '粉', '红'] : ['Gray', 'Brown', 'Orange', 'Yellow', 'Green', 'Blue', 'Purple', 'Pink', 'Red'])[index]}
      </button>)}
    </div>}
    {linkUrl !== null && <form className="rich-text-link-form" onSubmit={event => { event.preventDefault(); saveLink() }}>
      <input autoFocus aria-label={props.isZh ? '链接地址' : 'Link URL'} value={linkUrl} onChange={event => setLinkUrl(event.target.value)} />
      <button type="submit">{props.isZh ? '应用' : 'Apply'}</button><button type="button" onClick={() => { setLinkUrl(null); viewRef.current?.focus() }}>{props.isZh ? '取消' : 'Cancel'}</button>
    </form>}
    <div ref={mount} />
    {tableHosts.map(host => {
      const index = props.blocks.findIndex(block => block.id === host.id)
      if (index < 0 || props.blocks[index].type !== 'table') return null
      const content = props.blocks[index].content
      return createPortal(<MarkdownBlockNodesContext.Provider value={markdownDocument.model?.blockNodes[index]}>
        <Suspense fallback={<p role="status">{props.isZh ? '正在加载表格…' : 'Loading table…'}</p>}>
          <MarkdownTableEditor key={`${props.documentId}:${host.id}`} content={content} sessionKey={`${props.documentId}:${host.id}`} isZh={props.isZh}
            onReady={cell => focusAddedChild(host.id, cell)}
            onBeginEdit={() => latest.current.checkpoint()} onChange={(next, transaction) => {
              const editor = viewRef.current, position = host.position()
              if (!editor || editor.composing || !host.dom.isConnected || position === undefined) return
              const current = editor.state.doc.nodeAt(position)
              if (current?.attrs.block?.id !== host.id || current.attrs.block.type !== 'table' || current.attrs.block.content !== content || next === content) return
              if (transaction) { latest.current.checkpoint(); boundary.current = true }
              editor.dispatch(editor.state.tr.setNodeMarkup(position, undefined, { ...current.attrs, block: { ...current.attrs.block, content: next } }))
            }} />
        </Suspense>
      </MarkdownBlockNodesContext.Provider>, host.dom, `${props.documentId}:${host.id}`)
    })}
    {slashCommands.length > 0 && <div className="rich-text-slash-menu" role="listbox" aria-label={props.isZh ? '插入块' : 'Insert block'}>
      {slashCommands.map((command, index) => <button type="button" role="option" aria-selected={index === slashRef.current.index} key={command.type}
        onMouseDown={event => event.preventDefault()} onClick={() => convert(command.type, true)}>{command.label}</button>)}
    </div>}
    {message && <p role="status">{message}</p>}
  </div>
}
