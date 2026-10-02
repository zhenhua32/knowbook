import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type InitialFocusWatch = {
  element: HTMLElement
  calls: Array<{ preventScroll: boolean; beforeTag: string | null; beforeLabel: string | null; afterTag: string | null; afterLabel: string | null }>
}

type InitialFocusWindow = Window & {
  __knowbookInitialFocusFrames?: {
    originalRequest: typeof requestAnimationFrame
    originalCancel: typeof cancelAnimationFrame
    callbacks: Map<number, FrameRequestCallback>
    nextId: number
  }
  __knowbookInitialCloseWatch?: InitialFocusWatch
  __knowbookInitialViewNameWatch?: InitialFocusWatch
}

async function twoFrames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function holdInitialFrames(page: Page) {
  await page.evaluate(() => {
    const probe = window as InitialFocusWindow
    if (probe.__knowbookInitialFocusFrames) throw new Error('Initial renderer frames are already held')
    const state = { originalRequest: window.requestAnimationFrame, originalCancel: window.cancelAnimationFrame,
      callbacks: new Map<number, FrameRequestCallback>(), nextId: 1_000_000 }
    probe.__knowbookInitialFocusFrames = state
    window.requestAnimationFrame = callback => {
      const id = ++state.nextId
      state.callbacks.set(id, callback)
      return id
    }
    window.cancelAnimationFrame = id => {
      if (!state.callbacks.delete(id)) state.originalCancel.call(window, id)
    }
  })
}

async function releaseInitialFrames(page: Page) {
  const released = await page.evaluate(() => {
    const probe = window as InitialFocusWindow
    const state = probe.__knowbookInitialFocusFrames
    if (!state) return false
    window.requestAnimationFrame = state.originalRequest
    window.cancelAnimationFrame = state.originalCancel
    delete probe.__knowbookInitialFocusFrames
    for (const callback of state.callbacks.values()) state.originalRequest.call(window, callback)
    return true
  })
  if (released) await twoFrames(page)
}

async function pointerTo(page: Page, target: Locator) {
  await expect(target).toBeVisible()
  const bounds = await target.boundingBox()
  if (!bounds) throw new Error('The actual pointer target is not rendered')
  const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
  expect(await target.evaluate((element, point) => {
    const hit = document.elementFromPoint(point.x, point.y)
    return hit === element || (hit !== null && element.contains(hit))
  }, point)).toBe(true)
  // Native pointer input avoids an actionability RAF wait while deliberately
  // controlling renderer scheduling; it never changes native-window focus.
  await page.mouse.click(point.x, point.y)
}

async function watchInitialFocus(targetLocator: Locator, key: 'close' | 'view-name' = 'close') {
  await targetLocator.evaluate((element, key) => {
    const target = element as HTMLElement
    const watch: InitialFocusWatch = { element: target, calls: [] }
    if (key === 'close') (window as InitialFocusWindow).__knowbookInitialCloseWatch = watch
    else (window as InitialFocusWindow).__knowbookInitialViewNameWatch = watch
    const original = target.focus
    target.focus = options => {
      const before = document.activeElement
      original.call(target, options)
      watch.calls.push({ preventScroll: options?.preventScroll === true, beforeTag: before?.tagName ?? null,
        beforeLabel: before?.getAttribute('aria-label') ?? null, afterTag: document.activeElement?.tagName ?? null,
        afterLabel: document.activeElement?.getAttribute('aria-label') ?? null })
    }
  }, key)
}

