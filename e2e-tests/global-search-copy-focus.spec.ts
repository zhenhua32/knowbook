import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type CopyProbe = { texts: string[]; pending: Array<{ resolve: () => void; reject: (error: Error) => void }> }
type ProbeGlobal = typeof globalThis & { __knowbookPaletteCopyFocusProbe?: CopyProbe }
type TabStep = { phase: string; step: number; activeTag: string | null; activeText: string | null;
  activeLabel: string | null; activeRole: string | null; activeClass: string | null; tabIndex: number | null; reachedTarget: boolean }
type ProbeWindow = Window & { __knowbookPaletteTabRoute?: TabStep[] }

const query = 'PaletteCopyNeedle'
const firstBlock = `${query} First block.`
const secondBlock = `${query} Second block keeps selection through a pending copy.`
const copyError = 'Clipboard is temporarily unavailable.'

async function installCopyProbe(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const probe: CopyProbe = { texts: [], pending: [] }
    ;(globalThis as ProbeGlobal).__knowbookPaletteCopyFocusProbe = probe
    // Completely replace the handler; never retain/delegate it or read/write
    // the system clipboard. Only these isolated document links are recorded.
    ipcMain.removeHandler('knowbook:write-clipboard-text')
    ipcMain.handle('knowbook:write-clipboard-text', (_event, text: string) => {
      probe.texts.push(text)
      return new Promise<void>((resolve, reject) => probe.pending.push({ resolve, reject }))
    })
  })
}

async function copyState(app: ElectronApplication) {
  return app.evaluate(() => {
    const probe = (globalThis as ProbeGlobal).__knowbookPaletteCopyFocusProbe!
    return { calls: probe.texts.length, pending: probe.pending.length, texts: probe.texts }
  })
}

async function finishCopy(app: ElectronApplication, failure: string | null = null) {
  await app.evaluate((_electron, failure) => {
    const pending = (globalThis as ProbeGlobal).__knowbookPaletteCopyFocusProbe!.pending.shift()
    if (!pending) throw new Error('No pending palette clipboard request')
    // Return the Inspector command before delivering the real IPC completion.
    setImmediate(() => failure === null ? pending.resolve() : pending.reject(new Error(failure)))
  }, failure)
}

function controls(page: Page) {
  const palette = page.locator('.global-search-modal')
  const actions = palette.getByRole('group', { name: uiText('Selected result actions', '所选搜索结果操作'), exact: true })
  return { palette, input: palette.getByRole('combobox', { name: uiText('Search documents or commands', '搜索文档或命令'), exact: true }),
    mode: palette.locator('.palette-mode'),
    close: palette.getByRole('button', { name: uiText('Close search', '关闭搜索'), exact: true }),
    results: palette.locator('.global-search-result'), selected: palette.locator('.global-search-result[aria-selected="true"]'),
    go: actions.getByRole('button', { name: uiText('Go to block', '定位内容块'), exact: true }),
    open: actions.getByRole('button', { name: uiText('Open document', '打开文档'), exact: true }),
    copy: actions.getByRole('button', { name: uiText('Copy document link', '复制文档链接'), exact: true }),
    feedback: palette.locator('.palette-action-feedback') }
}

async function tabTo(page: Page, target: Locator, app: ElectronApplication, testInfo: TestInfo, phase: string) {
  let reachedTarget = false
  for (let step = 1; step <= 12; step++) {
    await page.keyboard.press('Tab')
    reachedTarget = await target.evaluate((element, { phase, step }) => {
      const active = document.activeElement as HTMLElement | null
      const reachedTarget = active === element
      const route = (window as ProbeWindow).__knowbookPaletteTabRoute ??= []
      route.push({ phase, step, activeTag: active?.tagName ?? null,
        activeText: active?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 160) ?? null,
        activeLabel: active?.getAttribute('aria-label') ?? null, activeRole: active?.getAttribute('role') ?? null,
        activeClass: active?.className ?? null, tabIndex: active?.tabIndex ?? null, reachedTarget })
      return reachedTarget
    }, { phase, step })
    await expect(controls(page).palette).toBeVisible()
    if (reachedTarget) break
  }
  // Preserve the actual browser route even if the bounded navigation fails.
  // Scroll containers may also be Tab stops; no target.focus() is used.
  await record(page, app, testInfo, phase)
  expect(reachedTarget).toBe(true)
  await expect(target).toBeFocused()
}

async function tabToCopy(page: Page, app: ElectronApplication, testInfo: TestInfo, phase: string) {
  const current = controls(page)
  await expect(current.input).toBeFocused()
  await tabTo(page, current.copy, app, testInfo, phase)
}

