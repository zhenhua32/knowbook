import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { randomUUID } from 'node:crypto'
import { register } from 'node:module'
import { act, createElement } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { JSDOM } from 'jsdom'
import type { MarkdownSourceDialogProps } from '../src/renderer/src/components/DocumentMarkdownSourceDialog'
import { createMarkdownSourceSession, markdownSourceEditorText } from '../src/renderer/src/utils/markdownSourceSession'
import { applySyncedSourceChanges, createSyncedSourceSnapshot } from '../src/renderer/src/features/synced-blocks/sourceAnchors'
import { serializeSyncedBlockPayload, SYNCED_BLOCK_FENCE_INFO } from '../src/shared/syncedBlockValidation'
import type { MarkdownSourceChange } from '../src/renderer/src/utils/markdownSourceDraft'
import type { DocumentBlockDraft } from '../src/shared/contracts'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
const { MarkdownSourceDialog, default: DocumentMarkdownSourceDialog } = await import('../src/renderer/src/components/DocumentMarkdownSourceDialog')

function reference(eol = '\n', prefix = 'Text\n\n') {
  const groupId = randomUUID(), original = '```' + SYNCED_BLOCK_FENCE_INFO + eol
    + serializeSyncedBlockPayload({ version: 1, groupId }) + eol + '```'
  return createSyncedSourceSnapshot({ sessionKey: 'opening', sourceDocumentId: ' 宿主:正文 ', source: prefix + original,
    anchors: [{ key: 'ref', groupId, instanceId: randomUUID(), from: prefix.length, to: prefix.length + original.length, newRefSource: null }] })
}
function protectedSession(draft = reference()) {
  const errors: unknown[] = [], calls: MarkdownSourceChange[][] = []
  const session = createMarkdownSourceSession({ draft, onError: error => errors.push(error), replaceChanges: (before, changes) => {
    calls.push([...changes]); return applySyncedSourceChanges(before, changes)
  } })
  const state = EditorState.create({ doc: markdownSourceEditorText(draft.source), extensions: session.extension })
  return { session, state, errors, calls }
}

test('a protected edit is filtered before CodeMirror accepts either text or selection and is calculated once', () => {
  const draft = reference(), { session, state, errors, calls } = protectedSession(draft)
  const from = draft.source.indexOf('groupId')
  const transaction = state.update({ changes: { from, to: from + 1, insert: 'X' }, selection: { anchor: from + 1 } })
  assert.equal(transaction.docChanged, false)
  assert.equal(transaction.state.doc.toString(), state.doc.toString())
  assert.equal(transaction.state.selection.main.anchor, state.selection.main.anchor)
  assert.equal(session.read(transaction.state), draft)
  assert.equal(errors.length, 1); assert.equal(calls.length, 1)
})

test('full same-text replacement loses public reference identity and replay restores the complete same-text draft', () => {
  const draft = reference(), { session, state, calls } = protectedSession(draft), anchor = draft.anchors[0]
  const replacement = state.update({ changes: { from: anchor.from, to: anchor.to, insert: anchor.original } })
  const next = replacement.state
  assert.equal(next.doc.toString(), state.doc.toString())
  assert.equal(session.read(next).anchors.length, 0)
  const restored = next.update({ annotations: session.replay.of(draft) })
  assert.equal(restored.docChanged, false)
  assert.equal(session.read(restored.state), draft)
  assert.equal(session.isReplay(restored), true)
  assert.equal(calls.length, 1, 'Replay must not infer provenance by passing identical text through replaceChanges')
})

test('right-to-left disjoint formatting specs use one original-coordinate candidate', () => {
  const draft = reference(), { session, state, calls } = protectedSession(draft)
  const transaction = state.update({ changes: [{ from: 4, insert: '**' }, { from: 0, insert: '**' }] })
  assert.equal(session.read(transaction.state).source, '**Text**\n\n' + draft.anchors[0].original)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], [{ from: 0, to: 0, insert: '**' }, { from: 4, to: 4, insert: '**' }])
  assert.equal(session.read(transaction.state), session.read(transaction.state), 'Repeated field reads reuse the exact accepted candidate')
  assert.equal(calls.length, 1)
})

