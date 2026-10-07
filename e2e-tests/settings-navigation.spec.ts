import { expect, test, type Page } from '@playwright/test'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

async function openSettings(page: Page) {
  await page.getByTitle(uiText('Settings', '配置中心'), { exact: true }).click()
  await expect(page.getByRole('tab', { name: uiText('General', '通用') })).toHaveAttribute('aria-selected', 'true')
}

async function expectSeparatedHeader(page: Page) {
  const header = await page.locator('.settings-page-header').boundingBox()
  const layout = await page.locator('.settings-layout').boundingBox()
  expect(header).not.toBeNull()
  expect(layout).not.toBeNull()
  expect(header!.height).toBeGreaterThan(0)
  expect(header!.y + header!.height).toBeLessThanOrEqual(layout!.y + 1)
}

test('settings categories preserve drafts and remain usable with keyboard, dark theme, and narrow windows @electron', async ({}, testInfo) => {
  test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')
  await withElectronApp(async ({ page }) => {
    await openSettings(page)
    await expect(page.getByRole('tab')).toHaveCount(7)
    await expect(page.getByRole('tabpanel')).toHaveCount(1)
    await expectSeparatedHeader(page)
    await expect(page.getByLabel(uiText('Interface language', '界面语言'))).toBeVisible()
    await expect(page.getByLabel(uiText('Model', '模型'))).toBeHidden()
    const generalTab = page.getByRole('tab', { name: uiText('General', '通用') })
    await generalTab.focus()
    await page.keyboard.press('ArrowDown')
    await expect(page.getByRole('tab', { name: 'AI', exact: true })).toBeFocused()
    await page.getByLabel(uiText('Model', '模型')).fill('unsaved-category-model')
    await page.getByLabel(uiText('API Key (leave blank to keep current)', 'API Key（留空表示保持当前值）')).fill('unsaved-category-key')

    await page.getByRole('tab', { name: uiText('Sync', '同步') }).click()
    const sync = page.getByRole('region', { name: uiText('WebDAV sync', 'WebDAV 同步') })
    await sync.getByLabel(uiText('Username', '用户名'), { exact: true }).fill('unsaved-sync-username')
    await page.getByRole('tab', { name: uiText('Web clipping', '网页剪藏') }).click()
    await page.getByLabel(uiText('Listening port', '监听端口')).fill('4455')
    await page.getByRole('tab', { name: 'AI', exact: true }).click()
    await expect(page.getByLabel(uiText('Model', '模型'))).toHaveValue('unsaved-category-model')
    await expect(page.getByLabel(uiText('API Key (leave blank to keep current)', 'API Key（留空表示保持当前值）'))).toHaveValue('unsaved-category-key')
    await page.getByRole('tab', { name: uiText('Sync', '同步') }).click()
    await expect(sync.getByLabel(uiText('Username', '用户名'), { exact: true })).toHaveValue('unsaved-sync-username')
    await page.getByRole('tab', { name: uiText('Web clipping', '网页剪藏') }).click()
    await expect(page.getByLabel(uiText('Listening port', '监听端口'))).toHaveValue('4455')
    await page.getByRole('tab', { name: uiText('Storage & recovery', '存储与恢复') }).click()
    await expect(page.getByRole('button', { name: uiText('Open Trash', '打开回收站') })).toBeVisible()
    await page.getByRole('tab', { name: uiText('Appearance', '外观') }).click()
    await expect(page.getByTestId('theme-switcher-settings')).toBeVisible()
    await expectSeparatedHeader(page)
    await page.screenshot({ path: testInfo.outputPath('settings-categories-light.png') })

    await page.evaluate(async () => {
      await window.knowbook.saveSetting('appearance.theme', 'dark')
      await window.knowbook.saveSetting('ui.language', 'zh-CN')
    })
    await page.reload()
    await page.setViewportSize({ width: 760, height: 850 })
    await openSettings(page)
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(page.getByRole('tab', { name: '通用', exact: true })).toBeVisible()
    await page.getByRole('tab', { name: '网页剪藏', exact: true }).click()
    await expect(page.getByRole('tabpanel')).toHaveCount(1)
    const panel = page.getByRole('tabpanel')
    const dimensions = await panel.evaluate(element => ({ scroll: element.scrollWidth, client: element.clientWidth }))
    expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client + 1)
    await expect(panel.getByRole('button', { name: '保存桥接设置', exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('settings-categories-dark-narrow.png') })
  })
})