async function expectPreserved(page: Page, selectedId: string) {
  const current = controls(page)
  await expect(current.palette).toBeVisible()
  await expect(current.input).toHaveValue(query)
  await expect(current.results).toHaveCount(2)
  await expect(current.selected).toHaveAttribute('id', selectedId)
  await expect(current.input).toHaveAttribute('aria-activedescendant', selectedId)
  await expect(current.selected.locator('.global-search-snippet')).toHaveText(secondBlock)
}

async function expectCopyBusy(page: Page) {
  const copy = controls(page).copy
  await expect(copy).toBeDisabled()
  await expect(copy).toHaveAttribute('aria-disabled', 'true')
  await expect(copy).toHaveAttribute('aria-busy', 'true')
  expect(await copy.evaluate(element => (element as HTMLButtonElement).disabled)).toBe(false)
  await expect(copy).toBeFocused()
  const style = await copy.evaluate(element => {
    const style = getComputedStyle(element)
    return { cursor: style.cursor, focusVisible: element.matches(':focus-visible'),
      outlineStyle: style.outlineStyle, outlineWidth: parseFloat(style.outlineWidth), outlineColor: style.outlineColor }
  })
  expect(['not-allowed', 'wait', 'progress']).toContain(style.cursor)
  expect(style.focusVisible).toBe(true)
  expect(style.outlineStyle).not.toBe('none')
  expect(style.outlineWidth).toBeGreaterThan(0)
  expect(['transparent', 'rgba(0, 0, 0, 0)']).not.toContain(style.outlineColor)
}

async function expectCopySettled(page: Page) {
  const copy = controls(page).copy
  await expect(copy).toBeEnabled()
  await expect(copy).toHaveAttribute('aria-disabled', 'false')
  await expect(copy).toHaveAttribute('aria-busy', 'false')
  expect(await copy.evaluate(element => (element as HTMLButtonElement).disabled)).toBe(false)
}

async function record(page: Page, app: ElectronApplication, testInfo: TestInfo, phase: string) {
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable(), bounds: window.getBounds()
  })))
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  const state = await page.evaluate(() => {
    const palette = document.querySelector<HTMLDialogElement>('.global-search-modal')
    const copy = Array.from(palette?.querySelectorAll<HTMLButtonElement>('.palette-result-actions button') ?? [])
      .find(button => /^(Copy document link|复制文档链接)$/.test(button.textContent?.trim() ?? ''))
    const active = document.activeElement
    const style = copy ? getComputedStyle(copy) : null
    return { viewport: { width: innerWidth, height: innerHeight }, theme: document.documentElement.dataset.theme,
      paletteOpen: palette?.open ?? false, query: palette?.querySelector<HTMLInputElement>('.global-search-input')?.value,
      selectedId: palette?.querySelector('[aria-selected="true"]')?.id,
      selectedText: palette?.querySelector('[aria-selected="true"] .global-search-snippet')?.textContent,
      feedback: palette?.querySelector('.palette-action-feedback')?.textContent,
      feedbackRole: palette?.querySelector('.palette-action-feedback')?.getAttribute('role'),
      active: { tag: active?.tagName, text: active?.tagName === 'BUTTON' ? active.textContent : null, label: active?.getAttribute('aria-label') },
      copy: copy && style ? { focused: copy === active, focusVisible: copy.matches(':focus-visible'),
        disabled: copy.disabled, ariaDisabled: copy.getAttribute('aria-disabled'), ariaBusy: copy.getAttribute('aria-busy'),
        cursor: style.cursor, opacity: style.opacity, color: style.color, backgroundColor: style.backgroundColor,
        borderColor: style.borderColor, boxShadow: style.boxShadow, transform: style.transform,
        outline: { style: style.outlineStyle, width: style.outlineWidth, color: style.outlineColor, offset: style.outlineOffset } } : null,
      tabRoute: (window as ProbeWindow).__knowbookPaletteTabRoute ?? [] }
  })
  const body = JSON.stringify({ windows, state, ipc: await copyState(app) }, null, 2)
  writeFileSync(testInfo.outputPath(`${phase}.json`), body, 'utf8')
  await testInfo.attach(phase, { body, contentType: 'application/json' })
  await page.screenshot({ path: testInfo.outputPath(`${phase}.png`) })
}

