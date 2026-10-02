import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type Handler = (event: unknown, input: unknown) => unknown | Promise<unknown>
type Request = { event: unknown; input: unknown; settled: boolean; resolve: (value: unknown) => void; reject: (error: Error) => void }
type Probe = { original: Handler; requests: Request[]; saved: unknown[]; failures: string[] }
type ProbeGlobal = typeof globalThis & { __knowbookRecordContinueFocus?: Probe }
type TitleWatch = { element: HTMLInputElement; calls: Array<{ beforeTag: string | null; afterTag: string | null; preventScroll: boolean }> }
type ProbeWindow = Window & {
  __knowbookRecordContinueTitle?: TitleWatch
  __knowbookRecordContinueRoute?: Array<{ phase: string; step: number; tag: string | null; text: string | null; reached: boolean }>
  __knowbookRecordContinueWindowSignals?: Array<'blur' | 'focus'>
  __knowbookRecordContinuePointer?: { point: { x: number; y: number }; inViewport: boolean;
    inScrim: boolean; outsideDialog: boolean; hitScrim: boolean; hitTag: string | null; hitClass: string | null }
}

const sourceName = 'Continue focus ownership'
const dialog = (page: Page) => page.getByRole('dialog', { name: uiText('Create record', '新建记录'), exact: true })
const titleInput = (scope: Locator) => scope.getByRole('textbox', { name: /Title|标题/ })
const linkedInput = (scope: Locator) => scope.getByLabel(/Linked document|关联文档/)
const noteInput = (scope: Locator) => scope.getByLabel('Notes', { exact: true })
const continueButton = (scope: Locator) => scope.locator('footer > .dbw-quiet-button')

async function seed(page: Page, language: 'en-US' | 'zh-CN') {
  const ids = await page.evaluate(async ({ sourceName, language }) => {
    const database = await window.knowbook.createDocumentDatabase({ name: sourceName })
    const field = await window.knowbook.createDocumentDatabaseColumn({ databaseId: database.id, name: 'Notes', type: 'text' })
    // The store requires each record in this database to have its own linked
    // document. Every success scenario uses a separately persisted real UUID.
    const documentIds: [string, string, string, string] = [
      (await window.knowbook.createDocument(null)).id,
      (await window.knowbook.createDocument(null)).id,
      (await window.knowbook.createDocument(null)).id,
      (await window.knowbook.createDocument(null)).id
    ]
    await window.knowbook.saveSetting('ui.language', language)
    await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
    window.localStorage.setItem('knowbook.database.last-source', database.id)
    return { databaseId: database.id, fieldId: field.id, documentIds }
  }, { sourceName, language })
  await page.reload()
  await page.setViewportSize({ width: 1180, height: language === 'zh-CN' ? 850 : 800 })
  await page.getByTitle(uiText('Database', '数据库'), { exact: true }).click()
  await expect(page.locator('.dbw-source-trigger')).toContainText(sourceName)
  await expect(page.locator('.dbw-empty-state')).toBeVisible()
  return ids
}

async function installProbe(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const original = handlers.get('knowbook:create-database-entity')
    if (!original) throw new Error('The real create-record IPC handler is required')
    const probe: Probe = { original, requests: [], saved: [], failures: [] }
    ;(globalThis as ProbeGlobal).__knowbookRecordContinueFocus = probe
    ipcMain.removeHandler('knowbook:create-database-entity')
    ipcMain.handle('knowbook:create-database-entity', (event, input) => new Promise((resolve, reject) => {
      probe.requests.push({ event, input, settled: false, resolve, reject })
    }))
  })
}

async function settle(app: ElectronApplication, index: number) {
  await app.evaluate((_electron, index) => {
    const probe = (globalThis as ProbeGlobal).__knowbookRecordContinueFocus!
    const request = probe.requests[index]
    if (!request || request.settled) throw new Error('A real unsettled create-record request is required')
    request.settled = true
    setImmediate(async () => {
      try {
        const saved = await probe.original(request.event, request.input)
        probe.saved.push(saved)
        request.resolve(saved)
      } catch (reason) {
        const error = reason instanceof Error ? reason : new Error(String(reason))
        probe.failures.push(error.message)
        request.reject(error)
      }
    })
  }, index)
}

