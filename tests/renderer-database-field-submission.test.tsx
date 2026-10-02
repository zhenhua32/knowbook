import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement, type ComponentProps } from 'react'
import { JSDOM } from 'jsdom'
import type { DatabaseField } from '../src/shared/contracts'
import { DatabaseFieldDrawer } from '../src/renderer/src/features/database/components/DatabaseFieldDrawer'
import { getDatabaseWorkspaceText } from '../src/renderer/src/features/database/databaseText'

const owner: DatabaseField = { id: 'owner', name: 'Owner', type: 'text', role: 'property', options: [], editable: true, hideable: true, deletable: true, sortOrder: 0 }
const stage: DatabaseField = { ...owner, id: 'stage', name: 'Stage', type: 'select', options: ['Draft', 'Published'], sortOrder: 1 }
function deferred() {
  let resolve!: (value: boolean) => void
  let reject!: (error: Error) => void
  const promise = new Promise<boolean>((success, failure) => { resolve = success; reject = failure })
  return { promise, resolve, reject }
}
type Request = ReturnType<typeof deferred> & { input: unknown[] }
type DrawerProps = ComponentProps<typeof DatabaseFieldDrawer>

async function withDrawer(run: (context: {
  document: Document
  window: JSDOM['window']
  text: ReturnType<typeof getDatabaseWorkspaceText>
  requests: { create: Request[]; name: Request[]; options: Request[]; move: Request[] }
  calls: { close: number; delete: number; move: number; toggle: number }
  render: (patch?: Partial<DrawerProps>) => Promise<void>
  click: (element: HTMLElement) => Promise<void>
  fill: (element: HTMLInputElement, value: string) => Promise<void>
  key: (element: HTMLElement, key: string, init?: KeyboardEventInit) => Promise<KeyboardEvent>
  createForm: () => HTMLElement
  startCreate: () => Promise<HTMLElement>
  row: (index?: number) => HTMLElement
  editName: (index?: number) => Promise<HTMLInputElement>
  unmount: () => Promise<void>
}) => Promise<void>, locale = 'en-US') {
  const dom = new JSDOM('<button id="opener">Fields</button><div id="mount"></div>', { url: 'http://localhost' })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  const frames = new Map<number, FrameRequestCallback>()
  let frameId = 0
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId },
    cancelAnimationFrame: (id: number) => frames.delete(id) })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const text = getDatabaseWorkspaceText(locale)
  const requests = { create: [] as Request[], name: [] as Request[], options: [] as Request[], move: [] as Request[] }
  const calls = { close: 0, delete: 0, move: 0, toggle: 0 }
  const request = (list: Request[], input: unknown[]) => { const item = { ...deferred(), input }; list.push(item); return item.promise }
  let props: DrawerProps = { fields: [owner, stage], fieldOrder: ['owner', 'stage'], visibleFieldIds: ['owner', 'stage'],
    open: true, sourceSessionKey: 'source-a', text, onClose: () => calls.close++, onDeleteField: () => calls.delete++,
    onMoveField: () => calls.move++, onToggleField: () => calls.toggle++,
    onCreateField: (...input) => request(requests.create, input), onRenameField: (...input) => request(requests.name, input),
    onUpdateOptions: (...input) => request(requests.options, input), onMoveDatabaseField: (...input) => request(requests.move, input) }
  let mounted = true
  const render = async (patch: Partial<DrawerProps> = {}) => {
    props = { ...props, ...patch }
    await act(async () => root.render(createElement(DatabaseFieldDrawer, props)))
    await act(async () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)) })
  }
  const click = async (element: HTMLElement) => { await act(async () => element.click()) }
  const row = (index = 0) => { const element = dom.window.document.querySelectorAll<HTMLElement>('.dbw-field-row')[index]; assert.ok(element); return element }
  const createForm = () => { const element = dom.window.document.querySelector<HTMLElement>('.dbw-field-create-form'); assert.ok(element); return element }
  const unmount = async () => { if (mounted) { mounted = false; await act(async () => root.unmount()) } }
  try {
    await render()
    await run({ document: dom.window.document, window: dom.window, text, requests, calls, render, row, click, createForm, unmount,
      fill: async (element, value) => { await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(element, value)
        element.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      }) },
      key: async (element, key, init = {}) => {
        const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
        await act(async () => element.dispatchEvent(event))
        return event
      },
      startCreate: async () => { await click(dom.window.document.querySelector<HTMLButtonElement>('.dbw-add-field-button')!); return createForm() },
      editName: async (index = 0) => { await click(row(index).querySelector<HTMLButtonElement>('.dbw-field-name')!);
        const input = row(index).querySelector<HTMLInputElement>('input:not(.dbw-field-options)'); assert.ok(input); return input }
    })
  } finally {
    await unmount()
    await act(async () => Object.values(requests).flat().forEach(request => request.resolve(false)))
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

const createButton = (form: HTMLElement) => form.querySelector<HTMLButtonElement>('.dbw-primary-button')!
const nameInput = (form: HTMLElement) => form.querySelector<HTMLInputElement>('input')!
const optionInput = (row: HTMLElement) => row.querySelector<HTMLInputElement>('.dbw-field-options')!
const alert = (element: ParentNode) => element.querySelector('[role=alert]')?.textContent ?? ''
const nameButton = (row: HTMLElement) => row.querySelector<HTMLButtonElement>('.dbw-field-name')!

test('failed field creation retains name, type and options for retry; only success clears the form in both languages', async () => {
  for (const locale of ['zh-CN', 'en-US']) {
    for (const failure of ['false', 'throw']) {
      await withDrawer(async ({ document, window, text, requests, startCreate, createForm, fill, click }) => {
        const form = await startCreate()
        await fill(nameInput(form), 'Project stage')
        const type = form.querySelector<HTMLSelectElement>('select')!
        await act(async () => { type.value = 'select'; type.dispatchEvent(new window.Event('change', { bubbles: true })) })
        await fill(form.querySelectorAll<HTMLInputElement>('input')[1], 'Draft, Review, Published')
        await click(createButton(form))
        await act(async () => failure === 'false' ? requests.create[0].resolve(false) : requests.create[0].reject(new Error('secret IPC exception')))
        assert.equal(nameInput(createForm()).value, 'Project stage')
        assert.equal(type.value, 'select')
        assert.equal(createForm().querySelectorAll<HTMLInputElement>('input')[1].value, 'Draft, Review, Published')
        assert.equal(alert(createForm()), text.failed)
        assert.equal(document.body.textContent!.includes('secret IPC exception'), false)
        await click(createButton(createForm()))
        assert.deepEqual(requests.create[1].input, requests.create[0].input)
        assert.equal(alert(createForm()), '')
        await act(async () => requests.create[1].resolve(true))
        assert.equal(document.querySelector('.dbw-field-create-form'), null)
        const next = await startCreate()
        assert.equal(nameInput(next).value, '')
        assert.equal(next.querySelector<HTMLSelectElement>('select')!.value, 'text')
        assert.equal(next.querySelectorAll('input').length, 1)
      }, locale)
    }
  }
})

test('one synchronous field submission lock blocks repeated create, other mutations, cancel, close and Escape', async () => {
  await withDrawer(async ({ document, window, text, requests, calls, startCreate, createForm, fill, row, key }) => {
    const form = await startCreate()
    await fill(nameInput(form), 'One field')
    const submit = createButton(form)
    const cancel = form.querySelector<HTMLButtonElement>('.dbw-quiet-button')!
    const close = document.querySelector<HTMLButtonElement>('.dbw-drawer-header .dbw-icon-button')!
    const scrim = document.querySelector<HTMLButtonElement>('.dbw-drawer-scrim')!
    await act(async () => {
      submit.click(); submit.click(); cancel.click(); close.click(); scrim.click()
      nameButton(row()).click(); row().querySelector<HTMLButtonElement>(`button[aria-label="${text.moveDown} · ${text.system}"]`)!.click()
      optionInput(row(1)).dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }))
    })
    assert.equal(requests.create.length, 1)
    assert.equal(requests.name.length + requests.options.length + requests.move.length, 0)
    assert.equal(calls.close, 0)
    assert.ok(createForm())
    assert.equal(document.querySelector('[role=dialog]')!.getAttribute('aria-busy'), 'true')
    assert.ok(document.querySelector('[role=status]'))
    for (const control of document.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('[role=dialog] input, [role=dialog] button, [role=dialog] select')) assert.equal(control.disabled, true)
    await key(document.querySelector<HTMLElement>('[role=dialog]')!, 'Escape')
    assert.equal(calls.close, 0)
    await act(async () => requests.create[0].resolve(false))
    assert.equal(document.querySelector('[role=dialog]')!.getAttribute('aria-busy'), 'false')
    await act(async () => close.click())
    assert.equal(calls.close, 1)
  })
})

