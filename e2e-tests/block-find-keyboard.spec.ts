import { expect, test, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type FindFocusCall = { preventScroll: boolean; beforeScroll: number | null; afterScroll: number | null }
type FindFocusProbe = { element: HTMLButtonElement; panelId: string | null; calls: FindFocusCall[] }
type ProbeWindow = Window & { __knowbookFindFocusProbes?: FindFocusProbe[] }

const needle = 'KeyboardNeedle'
const contents = [
  `${needle} — first matching paragraph / 第一处匹配`,
  Array.from({ length: 24 }, (_, index) => `First intervening paragraph, line ${index + 1}.`).join('\n'),
  `${needle} — second matching paragraph / 第二处匹配`,
  Array.from({ length: 24 }, (_, index) => `Second intervening paragraph, line ${index + 1}.`).join('\n'),
  `${needle} — third matching paragraph / 第三处匹配`,
  Array.from({ length: 32 }, (_, index) => `Trailing paragraph, line ${index + 1}.`).join('\n')
]

function controls(page: Page) {
  const panel = page.locator('.block-find-panel')
  return { panel, input: panel.locator('.block-find-input'), count: panel.locator('.block-find-count'),
    previous: panel.getByRole('button', { name: uiText('Previous match', '上一个匹配'), exact: true }),
    next: panel.getByRole('button', { name: uiText('Next match', '下一个匹配'), exact: true }),
    close: panel.getByRole('button', { name: uiText('Close find', '关闭查找'), exact: true }),
    result: (index: number) => panel.locator(`.block-find-result[data-result-index="${index}"]`) }
}

function findEntry(page: Page) {
  return page.locator('.document-navigation-bar').getByRole('button', { name: uiText('Find', '查找'), exact: true })
}

async function watchFindFocus(page: Page) {
  return findEntry(page).evaluate(element => {
    const entry = element as HTMLButtonElement
    const probes = (window as ProbeWindow).__knowbookFindFocusProbes ??= []
    const probe: FindFocusProbe = { element: entry, panelId: entry.getAttribute('aria-controls'), calls: [] }
    const nativeFocus = entry.focus
    // Observe this real DOM object's focus calls and delegate to its native
    // implementation. No keyboard, navigation or focus behavior is replaced.
    entry.focus = options => {
      const canvas = entry.closest<HTMLElement>('.preview-panel')
      const beforeScroll = canvas?.scrollTop ?? null
      nativeFocus.call(entry, options)
      probe.calls.push({ preventScroll: options?.preventScroll === true, beforeScroll, afterScroll: canvas?.scrollTop ?? null })
    }
    return probes.push(probe) - 1
  })
}

async function focusProbe(page: Page, index: number) {
  return page.evaluate(index => {
    const probe = (window as ProbeWindow).__knowbookFindFocusProbes![index]
    return { connected: probe.element.isConnected, calls: probe.calls }
  }, index)
}

async function expectFindState(page: Page, opened: boolean) {
  const entry = findEntry(page)
  await expect(page.locator('.document-navigation-bar').getByRole('button', {
    name: uiText('Find', '查找'), exact: true, expanded: opened
  })).toHaveCount(1)
  await expect(entry).toHaveAttribute('aria-expanded', String(opened))
  const state = await entry.evaluate(element => {
    const button = element as HTMLButtonElement
    const panel = document.querySelector<HTMLElement>('.block-find-panel')
    const panelId = button.getAttribute('aria-controls')
    const probe = (window as ProbeWindow).__knowbookFindFocusProbes?.find(probe => probe.element === button)
    // Resolve the existing theme token through the browser, rather than
    // comparing source declarations or assuming a particular color syntax.
    const colorProbe = document.createElement('span')
    colorProbe.hidden = true
    colorProbe.style.backgroundColor = 'var(--kb-accent-soft)'
    button.append(colorProbe)
    const accentSoft = getComputedStyle(colorProbe).backgroundColor
    colorProbe.remove()
    return { panelId, originalPanelId: probe?.panelId, actualPanelId: panel?.id ?? null,
      matchingIds: panelId ? Array.from(document.querySelectorAll('[id]')).filter(node => node.id === panelId).length : 0,
      controlsActualPanel: Boolean(panelId && panel && document.getElementById(panelId) === panel),
      background: getComputedStyle(button).backgroundColor, accentSoft }
  })
  expect(state.panelId).toBeTruthy()
  expect(state.panelId).toBe(state.originalPanelId)
  if (opened) {
    await expect(controls(page).panel).toHaveCount(1)
    expect(state.actualPanelId).toBe(state.panelId)
    expect(state.matchingIds).toBe(1)
    expect(state.controlsActualPanel).toBe(true)
    expect(state.background).toBe(state.accentSoft)
    expect(state.accentSoft).not.toBe('rgba(0, 0, 0, 0)')
  } else {
    await expect(controls(page).panel).toHaveCount(0)
    expect(state.matchingIds).toBe(0)
  }
}

async function closeInside(page: Page, probeIndex: number, key: string,
  snapshot?: { app: ElectronApplication; testInfo: TestInfo; phase: string }) {
  const beforeCalls = (await focusProbe(page, probeIndex)).calls.length
  await page.keyboard.press(key)
  if (snapshot) await record(page, snapshot.app, snapshot.testInfo, snapshot.phase)
  await expect(controls(page).panel).toHaveCount(0)
  await expectFindState(page, false)
  await expect(findEntry(page)).toBeFocused()
  await expect.poll(async () => (await focusProbe(page, probeIndex)).calls.length).toBe(beforeCalls + 1)
  const call = (await focusProbe(page, probeIndex)).calls.at(-1)!
  expect(call.preventScroll).toBe(true)
  expect(call.beforeScroll).not.toBeNull()
  expect(call.afterScroll).toBe(call.beforeScroll)
}

async function settleFrames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function openFind(page: Page, query = needle,
  snapshot?: { app: ElectronApplication; testInfo: TestInfo; phase: string }) {
  const current = controls(page)
  await expect(current.panel).toHaveCount(0)
  await page.keyboard.press('Control+f')
  await expect(current.input).toBeFocused()
  await expect(current.input).toHaveAccessibleName(uiText('Search blocks (Cmd+F to close)...', '搜索块内容（按 Cmd/Ctrl+F 关闭）...'))
  if (snapshot) await record(page, snapshot.app, snapshot.testInfo, snapshot.phase)
  await expectFindState(page, true)
  await current.input.fill(query)
  return current
}

async function expectMatch(page: Page, resultIndex: number) {
  const current = controls(page)
  await expect(current.count).toHaveText(`${resultIndex + 1} / 3`)
  await expect(current.result(resultIndex)).toHaveClass(/block-find-result-active/)
  const blockIndex = resultIndex * 2
  await expect(current.result(resultIndex).locator('.block-find-result-preview')).toHaveText(contents[blockIndex])
  await expect(current.input).toBeFocused()
  const row = page.locator(`.block-editor-row[data-block-index="${blockIndex}"]`)
  await expect(row.locator('textarea')).toHaveValue(contents[blockIndex])
  // Verify actual document navigation, not just the count/list highlight.
  await expect.poll(() => row.evaluate(element => {
    const canvas = element.closest('.preview-panel')!
    return element.getBoundingClientRect().top - canvas.querySelector('.document-sticky-header')!.getBoundingClientRect().bottom
  })).toBeGreaterThanOrEqual(10)
  await expect.poll(() => row.evaluate(element => {
    const canvas = element.closest('.preview-panel')!
    return element.getBoundingClientRect().top - canvas.querySelector('.document-sticky-header')!.getBoundingClientRect().bottom
  })).toBeLessThan(20)
}

async function record(page: Page, app: ElectronApplication, testInfo: TestInfo, phase: string) {
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable()
  })))
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  const state = await page.evaluate(() => {
    const entry = Array.from(document.querySelectorAll<HTMLButtonElement>('.document-navigation-bar button'))
      .find(button => ['Find', '查找'].includes(button.textContent?.trim() ?? ''))
    return { count: document.querySelector('.block-find-count')?.textContent ?? null,
    activeTag: document.activeElement?.tagName, activeLabel: document.activeElement?.getAttribute('aria-label'),
    activeResult: document.querySelector('.block-find-result-active')?.getAttribute('data-result-index') ?? null,
    findOpen: Boolean(document.querySelector('.block-find-panel')),
    findState: { expanded: entry?.getAttribute('aria-expanded') ?? null,
      controls: entry?.getAttribute('aria-controls') ?? null,
      panelId: document.querySelector('.block-find-panel')?.id ?? null,
      background: entry ? getComputedStyle(entry).backgroundColor : null },
    scrollTop: document.querySelector<HTMLElement>('[data-testid="document-scroll-region"]')?.scrollTop ?? null,
    focusProbes: (window as ProbeWindow).__knowbookFindFocusProbes?.map(probe => ({ connected: probe.element.isConnected, panelId: probe.panelId, calls: probe.calls })) ?? [] }
  })
  await testInfo.attach(phase, { body: JSON.stringify({ windows, state }, null, 2), contentType: 'application/json' })
  await page.screenshot({ path: testInfo.outputPath(`${phase}.png`) })
}

