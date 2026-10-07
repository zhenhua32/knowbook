import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import { hasBuiltElectronApp, withElectronApp } from './helpers/electron'

const pageIds = ['documents', 'search', 'database', 'dashboard', 'ai', 'plugins', 'settings']
const labels = {
  'en-US': ['Documents', 'Search', 'Database', 'Dashboard', 'AI Assistant', 'Plugins', 'Settings'],
  'zh-CN': ['文档', '搜索', '数据库', '总览', 'AI 助手', '插件中心', '配置中心']
}

async function settle(page: Page) {
  await expect.poll(() => page.locator('.sidebar').evaluate(element => element.getAnimations({ subtree: true })
    .filter(animation => animation.playState === 'running' || animation.pending).length)).toBe(0)
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function geometry(target: Locator, outline = false) {
  return target.evaluate((element, outline) => {
    const box = element.getBoundingClientRect(), css = getComputedStyle(element)
    const extra = outline && css.outlineStyle !== 'none' ? Math.max(0, parseFloat(css.outlineWidth) + parseFloat(css.outlineOffset)) : 0
    let left = 0, top = 0, right = innerWidth, bottom = innerHeight
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent), rect = parent.getBoundingClientRect()
      if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
        left = Math.max(left, rect.left + parent.clientLeft); right = Math.min(right, rect.left + parent.clientLeft + parent.clientWidth)
      }
      if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
        top = Math.max(top, rect.top + parent.clientTop); bottom = Math.min(bottom, rect.top + parent.clientTop + parent.clientHeight)
      }
    }
    const full = box.width > 0 && box.height > 0 && box.left - extra >= left - 1 && box.right + extra <= right + 1
      && box.top - extra >= top - 1 && box.bottom + extra <= bottom + 1
    const hit = document.elementFromPoint(box.right - 5, box.top + box.height / 2)
    return { box: box.toJSON(), full, rightHit: Boolean(hit && (hit === element || element.contains(hit))),
      clip: { left, top, right, bottom }, outline: { width: css.outlineWidth, offset: css.outlineOffset, style: css.outlineStyle },
      focusVisible: element.matches(':focus-visible'), focused: document.activeElement === element }
  }, outline)
}

