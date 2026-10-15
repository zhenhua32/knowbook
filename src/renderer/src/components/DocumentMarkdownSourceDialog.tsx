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
import { importAttachmentFiles } from '../utils/attachments'
import { attachmentMarkdown } from '@shared/attachments'
import { createMarkdownSourceSession, markdownSourceEditorText } from '../utils/markdownSourceSession'
import './document-markdown-source.css'

type Snapshot<Draft> = { draft: Draft; start: number; end: number }
const sourceCommand = Annotation.define<boolean>()

export type MarkdownSourceDialogText = {
  title: string; hint: string; editorLabel: string; cancel: string; undo: string; redo: string; apply: string
  applying: string; importing: string; attachments: string; conflict: string; laterEdits: string; attachmentChanged: string
}
export type MarkdownSourceDialogProps<Draft extends { source: string }> = {
  sessionKey: object
  createDraft: () => Draft
  replaceChanges: (draft: Draft, changes: readonly MarkdownSourceChange[]) => Draft
  onApply: (draft: Draft) => boolean | Promise<boolean>
  isCurrent: () => boolean
  getReturnFocus: () => HTMLElement | null
  onCompositionChange?: (composing: boolean) => void
  isZh: boolean
  onClose: () => void
  text?: Partial<MarkdownSourceDialogText>
}

export default function DocumentMarkdownSourceDialog({ blocks, isZh, onApply, onClose }: {
  blocks: DocumentBlockDraft[]
  isZh: boolean
  onApply: (blocks: DocumentBlockDraft[]) => boolean
  onClose: () => void
}) {
  const sessionKey = useRef({}).current
  const opener = useRef<HTMLElement | null>(null)
  return <MarkdownSourceDialog<MarkdownSourceDraft> sessionKey={sessionKey} isZh={isZh} onClose={onClose}
    createDraft={() => createMarkdownSourceDraft(blocks)}
    replaceChanges={(draft, changes) => replaceMarkdownSourceChanges(draft, [...changes])}
    onApply={draft => onApply(markdownSourceDraftToBlocks(draft))} isCurrent={() => true}
    getReturnFocus={() => {
      if (!opener.current) opener.current = document.querySelector<HTMLElement>('.document-header-more-button')
      return opener.current
    }} />
}

/** A changed opening identity remounts the one CM implementation. Old drafts
 * never flow into a new session's replace/apply callbacks, even at identical text. */
export function MarkdownSourceDialog<Draft extends { source: string }>(props: MarkdownSourceDialogProps<Draft>) {
  const opening = useRef({ key: props.sessionKey, generation: 0 })
  if (opening.current.key !== props.sessionKey) opening.current = { key: props.sessionKey, generation: opening.current.generation + 1 }
  const key = props.sessionKey
  return <MarkdownSourceDialogOpening key={opening.current.generation} {...props} ownsOpening={() => opening.current.key === key} />
}