for (const language of ['en-US', 'zh-CN'] as const) {
  test(`document find buttons retain native keyboard activation and do not change content (${language}) @electron`, async ({}, testInfo) => {
    test.skip(!hasBuiltElectronApp(), 'Run npm run build first.')
    await withElectronApp(async ({ page, app }) => {
      const title = language === 'zh-CN' ? '文内查找键盘样本' : 'Document find keyboard sample'
      const otherTitle = language === 'zh-CN' ? '另一个焦点样本' : 'Another focus sample'
      const blocks: DocumentBlockDraft[] = contents.map(content => ({ type: 'paragraph', content, checked: false, depth: 0 }))
      const id = await page.evaluate(async ({ title, otherTitle, blocks, language }) => {
        await window.knowbook.saveSetting('ui.language', language)
        await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
        const { id } = await window.knowbook.createDocument(null)
        await window.knowbook.updateDocument(id, { title, summary: 'Three separated matches / 三个分散匹配', blocks })
        const other = await window.knowbook.createDocument(null)
        await window.knowbook.updateDocument(other.id, { title: otherTitle, summary: '', blocks: [
          { type: 'paragraph', content: 'Other document keeps its own focus.', checked: false, depth: 0 }
        ] })
        return id
      }, { title, otherTitle, blocks, language })
      await page.reload()
      await expect(page.getByTestId('shell')).toBeVisible()
      await page.setViewportSize({ width: 1080, height: 850 })
      const documentButton = page.locator('.tree-button', { hasText: title }).first()
      await documentButton.focus()
      await page.keyboard.press('Enter')
      await expect(page.locator('.block-editor-row')).toHaveCount(contents.length)
      const before = await page.evaluate(id => window.knowbook.getDocumentDetail(id), id)
      expect(before).not.toBeNull()
      let probeIndex = await watchFindFocus(page)

      // Capture the real open panel before the new accessible-state assertions,
      // so an old build retains evidence of its missing expanded/controls state.
      let current = await openFind(page, needle, { app, testInfo, phase: 'shortcut-opens-find-before-state' })
      await expect(current.count).toHaveText('1 / 3')
      await expect(current.panel.locator('.block-find-result')).toHaveCount(3)
      await page.keyboard.press('Tab'); await expect(current.previous).toBeFocused()
      await page.keyboard.press('Tab'); await expect(current.next).toBeFocused()
      await page.keyboard.press('Tab'); await expect(current.close).toBeFocused()
      await page.keyboard.press('Shift+Tab'); await expect(current.next).toBeFocused()
      await page.keyboard.press('Tab'); await expect(current.close).toBeFocused()
      await record(page, app, testInfo, 'close-with-results-focused')
      await closeInside(page, probeIndex, 'Enter', { app, testInfo, phase: 'close-with-results-after-enter' })

      current = await openFind(page, 'ThisQueryHasNoMatchingBlocks')
      await expect(current.previous).toBeDisabled()
      await expect(current.next).toBeDisabled()
      await expect(current.count).toHaveText(uiText('No blocks match your search.', '没有匹配的块。'))
      await expect(current.panel.locator('.block-find-result')).toHaveCount(0)
      await page.keyboard.press('Tab'); await expect(current.close).toBeFocused()
      await page.keyboard.press('Shift+Tab'); await expect(current.input).toBeFocused()
      await page.keyboard.press('Tab'); await expect(current.close).toBeFocused()
      await closeInside(page, probeIndex, 'Enter', { app, testInfo, phase: 'close-with-no-results-after-enter' })

      current = await openFind(page)
      await page.keyboard.press('Tab'); await expect(current.previous).toBeFocused()
      await page.keyboard.press('Enter'); await expectMatch(page, 2)
      await page.keyboard.press('Tab'); await expect(current.previous).toBeFocused()
      await page.keyboard.press('Tab'); await expect(current.next).toBeFocused()
      await page.keyboard.press('Enter'); await expectMatch(page, 0)
      // Space continues to use the native button click behavior.
      await page.keyboard.press('Tab'); await expect(current.previous).toBeFocused()
      await page.keyboard.press('Tab'); await expect(current.next).toBeFocused()
      await page.keyboard.press('Space'); await expectMatch(page, 1)
      await page.keyboard.press('Tab'); await expect(current.previous).toBeFocused()
      await page.keyboard.press('Space'); await expectMatch(page, 0)
      await closeInside(page, probeIndex, 'Escape')

      // Choose a non-active result via actual forward/backward Tab navigation.
      current = await openFind(page)
      await page.keyboard.press('Tab'); await expect(current.previous).toBeFocused()
      await page.keyboard.press('Tab'); await expect(current.next).toBeFocused()
      await page.keyboard.press('Tab'); await expect(current.close).toBeFocused()
      await page.keyboard.press('Tab'); await expect(current.result(0)).toBeFocused()
      await page.keyboard.press('Tab'); await expect(current.result(1)).toBeFocused()
      await page.keyboard.press('Tab'); await expect(current.result(2)).toBeFocused()
      await page.keyboard.press('Shift+Tab'); await expect(current.result(1)).toBeFocused()
      await expect(current.result(1)).not.toHaveClass(/block-find-result-active/)
      await page.keyboard.press('Enter'); await expectMatch(page, 1)
      await record(page, app, testInfo, 'specific-result-enter-selected-second-block')
      await closeInside(page, probeIndex, 'Escape')

      current = await openFind(page)
      await page.keyboard.press('Enter'); await expectMatch(page, 0)
      await page.keyboard.press('Enter'); await expectMatch(page, 1)
      await page.keyboard.press('Shift+Enter'); await expectMatch(page, 0)
      await page.keyboard.press('Shift+Enter'); await expectMatch(page, 2)
      await page.keyboard.press('ArrowDown'); await expectMatch(page, 0)
      await page.keyboard.press('ArrowUp'); await expectMatch(page, 2)
      await page.keyboard.press('ArrowUp'); await expectMatch(page, 1)

      await current.input.dispatchEvent('compositionstart', { data: 'zhong' })
      await page.keyboard.press('Enter')
      await page.keyboard.press('Escape')
      await page.keyboard.press('ArrowDown')
      await expect(current.input).toBeFocused()
      await expect(current.count).toHaveText('2 / 3')
      await current.input.dispatchEvent('compositionend', { data: '' })
      const acceptedImeEvents = await current.input.evaluate(input => [
        { key: 'Enter', isComposing: true }, { key: 'Escape', isComposing: true },
        { key: 'ArrowDown', isComposing: true }, { key: 'Enter', keyCode: 229 }, { key: 'Escape', keyCode: 229 }
      ].map(event => input.dispatchEvent(new KeyboardEvent('keydown', { ...event, bubbles: true, cancelable: true }))))
      expect(acceptedImeEvents.every(Boolean)).toBe(true)
      await expect(current.count).toHaveText('2 / 3')
      await expect(current.input).toHaveValue(needle)
      await page.keyboard.press('Enter'); await expectMatch(page, 2)
      // Blurring during a composition also releases the input's composition ref.
      await current.input.dispatchEvent('compositionstart', { data: 'zhong' })
      await page.keyboard.press('Tab'); await expect(current.previous).toBeFocused()
      await page.keyboard.press('Shift+Tab'); await expect(current.input).toBeFocused()
      await page.keyboard.press('Enter'); await expectMatch(page, 0)
      await page.keyboard.press('Tab'); await expect(current.previous).toBeFocused()
      await page.keyboard.press('Tab'); await expect(current.next).toBeFocused()
      await page.keyboard.press('Tab'); await expect(current.close).toBeFocused()
      await closeInside(page, probeIndex, 'Space')

      current = await openFind(page)
      await closeInside(page, probeIndex, 'Control+f')

      // These openings use the real Find button's native Enter/Space activation,
      // independently of the global shortcut. The same panel ID must survive.
      await expect(findEntry(page)).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(controls(page).input).toBeFocused()
      await expectFindState(page, true)
      await controls(page).input.fill(needle)
      await expect(controls(page).count).toHaveText('1 / 3')
      await closeInside(page, probeIndex, 'Escape')
      await page.keyboard.press('Space')
      await expect(controls(page).input).toBeFocused()
      await expectFindState(page, true)
      await controls(page).input.fill(needle)
      await expect(controls(page).count).toHaveText('1 / 3')
      await record(page, app, testInfo, 'native-find-space-open-state')
      await closeInside(page, probeIndex, 'Control+f')

      // Outside focus is an intentional move: Ctrl+F closes the still-open
      // panel while the body editor retains focus.
      current = await openFind(page)
      let callsBefore = (await focusProbe(page, probeIndex)).calls.length
      const editor = page.locator('.block-editor-row[data-block-index="2"] textarea')
      await editor.focus()
      await expect(editor).toBeFocused()
      await expect(current.panel).toBeVisible()
      await page.keyboard.press('Control+f')
      await expect(current.panel).toHaveCount(0)
      await expectFindState(page, false)
      await settleFrames(page)
      await expect(editor).toBeFocused()
      expect((await focusProbe(page, probeIndex)).calls.length).toBe(callsBefore)

      // An actual pointer gesture on a non-focusable area also abandons the
      // return target, even though no other form control takes ownership.
      current = await openFind(page)
      callsBefore = (await focusProbe(page, probeIndex)).calls.length
      const headingText = page.locator('.document-current-heading')
      expect(await headingText.evaluate(element => (element as HTMLElement).tabIndex)).toBe(-1)
      await headingText.click()
      await expect(page.locator('body')).toBeFocused()
      await expect(current.panel).toBeVisible()
      await page.keyboard.press('Control+f')
      await expect(current.panel).toHaveCount(0)
      await expectFindState(page, false)
      await settleFrames(page)
      await expect(page.locator('body')).toBeFocused()
      expect((await focusProbe(page, probeIndex)).calls.length).toBe(callsBefore)

      // Global page shortcuts really unmount this Find entry. Its observed
      // native focus implementation must not be called during or after teardown.
      current = await openFind(page)
      const oldProbe = probeIndex
      callsBefore = (await focusProbe(page, oldProbe)).calls.length
      await page.keyboard.press('Control+6')
      await expect(page.locator('[data-page-id="settings"]')).toHaveAttribute('aria-current', 'page')
      await expect(page.getByRole('tab', { name: uiText('General', '通用'), exact: true })).toBeVisible()
      await expect(page.getByRole('heading', { name: uiText('General preferences', '基础偏好'), exact: true })).toBeVisible()
      await expect(findEntry(page)).toHaveCount(0)
      await settleFrames(page)
      expect((await focusProbe(page, oldProbe)).connected).toBe(false)
      expect((await focusProbe(page, oldProbe)).calls.length).toBe(callsBefore)
      await page.keyboard.press('Control+1')
      await expect(page.locator('[data-page-id="documents"]')).toHaveAttribute('aria-current', 'page')
      await expect(page.getByTestId('document-scroll-region')).toBeVisible()
      await expect(findEntry(page)).toBeVisible()
      await expect(page.locator('.block-editor-row')).toHaveCount(contents.length)
      await settleFrames(page)
      expect((await focusProbe(page, oldProbe)).calls.length).toBe(callsBefore)
      probeIndex = await watchFindFocus(page)

      // Playwright forces renderer focus; native windows stay hidden/unfocused.
      // These controlled window events test ownership cancellation and replay,
      // not a real operating-system focus change (getter=false is unit-covered).
      current = await openFind(page)
      callsBefore = (await focusProbe(page, probeIndex)).calls.length
      expect(await page.evaluate(() => document.hasFocus())).toBe(true)
      await page.evaluate(() => window.dispatchEvent(new Event('blur')))
      await page.keyboard.press('Escape')
      await expect(current.panel).toHaveCount(0)
      await expectFindState(page, false)
      await settleFrames(page)
      expect((await focusProbe(page, probeIndex)).calls.length).toBe(callsBefore)
      await expect(findEntry(page)).not.toBeFocused()
      await record(page, app, testInfo, 'controlled-window-blur-closes-without-restoring')
      await page.evaluate(() => window.dispatchEvent(new Event('focus')))
      await settleFrames(page)
      expect((await focusProbe(page, probeIndex)).calls.length).toBe(callsBefore)
      await expect(findEntry(page)).not.toBeFocused()

      // A genuine keyboard document selection also discards the old entry.
      current = await openFind(page)
      callsBefore = (await focusProbe(page, probeIndex)).calls.length
      const otherDocument = page.locator('.tree-button', { hasText: otherTitle }).first()
      await otherDocument.focus()
      await page.keyboard.press('Enter')
      await expect(page.locator('.block-editor-row')).toHaveCount(1)
      await expect(page.locator('.block-editor-row textarea')).toHaveValue('Other document keeps its own focus.')
      await settleFrames(page)
      const discarded = await focusProbe(page, probeIndex)
      expect(discarded.connected).toBe(false)
      expect(discarded.calls.length).toBe(callsBefore)

      const after = await page.evaluate(id => window.knowbook.getDocumentDetail(id), id)
      expect(after).not.toBeNull()
      expect(after).toEqual(before)
      await record(page, app, testInfo, 'keyboard-find-complete-content-unchanged')
    })
  })
}