test('late create responses cannot clear a reopened form, cross-source draft or unlock its newer submission', async () => {
  for (const transition of ['reopen', 'source', 'aba']) {
    for (const outcome of [true, false]) {
      await withDrawer(async ({ document, requests, startCreate, createForm, fill, click, render }) => {
        await startCreate(); await fill(nameInput(createForm()), 'Old request'); await click(createButton(createForm()))
        if (transition === 'reopen') { await render({ open: false }); await render({ open: true }) }
        else { await render({ sourceSessionKey: 'source-b' }); if (transition === 'aba') await render({ sourceSessionKey: 'source-a' }) }
        await startCreate(); await fill(nameInput(createForm()), 'New session'); await click(createButton(createForm()))
        await act(async () => requests.create[0].resolve(outcome))
        assert.equal(nameInput(createForm()).value, 'New session')
        assert.equal(createButton(createForm()).disabled, true)
        assert.equal(alert(createForm()), '')
        assert.equal(document.querySelector('[role=dialog]')!.getAttribute('aria-busy'), 'true')
        await act(async () => requests.create[1].resolve(false))
        assert.equal(nameInput(createForm()).value, 'New session')
        assert.equal(createButton(createForm()).disabled, false)
        assert.ok(alert(createForm()))
      })
    }
  }
})