for (const language of ['en-US', 'zh-CN'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    test(`760 × 620 native settings navigation preserves focus and reaches every category in ${language}/${theme} @electron`, async ({}, testInfo) => {
      test.setTimeout(120_000)
      test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')
      await withElectronApp(async ({ app, page, tempRoot }) => {
        await page.evaluate(async ({ language, theme }) => {
          await window.knowbook.saveSetting('ui.language', language)
          await window.knowbook.saveSetting('appearance.theme', theme)
        }, { language, theme })
        await page.reload()
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
        const labels = language === 'zh-CN'
          ? ['通用', 'AI', '同步', '存储与恢复', '网页剪藏', '更新', '外观']
          : ['General', 'AI', 'Sync', 'Storage & recovery', 'Web clipping', 'Updates', 'Appearance']
        const tabs = labels.map(name => page.getByRole('tab', { name, exact: true }))
        const list = page.getByRole('tablist', { name: uiText('Settings categories', '设置分类') })
        const content = page.locator('.content.page-settings')
        const appearance = tabs[6]
        const formControl = page.getByTestId('theme-switcher-settings').locator('button').first()
        const evidence: unknown[] = []
        const nativeState = () => app.evaluate(({ app, BrowserWindow }) => ({
          userData: app.getPath('userData'),
          userDataOverride: process.env.KNOWBOOK_USER_DATA_DIR,
          windows: BrowserWindow.getAllWindows().map(window => ({
            id: window.id, bounds: window.getBounds(), size: window.getSize(), contentSize: window.getContentSize(),
            visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable()
          }))
        }))
        const expectNativeWindow = async (phase: string, width: number) => {
          const native = await nativeState()
          const inner = await page.evaluate(() => [innerWidth, innerHeight])
          expect(native.userData).toBe(tempRoot)
          expect(native.userDataOverride).toBe(tempRoot)
          expect(native.windows.length).toBeGreaterThan(0)
          expect(native.windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
          const window = native.windows[0]
          expect(window.contentSize).toEqual([width, 620])
          expect(inner).toEqual(window.contentSize)
          expect([window.bounds.width, window.bounds.height]).toEqual(window.size)
          expect(window.bounds.width).toBeGreaterThanOrEqual(window.contentSize[0])
          expect(window.bounds.height).toBeGreaterThanOrEqual(window.contentSize[1])
          evidence.push({ phase, native, inner })
        }
        const resize = async (width: number) => {
          await app.evaluate(({ BrowserWindow }, width) => {
            const window = BrowserWindow.getAllWindows()[0]
            // The product minimum is 760px tall. Only this isolated hidden
            // fixture lowers it to exercise a 620px content-height stress case.
            window.setMinimumSize(760, 620)
            window.setContentSize(width, 620)
          }, width)
          await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, 620])
          await expect.poll(() => page.locator('.sidebar').evaluate(element => (
            element.getAnimations().filter(animation => animation.playState === 'running' || animation.pending).length
          ))).toBe(0)
          await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
          await expectNativeWindow(`resize-${width}`, width)
        }
        const expectTabVisible = async (index: number) => {
          await expect(tabs[index]).toHaveText(labels[index])
          await expect.poll(() => tabs[index].evaluate(tab => {
            const list = tab.parentElement!
            const bounds = list.getBoundingClientRect()
            const selected = tab.getBoundingClientRect()
            const left = bounds.left + list.clientLeft
            const right = left + list.clientWidth
            return selected.left >= left - 1 && selected.right <= right + 1
              && tab.scrollWidth <= tab.clientWidth + 1
          })).toBe(true)
          const focus = await tabs[index].evaluate(tab => {
            const style = getComputedStyle(tab)
            return { visible: tab.matches(':focus-visible'), style: style.outlineStyle,
              width: parseFloat(style.outlineWidth), outward: parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset) }
          })
          if (focus.visible) {
            expect(focus.style).not.toBe('none')
            expect(focus.width).toBeGreaterThanOrEqual(2)
            expect(focus.outward).toBeLessThanOrEqual(0)
          }
        }
        const expectSingleNavigationRow = async () => {
          const dimensions = await list.evaluate(element => {
            const buttons = [...element.querySelectorAll<HTMLElement>('[role="tab"]')]
            const boxes = buttons.map(button => button.getBoundingClientRect())
            return {
              navHeight: element.parentElement!.getBoundingClientRect().height,
              listHeight: element.getBoundingClientRect().height,
              verticalOverflow: element.scrollHeight - element.clientHeight,
              columns: getComputedStyle(element.closest('.settings-layout')!).gridTemplateColumns.split(' ').length,
              tops: boxes.map(box => box.top), heights: boxes.map(box => box.height),
              overflow: element.scrollWidth - element.clientWidth
            }
          })
          expect(dimensions.navHeight).toBeLessThanOrEqual(56)
          expect(dimensions.listHeight).toBeLessThanOrEqual(56)
          expect(dimensions.verticalOverflow).toBeLessThanOrEqual(1)
          expect(dimensions.columns).toBe(1)
          expect(Math.max(...dimensions.tops) - Math.min(...dimensions.tops)).toBeLessThanOrEqual(1)
          expect(dimensions.heights.every(height => height >= 38)).toBe(true)
          // Longer English labels exercise overflow; fitting labels must all
          // remain fully visible without requiring an unnecessary scrollbar.
          if (language === 'en-US') expect(dimensions.overflow).toBeGreaterThan(0)
          if (dimensions.overflow <= 1) {
            for (let index = 0; index < labels.length; index++) await expectTabVisible(index)
          }
          evidence.push({ phase: 'single-navigation-row', dimensions })
        }
        const expectSelectedCategory = async (index: number, focused = true) => {
          const tab = tabs[index]
          await expect(tab).toHaveAttribute('aria-selected', 'true')
          await expect(tab).toHaveAttribute('tabindex', '0')
          if (focused) {
            await expect(tab).toBeFocused()
            expect(await tab.evaluate(element => element.matches(':focus-visible'))).toBe(true)
          }
          await expectTabVisible(index)
          await expect(page.getByRole('tab', { selected: true })).toHaveCount(1)
          await expect(page.getByRole('tabpanel')).toHaveCount(1)
          const panelId = await tab.getAttribute('aria-controls')
          const panel = page.locator(`[id=${JSON.stringify(panelId)}]`)
          await expect(panel).toBeVisible()
          await expect(panel).toHaveAttribute('aria-labelledby', (await tab.getAttribute('id'))!)
          const control = panel.locator('input:not(:disabled), select:not(:disabled), button:not(:disabled)').first()
          await expect(control).toBeVisible()
          await expect(control).toBeEnabled()
          const panelSize = await panel.evaluate(element => ({ scroll: element.scrollWidth, client: element.clientWidth }))
          expect(panelSize.scroll).toBeLessThanOrEqual(panelSize.client + 1)
        }

        await resize(850)
        await openSettings(page)
        await expect(page.getByRole('tab')).toHaveCount(7)
        await expect(list).toHaveAttribute('aria-orientation', 'vertical')
        expect(await page.locator('.settings-layout').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(2)
        await appearance.click()
        await expect(page.getByTestId('theme-switcher-settings')).toBeVisible()
        await formControl.focus()
        await expect(formControl).toBeFocused()
        await content.evaluate(element => { element.scrollTop = 20 })
        const beforeScroll = await content.evaluate(element => element.scrollTop)
        expect(beforeScroll).toBeGreaterThan(0)
        for (const width of [800, 760]) {
          await resize(width)
          await expect(list).toHaveAttribute('aria-orientation', 'horizontal')
          await expect(appearance).toHaveAttribute('aria-selected', 'true')
          await expect(formControl).toBeFocused()
          await expectTabVisible(6)
          await expectSingleNavigationRow()
          expect(await content.evaluate(element => element.scrollTop)).toBe(beforeScroll)
          evidence.push({ phase: `appearance-retained-${width}`, scrollLeft: await list.evaluate(element => element.scrollLeft), verticalScroll: beforeScroll })
          await page.screenshot({ path: testInfo.outputPath(`native-settings-appearance-${width}x620.png`) })
        }

        // Use wheel input over the scroll port, rather than locator clicks
        // which could automatically reveal a clipped category for the test.
        const bounds = (await list.boundingBox())!
        await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
        await page.mouse.wheel(-10_000, 0)
        await expect.poll(() => list.evaluate(element => element.scrollLeft)).toBe(0)
        await expectTabVisible(0)
        await expect(formControl).toBeFocused()
        expect(await content.evaluate(element => element.scrollTop)).toBe(beforeScroll)
        const reachable = new Set<string>()
        const collectReachable = async () => {
          const names = await list.evaluate(element => {
            const bounds = element.getBoundingClientRect()
            const left = bounds.left + element.clientLeft, right = left + element.clientWidth
            return [...element.querySelectorAll<HTMLElement>('[role="tab"]')]
              .filter(tab => { const rect = tab.getBoundingClientRect(); return rect.left >= left - 1 && rect.right <= right + 1 })
              .map(tab => tab.textContent!.trim())
          })
          names.forEach(name => reachable.add(name))
        }
        await collectReachable()
        for (let attempt = 0; attempt < 20; attempt++) {
          const previous = await list.evaluate(element => ({ left: element.scrollLeft, maximum: element.scrollWidth - element.clientWidth }))
          if (previous.maximum - previous.left <= 1) break
          await page.mouse.wheel(100, 0)
          await expect.poll(() => list.evaluate(element => element.scrollLeft)).toBeGreaterThan(previous.left)
          await collectReachable()
        }
        await expect.poll(() => list.evaluate(element => element.scrollWidth - element.clientWidth - element.scrollLeft)).toBeLessThanOrEqual(1)
        await expectTabVisible(6)
        expect([...reachable].sort()).toEqual([...labels].sort())
        await expect(formControl).toBeFocused()
        await expect(appearance).toHaveAttribute('aria-selected', 'true')
        expect(await content.evaluate(element => element.scrollTop)).toBe(beforeScroll)
        evidence.push({ phase: 'wheel-reached-every-category', reachable: [...reachable], verticalScroll: beforeScroll })
        await page.screenshot({ path: testInfo.outputPath('native-settings-wheel-appearance-end.png') })
        await page.mouse.wheel(-10_000, 0)
        await expect.poll(() => list.evaluate(element => element.scrollLeft)).toBe(0)
        await expectTabVisible(0)

        await appearance.focus()
        await page.keyboard.press('Home')
        await expectSelectedCategory(0)
        for (let index = 1; index < labels.length; index++) {
          await page.keyboard.press('ArrowRight')
          await expectSelectedCategory(index)
        }
        await page.keyboard.press('ArrowRight')
        await expectSelectedCategory(0)
        await page.keyboard.press('ArrowLeft')
        await expectSelectedCategory(6)
        for (let index = labels.length - 2; index >= 0; index--) {
          await page.keyboard.press('ArrowLeft')
          await expectSelectedCategory(index)
        }
        await page.keyboard.press('End')
        await expectSelectedCategory(6)
        await page.keyboard.press('Home')
        await expectSelectedCategory(0)
        await page.keyboard.press('End')
        await expectSelectedCategory(6)
        await expectSingleNavigationRow()
        await page.screenshot({ path: testInfo.outputPath('native-settings-keyboard-appearance-end.png') })

        await page.getByTitle(uiText('Dashboard', '总览'), { exact: true }).click()
        await expect(page.locator('.content.page-dashboard')).toBeVisible()
        await expect(page.locator('.settings-category-nav')).toHaveCount(0)
        await page.getByTitle(uiText('Settings', '配置中心'), { exact: true }).click()
        await expect(list).toHaveAttribute('aria-orientation', 'horizontal')
        await expectSelectedCategory(6, false)
        await expectSingleNavigationRow()
        await expectNativeWindow('settings-dashboard-settings-return', 760)
        await testInfo.attach('native-settings-navigation', { body: JSON.stringify({ language, theme, tempRoot, evidence }), contentType: 'application/json' })
        await page.screenshot({ path: testInfo.outputPath('native-settings-return-appearance-760x620.png') })
      })
    })
  }
}
