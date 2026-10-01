import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type CopyProbe = { texts: string[]; pending: Array<{ resolve: () => void; reject: (error: Error) => void }> }
type ProbeGlobal = typeof globalThis & { __knowbookWorkspaceCopyProbe?: CopyProbe }
type TabStep = { step: number; tag: string | null; text: string | null; label: string | null;
  role: string | null; tabIndex: number | null; rowKey: string | null; reachedTarget: boolean }
type ProbeWindow = Window & { __knowbookWorkspaceTabRoute?: TabStep[]; __knowbookWorkspaceNewFocus?: Element | null }

const needle = 'WorkspaceOwnerNeedle'
const copyError = 'Workspace clipboard is temporarily unavailable.'
const rows = (page: Page) => page.getByTestId('workspace-search-result')
const keywords = (page: Page) => page.getByLabel(uiText('Keywords', '关键词'), { exact: true })
const feedback = (page: Page) => page.locator('.workspace-search-action-feedback')

async function installCopyProbe(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const probe: CopyProbe = { texts: [], pending: [] }
    ;(globalThis as ProbeGlobal).__knowbookWorkspaceCopyProbe = probe
    // Replace, rather than delegate, the clipboard handler. No system
    // clipboard read/write occurs; only this isolated document link is kept.
    ipcMain.removeHandler('knowbook:write-clipboard-text')
    ipcMain.handle('knowbook:write-clipboard-text', (_event, text: string) => {
      probe.texts.push(text)
      return new Promise<void>((resolve, reject) => probe.pending.push({ resolve, reject }))
    })
  })
}

async function copyState(app: ElectronApplication) {
  return app.evaluate(() => {
    const probe = (globalThis as ProbeGlobal).__knowbookWorkspaceCopyProbe!
    return { calls: probe.texts.length, pending: probe.pending.length, texts: probe.texts }
  })
}

async function finishCopy(app: ElectronApplication, failure: string | null = null) {
  await app.evaluate((_electron, failure) => {
    const pending = (globalThis as ProbeGlobal).__knowbookWorkspaceCopyProbe!.pending.shift()
    if (!pending) throw new Error('No pending workspace clipboard request')
    // Acknowledge Inspector before settling the actual renderer IPC promise.
    setImmediate(() => failure === null ? pending.resolve() : pending.reject(new Error(failure)))
  }, failure)
}

async function rowState(page: Page) {
  return rows(page).evaluateAll(elements => elements.map(element => {
    const row = element as HTMLElement
    return { key: `${row.dataset.documentId}:${row.dataset.blockId ?? ''}`, height: row.getBoundingClientRect().height }
  }))
}

async function tabToFirstCopy(page: Page, copy: Locator, app: ElectronApplication, testInfo: TestInfo, phase = 'native-tab-route-to-first-copy') {
  await expect(keywords(page)).toBeFocused()
  let reached = false
  for (let step = 1; step <= 24; step++) {
    await page.keyboard.press('Tab')
    reached = await copy.evaluate((element, step) => {
      const active = document.activeElement as HTMLElement | null
      const row = active?.closest<HTMLElement>('[data-testid="workspace-search-result"]')
      const reachedTarget = active === element
      const route = (window as ProbeWindow).__knowbookWorkspaceTabRoute ??= []
      route.push({ step, tag: active?.tagName ?? null,
        text: active?.tagName === 'BUTTON' ? active.textContent?.trim() ?? null : null,
        label: active?.getAttribute('aria-label') ?? null, role: active?.getAttribute('role') ?? null,
        tabIndex: active?.tabIndex ?? null,
        rowKey: row ? `${row.dataset.documentId}:${row.dataset.blockId ?? ''}` : null, reachedTarget })
      return reachedTarget
    }, step)
    if (reached) break
  }
  // Native Tab can also land on a scroll container. Keep every actual stop;
  // never focus Copy programmatically or scroll the feedback into view.
  await record(page, app, testInfo, phase)
  expect(reached).toBe(true)
  await expect(copy).toBeFocused()
}