test('failed renaming keeps its editor and draft through a refresh; retry succeeds without duplicate blur or later unchanged submission', async () => {
  await withDrawer(async ({ document, text, requests, row, editName, fill, key, render, click }) => {
    const input = await editName()
    await fill(input, 'Accepted owner')
    await key(input, 'Enter')
    assert.equal(input.disabled, true)
    await act(async () => input.dispatchEvent(new input.ownerDocument.defaultView!.FocusEvent('focusout', { bubbles: true })))
    assert.equal(requests.name.length, 1)
    await act(async () => requests.name[0].resolve(false))
    assert.equal(input.value, 'Accepted owner')
    assert.equal(input.disabled, false)
    assert.equal(document.activeElement, input, 'keyboard failure returns to the preserved editor')
    assert.equal(alert(row()), text.failed)
    await render({ fields: [{ ...owner, name: 'Server owner' }, stage] })
    assert.equal(input.value, 'Accepted owner', 'an unrelated refresh must not overwrite the failed draft')
    const save = row().querySelector<HTMLButtonElement>('.dbw-field-submit')!
    await act(async () => { save.click(); save.click() })
    assert.equal(requests.name.length, 2)
    assert.deepEqual(requests.name[1].input, ['owner', 'Accepted owner'])
    await act(async () => requests.name[1].resolve(true))
    assert.equal(nameButton(row()).textContent, 'Accepted owner', 'successful local snapshot survives delayed props refresh')
    const reopened = await editName()
    assert.equal(reopened.value, 'Accepted owner')
    await act(async () => reopened.blur())
    assert.equal(requests.name.length, 2, 'unchanged accepted value must not be persisted again')
    await render({ fields: [{ ...owner, name: 'Refreshed accepted owner' }, stage] })
    assert.equal(nameButton(row()).textContent, 'Refreshed accepted owner')
  })
})

test('failed options retain the draft, show a safe inline retry and do not duplicate blur or re-save a successful snapshot', async () => {
  for (const failure of ['false', 'throw']) {
    await withDrawer(async ({ window, text, requests, row, fill, render, click }) => {
      const input = optionInput(row(1))
      await act(async () => input.focus())
      await fill(input, 'Draft, Review')
      await act(async () => { input.blur(); input.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true })) })
      assert.equal(requests.options.length, 1)
      assert.equal(input.disabled, true)
      await act(async () => failure === 'false' ? requests.options[0].resolve(false) : requests.options[0].reject(new Error('private options failure')))
      assert.equal(input.value, 'Draft, Review')
      assert.equal(input.disabled, false)
      assert.equal(alert(row(1)), text.failed)
      await render({ fields: [owner, { ...stage, options: ['Server draft', 'Server published'] }] })
      assert.equal(input.value, 'Draft, Review')
      const save = row(1).querySelector<HTMLButtonElement>('.dbw-field-submit')!
      await act(async () => { input.focus(); save.focus(); save.click(); save.click() })
      assert.equal(requests.options.length, 2, 'focus change blur and the Save click share one submission lock')
      assert.deepEqual(requests.options[1].input, ['stage', ['Draft', 'Review']])
      await act(async () => requests.options[1].resolve(true))
      assert.equal(input.value, 'Draft, Review')
      assert.equal(alert(row(1)), '')
      await act(async () => { input.focus(); input.blur() })
      assert.equal(requests.options.length, 2)
      await render({ fields: [owner, { ...stage, options: ['Refreshed', 'Options'] }] })
      assert.equal(input.value, 'Refreshed, Options')
    })
  }
})