async function evidence(page: Page, app: ElectronApplication, info: TestInfo, phase: string, details: unknown = null) {
  const native = await app.evaluate(({ app, BrowserWindow }) => ({ userData: app.getPath('userData'),
    windows: BrowserWindow.getAllWindows().map(window => ({ bounds: window.getBounds(), content: window.getContentBounds(),
      minimum: window.getMinimumSize(), visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() })) }))
  const state = await page.locator('.sidebar-workspace-navigation').evaluate(element => ({ innerWidth, innerHeight,
    horizontalOverflow: element.scrollWidth - element.clientWidth, documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    theme: document.documentElement.dataset.theme, collapsed: element.classList.contains('collapsed'),
    ports: ['.sidebar-workspace-rail', '.pinned-section-compact', '.tree-virtual-scroll', '.sidebar-management-footer'].map(selector => {
      const node = element.querySelector<HTMLElement>(selector)!
      return { selector, box: node.getBoundingClientRect().toJSON(), clientHeight: node.clientHeight, scrollHeight: node.scrollHeight, scrollTop: node.scrollTop }
    }) }))
  const path = info.outputPath(`${phase}.json`)
  writeFileSync(path, JSON.stringify({ phase, native, state, details }, null, 2))
  await info.attach(phase, { path, contentType: 'application/json' })
  await page.screenshot({ path: info.outputPath(`${phase}.png`) })
  expect(native.windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  expect(state.horizontalOverflow).toBeLessThanOrEqual(1); expect(state.documentOverflow).toBeLessThanOrEqual(1)
  return { native, state }
}

async function wheelReveal(page: Page, target: Locator, port: Locator) {
  for (let step = 0; step < 16; step++) {
    if ((await geometry(target)).full) return
    const box = (await port.boundingBox())!, targetBox = (await target.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, targetBox.y < box.y ? -120 : 120)
    await settle(page)
  }
  expect((await geometry(target)).full, 'Native wheel must reveal the complete target').toBe(true)
}

async function tabChecks(page: Page, pins: boolean) {
  const expected = new Set([...pageIds, 'trash', 'shortcuts', ...(pins ? ['last-pin'] : [])]), seen = new Set<string>(), route: unknown[] = []
  await page.locator('.rail-toggle-btn').focus()
  for (let step = 0; step < 45 && seen.size < expected.size; step++) {
    await page.keyboard.press('Tab')
    const active = page.locator('.sidebar-workspace-navigation :focus')
    if (await active.count() !== 1) continue
    const key = await active.evaluate(element => element.getAttribute('data-page-id') ?? (element.classList.contains('sidebar-trash-button')
      ? 'trash' : element.classList.contains('shortcut-help-button') ? 'shortcuts'
        : element.classList.contains('pinned-doc-item-compact') && element === document.querySelector('.pinned-doc-item-compact:last-child') ? 'last-pin' : null))
    if (!key || !expected.has(key)) continue
    const state = await geometry(active, true); route.push({ key, ...state }); seen.add(key)
    expect(state, `${key} Tab focus including its outline must be unclipped`).toMatchObject({ full: true, focusVisible: true })
  }
  expect([...seen].sort()).toEqual([...expected].sort())
  return route
}

async function treeTail(page: Page, title: string) {
  const port = page.locator('.tree-virtual-scroll'), box = (await port.boundingBox())!
  expect(box.height, 'Keep at least two complete tree rows available').toBeGreaterThanOrEqual(72)
  await port.evaluate(node => { node.scrollTop = 0 })
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.wheel(0, 10_000)
  await expect.poll(() => port.evaluate(node => node.scrollTop)).toBeGreaterThan(0)
  const last = page.getByRole('treeitem', { name: title, exact: true })
  await expect(last).toBeAttached(); expect((await geometry(last)).full).toBe(true)
  await page.locator('.rail-toggle-btn').focus()
  for (let step = 0; step < 35; step++) {
    await page.keyboard.press('Tab')
    if (await page.locator('.tree-node[role="treeitem"]:focus').count()) break
  }
  await expect(page.locator('.tree-node[role="treeitem"]:focus')).toHaveCount(1)
  await page.keyboard.press('End'); await expect(last).toBeFocused()
  const focused = await geometry(last, true); expect(focused.full).toBe(true); expect(focused.focusVisible).toBe(true)
  expect((await geometry(page.locator('.sidebar-management-footer'))).full).toBe(true)
  return { title, focused, scrollTop: await port.evaluate(node => node.scrollTop) }
}

for (const { language, theme } of [{ language: 'en-US', theme: 'light' }, { language: 'zh-CN', theme: 'dark' }] as const) {
  test(`sidebar navigation, pins and tree stay reachable in real short windows ${language} ${theme} @electron`, async ({}, info) => {
    test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
    test.setTimeout(120_000)
    await withElectronApp(async ({ page, app, tempRoot }) => {
      const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
      const fixture = await page.evaluate(async ({ language, theme }) => {
        const ids: string[] = []
        for (let index = 0; index < 40; index++) {
          const document = await window.knowbook.createDocument(null)
          await window.knowbook.updateDocument(document.id, { title: `Sidebar layout ${String(index).padStart(2, '0')}`, summary: '', blocks: [] }); ids.push(document.id)
        }
        await window.knowbook.saveSetting('pinned_documents', JSON.stringify(ids.slice(0, 4)))
        await window.knowbook.saveSetting('ui.language', language); await window.knowbook.saveSetting('appearance.theme', theme)
        const tree = (await window.knowbook.getHomeData()).documentTree
        const tail = (nodes: typeof tree): string => nodes.at(-1)!.children.length ? tail(nodes.at(-1)!.children) : nodes.at(-1)!.title
        return { tail: tail(tree), catalog: (await window.knowbook.getDocumentCatalog()).map(({ id, parentId, title }) => ({ id, parentId, title })) }
      }, { language, theme })
      await page.reload(); await expect(page.locator('.pinned-doc-item-compact')).toHaveCount(4)
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      expect(await page.locator('html').getAttribute('data-knowbook-theme-switcher')).toBeNull()
      for (const height of [760, 620]) {
        await app.evaluate(({ BrowserWindow }, height) => {
          const window = BrowserWindow.getAllWindows()[0]; window.setMinimumSize(680, 400); window.setSize(760, height)
        }, height)
        await settle(page)
        const native = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize())
        await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual(native)
        const initial = await evidence(page, app, info, `${height}-expanded-before`)
        expect(initial.native.windows[0].bounds).toMatchObject({ width: 760, height })
        expect(initial.native.userData.toLowerCase()).toBe(tempRoot.toLowerCase())
        if (height === 760) for (const id of pageIds.slice(0, 5)) expect((await geometry(page.locator(`[data-page-id="${id}"]`))).full).toBe(true)
        const pins = page.locator('.pinned-section-compact'), lastPin = page.locator('.pinned-doc-item-compact').last(), pinBox = (await pins.boundingBox())!
        await page.mouse.move(pinBox.x + pinBox.width / 2, pinBox.y + pinBox.height / 2); await page.mouse.wheel(0, 1_000)
        await expect.poll(async () => (await geometry(lastPin)).full).toBe(true)
        const tail = await treeTail(page, fixture.tail); await evidence(page, app, info, `${height}-tree-and-pins-tail`, { tail, lastPin: await geometry(lastPin) })
        await page.locator('.tree-virtual-scroll').evaluate(node => { node.scrollTop = 0 })
        const transfer = await page.evaluateHandle(() => new DataTransfer())
        try {
          // Deliver browser drag events to the real handlers without an offscreen OS drag loop.
          await page.locator('.tree-button').first().dispatchEvent('dragstart', { dataTransfer: transfer })
          await expect(page.locator('.root-drop-zone-compact')).toBeVisible()
          await page.locator('.root-drop-zone-compact').dispatchEvent('dragover', { dataTransfer: transfer })
          await expect(page.locator('.root-drop-zone-compact')).toHaveClass(/root-drop-zone-active/)
          const dragTail = await treeTail(page, fixture.tail)
          await evidence(page, app, info, `${height}-drag-tree-tail`, dragTail)
        } finally {
          await page.locator('.tree-button').first().dispatchEvent('dragend', { dataTransfer: transfer }); await transfer.dispose()
        }
        await expect(page.locator('.root-drop-zone-compact')).toHaveCount(0)
        for (const collapsed of [false, true]) {
          if (collapsed) { await page.locator('.rail-toggle-btn').click(); await settle(page) }
          await expect(page.locator('.sidebar-workspace-navigation [data-page-id]')).toHaveCount(7)
          for (let index = 0; index < pageIds.length; index++) {
            const id = pageIds[index], button = page.locator(`.sidebar-workspace-navigation [data-page-id="${id}"]`)
            await expect(button).toHaveAttribute('aria-label', labels[language][index]); await expect(button).toHaveAttribute('title', labels[language][index])
            if (index < 5) await wheelReveal(page, button, page.locator('.sidebar-workspace-rail'))
            const state = await geometry(button); expect(state.full).toBe(true); expect(state.rightHit).toBe(true); expect(state.box.height).toBeGreaterThanOrEqual(36)
            if (!collapsed) {
              const label = button.locator('.nav-item-label'); await expect(label).toBeVisible()
              expect(await label.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1)
              if (index < 5) expect(await button.evaluate(node => Math.abs(node.getBoundingClientRect().width - node.parentElement!.getBoundingClientRect().width))).toBeLessThanOrEqual(1)
            }
            await page.mouse.click(state.box.right - 5, state.box.top + state.box.height / 2); await expect(button).toHaveAttribute('aria-current', 'page')
          }
          const tab = await tabChecks(page, !collapsed)
          await evidence(page, app, info, `${height}-${collapsed ? 'collapsed' : 'expanded'}-navigation`, tab)
        }
        await page.locator('.rail-toggle-btn').click(); await settle(page)
        await wheelReveal(page, page.locator('[data-page-id="documents"]'), page.locator('.sidebar-workspace-rail'))
        await page.locator('[data-page-id="documents"]').click()
      }
      expect(await page.evaluate(async () => (await window.knowbook.getDocumentCatalog()).map(({ id, parentId, title }) => ({ id, parentId, title })))).toEqual(fixture.catalog)
      expect(errors).toEqual([])
    }, { PLAYWRIGHT_ELECTRON_LOCALE: language })
  })
}
