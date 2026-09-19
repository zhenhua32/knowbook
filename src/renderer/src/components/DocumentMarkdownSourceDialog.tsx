import { useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Annotation, EditorState, Prec } from '@codemirror/state'
import { EditorView, drawSelection, keymap, type ViewUpdate } from '@codemirror/view'
import { standardKeymap } from '@codemirror/commands'
import type { DocumentBlockDraft } from '@shared/contracts'
import { createMarkdownSourceDraft, markdownSourceChange, markdownSourceDraftToBlocks, replaceMarkdownSourceChanges, type MarkdownSourceDraft, type MarkdownSourceChange } from '../utils/markdownSourceDraft'
import { formatMarkdownSelection, markdownFormatShortcut, type MarkdownFormat } from '../utils/markdownFormatting'
import { isImeKeyboardEvent } from '../utils/imeKeyboard'
import { MarkdownFormatToolbar } from './MarkdownFormatToolbar'
import './document-markdown-source.css'

type Snapshot = { draft: MarkdownSourceDraft; start: number; end: number }
const replay = Annotation.define<boolean>()

export default function DocumentMarkdownSourceDialog({ blocks, isZh, onApply, onClose }: {
  blocks: DocumentBlockDraft[]
  isZh: boolean
  onApply: (blocks: DocumentBlockDraft[]) => boolean
  onClose: () => void
}) {
  const [snapshot, setSnapshot] = useState<Snapshot>(() => ({ draft: createMarkdownSourceDraft(blocks), start: 0, end: 0 }))
  const current = useRef(snapshot)
  const history = useRef({ entries: [snapshot], index: 0, lastInput: 0 })
  const dialog = useRef<HTMLDialogElement>(null)
  const editorHost = useRef<HTMLDivElement>(null)
  const editor = useRef<EditorView | null>(null)
  const composing = useRef(false)
  const compositionHistoryIndex = useRef(-1)
  const [isComposing, setIsComposing] = useState(false)
  const [error, setError] = useState('')
  const labelId = useId(), hintId = useId()

  const display = (next: Snapshot, focus = false, changes?: MarkdownSourceChange[]) => {
    current.current = next
    const view = editor.current
    // Native input is already in the view. Programmatic transactions redraw
    // only its visible lines, even when formatting the entire document.
    if (view && focus) {
      const before = view.state.doc.toString()
      // The formatter emits right-to-left edits. CodeMirror can accept those,
      // but composes each out-of-order edit; sorting avoids quadratic work.
      view.dispatch({ changes: changes?.toSorted((a, b) => a.from - b.from)
        ?? (before === next.draft.source ? [] : markdownSourceChange(before, next.draft.source)),
        selection: { anchor: next.start, head: next.end }, scrollIntoView: true, annotations: replay.of(true) })
      if (!view.hasFocus) view.focus()
    }
    setSnapshot(next)
  }
  const commit = (next: Snapshot, input = false, previousSelection?: { start: number; end: number }, changes?: MarkdownSourceChange[]) => {
    if (next.draft === current.current.draft) return
    const state = history.current, selection = editor.current?.state.selection.main
    state.entries[state.index] = { ...current.current,
      start: previousSelection?.start ?? selection?.from ?? current.current.start,
      end: previousSelection?.end ?? selection?.to ?? current.current.end }
    state.entries.length = state.index + 1
    if (input && state.index > 0 && (Date.now() - state.lastInput < 600
      || composing.current && state.index > compositionHistoryIndex.current)) state.entries[state.index] = next
    else { state.entries.push(next); state.index++ }
    if (state.entries.length > 80) {
      state.entries.shift(); state.index--
      compositionHistoryIndex.current = Math.max(-1, compositionHistoryIndex.current - 1)
    }
    state.lastInput = input ? Date.now() : 0
    display(next, !input, changes)
  }
  const undo = (direction: -1 | 1) => {
    if (composing.current) return
    const state = history.current, index = state.index + direction
    if (index < 0 || index >= state.entries.length) return
    state.index = index; state.lastInput = 0
    display(state.entries[index], true)
  }
  const format = (kind: MarkdownFormat) => {
    const view = editor.current
    if (!view || composing.current) return
    const changes: MarkdownSourceChange[] = [], draft = current.current.draft, selection = view.state.selection.main
    const result = formatMarkdownSelection(draft.source, selection.from, selection.to, kind,
      isZh ? '链接' : 'Link', change => changes.push(change))
    commit({ draft: replaceMarkdownSourceChanges(draft, changes), start: result.start, end: result.end }, false,
      { start: selection.from, end: selection.to }, changes)
  }
  const apply = () => {
    if (composing.current) return
    if (onApply(markdownSourceDraftToBlocks(current.current.draft))) onClose()
    else setError(isZh ? '正文已在其他位置更新。请先复制当前源码，再重新打开以合并更改。' : 'The document changed elsewhere. Copy this source, then reopen to merge your changes.')
  }
  // The view lives for the dialog's lifetime; event handlers use current props
  // and callbacks without rebuilding its document or interrupting composition.
  const handlers = useRef<{ update: (update: ViewUpdate) => void; keydown: (event: KeyboardEvent) => boolean }>({
    update: (_update: ViewUpdate) => {},
    keydown: (_event: KeyboardEvent) => false
  })
  handlers.current = {
    update: update => {
      if (!update.docChanged || update.transactions.every(transaction => transaction.annotation(replay))) return
      const changes: MarkdownSourceChange[] = []
      update.changes.iterChanges((from, to, _fromB, _toB, insert) => changes.push({ from, to, insert: insert.toString() }))
      const selection = update.state.selection.main, before = update.startState.selection.main
      commit({ draft: replaceMarkdownSourceChanges(current.current.draft, changes), start: selection.from, end: selection.to }, true,
        { start: before.from, end: before.to })
    },
    keydown: event => {
      if (isImeKeyboardEvent(event, composing.current)) { event.stopPropagation(); return false }
      const key = event.key.toLowerCase(), modifier = (event.ctrlKey || event.metaKey) && !event.altKey
      if (modifier && (key === 'z' || key === 'y')) { undo(key === 'y' || event.shiftKey ? 1 : -1); return true }
      if (modifier && key === 's') { apply(); return true }
      if (event.altKey && event.key === 'F10') {
        dialog.current?.querySelector<HTMLButtonElement>('[role="toolbar"] button')?.focus(); return true
      }
      const kind = markdownFormatShortcut(event)
      if (kind) { format(kind); return true }
      return false
    }
  }
  useLayoutEffect(() => {
    const returnFocus = document.querySelector<HTMLElement>('.document-header-more-button')
    dialog.current?.showModal()
    const view = new EditorView({ parent: editorHost.current!, state: EditorState.create({ doc: current.current.draft.source,
      extensions: [EditorState.tabSize.of(2), EditorView.lineWrapping, drawSelection(), keymap.of(standardKeymap),
        EditorView.theme({ '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
          backgroundColor: 'color-mix(in srgb, var(--kb-accent) 25%, transparent)'
        } }),
        EditorView.contentAttributes.of({ 'aria-label': isZh ? 'Markdown 正文源码' : 'Markdown body source', 'aria-describedby': hintId, spellcheck: 'false' }),
        EditorView.updateListener.of(update => handlers.current.update(update)),
        Prec.highest(EditorView.domEventHandlers({
          keydown: event => handlers.current.keydown(event),
          compositionstart: () => { composing.current = true; setIsComposing(true); history.current.lastInput = 0; compositionHistoryIndex.current = history.current.index },
          compositionend: () => { composing.current = false; setIsComposing(false); history.current.lastInput = Date.now() }
        }))]
    }) })
    editor.current = view
    view.focus()
    return () => { editor.current = null; view.destroy(); returnFocus?.focus() }
  }, [])

  return createPortal(<dialog ref={dialog} className="document-markdown-source" aria-labelledby={labelId} aria-describedby={hintId}
    onKeyDown={event => event.stopPropagation()} onCancel={event => { event.preventDefault(); if (!composing.current) onClose() }}>
    <header><h3 id={labelId}>{isZh ? '编辑 Markdown 源码' : 'Edit Markdown source'}</h3>
      <button type="button" className="secondary-button" disabled={isComposing} onClick={onClose}>{isZh ? '取消' : 'Cancel'}</button></header>
    <p id={hintId}>{isZh ? '在完整正文中连续选择和编辑；应用后自动保存。' : 'Select and edit across the complete body. Changes autosave after applying.'}</p>
    <MarkdownFormatToolbar isZh={isZh} onFormat={format} onReturnToEditor={() => editor.current?.focus()} />
    <div ref={editorHost} className="document-markdown-source-editor" />
    {error && <p role="alert">{error}</p>}
    <footer><button type="button" className="secondary-button" disabled={isComposing || history.current.index === 0} onClick={() => undo(-1)}>{isZh ? '撤销' : 'Undo'}</button>
      <button type="button" className="secondary-button" disabled={isComposing || history.current.index + 1 >= history.current.entries.length} onClick={() => undo(1)}>{isZh ? '重做' : 'Redo'}</button>
      <button type="button" className="primary-button" disabled={isComposing} onClick={apply}>{isZh ? '应用更改' : 'Apply changes'}</button></footer>
  </dialog>, document.body)
}