test('sequential multi-spec and multi-transaction batches read each real startState draft', () => {
  const { session, state, calls } = protectedSession()
  const first = state.update({ changes: { from: 0, insert: 'A' } }, { changes: { from: 1, insert: 'B' }, sequential: true })
  assert.ok(session.read(first.state).source.startsWith('ABText'))
  assert.equal(calls.length, 1)
  const second = first.state.update({ changes: { from: 2, to: 6, insert: '中文🙂' } })
  assert.ok(session.read(second.state).source.startsWith('AB中文🙂'))
  assert.equal(calls.length, 2)
  assert.equal(session.read(state).source.startsWith('Text'), true)
  assert.ok(session.read(second.state).anchors.length === 1)
})

test('mixed CRLF, lone CR, LF, BOM and surrogate pairs map CM changes to exact raw draft boundaries', () => {
  const draft = reference('\r\n', '\uFEFF🙂\r\nA\rB\n\n'), { session, state, calls, errors } = protectedSession(draft)
  const lineBreak = state.doc.toString().indexOf('\n')
  const transaction = state.update({ changes: [{ from: lineBreak, to: lineBreak + 1, insert: '' }, { from: 1, to: 3, insert: '汉字🙂' }] })
  const after = session.read(transaction.state)
  // CM canonically merges adjacent edits. Its combined span must still consume
  // both raw CRLF code units, without normalizing the untouched source.
  assert.deepEqual(calls[0], [{ from: 1, to: 5, insert: '汉字🙂' }])
  assert.equal(after.source, '\uFEFF汉字🙂A\rB\n\n' + draft.anchors[0].original)
  assert.equal(after.anchors[0].from, draft.anchors[0].from)
  assert.equal(errors.length, 0)
  const payloadPosition = transaction.state.doc.toString().indexOf('groupId')
  const denied = transaction.state.update({ changes: { from: payloadPosition, insert: 'X' } })
  assert.equal(session.read(denied.state), after)
  assert.equal(errors.length, 1)
  const replay = denied.state.update({ changes: { from: 0, to: denied.state.doc.length, insert: markdownSourceEditorText(draft.source) }, annotations: session.replay.of(draft) })
  assert.equal(session.read(replay.state), draft)
  assert.ok(session.read(replay.state).source.includes('\r\n'))
})

test('replay mismatch, bad port output and expired openings fail without advancing the field', () => {
  let current = true, calls = 0
  const errors: unknown[] = [], draft = { source: 'one', identity: 1 }
  const session = createMarkdownSourceSession({ draft, isCurrent: () => current, onError: error => errors.push(error),
    replaceChanges: () => { calls++; return { source: 'wrong', identity: 2 } } })
  const state = EditorState.create({ doc: draft.source, extensions: session.extension })
  const denied = state.update({ changes: { from: 0, insert: 'x' } })
  assert.equal(session.read(denied.state), draft)
  const replay = state.update({ annotations: session.replay.of({ source: 'different', identity: 2 }) })
  assert.equal(session.read(replay.state), draft)
  current = false
  assert.equal(session.read(state.update({ changes: { from: 0, insert: 'x' } }).state), draft)
  assert.equal(calls, 1)
  assert.equal(errors.length, 3)
})

test('selection-only transactions do not call the draft port and opening text must agree', () => {
  const { session, state, calls } = protectedSession()
  const moved = state.update({ selection: { anchor: 3 } })
  assert.equal(session.read(moved.state), session.read(state)); assert.equal(calls.length, 0)
  const bad = createMarkdownSourceSession({ draft: { source: 'expected' }, replaceChanges: draft => draft })
  assert.throws(() => EditorState.create({ doc: 'other', extensions: bad.extension }), /opening draft/)
})

