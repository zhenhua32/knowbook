import { useLayoutEffect, useRef, useState } from 'react'
import { Fragment, Slice, type Node as RichNode } from 'prosemirror-model'
import { EditorState, Plugin, Selection, TextSelection, type Command, type Transaction } from 'prosemirror-state'
import { Decoration, DecorationSet, EditorView } from 'prosemirror-view'
import { baseKeymap, chainCommands, createParagraphNear, splitBlockAs, toggleMark } from 'prosemirror-commands'
import { keymap } from 'prosemirror-keymap'
import { InputRule, inputRules } from 'prosemirror-inputrules'
import type { DocumentBlockDraft } from '@shared/contracts'
import { markdownEngine } from '@shared/markdownEngine'
import { serializeBlocksToMarkdown } from '@shared/markdown'
import { htmlClipboardToMarkdown } from '@shared/htmlClipboard'
import { draftBlocksToRichDoc, reconcileRichTextBlockIds, richDocToDraftBlocks } from './model'
import { richTextSchema } from './schema'
import { registerRichTextHistoryBridge } from './history'
import { planRichTextTreePaste } from './paste'
import type { EditorHistoryBookmark } from '../utils/editorHistoryFocus'
import { areDocumentDraftBlocksEqual } from '../utils/documentDraftComparison'
import { createDraftBlockId } from '../utils/draftTreeFragment'
import { normalizeDraftBlocks } from '../utils/draftTreeNormalization'
import { getMarkdownShortcut, parsePastedMarkdown } from '../utils/markdownInput'
import { isImeKeyboardEvent } from '../utils/imeKeyboard'
import { attachmentMarkdown } from '@shared/attachments'
import { importAttachmentFiles } from '../utils/attachments'
import { promoteDraftBlockChildren } from '../utils/draftTreeTextEditing'
import { toBlockRichMediaPreviewUrl } from '../utils/blockRichMedia'
import './rich-text.css'

