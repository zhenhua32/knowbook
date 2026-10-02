import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement, type ComponentProps, type ReactNode } from 'react'
import { JSDOM } from 'jsdom'
import type { DatabaseField, DatabaseRecord, DocumentCatalogEntry } from '../src/shared/contracts'
import { CreateRecordDialog, DatabaseRecordDrawer } from '../src/renderer/src/features/database/components/DatabaseRecordDrawer'
import { getDatabaseWorkspaceText } from '../src/renderer/src/features/database/databaseText'

type CreateProps = ComponentProps<typeof CreateRecordDialog>
type DrawerProps = ComponentProps<typeof DatabaseRecordDrawer>
type Draft = Parameters<CreateProps['onCreate']>[0]
const fields: DatabaseField[] = [{ id: 'notes', name: 'Notes', type: 'text', role: 'property', options: [],
  editable: true, hideable: true, deletable: true, sortOrder: 0 }]
const documents: DocumentCatalogEntry[] = [{ id: 'document-1', title: 'Plan', path: 'Projects/Plan', parentId: null,
  parentTitle: null, updatedAt: '2026-10-01', summary: '', blockCount: 1, childCount: 0, linkCount: 0, fieldValues: {} }]
const recordA: DatabaseRecord = { id: 'record-a', databaseId: 'database', title: 'Record A', documentId: 'document-1',
  fieldValues: { notes: 'Original A' }, createdAt: '2026-10-01', updatedAt: '2026-10-01' }
const recordB: DatabaseRecord = { ...recordA, id: 'record-b', title: 'Record B', fieldValues: { notes: 'Original B' } }