async function withDialog<Draft extends { source: string }>(context: TestContext, props: MarkdownSourceDialogProps<Draft>,
  run: (api: { document: Document; view: () => EditorView; click: (label: string) => Promise<void>;
    render: (next: MarkdownSourceDialogProps<Draft>) => Promise<void>; renderNode: (node: ReturnType<typeof createElement>) => Promise<void>;
    unmount: () => Promise<void>; window: JSDOM['window'] }) => Promise<void>) {
  const dom = new JSDOM('<button id="opener">Open source</button><button id="elsewhere">Elsewhere</button><div id="mount"></div>',
    { url: 'https://fixture.local', pretendToBeVisual: true })
  const globals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, Element: dom.window.Element,
    Node: dom.window.Node, Text: dom.window.Text, Window: dom.window.Window, Document: dom.window.Document,
    MutationObserver: dom.window.MutationObserver, DOMRect: dom.window.DOMRect, Range: dom.window.Range,
    Event: dom.window.Event, KeyboardEvent: dom.window.KeyboardEvent, MouseEvent: dom.window.MouseEvent,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  Object.defineProperty(dom.window.document, 'hasFocus', { configurable: true, value: () => true })
  Object.assign(dom.window.HTMLDialogElement.prototype, {
    showModal(this: HTMLDialogElement) { this.open = true }, close(this: HTMLDialogElement) { this.open = false }
  })
  Object.assign(dom.window.Range.prototype, { getClientRects: () => [], getBoundingClientRect: () => new dom.window.DOMRect() })
  const { createRoot } = await import('react-dom/client'), root = createRoot(dom.window.document.getElementById('mount')!)
  let unmounted = false
  const unmount = async () => { if (!unmounted) { unmounted = true; await act(async () => root.unmount()) } }
  context.after(async () => {
    await unmount(); dom.window.close()
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  })
  const renderNode = async (node: ReturnType<typeof createElement>) => { await act(async () => root.render(node)) }
  const render = async (next: MarkdownSourceDialogProps<Draft>) => { await renderNode(createElement(MarkdownSourceDialog<Draft>, next)) }
  await render(props)
  await run({ document: dom.window.document, window: dom.window, render, renderNode, unmount,
    view: () => {
      const element = dom.window.document.querySelector<HTMLElement>('.cm-editor'); assert.ok(element)
      const view = EditorView.findFromDOM(element); assert.ok(view); return view
    },
    click: async label => {
      const button = [...dom.window.document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === label || button.getAttribute('aria-label') === label)
      assert.ok(button, label)
      await act(async () => button.click())
    } })
}

test('real CM rejection leaves DOM, source draft and temporary history aligned; same-text Undo restores identity', async context => {
  const draft = reference(), submissions: typeof draft[] = []
  const props: MarkdownSourceDialogProps<typeof draft> = { sessionKey: {}, createDraft: () => draft, replaceChanges: applySyncedSourceChanges,
    onApply: value => { submissions.push(value); return false }, isCurrent: () => true, getReturnFocus: () => null, isZh: false, onClose: () => {} }
  await withDialog(context, props, async api => {
    const view = api.view(), point = draft.source.indexOf('groupId')
    await act(async () => view.dispatch({ selection: { anchor: point, head: point + 1 } }))
    await api.click('Bold')
    assert.equal(view.state.doc.toString(), draft.source)
    assert.ok(api.document.querySelector('[role="alert"]')?.textContent?.includes('protected'))
    const undo = [...api.document.querySelectorAll<HTMLButtonElement>('footer button')].find(button => button.textContent === 'Undo')!
    assert.equal(undo.disabled, true)
    const anchor = draft.anchors[0]
    await act(async () => view.dispatch({ changes: { from: anchor.from, to: anchor.to, insert: anchor.original } }))
    await api.click('Apply changes')
    assert.equal(submissions[0].anchors.length, 0)
    await api.click('Undo'); await api.click('Apply changes')
    assert.equal(submissions[1], draft)
    assert.equal(view.state.doc.toString(), draft.source)
  })
})

test('a real multi-transaction CM view update records accepted drafts in order and Undo restores the full original', async context => {
  const draft = reference(), submissions: typeof draft[] = []
  const props: MarkdownSourceDialogProps<typeof draft> = { sessionKey: {}, createDraft: () => draft, replaceChanges: applySyncedSourceChanges,
    onApply: value => { submissions.push(value); return false }, isCurrent: () => true, getReturnFocus: () => null, isZh: false, onClose: () => {} }
  await withDialog(context, props, async api => {
    const view = api.view(), first = view.state.update({ changes: { from: 0, insert: 'A' } })
    const second = first.state.update({ changes: { from: 1, insert: 'B' } })
    await act(async () => view.update([first, second]))
    assert.equal(view.state.doc.toString(), 'AB' + draft.source)
    await api.click('Undo'); await api.click('Apply changes')
    assert.equal(submissions[0], draft)
    assert.equal(view.state.doc.toString(), draft.source)
  })
})