test('unchanged existing comma-containing options are not implicitly rewritten by a focus and blur', async () => {
  await withDrawer(async ({ requests, row, render }) => {
    await render({ fields: [owner, { ...stage, options: ['Design, UX', 'Core'] }] })
    const input = optionInput(row(1))
    assert.equal(input.value, 'Design, UX, Core')
    await act(async () => { input.focus(); input.blur() })
    assert.equal(requests.options.length, 0)
  })
})

test('default-order moves are locked, show failures and can retry without repeating another pending mutation', async () => {
  await withDrawer(async ({ document, text, requests, row, click }) => {
    const move = row().querySelector<HTMLButtonElement>(`button[aria-label="${text.moveDown} · ${text.system}"]`)!
    await act(async () => { move.click(); move.click() })
    assert.equal(requests.move.length, 1)
    assert.equal(document.querySelector('[role=dialog]')!.getAttribute('aria-busy'), 'true')
    await act(async () => requests.move[0].reject(new Error('secret move error')))
    assert.equal(alert(row()), text.failed)
    assert.equal(move.disabled, false)
    await click(move)
    assert.equal(alert(row()), '')
    await act(async () => requests.move[1].resolve(true))
    assert.equal(alert(row()), '')
    assert.equal(document.querySelector('[role=dialog]')!.getAttribute('aria-busy'), 'false')
  })
})

test('late field-row success and failure do not affect a new source editor or its pending request', async () => {
  for (const outcome of [true, false]) {
    await withDrawer(async ({ document, requests, row, editName, fill, key, render }) => {
      const old = await editName(); await fill(old, 'Old draft'); await key(old, 'Enter')
      await render({ sourceSessionKey: 'source-b', fields: [{ ...owner, name: 'B owner' }, stage] })
      const current = await editName(); await fill(current, 'B draft'); await key(current, 'Enter')
      await act(async () => requests.name[0].resolve(outcome))
      assert.equal(current.value, 'B draft')
      assert.equal(current.disabled, true)
      assert.equal(alert(row()), '')
      assert.equal(document.querySelector('[role=dialog]')!.getAttribute('aria-busy'), 'true')
      await act(async () => requests.name[1].resolve(false))
      assert.equal(current.value, 'B draft')
      assert.equal(current.disabled, false)
      assert.ok(alert(row()))
    })
  }
})

test('unmount ignores late field responses instead of closing a different drawer or rendering a failure', async () => {
  await withDrawer(async ({ document, calls, requests, startCreate, createForm, fill, click, unmount }) => {
    await startCreate(); await fill(nameInput(createForm()), 'Unmounted field'); await click(createButton(createForm()))
    await unmount()
    await act(async () => requests.create[0].resolve(true))
    assert.equal(document.querySelector('[role=dialog]'), null)
    assert.equal(calls.close, 0)
  })
})

test('field creation and row type descriptions expose all five localized types and accessible inputs', async () => {
  for (const locale of ['zh-CN', 'en-US']) {
    await withDrawer(async ({ text, row, startCreate, createForm, window, render }) => {
      const form = await startCreate()
      assert.equal(nameInput(form).getAttribute('aria-label'), text.name)
      const type = form.querySelector<HTMLSelectElement>('select')!
      assert.equal(type.getAttribute('aria-label'), text.fieldType)
      assert.deepEqual([...type.options].map(option => option.textContent), [text.typeText, text.typeSelect, text.typeMultiSelect, text.typeDate, text.typeCheckbox])
      await act(async () => { type.value = 'multi-select'; type.dispatchEvent(new window.Event('change', { bubbles: true })) })
      assert.equal(createForm().querySelectorAll('input')[1].getAttribute('aria-label'), text.options)
      assert.equal(row().querySelector('small')!.textContent, text.typeText)
      assert.equal(row(1).querySelector('small')!.textContent, text.typeSelect)
      await render({ fields: [{ ...owner, role: 'system', type: 'date' }, stage] })
      assert.equal(row().querySelector('small')!.textContent, `${text.system} · ${text.typeDate}`)
      assert.equal(optionInput(row(1)).getAttribute('aria-label'), `${text.options} · Stage`)
    }, locale)
  }
})