function MarkdownSourceDialogOpening<Draft extends { source: string }>(props: MarkdownSourceDialogProps<Draft> & { ownsOpening: () => boolean }) {
  const { isZh } = props
  const [snapshot, setSnapshot] = useState<Snapshot<Draft>>(() => ({ draft: props.createDraft(), start: 0, end: 0 }))
  const current = useRef(snapshot), live = useRef(props); live.current = props
  const history = useRef({ entries: [snapshot], index: 0, lastInput: 0 })
  const dialog = useRef<HTMLDialogElement>(null)
  const editorHost = useRef<HTMLDivElement>(null)
  const editor = useRef<EditorView | null>(null)
  const composing = useRef(false)
  const compositionCallback = useRef<((composing: boolean) => void) | undefined>(undefined)
  const mounted = useRef(false), applying = useRef<object | null>(null)
  const compositionHistoryIndex = useRef(-1)
  const [isComposing, setIsComposing] = useState(false)
  const [error, setError] = useState('')
  const [isApplying, setIsApplying] = useState(false)
  const [importing, setImporting] = useState(false), importLock = useRef(false)
  const labelId = useId(), hintId = useId()
  const text: MarkdownSourceDialogText = {
    title: isZh ? '编辑 Markdown 源码' : 'Edit Markdown source',
    hint: isZh ? '在完整正文中连续选择和编辑；应用后自动保存。' : 'Select and edit across the complete body. Changes autosave after applying.',
    editorLabel: isZh ? 'Markdown 正文源码' : 'Markdown body source', cancel: isZh ? '取消' : 'Cancel',
    undo: isZh ? '撤销' : 'Undo', redo: isZh ? '重做' : 'Redo', apply: isZh ? '应用更改' : 'Apply changes',
    applying: isZh ? '正在应用…' : 'Applying…', importing: isZh ? '正在导入附件…' : 'Importing attachments…',
    attachments: isZh ? '插入图片或附件（单个最多 25 MB）' : 'Insert images or attachments (up to 25 MB each)',
    conflict: isZh ? '正文已在其他位置更新。请先复制当前源码，再重新打开以合并更改。' : 'The document changed elsewhere. Copy this source, then reopen to merge your changes.',
    laterEdits: isZh ? '提交的版本已应用；之后的输入仍保留在此，请检查后再次应用。' : 'The submitted version was applied. Later input remains here; review it before applying again.',
    attachmentChanged: isZh ? '源码已变化，附件尚未插入，请重试。' : 'The source changed; retry inserting the attachments.',
    ...props.text
  }
  const canUse = () => mounted.current && live.current.ownsOpening() && live.current.isCurrent()
  const sourceSession = useRef<ReturnType<typeof createMarkdownSourceSession<Draft>> | null>(null)
  if (!sourceSession.current) sourceSession.current = createMarkdownSourceSession({ draft: snapshot.draft,
    replaceChanges: (draft, changes) => live.current.replaceChanges(draft, changes), isCurrent: canUse,
    onError: cause => { if (canUse()) setError(cause instanceof Error ? cause.message : String(cause)) } })
  const session = sourceSession.current

  const record = (before: Snapshot<Draft>, next: Snapshot<Draft>, input: boolean) => {
    const state = history.current
    state.entries[state.index] = before
    state.entries.length = state.index + 1
    if (input && state.index > 0 && (Date.now() - state.lastInput < 600
      || composing.current && state.index > compositionHistoryIndex.current)) state.entries[state.index] = next
    else { state.entries.push(next); state.index++ }
    if (state.entries.length > 80) {
      state.entries.shift(); state.index--
      compositionHistoryIndex.current = Math.max(-1, compositionHistoryIndex.current - 1)
    }
    state.lastInput = input ? Date.now() : 0
  }
  const undo = (direction: -1 | 1) => {
    const view = editor.current
    if (!view || composing.current || !canUse()) return
    const state = history.current, index = state.index + direction
    if (index < 0 || index >= state.entries.length) return
    const next = state.entries[index], source = markdownSourceEditorText(next.draft.source), before = view.state.doc.toString()
    view.dispatch({ changes: before === source ? [] : markdownSourceChange(before, source),
      selection: { anchor: next.start, head: next.end }, scrollIntoView: true, annotations: session.replay.of(next.draft) })
    if (session.read(view.state) !== next.draft) return
    state.index = index; state.lastInput = 0
    setSnapshot(current.current)
    if (canUse() && !view.hasFocus) view.focus()
  }
  const format = (kind: MarkdownFormat) => {
    const view = editor.current
    if (!view || composing.current || !canUse()) return
    try {
      const changes: MarkdownSourceChange[] = [], selection = view.state.selection.main
      const result = formatMarkdownSelection(view.state.doc.toString(), selection.from, selection.to, kind,
        isZh ? '链接' : 'Link', change => changes.push(change))
      // All edits are in the original CM coordinates. The field maps them to
      // raw draft offsets once, before the transaction can change the DOM.
      view.dispatch({ changes: changes.toSorted((a, b) => a.from - b.from), selection: { anchor: result.start, head: result.end },
        scrollIntoView: true, annotations: sourceCommand.of(true) })
      if (canUse() && !view.hasFocus) view.focus()
    } catch (cause) { if (canUse()) setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  const close = () => { if (canUse() && !composing.current) live.current.onClose() }
  const apply = async () => {
    if (composing.current || importLock.current || applying.current || !canUse()) return
    const submitted = current.current.draft, receipt = {}, opening = live.current
    applying.current = receipt; setIsApplying(true); setError('')
    try {
      const accepted = await opening.onApply(submitted)
      if (!canUse() || live.current.sessionKey !== opening.sessionKey) return
      if (accepted === true) {
        if (current.current.draft === submitted && !composing.current && !importLock.current) opening.onClose()
        else setError(text.laterEdits)
      } else if (accepted === false) setError(text.conflict)
      else throw new Error('Markdown source Apply must return a boolean result')
    } catch (cause) {
      if (canUse() && live.current.sessionKey === opening.sessionKey) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (applying.current === receipt) {
        applying.current = null
        if (canUse()) setIsApplying(false)
      }
    }
  }
  const insertFiles = async (files: File[], position?: number) => {
    const view = editor.current
    if (!view || !files.length || importLock.current || composing.current || !canUse()) return
    importLock.current = true; setImporting(true); setError('')
    const draft = current.current.draft, selection = view.state.selection.main
    const from = position ?? selection.from, to = position ?? selection.to
    try {
      const attachments = await importAttachmentFiles(files)
      if (editor.current !== view || !canUse()) return
      if (current.current.draft !== draft) throw new Error(text.attachmentChanged)
      const insert = attachments.map(attachmentMarkdown).join('\n')
      const changes = [{ from, to, insert }]
      view.dispatch({ changes, selection: { anchor: from + insert.length }, scrollIntoView: true, annotations: sourceCommand.of(true) })
    } catch (error) { if (editor.current === view && canUse()) setError(String(error)) }
    finally { importLock.current = false; if (editor.current === view && canUse()) setImporting(false) }
  }
  // The view lives for the dialog's lifetime; event handlers use current props
  // and callbacks without rebuilding its document or interrupting composition.
  const handlers = useRef<{ update: (update: ViewUpdate) => void; keydown: (event: KeyboardEvent) => boolean }>({
    update: (_update: ViewUpdate) => {},
    keydown: (_event: KeyboardEvent) => false
  })
  handlers.current = {
    update: update => {
      if (!canUse()) return
      let changed = false
      for (const transaction of update.transactions) {
        const draft = session.read(transaction.state), previous = session.read(transaction.startState)
        const selected = transaction.newSelection.main, before = transaction.startState.selection.main
        const next = { draft, start: selected.from, end: selected.to }
        if (draft !== previous && !session.isReplay(transaction)) {
          record({ draft: previous, start: before.from, end: before.to }, next, transaction.annotation(sourceCommand) !== true)
        }
        changed ||= draft !== previous
        current.current = next
      }
      if (changed) setSnapshot(current.current)
    },
    keydown: event => {
      if (isImeKeyboardEvent(event, composing.current)) { event.stopPropagation(); return false }
      const key = event.key.toLowerCase(), modifier = (event.ctrlKey || event.metaKey) && !event.altKey
      if (modifier && (key === 'z' || key === 'y')) { undo(key === 'y' || event.shiftKey ? 1 : -1); return true }
      if (modifier && key === 's') { void apply(); return true }
      if (event.altKey && event.key === 'F10') {
        dialog.current?.querySelector<HTMLButtonElement>('[role="toolbar"] button')?.focus(); return true
      }
      const kind = markdownFormatShortcut(event)
      if (kind) { format(kind); return true }
      return false
    }
  }
  useLayoutEffect(() => {
    mounted.current = true
    const returnFocus = live.current.getReturnFocus()
    if (canUse()) dialog.current?.showModal()
    const view = new EditorView({ parent: editorHost.current!, state: EditorState.create({ doc: markdownSourceEditorText(current.current.draft.source),
      extensions: [session.extension, EditorState.tabSize.of(2), EditorView.lineWrapping, drawSelection(), keymap.of(standardKeymap),
        EditorView.theme({ '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
          backgroundColor: 'color-mix(in srgb, var(--kb-accent) 25%, transparent)'
        } }),
        EditorView.contentAttributes.of({ 'aria-label': text.editorLabel, 'aria-describedby': hintId, spellcheck: 'false' }),
        EditorView.updateListener.of(update => handlers.current.update(update)),
        Prec.highest(EditorView.domEventHandlers({
          keydown: event => handlers.current.keydown(event),
          compositionstart: () => {
            if (composing.current || !canUse()) return false
            compositionCallback.current = live.current.onCompositionChange
            composing.current = true; setIsComposing(true)
            history.current.lastInput = 0; compositionHistoryIndex.current = history.current.index
            compositionCallback.current?.(true)
            return false
          },
          compositionend: () => {
            if (!composing.current) return false
            const callback = compositionCallback.current
            compositionCallback.current = undefined
            composing.current = false; setIsComposing(false); history.current.lastInput = Date.now()
            // A real end belongs to the callback captured by that exact start,
            // even if parent callbacks changed while native IME was active.
            callback?.(false)
            return false
          }
        }))]
    }) })
    editor.current = view
    if (canUse()) view.focus()
    return () => {
      const active = document.activeElement
      const restore = live.current.ownsOpening() && live.current.isCurrent() && document.hasFocus()
        && returnFocus?.isConnected && (active === document.body || active instanceof Node && dialog.current?.contains(active))
      mounted.current = false
      editor.current = null
      // Layout cleanup runs before React removes the modal. Close it first so
      // the background trigger is no longer inert when restoring its focus.
      dialog.current?.close()
      view.destroy()
      // Cleanup cannot manufacture compositionend or transfer an old lease to
      // another opening. The owning shell handles unresolved IME/recovery.
      if (restore && returnFocus) returnFocus.focus({ preventScroll: true })
    }
  }, [])

  return createPortal(<dialog ref={dialog} className="document-markdown-source" aria-labelledby={labelId} aria-describedby={hintId}
    onPasteCapture={event => { if (event.clipboardData.files.length) { event.preventDefault(); event.stopPropagation(); void insertFiles(Array.from(event.clipboardData.files)) } }}
    onDragOverCapture={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.stopPropagation() } }}
    onDropCapture={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.stopPropagation(); void insertFiles(Array.from(event.dataTransfer.files), editor.current?.posAtCoords({ x: event.clientX, y: event.clientY }) ?? undefined) } }}
    onKeyDown={event => {
      event.stopPropagation()
      // CodeMirror handles editor events first. Dialog controls use the same
      // commands without replaying an already handled editor transaction.
      if (!event.defaultPrevented && handlers.current.keydown(event.nativeEvent)) event.preventDefault()
    }} onCancel={event => { event.preventDefault(); close() }}>
    <header><h3 id={labelId}>{text.title}</h3>
      <button type="button" className="secondary-button" disabled={isComposing} onClick={close}>{text.cancel}</button></header>
    <p id={hintId}>{text.hint}</p>
    <MarkdownFormatToolbar isZh={isZh} onFormat={format} onReturnToEditor={() => { if (canUse()) editor.current?.focus() }} />
    <label className="markdown-source-attachments">{importing ? text.importing : text.attachments}
      <input type="file" multiple disabled={importing || isComposing} onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void insertFiles(files) }} /></label>
    <div ref={editorHost} className="document-markdown-source-editor" />
    {error && <p role="alert">{error}</p>}
    <footer><button type="button" className="secondary-button" disabled={isComposing || history.current.index === 0} onClick={() => undo(-1)}>{text.undo}</button>
      <button type="button" className="secondary-button" disabled={isComposing || history.current.index + 1 >= history.current.entries.length} onClick={() => undo(1)}>{text.redo}</button>
      <button type="button" className="primary-button" disabled={isComposing || importing || isApplying} onClick={() => { void apply() }}>{isApplying ? text.applying : text.apply}</button></footer>
  </dialog>, document.body)
}