test('async Apply is single-flight and later real CM input remains open after the submitted receipt', async context => {
  let settle!: (accepted: boolean) => void, closes = 0
  const promise = new Promise<boolean>(resolve => { settle = resolve }), submissions: string[] = []
  const props: MarkdownSourceDialogProps<{ source: string }> = { sessionKey: {}, createDraft: () => ({ source: 'old' }),
    replaceChanges: (draft, changes) => ({ source: changes.reduceRight((source, change) => source.slice(0, change.from) + change.insert + source.slice(change.to), draft.source) }),
    onApply: draft => { submissions.push(draft.source); return promise }, isCurrent: () => true, getReturnFocus: () => null, isZh: false, onClose: () => { closes++ } }
  await withDialog(context, props, async api => {
    await api.click('Apply changes')
    await act(async () => api.view().contentDOM.dispatchEvent(new api.window.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true })))
    assert.deepEqual(submissions, ['old'])
    await act(async () => api.view().dispatch({ changes: { from: 3, insert: ' newer' } }))
    await act(async () => settle(true))
    assert.equal(closes, 0); assert.equal(api.view().state.doc.toString(), 'old newer')
    assert.ok(api.document.querySelector('[role="alert"]')?.textContent?.includes('Later input remains'))
    await api.render({ ...props, onApply: () => true })
    await api.click('Apply changes')
    assert.equal(closes, 1)
  })
})

test('new opening props never receive the old draft or old pending Apply receipt', async context => {
  let settle!: (accepted: boolean) => void, oldClosed = 0, newClosed = 0
  const first: MarkdownSourceDialogProps<{ source: string }> = { sessionKey: {}, createDraft: () => ({ source: 'first' }),
    replaceChanges: draft => draft, onApply: () => new Promise<boolean>(resolve => { settle = resolve }),
    isCurrent: () => true, getReturnFocus: () => null, isZh: false, onClose: () => { oldClosed++ } }
  await withDialog(context, first, async api => {
    const originalView = api.view()
    await api.click('Apply changes')
    const submitted: string[] = []
    await api.render({ ...first, sessionKey: {}, createDraft: () => ({ source: 'second' }),
      onApply: draft => { submitted.push(draft.source); return false }, onClose: () => { newClosed++ } })
    assert.notEqual(api.view(), originalView); assert.equal(api.view().state.doc.toString(), 'second')
    await act(async () => settle(true))
    assert.equal(oldClosed, 0); assert.equal(newClosed, 0); assert.deepEqual(submitted, [])
    await api.click('Apply changes'); assert.deepEqual(submitted, ['second'])
  })
})

test('real IME end settles its start callback, while unmount never fabricates an end', async context => {
  const firstEvents: boolean[] = [], laterEvents: boolean[] = []
  const props: MarkdownSourceDialogProps<{ source: string }> = { sessionKey: {}, createDraft: () => ({ source: 'body' }),
    replaceChanges: draft => draft, onApply: () => false, isCurrent: () => true, getReturnFocus: () => null,
    onCompositionChange: value => firstEvents.push(value), isZh: false, onClose: () => {} }
  await withDialog(context, props, async api => {
    await act(async () => api.view().contentDOM.dispatchEvent(new api.window.CompositionEvent('compositionstart', { bubbles: true })))
    await api.render({ ...props, onCompositionChange: value => laterEvents.push(value) })
    await act(async () => api.view().contentDOM.dispatchEvent(new api.window.CompositionEvent('compositionend', { bubbles: true })))
    assert.deepEqual(firstEvents, [true, false]); assert.deepEqual(laterEvents, [])
    await act(async () => api.view().contentDOM.dispatchEvent(new api.window.CompositionEvent('compositionstart', { bubbles: true })))
    await api.unmount()
    assert.deepEqual(laterEvents, [true])
  })
})

test('default Document adapter keeps original public parse, no-op grouping, labels and class', async context => {
  const props: MarkdownSourceDialogProps<{ source: string }> = { sessionKey: {}, createDraft: () => ({ source: '' }),
    replaceChanges: draft => draft, onApply: () => false, isCurrent: () => true, getReturnFocus: () => null, isZh: false, onClose: () => {} }
  await withDialog(context, props, async api => {
    const blocks: DocumentBlockDraft[] = [{ id: ' 中文:旧ID ', type: 'paragraph', content: '# Heading\n\n- Item',
      checked: false, depth: 0, parentBlockId: null, tags: ['kept'], highlight: 'yellow' }]
    const submissions: DocumentBlockDraft[][] = [], closes: boolean[] = []
    await api.renderNode(createElement(DocumentMarkdownSourceDialog, { blocks, isZh: false,
      onApply: value => { submissions.push(value); return true }, onClose: () => { closes.push(true) } }))
    assert.ok(api.document.querySelector('dialog.document-markdown-source'))
    assert.equal(api.view().contentDOM.getAttribute('aria-label'), 'Markdown body source')
    await api.click('Apply changes')
    assert.equal(submissions[0], blocks)
    assert.deepEqual(closes, [true])
  })
})