test('field creation keeps localized labels and required guidance visible after filling and across conditional option types', async () => {
  for (const locale of ['zh-CN', 'en-US']) {
    await withDrawer(async ({ document, window, text, requests, startCreate, createForm, fill }) => {
      const form = await startCreate()
      const name = nameInput(form)
      const type = form.querySelector<HTMLSelectElement>('select')!
      assert.equal((name.labels?.length ?? 0) > 0, true, 'Name must have a persistent visible label')
      assert.equal((type.labels?.length ?? 0) > 0, true, 'Field type must have a persistent visible label')
      assert.equal(name.labels![0].textContent!.includes(text.name), true)
      assert.equal(name.labels![0].textContent!.includes('*'), true)
      assert.equal(type.labels![0].textContent!.includes(text.fieldType), true)
      assert.equal(name.getAttribute('aria-required'), 'true')
      assert.equal(type.getAttribute('aria-required') === 'true', false)
      const requiredId = name.getAttribute('aria-describedby') ?? ''
      assert.equal(requiredId.length > 0, true)
      const requiredHint = document.getElementById(requiredId)
      assert.equal(requiredHint?.textContent, locale === 'zh-CN' ? '标有 * 的项目为必填。' : 'Fields marked * are required.')
      assert.equal(requiredHint?.closest('[hidden], [aria-hidden="true"]') === null, true)
      await fill(name, 'Filled field name')
      assert.equal(name.labels![0].textContent!.includes(text.name), true, 'Filling must not replace the visible name label')
      const changeType = async (value: string) => act(async () => {
        type.value = value
        type.dispatchEvent(new window.Event('change', { bubbles: true }))
      })
      let optionsHintId = ''
      for (const value of ['select', 'multi-select']) {
        await changeType(value)
        const options = createForm().querySelector<HTMLInputElement>(`input[aria-label="${text.options}"]`)!
        assert.ok(options)
        assert.equal((options.labels?.length ?? 0) > 0, true)
        assert.equal(options.labels![0].textContent!.includes(text.options), true)
        assert.equal(options.labels![0].textContent!.includes('*'), true)
        assert.equal(options.getAttribute('aria-required'), 'true')
        const hintId = options.getAttribute('aria-describedby') ?? ''
        assert.equal(hintId.length > 0, true)
        if (optionsHintId) assert.equal(hintId, optionsHintId, 'The options explanation keeps its identity across select types')
        optionsHintId = hintId
        assert.equal(document.getElementById(hintId)?.textContent, locale === 'zh-CN'
          ? '至少输入一个选项，使用英文逗号分隔。' : 'Enter at least one option. Separate options with commas.')
        await fill(options, 'Draft, Review')
        assert.equal(options.labels![0].textContent!.includes(text.options), true)
        assert.equal(name.value, 'Filled field name')
        assert.equal(name.getAttribute('aria-describedby'), requiredId)
      }
      for (const value of ['text', 'date', 'checkbox']) {
        await changeType(value)
        assert.equal(createForm().querySelectorAll(`input[aria-label="${text.options}"]`).length, 0)
        assert.equal(document.getElementById(optionsHintId) === null, true)
        assert.equal(name.getAttribute('aria-describedby'), requiredId)
        assert.equal(document.getElementById(requiredId) === requiredHint, true)
        for (const element of createForm().querySelectorAll('[aria-describedby]')) {
          for (const id of element.getAttribute('aria-describedby')!.split(/\s+/)) assert.equal(document.getElementById(id) !== null, true)
        }
      }
      await changeType('select')
      const returnedOptions = createForm().querySelector<HTMLInputElement>(`input[aria-label="${text.options}"]`)!
      assert.equal(returnedOptions.value, 'Draft, Review', 'Type changes must preserve the previously entered option draft')
      assert.equal(returnedOptions.getAttribute('aria-describedby'), optionsHintId)
      assert.equal(alert(createForm()), '')
      assert.equal(createForm().querySelectorAll('[aria-invalid="true"]').length, 0)
      assert.equal(Object.values(requests).flat().length, 0)
    }, locale)
  }
})