async function geometry(page: Page) {
  return page.evaluate(() => {
    const rect = (value: DOMRect) => ({ left: value.left, top: value.top, right: value.right,
      bottom: value.bottom, width: value.width, height: value.height })
    const clipped = (element: Element | null) => {
      if (!element) return null
      const box = element.getBoundingClientRect()
      const clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight }
      const ancestors: Array<{ tag: string; className: string; overflowX: string; overflowY: string;
        rect: ReturnType<typeof rect>; client: { left: number; top: number; right: number; bottom: number } }> = []
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent)
        const clipsX = /^(auto|scroll|hidden|clip)$/.test(style.overflowX)
        const clipsY = /^(auto|scroll|hidden|clip)$/.test(style.overflowY)
        if (!clipsX && !clipsY) continue
        const bounds = parent.getBoundingClientRect()
        const client = { left: bounds.left + parent.clientLeft, top: bounds.top + parent.clientTop,
          right: bounds.left + parent.clientLeft + parent.clientWidth,
          bottom: bounds.top + parent.clientTop + parent.clientHeight }
        if (clipsX) { clip.left = Math.max(clip.left, client.left); clip.right = Math.min(clip.right, client.right) }
        if (clipsY) { clip.top = Math.max(clip.top, client.top); clip.bottom = Math.min(clip.bottom, client.bottom) }
        ancestors.push({ tag: parent.tagName, className: parent.className,
          overflowX: style.overflowX, overflowY: style.overflowY, rect: rect(bounds), client })
      }
      const visibleWidth = Math.max(0, Math.min(box.right, clip.right) - Math.max(box.left, clip.left))
      const visibleHeight = Math.max(0, Math.min(box.bottom, clip.bottom) - Math.max(box.top, clip.top))
      return { rect: rect(box), clip, ancestors,
        visibleRatio: box.width && box.height ? visibleWidth * visibleHeight / (box.width * box.height) : 0,
        fullyVisible: box.width > 0 && box.height > 0 && box.left >= clip.left - 0.5 && box.top >= clip.top - 0.5
          && box.right <= clip.right + 0.5 && box.bottom <= clip.bottom + 0.5 }
    }
    const owner = document.querySelector<HTMLElement>('[data-testid="workspace-search-result"]')
    const actionFeedback = document.querySelector('.workspace-search-action-feedback')
    const actions = owner?.querySelector('.workspace-search-result-actions') ?? null
    const copy = Array.from(actions?.querySelectorAll<HTMLButtonElement>('button') ?? [])
      .find(button => /^(Copy document link|复制文档链接)$/.test(button.textContent?.trim() ?? '')) ?? null
    const feedbackOwner = actionFeedback?.closest<HTMLElement>('[data-testid="workspace-search-result"]')
    const active = document.activeElement as HTMLElement | null
    const style = copy ? getComputedStyle(copy) : null
    return { viewport: { width: innerWidth, height: innerHeight }, theme: document.documentElement.dataset.theme,
      query: document.querySelector<HTMLInputElement>('.workspace-search-query input')?.value,
      total: document.querySelector('[data-testid="workspace-search-total"]')?.getAttribute('data-total-number'),
      ownerKey: owner ? `${owner.dataset.documentId}:${owner.dataset.blockId ?? ''}` : null,
      feedbackOwnerKey: feedbackOwner ? `${feedbackOwner.dataset.documentId}:${feedbackOwner.dataset.blockId ?? ''}` : null,
      ownerContainsFeedback: Boolean(owner && actionFeedback && owner.contains(actionFeedback)),
      feedback: { text: actionFeedback?.textContent, role: actionFeedback?.getAttribute('role'), ...clipped(actionFeedback) },
      actions: clipped(actions), button: clipped(copy), row: clipped(owner),
      copy: copy && style ? { focused: copy === active, disabled: copy.disabled,
        ariaDisabled: copy.getAttribute('aria-disabled'), ariaBusy: copy.getAttribute('aria-busy'), cursor: style.cursor,
        focusVisible: copy.matches(':focus-visible'), outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth } : null,
      active: { tag: active?.tagName, text: active?.tagName === 'BUTTON' ? active.textContent : null,
        label: active?.getAttribute('aria-label') }, tabRoute: (window as ProbeWindow).__knowbookWorkspaceTabRoute ?? [] }
  })
}