for (const language of ['en-US', 'zh-CN'] as const) {
  test(`global search copy retains keyboard focus for failure retry (${language}) @electron`, async ({}, testInfo) => {
    test.skip(!hasBuiltElectronApp(), 'Run npm run build first.')
    await withElectronApp(async ({ page, app }) => {
      const title = language === 'zh-CN' ? '复制键盘焦点样本' : 'Keyboard copy focus target'
      const target = await page.evaluate(async ({ language, title, firstBlock, secondBlock }) => {
        await window.knowbook.saveSetting('ui.language', language)
        await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
        const { id } = await window.knowbook.createDocument(null)
        await window.knowbook.updateDocument(id, { title, summary: '', blocks: [
          { type: 'paragraph', content: firstBlock, checked: false, depth: 0 },
          { type: 'paragraph', content: secondBlock, checked: false, depth: 0 }
        ] })
        return (await window.knowbook.getDocumentDetail(id))!
      }, { language, title, firstBlock, secondBlock })
      await installCopyProbe(app)
      await page.reload()
      await expect(page.getByTestId('shell')).toBeVisible()
      await page.setViewportSize({ width: 760, height: language === 'zh-CN' ? 850 : 640 })
      await page.locator('.tree-button', { hasText: title }).first().focus()
      await page.keyboard.press('Enter')
      await expect(page.locator('.block-editor-row')).toHaveCount(2)
      await page.keyboard.press('Control+k')
      const current = controls(page)
      await expect(current.input).toBeFocused()
      await current.input.fill(query)
      await expect(current.results).toHaveCount(2)
      await expect(current.selected.locator('.global-search-snippet')).toHaveText(firstBlock)
      await page.keyboard.press('ArrowDown')
      await expect(current.selected.locator('.global-search-snippet')).toHaveText(secondBlock)
      const selectedId = (await current.selected.getAttribute('id'))!
      await tabToCopy(page, app, testInfo, 'native-tab-route-to-copy')
      await page.keyboard.press('Enter')
      await expect.poll(async () => (await copyState(app)).calls).toBe(1)
      await expectCopyBusy(page)
      await expect(current.feedback).toHaveAttribute('role', 'status')
      await expect(current.feedback).toHaveText(uiText('Copying…', '正在复制…'))
      await expectPreserved(page, selectedId)
      // The native button remains focusable; ARIA and the synchronous action
      // lock reject real keyboard and pointer activation during the request.
      await page.keyboard.press('Enter')
      await page.keyboard.press('Space')
      await expectCopyBusy(page)
      expect((await copyState(app)).calls).toBe(1)
      expect((await copyState(app)).pending).toBe(1)
      await record(page, app, testInfo, 'copy-pending-keyboard-focus-ring')
      await expect(current.copy).toBeInViewport({ ratio: 1 })
      const box = await current.copy.boundingBox()
      expect(box).not.toBeNull()
      const reachable = await current.copy.evaluate(element => {
        const rect = element.getBoundingClientRect()
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
        return hit === element || Boolean(hit && element.contains(hit))
      })
      expect(reachable).toBe(true)
      // locator.click() waits for aria-disabled to clear; use the real native
      // pointer at the measured center while this request remains pending.
      await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2)
      expect((await copyState(app)).calls).toBe(1)
      expect((await copyState(app)).pending).toBe(1)
      await expect(current.copy).toBeFocused()
      await record(page, app, testInfo, 'copy-pending-repeated-activation-ignored')
      await finishCopy(app, copyError)
      await expect(current.feedback).toHaveAttribute('role', 'alert')
      await expect(current.feedback).toHaveText(copyError)
      await expectCopySettled(page)
      // The old-build evidence is captured before the missing focus is asserted.
      await record(page, app, testInfo, 'copy-failed-before-keyboard-retry-focus')
      await expect(current.copy).toBeFocused()
      await expectPreserved(page, selectedId)
      await page.keyboard.press('Enter')
      await expect.poll(async () => (await copyState(app)).calls).toBe(2)
      await expectCopyBusy(page)
      await expect(current.feedback).toHaveText(uiText('Copying…', '正在复制…'))
      await finishCopy(app)
      await expect(current.feedback).toHaveAttribute('role', 'status')
      await expect(current.feedback).toHaveText(uiText('Document link copied. Paste it into another document.', '文档链接已复制，可粘贴到其他文档。'))
      await expectCopySettled(page)
      await expect(current.copy).toBeFocused()
      await expectPreserved(page, selectedId)
      const expectedLink = `[${target.title}](/${target.path.split('/').map(encodeURIComponent).join('/')}.md)`
      expect((await copyState(app)).texts).toEqual([expectedLink, expectedLink])
      await record(page, app, testInfo, 'copy-retry-success-preserves-query-selection-and-focus')

      // An intentional native Tab move to the combobox, followed by selection
      // and query changes, must retain the user's new focus after a late error.
      await page.keyboard.press('Enter')
      await expect.poll(async () => (await copyState(app)).calls).toBe(3)
      await expectCopyBusy(page)
      await expect(current.feedback).toHaveText(uiText('Copying…', '正在复制…'))
      await tabTo(page, current.input, app, testInfo, 'pending-copy-tab-route-back-to-input')
      await page.keyboard.press('ArrowUp')
      await expect(current.selected.locator('.global-search-snippet')).toHaveText(firstBlock)
      await page.keyboard.press('End')
      await page.keyboard.type(' First')
      const changedQuery = `${query} First`
      await expect(current.input).toHaveValue(changedQuery)
      await expect(current.results).toHaveCount(1)
      await expect(current.selected.locator('.global-search-snippet')).toHaveText(firstBlock)
      const changedSelection = (await current.selected.getAttribute('id'))!
      await finishCopy(app, 'Obsolete clipboard failure')
      await expectCopySettled(page)
      await expect(current.feedback).toHaveCount(0)
      await expect(current.input).toBeFocused()
      await expect(current.copy).not.toBeFocused()
      await expect(current.input).toHaveValue(changedQuery)
      await expect(current.selected).toHaveAttribute('id', changedSelection)
      expect((await copyState(app)).calls).toBe(3)
      await record(page, app, testInfo, 'late-copy-error-preserves-new-query-selection-and-input-focus')

      // A real Escape closes the native dialog before this clipboard request
      // completes. Its late error must not reopen the palette or steal focus.
      await current.input.fill(query)
      await expect(current.results).toHaveCount(2)
      await page.keyboard.press('ArrowDown')
      await expect(current.selected.locator('.global-search-snippet')).toHaveText(secondBlock)
      await tabToCopy(page, app, testInfo, 'native-tab-route-to-copy-before-close')
      await page.keyboard.press('Enter')
      await expect.poll(async () => (await copyState(app)).calls).toBe(4)
      await expectCopyBusy(page)
      await page.keyboard.press('Escape')
      await expect(current.palette).toHaveCount(0)
      const closeFocus = await page.evaluateHandle(() => document.activeElement)
      await record(page, app, testInfo, 'palette-closed-before-late-copy-error')
      await finishCopy(app, 'Closed palette clipboard failure')
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      await expect(current.palette).toHaveCount(0)
      await expect(page.locator('.palette-action-feedback')).toHaveCount(0)
      expect(await closeFocus.evaluate(element => document.activeElement === element)).toBe(true)
      await closeFocus.dispose()
      expect((await copyState(app)).calls).toBe(4)
      expect((await copyState(app)).texts).toEqual([expectedLink, expectedLink, expectedLink, expectedLink])

      // Command results are selected by the combobox's arrow keys; their
      // negative-tabindex options and wrapper add no unrelated Tab stop.
      const focusBeforeCommand = await page.evaluateHandle(() => document.activeElement)
      await page.keyboard.press('Control+Shift+p')
      await expect(current.input).toBeFocused()
      await current.input.fill('> sidebar')
      await expect(current.palette.getByRole('option')).toHaveCount(1)
      await expect(current.input).toBeFocused()
      await page.keyboard.press('Tab'); await expect(current.close).toBeFocused()
      await page.keyboard.press('Tab'); await expect(current.mode).toBeFocused()
      await expect(current.palette).toBeVisible()
      await page.keyboard.press('Shift+Tab'); await expect(current.close).toBeFocused()
      await page.keyboard.press('Shift+Tab'); await expect(current.input).toBeFocused()
      await expect(current.input).toHaveValue('> sidebar')
      await record(page, app, testInfo, 'command-single-result-forward-and-backward-tab-cycle')

      await current.input.fill('> NoCommandCanMatchThis')
      await expect(current.palette.getByRole('option')).toHaveCount(0)
      await expect(current.input).toBeFocused()
      await page.keyboard.press('Tab'); await expect(current.close).toBeFocused()
      await page.keyboard.press('Tab'); await expect(current.mode).toBeFocused()
      await expect(current.palette).toBeVisible()
      await page.keyboard.press('Shift+Tab'); await expect(current.close).toBeFocused()
      await page.keyboard.press('Shift+Tab'); await expect(current.input).toBeFocused()
      await expect(current.input).toHaveValue('> NoCommandCanMatchThis')
      await record(page, app, testInfo, 'command-no-results-forward-and-backward-tab-cycle')
      await page.keyboard.press('Escape')
      await expect(current.palette).toHaveCount(0)
      expect(await focusBeforeCommand.evaluate(element => document.activeElement === element)).toBe(true)
      await focusBeforeCommand.dispose()
      expect((await copyState(app)).calls).toBe(4)
      expect(await page.evaluate(id => window.knowbook.getDocumentDetail(id), target.id)).toEqual(target)
      await record(page, app, testInfo, 'copy-flow-complete-document-unchanged')
    })
  })
}