test('select fields explain empty options without treating normal incomplete input as an error, and retain trimmed deduplicated submission behavior', async () => {
  for (const locale of ['zh-CN', 'en-US']) for (const fieldType of ['select', 'multi-select']) {
    await withDrawer(async ({ window, text, requests, startCreate, createForm, fill, click }) => {
      const form = await startCreate()
      const name = nameInput(form)
      const type = form.querySelector<HTMLSelectElement>('select')!
      await act(async () => { type.value = fieldType; type.dispatchEvent(new window.Event('change', { bubbles: true })) })
      const options = createForm().querySelector<HTMLInputElement>(`input[aria-label="${text.options}"]`)!
      const hintId = options.getAttribute('aria-describedby') ?? ''
      assert.equal(hintId.length > 0, true)
      assert.equal(options.ownerDocument.getElementById(hintId)?.textContent, locale === 'zh-CN'
        ? '至少输入一个选项，使用英文逗号分隔。' : 'Enter at least one option. Separate options with commas.')
      await fill(name, '  Project stage  ')
      for (const emptyOptions of ['', ' \t ', ', , ,']) {
        await fill(options, emptyOptions)
        assert.equal(createButton(createForm()).disabled, true)
        await click(createButton(createForm()))
        assert.equal(requests.create.length, 0)
        assert.equal(alert(createForm()), '')
        assert.equal(createForm().querySelectorAll('[aria-invalid="true"]').length, 0)
      }
      await fill(options, ' Draft, Review, Draft, ,  ')
      assert.equal(createButton(createForm()).disabled, false)
      for (const emptyName of ['', ' \t ']) {
        await fill(name, emptyName)
        assert.equal(createButton(createForm()).disabled, true)
        await click(createButton(createForm()))
        assert.equal(requests.create.length, 0)
        assert.equal(alert(createForm()), '')
      }
      await fill(name, '  Project stage  ')
      assert.equal(createButton(createForm()).disabled, false)
      assert.equal(name.labels![0].textContent!.includes(text.name), true)
      assert.equal(options.labels![0].textContent!.includes(text.options), true)
      await click(createButton(createForm()))
      assert.equal(requests.create.length, 1)
      assert.deepEqual(requests.create[0].input, ['Project stage', fieldType, ['Draft', 'Review']])
      await act(async () => requests.create[0].resolve(true))
    }, locale)
  }
})

test('creation and option drafts survive IME Enter and Escape; ordinary Escape works after composition ends or blur', async () => {
  for (const locale of ['zh-CN', 'en-US']) {
    for (const target of ['create-name', 'create-options', 'row-options']) {
      await withDrawer(async ({ document, window, calls, requests, startCreate, fill, row, key }) => {
        let input: HTMLInputElement
        if (target === 'row-options') input = optionInput(row(1))
        else {
          const form = await startCreate()
          if (target === 'create-options') {
            const type = form.querySelector<HTMLSelectElement>('select')!
            await act(async () => { type.value = 'select'; type.dispatchEvent(new window.Event('change', { bubbles: true })) })
            input = form.querySelectorAll<HTMLInputElement>('input')[1]
          } else input = nameInput(form)
        }
        await fill(input, '中文候选')
        await act(async () => { input.focus(); input.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true })) })
        for (const candidate of ['Enter', 'Escape']) {
          assert.equal((await key(input, candidate)).defaultPrevented, false)
          assert.equal(document.activeElement, input)
          assert.equal(input.value, '中文候选')
          assert.equal(calls.close, 0)
          assert.equal(Object.values(requests).flat().length, 0)
        }
        await act(async () => input.dispatchEvent(new window.CompositionEvent('compositionend', { bubbles: true })))
        for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
          for (const candidate of ['Enter', 'Escape']) {
            assert.equal((await key(input, candidate, init)).defaultPrevented, false)
            assert.equal(input.value, '中文候选')
            assert.equal(calls.close, 0)
            assert.equal(Object.values(requests).flat().length, 0)
          }
        }
        await act(async () => { input.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true })); input.blur() })
        if (target === 'row-options') {
          assert.deepEqual(requests.options[0].input, ['stage', ['中文候选']])
          await act(async () => requests.options[0].resolve(false))
        }
        await act(async () => input.focus())
        assert.equal((await key(input, 'Escape')).defaultPrevented, true)
        assert.equal(calls.close, 1, 'blur clears a stale composition lifecycle so ordinary drawer Escape is available')
      }, locale)
    }
  }
})