async function watchTitle(target: Locator) {
  await target.evaluate(element => {
    const input = element as HTMLInputElement
    const existing = (window as ProbeWindow).__knowbookRecordContinueTitle
    if (existing?.element === input) {
      existing.calls.length = 0
      return
    }
    const watch: TitleWatch = { element: input, calls: [] }
    ;(window as ProbeWindow).__knowbookRecordContinueTitle = watch
    const original = input.focus
    input.focus = options => {
      const before = document.activeElement
      original.call(input, options)
      watch.calls.push({ beforeTag: before?.tagName ?? null, afterTag: document.activeElement?.tagName ?? null,
        preventScroll: options?.preventScroll === true })
    }
  })
}

async function tabTo(page: Page, target: Locator, phase: string, limit = 10) {
  let reached = false
  for (let step = 1; step <= limit; step++) {
    await page.keyboard.press('Tab')
    const stop = await target.evaluate((element, { phase, step }) => {
      const active = document.activeElement as HTMLElement | null
      const stop = { phase, step, tag: active?.tagName ?? null,
        text: active?.tagName === 'BUTTON' ? active.textContent?.trim() ?? null : null, reached: active === element }
      ;((window as ProbeWindow).__knowbookRecordContinueRoute ??= []).push(stop)
      return stop
    }, { phase, step })
    reached = stop.reached
    if (reached || stop.tag === 'BODY') break
  }
  expect(reached).toBe(true)
  await expect(target).toBeFocused()
}

async function pointerToDisabledScrim(page: Page, scope: Locator) {
  const scrim = page.locator('.dbw-modal-scrim')
  await expect(scrim).toHaveCount(1)
  await expect(scrim).toBeDisabled()
  const bounds = await scrim.boundingBox()
  const dialogBounds = await scope.boundingBox()
  if (!bounds || !dialogBounds) throw new Error('The actual scrim and dialog must be rendered')
  const point = { x: bounds.x + 12, y: bounds.y + 12 }
  const inspected = await scrim.evaluate((element, { point, dialogBounds }) => {
    const scrim = element.getBoundingClientRect()
    const hit = document.elementFromPoint(point.x, point.y)
    const inspected = { point, inViewport: point.x >= 0 && point.x < innerWidth && point.y >= 0 && point.y < innerHeight,
      inScrim: point.x >= scrim.left && point.x < scrim.right && point.y >= scrim.top && point.y < scrim.bottom,
      outsideDialog: point.x < dialogBounds.x || point.x >= dialogBounds.x + dialogBounds.width ||
        point.y < dialogBounds.y || point.y >= dialogBounds.y + dialogBounds.height,
      hitScrim: hit === element, hitTag: hit?.tagName ?? null, hitClass: hit?.getAttribute('class') ?? null }
    ;(window as ProbeWindow).__knowbookRecordContinuePointer = inspected
    return inspected
  }, { point, dialogBounds })
  expect(inspected.inViewport).toBe(true)
  expect(inspected.inScrim).toBe(true)
  expect(inspected.outsideDialog).toBe(true)
  expect(inspected.hitScrim).toBe(true)
  // Use genuine mouse input: Locator.click would wait for this deliberately
  // disabled scrim to become enabled and would not represent the interaction.
  await page.mouse.click(point.x, point.y)
}

async function expectTitleReachable(target: Locator) {
  await expect(target).toBeFocused()
  await expect(target).toBeInViewport({ ratio: 1 })
  const geometry = await target.evaluate(element => {
    const container = element.closest<HTMLElement>('.dbw-create-record-dialog')
    if (!container) throw new Error('The actual create-record dialog is required')
    const bounds = container.getBoundingClientRect()
    const rect = element.getBoundingClientRect()
    const clip = { left: bounds.left + container.clientLeft, top: bounds.top + container.clientTop,
      right: bounds.left + container.clientLeft + container.clientWidth,
      bottom: bounds.top + container.clientTop + container.clientHeight }
    return { rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }, clip,
      inside: rect.left >= clip.left - .5 && rect.top >= clip.top - .5 && rect.right <= clip.right + .5 && rect.bottom <= clip.bottom + .5 }
  })
  expect(geometry.inside, JSON.stringify(geometry)).toBe(true)
}

