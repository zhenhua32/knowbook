import { Annotation, EditorState, StateField, type Extension, type Transaction } from '@codemirror/state'
import type { MarkdownSourceChange } from './markdownSourceDraft'

export type MarkdownSourceSessionDraft = { source: string }
export interface MarkdownSourceSessionOptions<Draft extends MarkdownSourceSessionDraft> {
  draft: Draft
  replaceChanges: (draft: Draft, changes: readonly MarkdownSourceChange[]) => Draft
  /** A cold producer may reject foreign opening/replay receipts. Ordinary
   * sessions omit this port and retain their existing behavior and shape. */
  validateDraft?: (draft: Draft) => void
  isCurrent?: () => boolean
  onError?: (error: unknown) => void
}

/** CodeMirror counts every physical line ending as one position. Drafts keep
 * their original bytes, including untouched CRLF, so only the view is normalized. */
export function markdownSourceEditorText(source: string): string { return source.replace(/\r\n?/g, '\n') }

function rawChanges(source: string, transaction: Transaction): MarkdownSourceChange[] {
  const offsets: number[] = []
  if (source.includes('\r')) {
    offsets.push(0)
    for (let index = 0; index < source.length; index++) {
      if (source[index] === '\r' && source[index + 1] === '\n') index++
      offsets.push(index + 1)
    }
  }
  const changes: MarkdownSourceChange[] = []
  transaction.changes.iterChanges((from, to, _fromB, _toB, insert) => {
    changes.push({ from: offsets.length ? offsets[from] : from, to: offsets.length ? offsets[to] : to, insert: insert.toString() })
  })
  return changes
}

/** The field is the single draft authority for this editor opening. Protected
 * edits fail before CodeMirror accepts its transaction; the view listener only
 * reads accepted drafts. Programmatic callers must use normal filtered dispatch,
 * including replay annotations, never CodeMirror's filter:false escape hatch. */
export function createMarkdownSourceSession<Draft extends MarkdownSourceSessionDraft>(options: MarkdownSourceSessionOptions<Draft>) {
  const replay = Annotation.define<Draft>(), candidates = new WeakMap<Transaction, Draft>()
  const candidate = (transaction: Transaction): Draft => {
    const cached = candidates.get(transaction)
    if (cached) return cached
    const before = transaction.startState.field(field), restored = transaction.annotation(replay)
    const next = restored ?? (transaction.docChanged ? options.replaceChanges(before, rawChanges(before.source, transaction)) : before)
    if (!next || typeof next.source !== 'string' || markdownSourceEditorText(next.source) !== transaction.newDoc.toString()) {
      throw new Error('Markdown source draft and editor text disagree')
    }
    options.validateDraft?.(next)
    candidates.set(transaction, next)
    return next
  }
  const field: StateField<Draft> = StateField.define<Draft>({
    create(state) {
      if (typeof options.draft?.source !== 'string' || markdownSourceEditorText(options.draft.source) !== state.doc.toString()) {
        throw new Error('Markdown source opening draft and editor text disagree')
      }
      options.validateDraft?.(options.draft)
      return options.draft
    },
    update(value, transaction) {
      return transaction.docChanged || transaction.annotation(replay) !== undefined ? candidate(transaction) : value
    }
  })
  const extension: Extension = [field, EditorState.transactionFilter.of(transaction => {
    if (!transaction.docChanged && transaction.annotation(replay) === undefined) return transaction
    try {
      if (options.isCurrent?.() === false) throw new Error('This Markdown source opening is no longer current')
      candidate(transaction)
      return transaction
    } catch (error) {
      options.onError?.(error)
      return []
    }
  })]
  return { field, replay, extension, read: (state: EditorState) => state.field(field),
    isReplay: (transaction: Transaction) => transaction.annotation(replay) !== undefined }
}