async function record(page: Page, app: ElectronApplication, testInfo: TestInfo, phase: string) {
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable(), bounds: window.getBounds()
  })))
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  const state = await geometry(page)
  const body = JSON.stringify({ windows, state, rows: await rowState(page), ipc: await copyState(app) }, null, 2)
  writeFileSync(testInfo.outputPath(`${phase}.json`), body, 'utf8')
  await testInfo.attach(phase, { body, contentType: 'application/json' })
  await page.screenshot({ path: testInfo.outputPath(`${phase}.png`) })
  return state
}

async function expectLocalFeedback(page: Page, owner: Locator, ownerKey: string, state: Awaited<ReturnType<typeof geometry>>) {
  expect(state.ownerContainsFeedback).toBe(true)
  expect(state.feedbackOwnerKey).toBe(ownerKey)
  expect(state.feedback.fullyVisible).toBe(true)
  expect(state.actions?.fullyVisible).toBe(true)
  await expect(owner.locator('.workspace-search-action-feedback')).toHaveCount(1)
  await expect(feedback(page)).toHaveCount(1)
  await expect(feedback(page)).toBeInViewport({ ratio: 1 })
  await expect(owner.locator('.workspace-search-result-actions')).toBeInViewport({ ratio: 1 })
  const id = await owner.locator('.workspace-search-action-feedback').getAttribute('id')
  expect(id).toBeTruthy()
  const copy = owner.getByRole('button', { name: uiText('Copy document link', '复制文档链接'), exact: true })
  expect((await copy.getAttribute('aria-describedby'))?.split(/\s+/)).toContain(id)
}

async function expectCopyState(copy: Locator, busy: boolean) {
  // aria-disabled guards activation without removing the keyboard's native
  // focus owner. The IPC lock also guards native pointer/keyboard duplicates.
  expect(await copy.evaluate(element => (element as HTMLButtonElement).disabled)).toBe(false)
  await expect(copy).toHaveAttribute('aria-disabled', String(busy))
  await expect(copy).toHaveAttribute('aria-busy', String(busy))
  await expect(copy).toBeFocused()
  if (busy) await expect(copy).toBeDisabled()
  else await expect(copy).toBeEnabled()
}

async function seedSearch(page: Page, app: ElectronApplication, language: 'en-US' | 'zh-CN') {
  const target = await page.evaluate(async ({ language, needle }) => {
    await window.knowbook.saveSetting('ui.language', language)
    await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
    const { id } = await window.knowbook.createDocument(null)
    await window.knowbook.updateDocument(id, {
      title: language === 'zh-CN' ? '完整搜索操作样本' : 'Workspace search action sample', summary: '',
      blocks: Array.from({ length: 30 }, (_, index) => ({ id: `${id}-match-${index}`, type: 'paragraph' as const,
        content: `${needle} row ${String(index).padStart(2, '0')} stays unchanged.`, checked: false, depth: 0 }))
    })
    const detail = await window.knowbook.getDocumentDetail(id)
    if (!detail) throw new Error('Workspace search fixture was not saved')
    return detail
  }, { language, needle })
  await installCopyProbe(app)
  await page.reload()
  await expect(page.getByTestId('shell')).toBeVisible()
  await page.setViewportSize({ width: 760, height: language === 'zh-CN' ? 850 : 640 })
  return target
}

async function expectPreserved(page: Page, before: Awaited<ReturnType<typeof rowState>>) {
  await expect(keywords(page)).toHaveValue(needle)
  await expect(page.getByLabel(uiText('Results per page', '每页结果'), { exact: true })).toHaveValue('25')
  await expect(page.getByTestId('workspace-search-total')).toHaveAttribute('data-total-number', '30')
  await expect(rows(page)).toHaveCount(25)
  const current = await rowState(page)
  expect(current.map(row => row.key)).toEqual(before.map(row => row.key))
  // A local operation must not add status padding to the other 24 results.
  for (let index = 1; index < before.length; index++) {
    expect(Math.abs(current[index]!.height - before[index]!.height)).toBeLessThanOrEqual(0.5)
  }
}