type Props = {
  blocks: DocumentBlockDraft[]
  visibleIndices: number[]
  documentId: string
  isZh: boolean
  onChange: (blocks: DocumentBlockDraft[]) => void
  checkpoint: () => void
  onUndo: () => void
  onRedo: () => void
  onEditSource: () => void
  onRevealBlock: (id: string) => void
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

const types = ['paragraph', 'heading-1', 'heading-2', 'heading-3', 'heading-4', 'heading-5', 'heading-6', 'bulleted-list', 'numbered-list', 'todo', 'quote']
const labelsZh = ['正文', '标题 1', '标题 2', '标题 3', '标题 4', '标题 5', '标题 6', '无序列表', '有序列表', '待办', '引用']
const labelsEn = ['Text', 'Heading 1', 'Heading 2', 'Heading 3', 'Heading 4', 'Heading 5', 'Heading 6', 'Bullet list', 'Numbered list', 'To-do', 'Quote']

export function DocumentRichTextEditor(props: Props) {
  const mount = useRef<HTMLDivElement>(null), viewRef = useRef<EditorView | null>(null)
  const latest = useRef(props), emitted = useRef<DocumentBlockDraft[]>(props.blocks)
  latest.current = props
  const [revision, setRevision] = useState(0)
  const [message, setMessage] = useState('')
  const [linkUrl, setLinkUrl] = useState<string | null>(null)
  const linkSelection = useRef<{ from: number; to: number; doc: RichNode } | null>(null)
  const [slashIndex, setSlashIndex] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState<string | null>(null)
  const boundary = useRef(false), importing = useRef(false)
  const pendingSelection = useRef<EditorHistoryBookmark | null>(null)
  const view = viewRef.current
  const selection = view?.state.selection
  const currentType = selection?.$from.parent.attrs.block?.type ?? 'paragraph'
  const currentText = selection?.$from.parent.textContent ?? ''
  const slashMatch = selection?.empty ? /^\/([^\s]*)$/.exec(currentText) : null
  const slashQuery = slashMatch?.[1].toLowerCase()
  const slashCommands = slashQuery === undefined || slashDismissed === currentText ? []
    : types.map((type, index) => ({ type, label: (props.isZh ? labelsZh : labelsEn)[index] }))
      .filter(item => `${item.type} ${item.label}`.toLowerCase().includes(slashQuery))
  const slashRef = useRef({ commands: slashCommands, index: slashIndex })
  slashRef.current = { commands: slashCommands, index: Math.min(slashIndex, Math.max(0, slashCommands.length - 1)) }
  void revision

  const convert = (type: string, removeSlash = false): void => {
    const editor = viewRef.current
    if (!editor || editor.composing) return
    latest.current.checkpoint()
    let tr = editor.state.tr
    if (removeSlash) tr = tr.delete(editor.state.selection.$from.start(), editor.state.selection.$from.end())
    tr.doc.nodesBetween(tr.selection.from, tr.selection.to, (node, pos) => {
      if (node.type.name !== 'text_block') return false
      const block: DocumentBlockDraft = { ...node.attrs.block, type, checked: false,
        depth: ['bulleted-list', 'numbered-list', 'todo'].includes(type) ? node.attrs.block?.depth ?? 0 : 0,
        parentBlockId: ['bulleted-list', 'numbered-list', 'todo'].includes(type) ? node.attrs.block?.parentBlockId : null }
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, block })
      return false
    })
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
            decorations.push(Decoration.node(pos, pos + node.nodeSize, {
              'data-block-index': String(index), 'data-block-id': node.attrs.block?.id ?? '',
              ...(visible.has(index) ? {} : { style: 'display:none', 'aria-hidden': 'true' })
            }))
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
      if (node.type.name === 'text_block' && !node.content.size && block?.type !== 'paragraph') {
        const blocks = richDocToDraftBlocks(state.doc), index = state.selection.$from.index(0)
        const promoted = promoteDraftBlockChildren(blocks, index)
        promoted[index] = { ...promoted[index], type: 'paragraph', depth: 0, checked: false, parentBlockId: null }
        const tr = state.tr.replaceWith(0, state.doc.content.size, draftBlocksToRichDoc(promoted).content)
        let pos = 1; for (let i = 0; i < index; i++) pos += tr.doc.child(i).nodeSize
        dispatch?.(tr.setSelection(TextSelection.create(tr.doc, pos)))
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
      const blocks = promoteDraftBlockChildren(richDocToDraftBlocks(state.doc), $from.index(0))
      blocks[$from.index(0)] = { ...blocks[$from.index(0)], type: 'paragraph', depth: 0, checked: false, parentBlockId: null }
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
        copy(_editor, event) {
          if (!event.clipboardData || editor.state.selection.empty) return false
          const slice = editor.state.selection.content(), markdown = sliceMarkdown(slice)
          event.clipboardData.setData('text/plain', markdown)
          event.clipboardData.setData('text/html', markdownEngine.render(markdown))
          event.clipboardData.setData('application/x-knowbook-markdown', markdown)
          event.preventDefault(); return true
        },
        cut(_editor, event) {
          if (!event.clipboardData || editor.state.selection.empty || editor.composing) return false
          const slice = editor.state.selection.content(), markdown = sliceMarkdown(slice)
          event.clipboardData.setData('text/plain', markdown); event.clipboardData.setData('text/html', markdownEngine.render(markdown))
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
        source_block(node) {
          const dom = document.createElement('div')
          dom.className = 'rich-text-source-block block-editor-row'
          dom.contentEditable = 'false'
          const preview = document.createElement('div')
          preview.className = 'rich-text-source-preview'
          preview.innerHTML = markdownEngine.render(serializeBlocksToMarkdown([node.attrs.block]))
          for (const image of preview.querySelectorAll('img[src]')) image.setAttribute('src', toBlockRichMediaPreviewUrl(image.getAttribute('src')!))
          const button = document.createElement('button')
          button.type = 'button'; button.className = 'secondary-button'
          button.textContent = latest.current.isZh ? '编辑源码' : 'Edit source'
          button.addEventListener('click', () => latest.current.onEditSource())
          dom.append(preview, button)
          return { dom, stopEvent: event => event.target === button }
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
    return () => { unregister(); viewRef.current = null; editor.destroy() }
  }, [props.documentId])

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
    if (boundary.current) { boundary.current = false; props.checkpoint() }
    if (pendingSelection.current?.richText) {
      const { anchor, head } = pendingSelection.current.richText
      pendingSelection.current = null
      editor.dispatch(editor.state.tr.setSelection(TextSelection.between(editor.state.doc.resolve(positionOf(editor.state.doc, anchor)), editor.state.doc.resolve(positionOf(editor.state.doc, head)))))
      editor.focus()
    }
  }, [props.blocks, props.visibleIndices])

  const format = (name: string) => {
    const editor = viewRef.current
    if (!editor || editor.composing) return
    props.checkpoint()
    boundary.current = true; toggleMark(richTextSchema.marks[name])(editor.state, editor.dispatch, editor)
    editor.focus()
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
  return <div className="rich-text-document">
    <div className="rich-text-toolbar" role="toolbar" aria-label={props.isZh ? '正文格式' : 'Body formatting'}>
      <label><span className="sr-only">{props.isZh ? '块类型' : 'Block type'}</span><select aria-label={props.isZh ? '块类型' : 'Block type'} value={types.includes(currentType) ? currentType : 'paragraph'}
        onChange={event => convert(event.target.value)}>{types.map((type, index) => <option key={type} value={type}>{(props.isZh ? labelsZh : labelsEn)[index]}</option>)}</select></label>
      {([['strong', 'B', '加粗', 'Bold'], ['em', 'I', '斜体', 'Italic'], ['strike', 'S', '删除线', 'Strikethrough'],
        ['highlight', '▧', '高亮', 'Highlight'], ['code', '</>', '行内代码', 'Inline code']] as const).map(([name, symbol, zh, en]) =>
        <button key={name} type="button" aria-label={props.isZh ? zh : en} title={props.isZh ? zh : en}
          aria-pressed={Boolean(view && selection && (selection.empty ? (view.state.storedMarks ?? selection.$from.marks()).some(mark => mark.type === richTextSchema.marks[name]) : view.state.doc.rangeHasMark(selection.from, selection.to, richTextSchema.marks[name])))}
          onMouseDown={event => event.preventDefault()} onClick={() => format(name)}>{symbol}</button>)}
      <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => {
        const editor = viewRef.current
        if (!editor || editor.composing) return
        linkSelection.current = { from: editor.state.selection.from, to: editor.state.selection.to, doc: editor.state.doc }; setLinkUrl('https://')
      }}>{props.isZh ? '链接' : 'Link'}</button>
    </div>
    {linkUrl !== null && <form className="rich-text-link-form" onSubmit={event => { event.preventDefault(); saveLink() }}>
      <input autoFocus aria-label={props.isZh ? '链接地址' : 'Link URL'} value={linkUrl} onChange={event => setLinkUrl(event.target.value)} />
      <button type="submit">{props.isZh ? '应用' : 'Apply'}</button><button type="button" onClick={() => { setLinkUrl(null); viewRef.current?.focus() }}>{props.isZh ? '取消' : 'Cancel'}</button>
    </form>}
    <div ref={mount} />
    {slashCommands.length > 0 && <div className="rich-text-slash-menu" role="listbox" aria-label={props.isZh ? '插入块' : 'Insert block'}>
      {slashCommands.map((command, index) => <button type="button" role="option" aria-selected={index === slashRef.current.index} key={command.type}
        onMouseDown={event => event.preventDefault()} onClick={() => convert(command.type, true)}>{command.label}</button>)}
    </div>}
    {message && <p role="status">{message}</p>}
  </div>
}