test('focus return uses its actual opener and cannot reclaim focus from later navigation', async context => {
  let current = true
  const props: MarkdownSourceDialogProps<{ source: string }> = { sessionKey: {}, createDraft: () => ({ source: 'body' }),
    replaceChanges: draft => draft, onApply: () => false, isCurrent: () => current,
    getReturnFocus: () => document.getElementById('opener'), isZh: false, onClose: () => {} }
  await withDialog(context, props, async api => {
    const elsewhere = api.document.getElementById('elsewhere')!
    await act(async () => elsewhere.focus())
    current = false
    await api.unmount()
    assert.equal(api.document.activeElement, elsewhere)
  })
})

test('a current opening returns focus to its supplied opener after removing the modal', async context => {
  const props: MarkdownSourceDialogProps<{ source: string }> = { sessionKey: {}, createDraft: () => ({ source: 'body' }),
    replaceChanges: draft => draft, onApply: () => false, isCurrent: () => true,
    getReturnFocus: () => document.getElementById('opener'), isZh: false, onClose: () => {} }
  await withDialog(context, props, async api => {
    await act(async () => api.view().focus())
    await api.unmount()
    assert.equal(api.document.activeElement, api.document.getElementById('opener'))
    assert.equal(api.document.querySelector('dialog'), null)
  })
})

test('a rejected async Apply remains visible with its source and allows an explicit successful retry', async context => {
  let reject!: (error: Error) => void, closes = 0, calls = 0
  const props: MarkdownSourceDialogProps<{ source: string }> = { sessionKey: {}, createDraft: () => ({ source: 'retained' }),
    replaceChanges: draft => draft, onApply: () => { calls++; return new Promise<boolean>((_resolve, fail) => { reject = fail }) },
    isCurrent: () => true, getReturnFocus: () => null, isZh: false, onClose: () => { closes++ } }
  await withDialog(context, props, async api => {
    await api.click('Apply changes')
    await act(async () => reject(new Error('Explicit source failure')))
    assert.equal(closes, 0); assert.equal(calls, 1)
    assert.equal(api.view().state.doc.toString(), 'retained')
    assert.ok(api.document.querySelector('[role="alert"]')?.textContent?.includes('Explicit source failure'))
    await api.render({ ...props, onApply: () => { calls++; return true } })
    await api.click('Apply changes')
    assert.equal(closes, 1); assert.equal(calls, 2)
  })
})

test('attachment insertion rejected by the real CM filter retains the original draft and history', async context => {
  const draft = reference(), submissions: typeof draft[] = []
  const props: MarkdownSourceDialogProps<typeof draft> = { sessionKey: {}, createDraft: () => draft, replaceChanges: applySyncedSourceChanges,
    onApply: value => { submissions.push(value); return false }, isCurrent: () => true, getReturnFocus: () => null, isZh: false, onClose: () => {} }
  await withDialog(context, props, async api => {
    Object.defineProperty(api.window, 'knowbook', { configurable: true, value: { importAttachments: async () => [
      { url: 'file:///fixture.png', name: 'fixture.png', size: 1, kind: 'image' }
    ] } })
    const file = new api.window.File(['x'], 'fixture.png')
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new Uint8Array([1]).buffer })
    const input = api.document.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    await act(async () => api.view().dispatch({ selection: { anchor: draft.source.indexOf('groupId') } }))
    await act(async () => input.dispatchEvent(new api.window.Event('change', { bubbles: true })))
    assert.equal(api.view().state.doc.toString(), draft.source)
    assert.ok(api.document.querySelector('[role="alert"]')?.textContent?.includes('protected'))
    const undo = [...api.document.querySelectorAll<HTMLButtonElement>('footer button')].find(button => button.textContent === 'Undo')!
    assert.equal(undo.disabled, true)
    await api.click('Apply changes'); assert.equal(submissions[0], draft)
  })
})