async function snapshot(page: Page, app: ElectronApplication, testInfo: TestInfo, phase: string, databaseId: string) {
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable(), bounds: window.getBounds()
  })))
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  const state = await page.evaluate(async databaseId => {
    const probe = window as InitialFocusWindow
    const active = document.activeElement
    const form = document.querySelector('.dbw-field-create-form')
    const watch = probe.__knowbookInitialCloseWatch
    const viewForm = document.querySelector('form.dbw-dialog')
    const viewName = viewForm?.querySelector<HTMLInputElement>('input')
    const viewSubmit = viewForm?.querySelector<HTMLButtonElement>('button[type=submit]')
    const viewWatch = probe.__knowbookInitialViewNameWatch
    return { viewport: { width: innerWidth, height: innerHeight }, active: { tag: active?.tagName,
      label: active?.getAttribute('aria-label'), text: active?.tagName === 'BUTTON' ? active.textContent?.trim() : null },
      formValues: Array.from(form?.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select') ?? []).map(input => ({
        label: input.getAttribute('aria-label'), value: input.value, focused: active === input, disabled: input.disabled })),
      heldFrames: probe.__knowbookInitialFocusFrames?.callbacks.size ?? 0,
      closeWatch: watch ? { connected: watch.element.isConnected, focused: active === watch.element, calls: watch.calls } : null,
      viewForm: viewForm ? { name: viewName?.value, nameFocused: active === viewName, submitFocused: active === viewSubmit } : null,
      viewNameWatch: viewWatch ? { connected: viewWatch.element.isConnected, focused: active === viewWatch.element, calls: viewWatch.calls } : null,
      columns: await window.knowbook.getDocumentDatabaseColumns(databaseId),
      entities: await window.knowbook.getDatabaseEntities(databaseId),
      views: await window.knowbook.getDatabaseSavedViews(databaseId) }
  }, databaseId)
  const path = testInfo.outputPath(`${phase}.json`)
  writeFileSync(path, JSON.stringify({ phase, windows, state }, null, 2))
  await testInfo.attach(phase, { path, contentType: 'application/json' })
  await page.screenshot({ path: testInfo.outputPath(`${phase}.png`) })
  return state
}

