import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { DocumentBlockDraft } from '@shared/contracts'
import { createMarkdownSourceDraft, markdownSourceChange, markdownSourceDraftToBlocks, replaceMarkdownSource, replaceMarkdownSourceChanges, type MarkdownSourceDraft, type MarkdownSourceChange } from '../utils/markdownSourceDraft'
import { formatMarkdownSelection, markdownFormatShortcut, type MarkdownFormat } from '../utils/markdownFormatting'
import { isImeKeyboardEvent } from '../utils/imeKeyboard'
import { MarkdownFormatToolbar } from './MarkdownFormatToolbar'
import './document-markdown-source.css'

type Snapshot = { draft: MarkdownSourceDraft; start: number; end: number }

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
  const editor = useRef<HTMLTextAreaElement>(null)
  const beforeInput = useRef<{ start: number; end: number } | null>(null)
  const composing = useRef(false)
  const compositionHistoryIndex = useRef(-1)
  const [isComposing, setIsComposing] = useState(false)
  const [error, setError] = useState('')
  const labelId = useId(), hintId = useId()

  useEffect(() => {
    const returnFocus = document.querySelector<HTMLElement>('.document-header-more-button')
    dialog.current?.showModal()
    editor.current?.focus()
    const target = editor.current
    // React's synthetic beforeInput can be derived from textInput, after the
    // textarea has changed. Native beforeinput captures the original selection.
    const capture = () => { if (target) beforeInput.current = { start: target.selectionStart, end: target.selectionEnd } }
    target?.addEventListener('beforeinput', capture)
    return () => { target?.removeEventListener('beforeinput', capture); returnFocus?.focus() }
  }, [])

  const display = (next: Snapshot, focus = false) => {
    current.current = next
    setSnapshot(next)
    if (focus) requestAnimationFrame(() => {
      editor.current?.focus()
      editor.current?.setSelectionRange(next.start, next.end)
    })
  }
  const commit = (next: Snapshot, input = false, previousSelection?: { start: number; end: number }) => {
    if (next.draft === current.current.draft) return
    const state = history.current
    state.entries[state.index] = { ...current.current,
      start: previousSelection?.start ?? editor.current?.selectionStart ?? current.current.start,
      end: previousSelection?.end ?? editor.current?.selectionEnd ?? current.current.end }
    state.entries.length = state.index + 1
    if (input && state.index > 0 && (Date.now() - state.lastInput < 600
      || composing.current && state.index > compositionHistoryIndex.current)) state.entries[state.index] = next
    else { state.entries.push(next); state.index++ }
    if (state.entries.length > 80) { state.entries.shift(); state.index-- }
    state.lastInput = input ? Date.now() : 0
    display(next, !input)
  }
  const undo = (direction: -1 | 1) => {
    if (composing.current) return
    const state = history.current, index = state.index + direction
    if (index < 0 || index >= state.entries.length) return
    state.index = index; state.lastInput = 0
    display(state.entries[index], true)
  }
  const format = (kind: MarkdownFormat) => {
    const target = editor.current
    if (!target || composing.current) return
    const changes: MarkdownSourceChange[] = [], draft = current.current.draft
    const result = formatMarkdownSelection(draft.source, target.selectionStart, target.selectionEnd, kind,
      isZh ? '链接' : 'Link', (change) => changes.push(change))
    commit({ draft: replaceMarkdownSourceChanges(draft, changes), start: result.start, end: result.end })
  }
  const apply = () => {
    if (composing.current) return
    if (onApply(markdownSourceDraftToBlocks(current.current.draft))) onClose()
    else setError(isZh ? '正文已在其他位置更新。请先复制当前源码，再重新打开以合并更改。' : 'The document changed elsewhere. Copy this source, then reopen to merge your changes.')
  }
  return createPortal(<dialog ref={dialog} className="document-markdown-source" aria-labelledby={labelId} aria-describedby={hintId}
    onKeyDown={(event) => event.stopPropagation()} onCancel={(event) => { event.preventDefault(); if (!composing.current) onClose() }}>
    <header><h3 id={labelId}>{isZh ? '编辑 Markdown 源码' : 'Edit Markdown source'}</h3>
      <button type="button" className="secondary-button" disabled={isComposing} onClick={onClose}>{isZh ? '取消' : 'Cancel'}</button></header>
    <p id={hintId}>{isZh ? '在完整正文中连续选择和编辑；应用后自动保存。' : 'Select and edit across the complete body. Changes autosave after applying.'}</p>
    <MarkdownFormatToolbar isZh={isZh} onFormat={format} onReturnToEditor={() => editor.current?.focus()} />
    <textarea ref={editor} aria-label={isZh ? 'Markdown 正文源码' : 'Markdown body source'} spellCheck={false} value={snapshot.draft.source}
      onChange={(event) => {
        const target = event.currentTarget
        const selection = beforeInput.current
        const change = markdownSourceChange(current.current.draft.source, target.value, selection?.start, selection?.end)
        beforeInput.current = null
        commit({ draft: replaceMarkdownSource(current.current.draft, change), start: target.selectionStart, end: target.selectionEnd }, true, selection ?? undefined)
      }}
      onCompositionStart={() => { composing.current = true; setIsComposing(true); history.current.lastInput = 0; compositionHistoryIndex.current = history.current.index }}
      onCompositionEnd={() => { composing.current = false; setIsComposing(false); history.current.lastInput = Date.now() }}
      onKeyDown={(event) => {
        if (isImeKeyboardEvent(event.nativeEvent, composing.current)) { event.stopPropagation(); return }
        const key = event.key.toLowerCase(), modifier = (event.ctrlKey || event.metaKey) && !event.altKey
        if (modifier && (key === 'z' || key === 'y')) { event.preventDefault(); undo(key === 'y' || event.shiftKey ? 1 : -1); return }
        if (modifier && key === 's') { event.preventDefault(); apply(); return }
        if (event.altKey && event.key === 'F10') {
          event.preventDefault(); dialog.current?.querySelector<HTMLButtonElement>('[role="toolbar"] button')?.focus(); return
        }
        const kind = markdownFormatShortcut(event)
        if (kind) { event.preventDefault(); format(kind) }
      }} />
    {error && <p role="alert">{error}</p>}
    <footer><button type="button" className="secondary-button" disabled={isComposing || history.current.index === 0} onClick={() => undo(-1)}>{isZh ? '撤销' : 'Undo'}</button>
      <button type="button" className="secondary-button" disabled={isComposing || history.current.index + 1 >= history.current.entries.length} onClick={() => undo(1)}>{isZh ? '重做' : 'Redo'}</button>
      <button type="button" className="primary-button" disabled={isComposing} onClick={apply}>{isZh ? '应用更改' : 'Apply changes'}</button></footer>
  </dialog>, document.body)
}