for (const language of ['en-US', 'zh-CN'] as const) {
  test(`workspace search keeps first-row copy feedback and keyboard retry local (${language}) @electron`, async ({}, testInfo) => {
    test.skip(!hasBuiltElectronApp(), 'Run npm run build first.')
    await withElectronApp(async ({ page, app }) => {
      // Renderer responsiveness is tested separately from the unchanged native
      // minimum window bounds, which are included in every geometry record.
      const target = await seedSearch(page, app, language)
      await page.getByTitle(uiText('Search', '搜索'), { exact: true }).click()
      await expect(keywords(page)).toBeVisible()
      await keywords(page).fill(needle)
      await expect(page.getByTestId('workspace-search-total')).toHaveAttribute('data-total-number', '30')
      await expect(rows(page)).toHaveCount(25)
      await expect(page.locator('.workspace-search-results-panel')).toHaveAttribute('aria-busy', 'false')
      await expect(page.getByLabel(uiText('Results per page', '每页结果'), { exact: true })).toHaveValue('25')
      const before = await rowState(page)
      expect(new Set(before.map(row => row.key)).size).toBe(25)
      const owner = rows(page).first()
      const ownerKey = before[0]!.key
      const copy = owner.getByRole('button', { name: uiText('Copy document link', '复制文档链接'), exact: true })
      await tabToFirstCopy(page, copy, app, testInfo)
      await page.keyboard.press('Enter')
      await expect.poll(async () => (await copyState(app)).calls).toBe(1)
      await expect(feedback(page)).toHaveCount(1)
      await expect(feedback(page)).toHaveAttribute('role', 'status')
      // Evidence precedes the new owner/viewport assertions. In the old build
      // this is a real status paragraph after all 25 rows, outside this view.
      const pending = await record(page, app, testInfo, 'copy-pending-before-local-owner-and-clip-assertions')
      await expectLocalFeedback(page, owner, ownerKey, pending)
      await expectCopyState(copy, true)
      await page.keyboard.press('Enter')
      await page.keyboard.press('Space')
      await expect(copy).toBeInViewport({ ratio: 1 })
      expect(await copy.evaluate(element => {
        const rect = element.getBoundingClientRect()
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
        return hit === element || Boolean(hit && element.contains(hit))
      })).toBe(true)
      const box = (await copy.boundingBox())!
      // locator.click() waits for aria-disabled to clear; a native mouse event
      // at the measured, reachable center exercises the actual busy lock.
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      expect((await copyState(app)).calls).toBe(1)
      expect((await copyState(app)).pending).toBe(1)
      await expectCopyState(copy, true)
      await expectPreserved(page, before)

      await finishCopy(app, copyError)
      await expect(feedback(page)).toHaveAttribute('role', 'alert')
      await expect(feedback(page)).toHaveText(copyError)
      const failed = await record(page, app, testInfo, 'copy-failed-before-immediate-keyboard-retry')
      await expectLocalFeedback(page, owner, ownerKey, failed)
      await expectCopyState(copy, false)
      await expectPreserved(page, before)
      await page.keyboard.press('Enter')
      await expect.poll(async () => (await copyState(app)).calls).toBe(2)
      await expect(feedback(page)).toHaveAttribute('role', 'status')
      const retry = await record(page, app, testInfo, 'copy-retry-pending-preserves-owner')
      await expectLocalFeedback(page, owner, ownerKey, retry)
      await expectCopyState(copy, true)
      await finishCopy(app)
      await expect(feedback(page)).toHaveAttribute('role', 'status')
      await expect(feedback(page)).toHaveText(uiText('Document link copied. Paste it into another document.', '文档链接已复制，可粘贴到其他文档。'))
      await expectCopyState(copy, false)
      await expectPreserved(page, before)
      const expectedLink = `[${target.title}](/${target.path.split('/').map(encodeURIComponent).join('/')}.md)`
      expect((await copyState(app)).texts).toEqual([expectedLink, expectedLink])
      expect(await page.evaluate(id => window.knowbook.getDocumentDetail(id), target.id)).toEqual(target)
      const success = await record(page, app, testInfo, 'copy-retry-success-query-page-rows-and-document-preserved')
      await expectLocalFeedback(page, owner, ownerKey, success)
    }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
  })
}

test('workspace search ignores late copy errors after query, page and page navigation @electron', async ({}, testInfo) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build first.')
  await withElectronApp(async ({ page, app }) => {
    const target = await seedSearch(page, app, 'en-US')
    for (const [index, transition] of ['query', 'page', 'leave'].entries()) {
      await page.getByTitle(uiText('Search', '搜索'), { exact: true }).click()
      await expect(keywords(page)).toBeVisible()
      await keywords(page).fill('')
      await keywords(page).fill(needle)
      await expect(page.getByTestId('workspace-search-total')).toHaveAttribute('data-total-number', '30')
      await expect(rows(page)).toHaveCount(25)
      await expect(page.locator('.workspace-search-results-panel')).toHaveAttribute('aria-busy', 'false')
      const original = await rowState(page)
      const copy = rows(page).first().getByRole('button', { name: 'Copy document link', exact: true })
      await tabToFirstCopy(page, copy, app, testInfo, `${transition}-native-tab-route-to-copy`)
      await page.keyboard.press('Enter')
      await expect.poll(async () => (await copyState(app)).calls).toBe(index + 1)
      await expectCopyState(copy, true)
      if (transition === 'query') {
        await keywords(page).fill(`${needle} row 29`)
        await expect(rows(page)).toHaveCount(1)
        await expect(rows(page).first()).toHaveAttribute('data-block-id', `${target.id}-match-29`)
      } else if (transition === 'page') {
        await page.getByRole('button', { name: 'Next page', exact: true }).click()
        await expect(rows(page)).toHaveCount(5)
        const next = await rowState(page)
        expect(next.every(row => !original.some(before => before.key === row.key))).toBe(true)
      } else {
        await page.getByTitle(uiText('Settings', '配置中心'), { exact: true }).click()
        const general = page.getByRole('tab', { name: 'General', exact: true })
        await expect(general).toBeVisible()
        await expect(page.getByRole('heading', { name: 'General preferences', exact: true })).toBeVisible()
        await general.click()
        // The complete search page remains mounted under its hidden host so
        // query/pagination survive navigation; hidden owners cannot reclaim focus.
        await expect(page.locator('.workspace-search-page')).toBeHidden()
      }
      if (transition !== 'leave') await expect(page.locator('.workspace-search-results-panel')).toHaveAttribute('aria-busy', 'false')
      await expect(feedback(page)).toHaveCount(0)
      const newRows = await rowState(page)
      await page.evaluate(() => { (window as ProbeWindow).__knowbookWorkspaceNewFocus = document.activeElement })
      const obsoleteError = `Obsolete ${transition} clipboard failure`
      await finishCopy(app, obsoleteError)
      // Wait for real renderer commits after the IPC rejection; this does not
      // modify app timers, focus, the native window, or the clipboard API.
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      await record(page, app, testInfo, `${transition}-late-error-retains-new-owner-and-focus`)
      await expect(feedback(page)).toHaveCount(0)
      await expect(page.getByText(obsoleteError, { exact: true })).toHaveCount(0)
      expect(await page.evaluate(() => document.activeElement === (window as ProbeWindow).__knowbookWorkspaceNewFocus)).toBe(true)
      expect((await copyState(app)).pending).toBe(0)
      expect((await rowState(page)).map(row => row.key)).toEqual(newRows.map(row => row.key))
      if (transition === 'query') await expect(keywords(page)).toHaveValue(`${needle} row 29`)
      else if (transition === 'page') await expect(keywords(page)).toHaveValue(needle)
    }
    await page.getByTitle(uiText('Search', '搜索'), { exact: true }).click()
    await expect(keywords(page)).toHaveValue(needle)
    await expect(rows(page)).toHaveCount(25)
    await expect(feedback(page)).toHaveCount(0)
    expect((await copyState(app)).calls).toBe(3)
    expect(await page.evaluate(id => window.knowbook.getDocumentDetail(id), target.id)).toEqual(target)
    await record(page, app, testInfo, 'returned-search-has-no-obsolete-copy-feedback')
  })
})