async function record(page: Page, app: ElectronApplication, testInfo: TestInfo, scope: Locator, phase: string) {
  const main = await app.evaluate(({ BrowserWindow }) => {
    const probe = (globalThis as ProbeGlobal).__knowbookRecordContinueFocus!
    return { windows: BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible(),
      focused: window.isFocused(), focusable: window.isFocusable(), bounds: window.getBounds() })),
      requests: probe.requests.map(request => ({ input: request.input, settled: request.settled })),
      savedCount: probe.saved.length, failures: probe.failures }
  })
  expect(main.windows.length).toBeGreaterThan(0)
  expect(main.windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  const state = await scope.evaluate(element => {
    const active = document.activeElement as HTMLElement | null
    const watch = (window as ProbeWindow).__knowbookRecordContinueTitle
    return { viewport: { width: innerWidth, height: innerHeight }, active: { tag: active?.tagName,
      label: active?.getAttribute('aria-label'), text: active?.tagName === 'BUTTON' ? active.textContent?.trim() : null },
      dialogFocused: active === element, bodyFocused: active === document.body,
      rendererHasFocus: document.hasFocus(), ariaBusy: element.getAttribute('aria-busy'),
      controls: Array.from(element.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select')).map(input => {
        const rect = input.getBoundingClientRect()
        return { label: input.getAttribute('aria-label') ?? input.closest('label')?.querySelector('span')?.textContent,
          value: input.value, disabled: input.disabled, focused: active === input,
          rect: { top: rect.top, bottom: rect.bottom, height: rect.height } }
      }),
      titleWatch: watch ? { connected: watch.element.isConnected, sameInput: element.querySelector('input') === watch.element,
        focused: active === watch.element, calls: watch.calls } : null,
      route: (window as ProbeWindow).__knowbookRecordContinueRoute ?? [],
      controlledWindowSignals: (window as ProbeWindow).__knowbookRecordContinueWindowSignals ?? [],
      pointer: (window as ProbeWindow).__knowbookRecordContinuePointer ?? null }
  })
  const path = testInfo.outputPath(`${phase}.json`)
  writeFileSync(path, JSON.stringify({ phase, main, state }, null, 2))
  await testInfo.attach(`${phase}-state`, { path, contentType: 'application/json' })
  await page.screenshot({ path: testInfo.outputPath(`${phase}.png`) })
  return { main, state }
}