for (const [language, theme] of [['en-US', 'light'], ['zh-CN', 'dark']] as const) {
  test(`delayed database initial focus preserves newer field and view controls in ${language} @electron`, async ({}, testInfo) => {
    test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
    await withElectronApp(async ({ page, app }) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      // Only UI preferences are fixture writes. No business-data create/save
      // API is called anywhere in this keyboard and scheduling regression.
      await page.evaluate(async ({ language, theme }) => {
        await window.knowbook.saveSetting('ui.language', language)
        await window.knowbook.saveSetting('appearance.theme', theme)
      }, { language, theme })
      await page.reload()
      await page.setViewportSize({ width: 1180, height: language === 'zh-CN' ? 850 : 800 })
      await page.getByTitle(uiText('Database', '数据库'), { exact: true }).click()
      await expect(page.locator('.dbw-source-trigger')).toContainText(language === 'en-US' ? 'All documents' : '全部文档')
      await twoFrames(page)
      const before = await page.evaluate(async () => {
        const database = (await window.knowbook.getDatabases()).find(source => source.kind === 'document-catalog')
        if (!database) throw new Error('The real default document catalog is required')
        return { databaseId: database.id, columns: await window.knowbook.getDocumentDatabaseColumns(database.id),
          entities: await window.knowbook.getDatabaseEntities(database.id), views: await window.knowbook.getDatabaseSavedViews(database.id) }
      })
      const fields = page.getByRole('button', { name: /^(?:Fields|字段)/ })
      const drawer = page.getByRole('dialog', { name: uiText('Manage fields', '字段管理'), exact: true })
      const close = drawer.getByRole('button', { name: uiText('Close', '关闭'), exact: true })
      try {
        // Uninteracted normal opening must still perform its initial focus.
        await holdInitialFrames(page)
        await pointerTo(page, fields)
        await expect(drawer).toBeVisible()
        await watchInitialFocus(close)
        await releaseInitialFrames(page)
        await snapshot(page, app, testInfo, `${language}-normal-fields-initial-close`, before.databaseId)
        await expect(close).toBeFocused()
        await page.keyboard.press('Escape')
        await expect(drawer).toHaveCount(0)
        await twoFrames(page)

        // This controls a delayed renderer callback, not OS focus or an OS IME.
        await holdInitialFrames(page)
        await pointerTo(page, fields)
        await expect(drawer).toBeVisible()
        await watchInitialFocus(close)
        await pointerTo(page, drawer.getByRole('button', { name: uiText('＋ Add field', '＋ 新增字段'), exact: true }))
        const name = drawer.locator('.dbw-field-create-form').getByLabel(uiText('Name', '名称'), { exact: true })
        await pointerTo(page, name)
        await expect(name).toBeFocused()
        await page.keyboard.type('Initial focus retained')
        // A controlled composition lifecycle makes the ongoing input explicit;
        // no operating-system candidate window is opened.
        await name.dispatchEvent('compositionstart', { data: 'candidate' })
        const held = await snapshot(page, app, testInfo, `${language}-user-name-before-initial-frame`, before.databaseId)
        await releaseInitialFrames(page)
        // Preserve the old-build evidence before the strict focus assertion.
        const completed = await snapshot(page, app, testInfo, `${language}-delayed-initial-focus-state`, before.databaseId)
        expect(completed.columns).toEqual(before.columns)
        expect(completed.entities).toEqual(before.entities)
        await expect(name).toHaveValue('Initial focus retained')
        await expect(name).toBeFocused()
        expect(completed.closeWatch?.calls.length).toBe(held.closeWatch?.calls.length)
        await name.dispatchEvent('compositionend', { data: 'candidate' })
        await page.keyboard.press('Escape')
        await expect(drawer).toHaveCount(0)
        await twoFrames(page)

        // The shared dialog helper also initializes a view form's Name. A user
        // who has already moved to Create must retain that newer focus.
        await pointerTo(page, page.locator('.dbw-new-view-menu summary'))
        const menu = page.locator('.dbw-layout-menu')
        await expect(menu).toBeVisible()
        await twoFrames(page)
        await holdInitialFrames(page)
        await pointerTo(page, menu.getByRole('button', { name: uiText('Table', '表格'), exact: true }))
        const viewForm = page.locator('form.dbw-dialog')
        await expect(viewForm).toBeVisible()
        const viewName = viewForm.getByLabel(uiText('Name', '名称'), { exact: true })
        await watchInitialFocus(viewName, 'view-name')
        await pointerTo(page, viewName)
        await page.keyboard.press('ControlOrMeta+A')
        await page.keyboard.type('Unsaved focus view')
        await page.keyboard.press('Tab')
        await expect(viewForm.getByRole('button', { name: uiText('Cancel', '取消'), exact: true })).toBeFocused()
        await page.keyboard.press('Tab')
        const create = viewForm.getByRole('button', { name: uiText('Create', '创建'), exact: true })
        await expect(create).toBeFocused()
        const heldView = await snapshot(page, app, testInfo, `${language}-view-create-before-initial-frame`, before.databaseId)
        await releaseInitialFrames(page)
        const completedView = await snapshot(page, app, testInfo, `${language}-view-create-keeps-user-focus`, before.databaseId)
        await expect(create).toBeFocused()
        await expect(viewName).toHaveValue('Unsaved focus view')
        expect(completedView.viewNameWatch?.calls.length).toBe(heldView.viewNameWatch?.calls.length)
        await page.keyboard.press('Escape')
        await expect(viewForm).toHaveCount(0)
        await twoFrames(page)
        const finalState = await snapshot(page, app, testInfo, `${language}-initial-focus-business-data-unchanged`, before.databaseId)
        expect(finalState.columns).toEqual(before.columns)
        expect(finalState.entities).toEqual(before.entities)
        expect(finalState.views).toEqual(before.views)
        expect(errors).toEqual([])
      } finally {
        await releaseInitialFrames(page)
      }
    })
  })
}