function deferred() {
  let resolve!: (success: boolean) => void
  let reject!: (error: Error) => void
  const promise = new Promise<boolean>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
type CreateRequest = ReturnType<typeof deferred> & { draft: Draft; continueAdding: boolean }
type SaveRequest = ReturnType<typeof deferred> & { draft: Draft; recordId: string }

async function withForms(run: (context: {
  document: Document; window: JSDOM['window']; creates: CreateRequest[]; saves: SaveRequest[];
  calls: { close: number; cancel: number; delete: number; openDocument: number };
  renderCreate: (overrides?: Partial<CreateProps>) => Promise<void>;
  renderDrawer: (overrides?: Partial<DrawerProps>) => Promise<void>;
  fill: (input: HTMLInputElement, value: string) => Promise<void>;
  unmount: () => Promise<void>
}) => Promise<void>) {
  const dom = new JSDOM('<button id="opener">Open</button><div id="mount"></div>', { url: 'http://localhost' })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  const frames = new Map<number, FrameRequestCallback>()
  let frameId = 0
  const requestFrame = (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId }
  const cancelFrame = (id: number) => { frames.delete(id) }
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, requestAnimationFrame: requestFrame,
    cancelAnimationFrame: cancelFrame, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const creates: CreateRequest[] = []
  const saves: SaveRequest[] = []
  const calls = { close: 0, cancel: 0, delete: 0, openDocument: 0 }
  const text = getDatabaseWorkspaceText('en-US')
  let mounted = true
  const render = async (content: ReactNode) => {
    await act(async () => root.render(content))
    await act(async () => {
      const pending = [...frames.values()]
      frames.clear()
      pending.forEach(callback => callback(0))
    })
  }
  const unmount = async () => { if (mounted) { await act(async () => root.unmount()); mounted = false } }
  try {
    await run({ document: dom.window.document, window: dom.window, creates, saves, calls, unmount,
      renderCreate: overrides => render(createElement(CreateRecordDialog, {
        documents, fields, open: true, text, onCancel: () => calls.cancel++,
        onCreate: (draft, continueAdding) => {
          const request = { ...deferred(), draft: structuredClone(draft), continueAdding }
          creates.push(request)
          return request.promise
        }, ...overrides
      })),
      renderDrawer: overrides => render(createElement(DatabaseRecordDrawer, {
        documents, fields, open: true, record: recordA, text, onClose: () => calls.close++,
        onDelete: () => calls.delete++, onOpenDocument: () => calls.openDocument++,
        onSave: (record, draft) => {
          const request = { ...deferred(), draft: structuredClone(draft), recordId: record.id }
          saves.push(request)
          return request.promise
        }, ...overrides
      })),
      fill: async (input, value) => {
        const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!
        await act(async () => input.focus())
        await act(async () => { setter.call(input, value); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })) })
      }
    })
  } finally {
    await unmount()
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

const titleInput = (document: Document) => document.querySelector<HTMLInputElement>('.dbw-record-form input')!
const notesInput = (document: Document) => document.querySelector<HTMLInputElement>('input[aria-label="Notes"]')!
const primaryButton = (document: Document) => document.querySelector<HTMLButtonElement>('.dbw-primary-button')!
const continueButton = (document: Document) => document.querySelector<HTMLButtonElement>('footer .dbw-quiet-button')!
const alertText = (document: Document) => document.querySelector('[role="alert"]')?.textContent ?? ''
const dialog = (document: Document) => document.querySelector<HTMLElement>('[role="dialog"]')!

test('failed creation retains the complete draft and retries; only a successful continue clears and refocuses it in both languages', async () => {
  for (const locale of ['zh-CN', 'en-US']) {
    await withForms(async ({ document, window, creates, calls, renderCreate, fill }) => {
      const text = getDatabaseWorkspaceText(locale)
      await renderCreate({ text })
      await fill(titleInput(document), 'New record')
      await fill(notesInput(document), 'Keep these notes')
      const linked = document.querySelector<HTMLSelectElement>('.dbw-record-form select')!
      await act(async () => { linked.value = 'document-1'; linked.dispatchEvent(new window.Event('change', { bubbles: true })) })
      await act(async () => continueButton(document).click())
      await act(async () => creates[0].resolve(false))
      assert.equal(titleInput(document).value, 'New record')
      assert.equal(notesInput(document).value, 'Keep these notes')
      assert.equal(linked.value, 'document-1')
      assert.equal(alertText(document), text.formFailed)
      const alert = document.querySelector<HTMLElement>('[role="alert"]')!
      assert.equal(alert.id.length > 0, true)
      assert.equal(primaryButton(document).getAttribute('aria-describedby'), alert.id)
      assert.equal(continueButton(document).getAttribute('aria-describedby'), alert.id)
      assert.equal(calls.cancel, 0)
      await act(async () => continueButton(document).click())
      assert.deepEqual(creates[1].draft, creates[0].draft)
      assert.equal(alertText(document), '', 'a retry clears the previous error')
      assert.equal(primaryButton(document).hasAttribute('aria-describedby'), false)
      assert.equal(continueButton(document).hasAttribute('aria-describedby'), false)
      await act(async () => creates[1].resolve(true))
      assert.equal(titleInput(document).value, '')
      assert.equal(notesInput(document).value, '')
      assert.equal(linked.value, '')
      assert.equal(document.activeElement, titleInput(document))
      assert.equal(calls.cancel, 0, 'continue keeps the form open')
    })
  }
})

test('a thrown create error stays generic and retrying a successful ordinary create closes the current form', async () => {
  await withForms(async ({ document, creates, calls, renderCreate, fill }) => {
    await renderCreate()
    await fill(titleInput(document), 'Preserved title')
    await fill(notesInput(document), 'Preserved property')
    await act(async () => primaryButton(document).click())
    await act(async () => creates[0].reject(new Error('secret IPC failure detail')))
    assert.equal(alertText(document), getDatabaseWorkspaceText('en-US').formFailed)
    assert.equal(document.body.textContent!.includes('secret IPC failure detail'), false)
    assert.equal(titleInput(document).value, 'Preserved title')
    assert.equal(notesInput(document).value, 'Preserved property')
    assert.equal(primaryButton(document).disabled, false)
    await act(async () => primaryButton(document).click())
    await act(async () => creates[1].resolve(true))
    assert.equal(calls.cancel, 1)
  })
})

test('creation locks synchronously across both submit buttons and blocks close, scrim and Escape while pending', async () => {
  await withForms(async ({ document, window, creates, calls, renderCreate, fill }) => {
    await renderCreate()
    await fill(titleInput(document), 'One create')
    const primary = primaryButton(document)
    const next = continueButton(document)
    const close = document.querySelector<HTMLButtonElement>('header .dbw-icon-button')!
    const scrim = document.querySelector<HTMLButtonElement>('.dbw-modal-scrim')!
    await act(async () => { primary.click(); next.click(); primary.click(); close.click(); scrim.click() })
    assert.equal(creates.length, 1, 'clicks in the same React batch share a synchronous lock')
    assert.equal(calls.cancel, 0)
    assert.equal(dialog(document).getAttribute('aria-busy'), 'true')
    assert.equal(primary.textContent, getDatabaseWorkspaceText('en-US').creating)
    for (const control of document.querySelectorAll('button, input, select')) {
      if (control.id !== 'opener') assert.equal(control.matches(':disabled'), true)
    }
    await act(async () => primary.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    assert.equal(calls.cancel, 0)
    await act(async () => creates[0].resolve(false))
    assert.equal(dialog(document).getAttribute('aria-busy'), 'false')
    assert.equal(close.disabled, false)
    await act(async () => close.click())
    assert.equal(calls.cancel, 1)
  })
})

test('an old successful continue cannot clear a reopened create form or unlock its newer request', async () => {
  await withForms(async ({ document, creates, calls, renderCreate, fill }) => {
    await renderCreate()
    await fill(titleInput(document), 'Old request')
    await act(async () => continueButton(document).click())
    await renderCreate({ open: false })
    await renderCreate()
    await fill(titleInput(document), 'New session')
    await fill(notesInput(document), 'New notes')
    await act(async () => primaryButton(document).click())
    await act(async () => creates[0].resolve(true))
    assert.equal(titleInput(document).value, 'New session')
    assert.equal(notesInput(document).value, 'New notes')
    assert.equal(dialog(document).getAttribute('aria-busy'), 'true')
    assert.equal(alertText(document), '')
    assert.equal(calls.cancel, 0)
    await act(async () => creates[1].resolve(false))
    assert.equal(titleInput(document).value, 'New session')
    assert.equal(dialog(document).getAttribute('aria-busy'), 'false')
    assert.ok(alertText(document))
  })
})

test('workspace refresh props do not invalidate a pending create or prevent its successful close', async () => {
  await withForms(async ({ document, creates, calls, renderCreate, fill }) => {
    await renderCreate()
    await fill(titleInput(document), 'Pending across refresh')
    await fill(notesInput(document), 'Retained across refresh')
    await act(async () => primaryButton(document).click())
    await renderCreate({ fields: fields.map(field => ({ ...field, options: [...field.options] })),
      documents: documents.map(document => ({ ...document, fieldValues: { ...document.fieldValues } })),
      text: getDatabaseWorkspaceText('zh-CN') })
    assert.equal(titleInput(document).value, 'Pending across refresh')
    assert.equal(notesInput(document).value, 'Retained across refresh')
    assert.equal(dialog(document).getAttribute('aria-busy'), 'true')
    assert.equal(primaryButton(document).textContent, getDatabaseWorkspaceText('zh-CN').creating)
    await act(async () => primaryButton(document).click())
    assert.equal(creates.length, 1)
    await act(async () => creates[0].resolve(true))
    assert.equal(calls.cancel, 1)
    assert.equal(dialog(document).getAttribute('aria-busy'), 'false')
    assert.equal(alertText(document), '')
  })
})

test('a failed save retains record edits and a successful retry closes only after completion', async () => {
  await withForms(async ({ document, saves, calls, renderDrawer, fill }) => {
    await renderDrawer()
    await fill(titleInput(document), 'Edited record')
    await fill(notesInput(document), 'Edited notes')
    await act(async () => primaryButton(document).click())
    assert.equal(calls.close, 0)
    await act(async () => saves[0].resolve(false))
    assert.equal(titleInput(document).value, 'Edited record')
    assert.equal(notesInput(document).value, 'Edited notes')
    assert.equal(alertText(document), getDatabaseWorkspaceText('en-US').formFailed)
    await act(async () => primaryButton(document).click())
    assert.deepEqual(saves[1].draft, saves[0].draft)
    await act(async () => saves[1].resolve(true))
    assert.equal(calls.close, 1)
    assert.equal(alertText(document), '')
  })
})

test('saving locks all record controls and guards same-tick close, delete and document navigation', async () => {
  await withForms(async ({ document, window, saves, calls, renderDrawer, fill }) => {
    await renderDrawer()
    await fill(titleInput(document), 'Locked record')
    const save = primaryButton(document)
    const close = document.querySelector<HTMLButtonElement>('header .dbw-icon-button')!
    const cancel = document.querySelector<HTMLButtonElement>('footer .dbw-quiet-button')!
    const remove = document.querySelector<HTMLButtonElement>('.dbw-danger-quiet-button')!
    const open = document.querySelector<HTMLButtonElement>('.dbw-open-document-button')!
    const scrim = document.querySelector<HTMLButtonElement>('.dbw-drawer-scrim')!
    await act(async () => { save.click(); save.click(); close.click(); cancel.click(); remove.click(); open.click(); scrim.click() })
    assert.equal(saves.length, 1)
    assert.deepEqual(calls, { close: 0, cancel: 0, delete: 0, openDocument: 0 })
    assert.equal(save.textContent, getDatabaseWorkspaceText('en-US').saving)
    assert.equal(dialog(document).getAttribute('aria-busy'), 'true')
    for (const control of document.querySelectorAll('button, input, select')) {
      if (control.id !== 'opener') assert.equal(control.matches(':disabled'), true)
    }
    await act(async () => save.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    assert.equal(calls.close, 0)
    await act(async () => saves[0].reject(new Error('private database error')))
    assert.equal(alertText(document), getDatabaseWorkspaceText('en-US').formFailed)
    assert.equal(document.body.textContent!.includes('private database error'), false)
    assert.equal(titleInput(document).value, 'Locked record')
    assert.equal(save.disabled, false)
    await act(async () => cancel.click())
    assert.equal(calls.close, 1)
  })
})

test('old record completions cannot close, overwrite or unlock a different record session', async () => {
  for (const outcome of ['success', 'false', 'throw'] as const) {
    await withForms(async ({ document, saves, calls, renderDrawer, fill }) => {
      await renderDrawer()
      await act(async () => primaryButton(document).click())
      await renderDrawer({ record: recordB })
      assert.equal(titleInput(document).value, 'Record B')
      await fill(titleInput(document), 'Edited B')
      await fill(notesInput(document), 'Keep B')
      await act(async () => primaryButton(document).click())
      await act(async () => outcome === 'throw' ? saves[0].reject(new Error('old request')) : saves[0].resolve(outcome === 'success'))
      assert.equal(titleInput(document).value, 'Edited B')
      assert.equal(notesInput(document).value, 'Keep B')
      assert.equal(dialog(document).getAttribute('aria-busy'), 'true')
      assert.equal(calls.close, 0)
      assert.equal(alertText(document), '')
      await act(async () => saves[1].resolve(true))
      assert.equal(calls.close, 1)
    })
  }
})

test('fresh props for the same record preserve its pending lock and submitted draft until normal success closes it', async () => {
  await withForms(async ({ document, saves, calls, renderDrawer, fill }) => {
    await renderDrawer()
    await fill(titleInput(document), 'Submitted edit')
    await fill(notesInput(document), 'Submitted notes')
    await act(async () => primaryButton(document).click())
    await renderDrawer({ record: { ...recordA, title: 'Refreshed title', fieldValues: { notes: 'Refreshed notes' } } })
    assert.equal(titleInput(document).value, 'Submitted edit')
    assert.equal(notesInput(document).value, 'Submitted notes')
    assert.equal(dialog(document).getAttribute('aria-busy'), 'true')
    await act(async () => primaryButton(document).click())
    assert.equal(saves.length, 1)
    await act(async () => saves[0].resolve(true))
    assert.equal(calls.close, 1)
    assert.equal(alertText(document), '')
  })
})

test('a same-record refresh followed by failure keeps the edited draft available for retry', async () => {
  await withForms(async ({ document, saves, calls, renderDrawer, fill }) => {
    await renderDrawer()
    await fill(titleInput(document), 'Retry this title')
    await fill(notesInput(document), 'Retry these notes')
    await act(async () => primaryButton(document).click())
    await renderDrawer({ record: { ...recordA, fieldValues: { notes: 'Background value' } } })
    await act(async () => saves[0].resolve(false))
    assert.equal(titleInput(document).value, 'Retry this title')
    assert.equal(notesInput(document).value, 'Retry these notes')
    assert.equal(primaryButton(document).disabled, false)
    assert.ok(alertText(document))
    assert.equal(calls.close, 0)
    await act(async () => primaryButton(document).click())
    assert.deepEqual(saves[1].draft, saves[0].draft)
    await act(async () => saves[1].resolve(true))
    assert.equal(calls.close, 1)
  })
})

test('unsaved record edits survive a background refresh of the same record without moving input focus in both languages', async () => {
  for (const locale of ['zh-CN', 'en-US']) {
    await withForms(async ({ document, window, saves, renderDrawer, fill }) => {
      const text = getDatabaseWorkspaceText(locale)
      await renderDrawer({ text })
      await fill(titleInput(document), 'Unsaved title')
      await fill(notesInput(document), 'Unsaved notes')
      const linked = document.querySelector<HTMLSelectElement>('.dbw-record-form select')!
      await act(async () => { linked.value = ''; linked.dispatchEvent(new window.Event('change', { bubbles: true })) })
      const focused = titleInput(document)
      await act(async () => focused.focus())
      await renderDrawer({ text, record: { ...recordA, title: 'Background title', fieldValues: { notes: 'Background notes' } },
        fields: fields.map(field => ({ ...field, options: [...field.options] })) })
      assert.equal(titleInput(document).value, 'Unsaved title')
      assert.equal(notesInput(document).value, 'Unsaved notes')
      assert.equal(linked.value, '')
      assert.equal(document.activeElement === focused, true)
      assert.equal(saves.length, 0, 'A refresh must not persist the local draft')
      await act(async () => primaryButton(document).click())
      assert.deepEqual(saves[0].draft, { title: 'Unsaved title', documentId: '', fieldValues: { notes: 'Unsaved notes' } })
      await act(async () => saves[0].resolve(true))
    })
  }
})

test('a background refresh after a failed save keeps the whole retry draft and its localized recovery feedback', async () => {
  for (const locale of ['zh-CN', 'en-US']) {
    await withForms(async ({ document, window, saves, calls, renderDrawer, fill }) => {
      const text = getDatabaseWorkspaceText(locale)
      await renderDrawer({ text })
      await fill(titleInput(document), 'Retry title')
      await fill(notesInput(document), 'Retry notes')
      const linked = document.querySelector<HTMLSelectElement>('.dbw-record-form select')!
      await act(async () => { linked.value = ''; linked.dispatchEvent(new window.Event('change', { bubbles: true })) })
      await act(async () => primaryButton(document).click())
      await act(async () => saves[0].reject(new Error('secret failed mutation')))
      const focused = notesInput(document)
      await act(async () => focused.focus())
      await renderDrawer({ text, record: { ...recordA, title: 'Server title', fieldValues: { notes: 'Server notes' } },
        fields: fields.map(field => ({ ...field, options: [...field.options] })) })
      assert.equal(titleInput(document).value, 'Retry title')
      assert.equal(notesInput(document).value, 'Retry notes')
      assert.equal(linked.value, '')
      assert.equal(document.activeElement === focused, true)
      assert.equal(alertText(document), text.formFailed)
      assert.equal(document.body.textContent!.includes('secret failed mutation'), false)
      const alert = document.querySelector<HTMLElement>('[role="alert"]')!
      assert.equal(alert.id.length > 0, true)
      assert.equal(primaryButton(document).getAttribute('aria-describedby'), alert.id)
      assert.equal(saves.length, 1)
      assert.equal(calls.close, 0)
      await act(async () => primaryButton(document).click())
      assert.deepEqual(saves[1].draft, saves[0].draft)
      assert.equal(alertText(document), '')
      assert.equal(primaryButton(document).hasAttribute('aria-describedby'), false)
      await act(async () => saves[1].resolve(true))
      assert.equal(calls.close, 1)
    })
  }
})

test('pristine records still synchronize fresh props while different records and reopened sessions initialize a fresh draft', async () => {
  for (const locale of ['zh-CN', 'en-US']) {
    await withForms(async ({ document, saves, renderDrawer, fill }) => {
      const text = getDatabaseWorkspaceText(locale)
      await renderDrawer({ text })
      const focused = titleInput(document)
      await act(async () => focused.focus())
      const refreshed = { ...recordA, title: 'Fresh server title', documentId: null, fieldValues: { notes: 'Fresh server notes' } }
      await renderDrawer({ text, record: refreshed, fields: fields.map(field => ({ ...field, options: [...field.options] })) })
      assert.equal(titleInput(document).value, 'Fresh server title')
      assert.equal(notesInput(document).value, 'Fresh server notes')
      assert.equal(document.querySelector<HTMLSelectElement>('.dbw-record-form select')!.value, '')
      assert.equal(document.activeElement === focused, true, 'Refreshing a pristine value must not move focus')
      assert.equal(saves.length, 0)

      await fill(titleInput(document), 'Discard only on a new record')
      await fill(notesInput(document), 'Local A notes')
      await renderDrawer({ text, record: recordB })
      assert.equal(titleInput(document).value, 'Record B')
      assert.equal(notesInput(document).value, 'Original B')
      assert.equal(document.querySelector<HTMLSelectElement>('.dbw-record-form select')!.value, 'document-1')
      assert.equal(alertText(document), '')
      await fill(titleInput(document), 'Local B edit')
      await renderDrawer({ text, record: recordB, open: false })
      await renderDrawer({ text, record: { ...recordB, title: 'Latest reopened B', documentId: null, fieldValues: { notes: 'Reopened notes' } } })
      assert.equal(titleInput(document).value, 'Latest reopened B')
      assert.equal(notesInput(document).value, 'Reopened notes')
      assert.equal(document.querySelector<HTMLSelectElement>('.dbw-record-form select')!.value, '')
      assert.equal(saves.length, 0)
    })
  }
})

test('schema refresh prunes removed field values and initializes added fields without replacing the remaining dirty record draft', async () => {
  await withForms(async ({ document, window, saves, renderDrawer, fill }) => {
    const removed: DatabaseField = { ...fields[0], id: 'removed', name: 'Removed field', sortOrder: 1 }
    const added: DatabaseField = { ...fields[0], id: 'added', name: 'Added field', sortOrder: 1 }
    await renderDrawer({ fields: [...fields, removed], record: { ...recordA, fieldValues: { notes: 'Original A', removed: 'Original removed value' } } })
    await fill(titleInput(document), 'Schema-safe title')
    await fill(notesInput(document), 'Schema-safe notes')
    await fill(document.querySelector<HTMLInputElement>('input[aria-label="Removed field"]')!, 'Removed local value')
    const linked = document.querySelector<HTMLSelectElement>('.dbw-record-form select')!
    await act(async () => { linked.value = ''; linked.dispatchEvent(new window.Event('change', { bubbles: true })) })
    const focused = titleInput(document)
    await act(async () => focused.focus())
    const newFields = [...fields.map(field => ({ ...field })), added]
    await renderDrawer({ fields: newFields, record: { ...recordA, title: 'Remote title',
      fieldValues: { notes: 'Remote notes', removed: 'Still present in an old snapshot', added: 'Initial added value' } } })
    assert.equal(titleInput(document).value, 'Schema-safe title')
    assert.equal(notesInput(document).value, 'Schema-safe notes')
    assert.equal(linked.value, '')
    assert.equal(document.querySelectorAll('input[aria-label="Removed field"]').length, 0)
    const addedInput = document.querySelector<HTMLInputElement>('input[aria-label="Added field"]')!
    assert.equal(addedInput.value, 'Initial added value')
    assert.equal(document.activeElement === focused, true)
    await fill(addedInput, 'Added local value')
    await renderDrawer({ fields: newFields.map(field => ({ ...field })), record: { ...recordA,
      fieldValues: { notes: 'Another remote value', added: 'Another added server value' } } })
    assert.equal(titleInput(document).value, 'Schema-safe title')
    assert.equal(notesInput(document).value, 'Schema-safe notes')
    assert.equal(addedInput.value, 'Added local value')
    assert.equal(document.activeElement === addedInput, true)
    assert.equal(saves.length, 0)
    await act(async () => primaryButton(document).click())
    assert.deepEqual(saves[0].draft, { title: 'Schema-safe title', documentId: '',
      fieldValues: { notes: 'Schema-safe notes', added: 'Added local value' } })
    await act(async () => saves[0].resolve(true))
  })
})

test('closing and reopening the same record invalidates a pending save and initializes a fresh draft', async () => {
  await withForms(async ({ document, saves, calls, renderDrawer, fill }) => {
    await renderDrawer()
    await fill(titleInput(document), 'Old edit')
    await act(async () => primaryButton(document).click())
    await renderDrawer({ open: false })
    await renderDrawer()
    assert.equal(titleInput(document).value, 'Record A')
    await fill(titleInput(document), 'Reopened edit')
    await act(async () => saves[0].resolve(true))
    assert.equal(titleInput(document).value, 'Reopened edit')
    assert.equal(calls.close, 0)
    assert.equal(dialog(document).getAttribute('aria-busy'), 'false')
    assert.equal(alertText(document), '')
  })
})

test('unmounted record forms ignore pending success and rejection without invoking close callbacks', async () => {
  await withForms(async ({ document, creates, calls, renderCreate, fill, unmount }) => {
    await renderCreate()
    await fill(titleInput(document), 'Unmounted create')
    await act(async () => primaryButton(document).click())
    await unmount()
    await act(async () => creates[0].resolve(true))
    assert.equal(calls.cancel, 0)
    assert.equal(document.querySelector('[role="dialog"]'), null)
  })
  await withForms(async ({ document, saves, calls, renderDrawer, unmount }) => {
    await renderDrawer()
    await act(async () => primaryButton(document).click())
    await unmount()
    await act(async () => saves[0].reject(new Error('late failure')))
    assert.equal(calls.close, 0)
    assert.equal(document.querySelector('[role="alert"]'), null)
  })
})