for (const language of ['en-US', 'zh-CN'] as const) {
  test(`successful Continue respects keyboard, pointer and blur focus ownership in ${language} @electron`, async ({}, testInfo) => {
    test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
    await withElectronApp(async ({ page, app }) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      const ids = await seed(page, language)
      expect(new Set(ids.documentIds).size).toBe(4)
      const before = await page.evaluate(async id => ({ records: await window.knowbook.getDatabaseEntities(id),
        columns: await window.knowbook.getDocumentDatabaseColumns(id), views: await window.knowbook.getDatabaseSavedViews(id) }), ids.databaseId)
      expect(before.records).toEqual([])
      await installProbe(app)
      await page.getByRole('button', { name: uiText('New record', '新建记录'), exact: true }).click()
      const scope = dialog(page)
      const originalTitle = titleInput(scope)
      await expect(originalTitle).toBeFocused()
      if (language === 'zh-CN') await page.setViewportSize({ width: 1180, height: 440 })
      const titles = ['Continue without intervening input', 'Continue with transferred focus',
        'Continue after pointer focus cycle', 'Continue after renderer blur signal'] as const

      for (const [index, ownership] of (['owned', 'dialog', 'body', 'blur'] as const).entries()) {
        const recordsBefore = await page.evaluate(id => window.knowbook.getDatabaseEntities(id), ids.databaseId)
        if (index === 1) await expect(originalTitle).toHaveValue(titles[index])
        await originalTitle.fill(titles[index])
        await linkedInput(scope).selectOption(ids.documentIds[index])
        const note = `Persisted note for ${ownership}`
        await noteInput(scope).fill(note)
        // Initial/opening focus and draft entry are outside this counter window.
        // The same original input's native method is wrapped once, then reset.
        await watchTitle(originalTitle)
        const submit = continueButton(scope)
        await expect(submit).toHaveText(uiText('Create and add another', '创建并继续添加'))
        await tabTo(page, submit, `${ownership}-notes-to-continue`)
        await page.keyboard.press('Enter')
        await expect.poll(() => app.evaluate(() => (globalThis as ProbeGlobal).__knowbookRecordContinueFocus!.requests.length)).toBe(index + 1)
        await expect(scope).toHaveAttribute('aria-busy', 'true')
        await expect(submit).toBeDisabled()
        if (ownership === 'dialog' || ownership === 'body') {
          // Actual Tab transfers focus to the real container via the existing
          // trap while every control is disabled; no target.focus() is used.
          await page.keyboard.press('Tab')
          await expect(scope).toBeFocused()
        }
        if (ownership === 'body') {
          await pointerToDisabledScrim(page, scope)
        }
        if (ownership === 'blur') {
          // Playwright forces renderer focus. These are explicit controlled
          // events, not a claim of OS-window blur or native foreground changes.
          await page.evaluate(() => {
            const probe = window as ProbeWindow
            probe.__knowbookRecordContinueWindowSignals = ['blur', 'focus']
            window.dispatchEvent(new Event('blur'))
            window.dispatchEvent(new Event('focus'))
          })
        }
        const pending = await record(page, app, testInfo, scope, `${language}-${ownership}-continue-pending`)
        expect(pending.state.titleWatch?.calls).toEqual([])
        if (ownership === 'body' || ownership === 'blur') {
          // Capture real browser focus before checking this precondition; do
          // not manufacture BODY with blur()/focus() if the pointer differs.
          expect(pending.state.bodyFocused).toBe(true)
          expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true)
        }
        await settle(app, index)
        await expect(scope).toHaveAttribute('aria-busy', 'false')
        await expect(scope).toBeVisible()
        await expect(originalTitle).toHaveValue('')
        await expect(linkedInput(scope)).toHaveValue('')
        await expect(noteInput(scope)).toHaveValue('')
        const saved = await page.evaluate(id => window.knowbook.getDatabaseEntities(id), ids.databaseId)
        expect(saved).toHaveLength(index + 1)
        const created = saved.filter(record => !recordsBefore.some(previous => previous.id === record.id))
        expect(created).toHaveLength(1)
        expect(created[0].title).toBe(titles[index])
        expect(created[0].documentId).toBe(ids.documentIds[index])
        expect(created[0].fieldValues[ids.fieldId]).toBe(note)
        expect(saved.filter(record => record.id !== created[0].id)).toEqual(recordsBefore)
        // Actual state is saved before every successful-focus ownership oracle.
        const completed = await record(page, app, testInfo, scope, `${language}-${ownership}-continue-saved`)
        expect(completed.main.requests).toHaveLength(index + 1)
        expect(completed.main.savedCount).toBe(index + 1)
        expect(completed.main.failures).toEqual([])
        expect(completed.state.titleWatch?.connected).toBe(true)
        expect(completed.state.titleWatch?.sameInput).toBe(true)
        if (ownership === 'owned') {
          expect(completed.state.titleWatch?.calls).toHaveLength(1)
          await expectTitleReachable(originalTitle)
          // A successful owned action supports immediate next-record typing.
          await page.keyboard.type(titles[1])
          await expect(originalTitle).toHaveValue(titles[1])
        } else {
          await expect(originalTitle).not.toBeFocused()
          expect(completed.state.titleWatch?.calls).toEqual([])
          if (ownership === 'dialog') await expect(scope).toBeFocused()
          else expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true)
        }
      }
      const final = await page.evaluate(async id => ({ records: await window.knowbook.getDatabaseEntities(id),
        columns: await window.knowbook.getDocumentDatabaseColumns(id), views: await window.knowbook.getDatabaseSavedViews(id) }), ids.databaseId)
      expect(final.records).toHaveLength(4)
      expect(new Set(final.records.map(record => record.documentId)).size).toBe(4)
      expect(final.columns).toEqual(before.columns)
      expect(final.views).toEqual(before.views)
      expect(errors).toEqual([])
    })
  })
}
