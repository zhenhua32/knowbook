import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement } from 'react'
import { JSDOM } from 'jsdom'
import type { AttachmentInput, ManagedAttachment } from '../src/shared/attachments'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import type { DocumentsDomainState } from '../src/renderer/src/types/appDomains'
import { appNotifications } from '../src/renderer/src/app-notifications'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
const { useDocumentAttachments } = await import('../src/renderer/src/hooks/useDocumentAttachments')

function deferred() {
  let resolve!: (attachments: ManagedAttachment[]) => void
  let reject!: (error: Error) => void
  const promise = new Promise<ManagedAttachment[]>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
type Request = ReturnType<typeof deferred> & { inputs: AttachmentInput[] }
const attachment: ManagedAttachment = { name: 'report.pdf', url: 'file:///assets/report.pdf', size: 7, kind: 'file' }

async function withAttachments(run: (context: {
  document: Document; window: JSDOM['window']; requests: Request[];
  changes: { documentId: string; blocks: DocumentBlockDraft[] }[];
  render: (documentId: string, detailLoading?: boolean) => Promise<void>;
  open: () => Promise<void>; upload: () => Promise<void>; unmount: () => Promise<void>
}) => Promise<void>, isZh = true) {
  const dom = new JSDOM('<div id="mount"></div>', { url: 'http://localhost' })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement, HTMLImageElement: dom.window.HTMLImageElement,
    IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const requests: Request[] = []
  const changes: { documentId: string; blocks: DocumentBlockDraft[] }[] = []
  Object.defineProperty(dom.window, 'knowbook', { value: {
    importAttachments: (inputs: AttachmentInput[]) => {
      const request = { ...deferred(), inputs }
      requests.push(request)
      return request.promise
    }
  } })
  appNotifications.markAllRead()
  appNotifications.clearCompleted()
  let mounted = true
  function Harness({ documentId, detailLoading }: { documentId: string; detailLoading: boolean }) {
    const blocks: DocumentBlockDraft[] = [{ id: `${documentId}-block`, type: 'paragraph', content: `${documentId} original text`, checked: false, depth: 0 }]
    const documents = { selectedDocumentId: documentId, detailLoading, draftBlocks: blocks, getDraftBlocks: () => blocks,
      checkpointDraft: () => {}, clearBlockSelection: () => {}, setIsReadingMode: () => {},
      setDraftBlocks: (next: DocumentBlockDraft[]) => changes.push({ documentId, blocks: next }) } as unknown as DocumentsDomainState
    const state = useDocumentAttachments(documents, isZh)
    return createElement('div', null,
      createElement('button', { className: 'open-attachments', onClick: state.openAttachments }, 'Attachments'),
      createElement('div', state.surfaceProps, createElement('div', { className: 'preview-panel' },
        createElement('textarea', { className: 'block-inline-textarea', defaultValue: blocks[0].content }))),
      state.dialog)
  }
  const unmount = async () => { if (mounted) { await act(async () => root.unmount()); mounted = false } }
  try {
    await run({ document: dom.window.document, window: dom.window, requests, changes, unmount,
      render: async (documentId, detailLoading = false) => {
        await act(async () => root.render(createElement(Harness, { documentId, detailLoading })))
      },
      open: async () => { await act(async () => dom.window.document.querySelector<HTMLButtonElement>('.open-attachments')!.click()) },
      upload: async () => {
        const input = dom.window.document.querySelector<HTMLInputElement>('.attachment-upload input')!
        assert.equal(input.disabled, false, 'the current document can start an import')
        Object.defineProperty(input, 'files', { configurable: true, value: [new File(['payload'], 'report.pdf', { type: 'application/pdf' })] })
        await act(async () => input.dispatchEvent(new dom.window.Event('change', { bubbles: true })))
      }
    })
  } finally {
    await unmount()
    appNotifications.markAllRead()
    appNotifications.clearCompleted()
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

const uploadInput = (document: Document) => document.querySelector<HTMLInputElement>('.attachment-upload input')!
const dialog = (document: Document) => document.querySelector<HTMLDialogElement>('.attachment-dialog')!
const alert = (document: Document) => document.querySelector('.attachment-error[role="alert"]')

test('a late attachment failure from A cannot add an error or notification to B, and B can import after the old request settles', async () => {
  await withAttachments(async ({ document, requests, changes, render, open, upload }) => {
    await render('A')
    await open()
    await upload()
    assert.equal(requests.length, 1)
    assert.equal(uploadInput(document).disabled, true)
    await render('B')
    assert.equal(document.querySelector('.attachment-dialog'), null)
    await open()
    assert.equal(uploadInput(document).disabled, true)
    await act(async () => requests[0].reject(new Error('A import failed')))
    assert.equal(alert(document), null)
    assert.deepEqual(appNotifications.getHistorySnapshot(), [])
    assert.equal(uploadInput(document).disabled, false)
    assert.equal(document.querySelector('.attachment-import-status'), null)
    await upload()
    assert.equal(requests.length, 2, 'the old request releases the import lock')
    assert.equal(requests[1].inputs[0].name, 'report.pdf')
    await act(async () => requests[1].resolve([attachment]))
    assert.equal(changes.length, 1)
    assert.equal(changes[0].documentId, 'B')
    assert.equal(changes[0].blocks[0].content, 'B original text')
    assert.match(changes[0].blocks[1].content, /report\.pdf/)
    assert.equal(appNotifications.getHistorySnapshot().length, 1)
    assert.equal(appNotifications.getHistorySnapshot()[0].level, 'success')
  })
})

test('a current-document failure remains visible and retryable in both languages without allowing a busy dialog to close', async () => {
  for (const isZh of [true, false]) {
    await withAttachments(async ({ document, window, requests, changes, render, open, upload }) => {
      await render('A')
      await open()
      await upload()
      assert.equal(dialog(document).querySelector<HTMLButtonElement>('header button')!.disabled, true)
      assert.equal(document.querySelector('.attachment-import-status')?.textContent, isZh ? '正在导入附件…' : 'Importing attachments…')
      const cancel = new window.Event('cancel', { cancelable: true })
      await act(async () => dialog(document).dispatchEvent(cancel))
      assert.equal(cancel.defaultPrevented, true)
      assert.ok(dialog(document), 'pending imports keep the current dialog session open')
      await act(async () => requests[0].reject(new Error('Current attachment failed')))
      assert.equal(alert(document)?.textContent, 'Error: Current attachment failed')
      assert.equal(appNotifications.getHistorySnapshot()[0].message, 'Error: Current attachment failed')
      assert.equal(appNotifications.getHistorySnapshot()[0].level, 'error')
      assert.equal(uploadInput(document).disabled, false)
      assert.equal(dialog(document).querySelector<HTMLButtonElement>('header button')!.disabled, false)
      assert.equal(changes.length, 0)
      await upload()
      assert.equal(alert(document), null, 'retry clears only the old error')
      await act(async () => requests[1].resolve([attachment]))
      assert.equal(changes.length, 1)
      assert.equal(changes[0].documentId, 'A')
      assert.equal(uploadInput(document).disabled, false)
    }, isZh)
  }
})

test('a late success from A still cannot insert an attachment or notify while B is selected', async () => {
  await withAttachments(async ({ document, requests, changes, render, open, upload }) => {
    await render('A')
    await open()
    await upload()
    await render('B')
    await open()
    await act(async () => requests[0].resolve([attachment]))
    assert.equal(changes.length, 0)
    assert.deepEqual(appNotifications.getHistorySnapshot(), [])
    assert.equal(alert(document), null)
    assert.equal(uploadInput(document).disabled, false)
  })
})

test('a failure during document detail loading is ignored consistently with successful imports', async () => {
  await withAttachments(async ({ document, requests, changes, render, open, upload }) => {
    await render('A')
    await open()
    await upload()
    await render('A', true)
    await act(async () => requests[0].reject(new Error('A is no longer ready')))
    assert.equal(alert(document), null)
    assert.deepEqual(appNotifications.getHistorySnapshot(), [])
    assert.equal(changes.length, 0)
    assert.equal(uploadInput(document).disabled, false)
    assert.equal(document.querySelector('.attachment-import-status'), null)
  })
})

test('an attachment rejection after unmount does not emit a stale global notification', async () => {
  await withAttachments(async ({ requests, render, open, upload, unmount }) => {
    await render('A')
    await open()
    await upload()
    await unmount()
    await act(async () => requests[0].reject(new Error('Disposed document failed')))
    assert.deepEqual(appNotifications.getHistorySnapshot(), [])
  })
})
