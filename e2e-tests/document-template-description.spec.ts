import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { uiText, withElectronApp } from './helpers/electron'

const marker = 'DescriptionTailUnique20261009'
const names = { alpha: 'Template Guide Alpha', beta: 'Template Guide Beta', empty: 'Template Guide Empty' }
const betaDescription = 'A different, complete explanation for the second template.'
const prefix = `Instructions remain plain text.\n<img src="https://invalid.test/hidden.png"> {{title}}\nhttps://example.invalid/${'LongUrlSegment'.repeat(30)}\n`
const ending = `\nSearchable final instruction: ${marker}`
const description = prefix + 'Read the instructions before creating a note. Keep the original recipe and review every step.\n'
  .repeat(30).slice(0, 1980 - prefix.length - ending.length) + ending
const picker = (page: Page) => page.getByRole('dialog', { name: uiText('From template', '从模板新建'), exact: true })
const search = (page: Page) => picker(page).getByRole('searchbox', { name: uiText('Search templates', '搜索模板'), exact: true })
const title = (page: Page) => picker(page).getByRole('textbox', { name: uiText('Document title', '文档标题'), exact: true })
const parent = (page: Page) => picker(page).getByRole('combobox', { name: uiText('Parent folder', '父目录'), exact: true })
const create = (page: Page) => picker(page).getByRole('button', { name: uiText('Create document', '创建文档'), exact: true })
const fullDescription = (page: Page) => picker(page).locator('details.document-template-full-description')
const summary = (page: Page) => fullDescription(page).locator('summary')
const item = (page: Page, name: string) => picker(page).locator('.document-template-item').filter({ has: page.getByText(name, { exact: true }) })
const twoFrames = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))

async function tabTo(page: Page, target: Locator) {
  await expect(target).toHaveCount(1)
  let reached = await target.evaluate(element => element === document.activeElement)
  for (let step = 0; step < 40 && !reached; step++) {
    await page.keyboard.press('Tab')
    reached = await target.evaluate(element => element === document.activeElement)
  }
  expect(reached, 'Native Tab must reach the control without repairing focus or scrolling').toBe(true)
  await expect(target).toBeFocused()
}

async function replaceQuery(page: Page, query: string) {
  await tabTo(page, search(page))
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.press('Backspace')
  if (query) await page.keyboard.type(query)
}

async function chooseParent(page: Page, id: string) {
  await tabTo(page, parent(page))
  await page.keyboard.press('Home')
  for (let step = 0; step < 32; step++) {
    if (await parent(page).inputValue() === id) return
    await page.keyboard.press('ArrowDown')
  }
  throw new Error('Native parent selection must reach the saved parent document')
}

async function textVisibility(target: Locator, text: string) {
  return target.evaluate((element, text) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    let node: Node | null, matched: Text | null = null, offset = -1
    while ((node = walker.nextNode())) {
      offset = (node.textContent ?? '').indexOf(text)
      if (offset >= 0) { matched = node as Text; break }
    }
    if (!matched) return { found: false, visible: false, fragments: [] }
    const range = document.createRange()
    range.setStart(matched, offset); range.setEnd(matched, offset + text.length)
    const clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight }
    for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
      const bounds = ancestor.getBoundingClientRect(), style = getComputedStyle(ancestor)
      if (/^(auto|scroll|hidden|clip)$/.test(style.overflowX)) {
        clip.left = Math.max(clip.left, bounds.left + ancestor.clientLeft)
        clip.right = Math.min(clip.right, bounds.left + ancestor.clientLeft + ancestor.clientWidth)
      }
      if (/^(auto|scroll|hidden|clip)$/.test(style.overflowY)) {
        clip.top = Math.max(clip.top, bounds.top + ancestor.clientTop)
        clip.bottom = Math.min(clip.bottom, bounds.top + ancestor.clientTop + ancestor.clientHeight)
      }
    }
    const fragments = [...range.getClientRects()].filter(bounds => bounds.width && bounds.height).map(bounds => {
      const width = Math.max(0, Math.min(bounds.right, clip.right) - Math.max(bounds.left, clip.left))
      const height = Math.max(0, Math.min(bounds.bottom, clip.bottom) - Math.max(bounds.top, clip.top))
      const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
      return { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height,
        visibleRatio: width * height / (bounds.width * bounds.height), centerHit: hit === element || Boolean(hit && element.contains(hit)) }
    })
    return { found: true, clip, visible: fragments.length > 0 && fragments.every(fragment => fragment.visibleRatio >= .999 && fragment.centerHit), fragments }
  }, text)
}

async function frameState(page: Page) {
  return picker(page).evaluate(modal => {
    const box = (element: Element) => {
      const bounds = element.getBoundingClientRect(), clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight }
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor), rect = ancestor.getBoundingClientRect()
        if (/^(auto|scroll|hidden|clip)$/.test(style.overflowX)) {
          clip.left = Math.max(clip.left, rect.left + ancestor.clientLeft)
          clip.right = Math.min(clip.right, rect.left + ancestor.clientLeft + ancestor.clientWidth)
        }
        if (/^(auto|scroll|hidden|clip)$/.test(style.overflowY)) {
          clip.top = Math.max(clip.top, rect.top + ancestor.clientTop)
          clip.bottom = Math.min(clip.bottom, rect.top + ancestor.clientTop + ancestor.clientHeight)
        }
      }
      const width = Math.max(0, Math.min(bounds.right, clip.right) - Math.max(bounds.left, clip.left))
      const height = Math.max(0, Math.min(bounds.bottom, clip.bottom) - Math.max(bounds.top, clip.top))
      const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)
      return { text: element.textContent, visibleRatio: bounds.width && bounds.height ? width * height / (bounds.width * bounds.height) : 0,
        centerHit: hit === element || Boolean(hit && element.contains(hit)) }
    }
    const workspace = modal.querySelector<HTMLElement>('.document-template-workspace')!
    return { viewport: { width: innerWidth, height: innerHeight }, theme: document.documentElement.dataset.theme,
      controls: [...modal.querySelectorAll('header > button, footer > button')].map(box),
      overflow: [modal, workspace, ...modal.querySelectorAll('.document-template-details, details.document-template-full-description, details.document-template-full-description p')]
        .map(element => ({ className: element.className, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth })),
      modal: { scrollTop: modal.scrollTop, scrollHeight: modal.scrollHeight, clientHeight: modal.clientHeight },
      workspace: { scrollTop: workspace.scrollTop, scrollHeight: workspace.scrollHeight, clientHeight: workspace.clientHeight } }
  })
}

function expectFrame(state: Awaited<ReturnType<typeof frameState>>) {
  expect(state.controls).toHaveLength(2)
  for (const control of state.controls) {
    expect(control.visibleRatio).toBeGreaterThanOrEqual(.999)
    expect(control.centerHit).toBe(true)
  }
  for (const element of state.overflow) expect(element.scrollWidth, `${element.className} must not overflow horizontally`).toBeLessThanOrEqual(element.clientWidth + 1)
  expect(state.modal.scrollTop).toBe(0)
  expect(state.modal.scrollHeight).toBeLessThanOrEqual(state.modal.clientHeight + 1)
}

async function record(page: Page, app: ElectronApplication, info: TestInfo, phase: string, extra: unknown = null) {
  const state = await frameState(page)
  expectFrame(state)
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable()
  })))
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  await info.attach(`${phase}-state`, { body: Buffer.from(JSON.stringify({ state, windows, extra }, null, 2)), contentType: 'application/json' })
  await page.screenshot({ path: info.outputPath(`${phase}.png`) })
  return state
}

for (const scenario of [
  { language: 'en-US', theme: 'light', viewport: { width: 1360, height: 520 } },
  { language: 'zh-CN', theme: 'dark', viewport: { width: 600, height: 560 } }
] as const) {
  test(`full template descriptions are readable through the keyboard and stay separate from note content (${scenario.language}) @electron`, async ({}, info) => {
    test.setTimeout(120_000)
    await withElectronApp(async ({ page, app }) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      expect(description.length).toBe(1980)
      const ids = await page.evaluate(async ({ scenario, names, description, betaDescription }) => {
        const { id: parentId } = await window.knowbook.createDocument(null)
        await window.knowbook.updateDocument(parentId, { title: 'Description parent', summary: 'Preserve the parent summary', blocks: [
          { id: `${parentId}-body`, type: 'paragraph', content: 'Preserve the parent body.', checked: false, depth: 0 }
        ] })
        const alpha = await window.knowbook.saveDocumentTemplate({ name: names.alpha, description, title: 'Alpha automatic title', summary: 'Alpha actual summary', blocks: [
          { id: 'description-alpha-body', type: 'paragraph', content: 'Alpha actual body for {{title}}.', checked: false, depth: 0 }
        ] })
        const beta = await window.knowbook.saveDocumentTemplate({ name: names.beta, description: betaDescription, title: 'Beta automatic title', summary: 'Beta actual summary', blocks: [
          { id: 'description-beta-body', type: 'paragraph', content: 'Beta actual body.', checked: false, depth: 0 }
        ] })
        await window.knowbook.saveDocumentTemplate({ name: names.empty, description: '', title: 'Empty explanation', summary: '', blocks: [
          { id: 'description-empty-body', type: 'paragraph', content: 'Body without instructions.', checked: false, depth: 0 }
        ] })
        await window.knowbook.saveSetting('ui.language', scenario.language)
        await window.knowbook.saveSetting('appearance.theme', scenario.theme)
        return { parentId, alphaId: alpha.id, betaId: beta.id }
      }, { scenario, names, description, betaDescription })
      await page.reload()
      await expect(page.getByTestId('shell')).toBeVisible()
      await page.setViewportSize(scenario.viewport)
      await app.evaluate(({ BrowserWindow }, viewport) => BrowserWindow.getAllWindows()[0].setContentSize(viewport.width, viewport.height), scenario.viewport)
      await twoFrames(page)
      const before = await page.evaluate(async language => ({ catalog: await window.knowbook.getDocumentCatalog(), templates: await window.knowbook.listDocumentTemplates(language) }), scenario.language)
      expect(before.templates.find(template => template.id === ids.alphaId)?.description).toBe(description)
      await tabTo(page, page.getByRole('button', { name: uiText('New from template', '从模板新建'), exact: true }))
      await page.keyboard.press('Enter')
      await expect(picker(page)).toBeVisible()
      await expect(search(page)).toBeFocused()
      await page.keyboard.type(names.alpha)
      await expect(item(page, names.alpha)).toHaveAttribute('aria-pressed', 'true')
      await tabTo(page, item(page, names.alpha))
      await page.keyboard.press('Enter')
      const clamped = item(page, names.alpha).locator('.document-template-description')
      const clipping = await clamped.evaluate(element => ({ lines: getComputedStyle(element).webkitLineClamp, height: element.clientHeight, contentHeight: element.scrollHeight }))
      const hiddenTail = await textVisibility(clamped, marker)
      expect(clipping.lines).toBe('3')
      expect(clipping.contentHeight).toBeGreaterThan(clipping.height)
      expect(hiddenTail.found).toBe(true)
      expect(hiddenTail.visible).toBe(false)
      await record(page, app, info, `${scenario.language}-clamped-tail-before-search`, { clipping, hiddenTail })

      await replaceQuery(page, marker)
      await expect(picker(page).locator('.document-template-item')).toHaveCount(1)
      await expect(item(page, names.alpha)).toHaveAttribute('aria-pressed', 'true')
      // The previous build cannot pass this oracle: it offers no full explanation.
      await expect(summary(page)).toHaveCount(1)
      await expect(summary(page)).toHaveText(uiText('Full template description', '完整模板说明'))
      await expect(fullDescription(page)).not.toHaveAttribute('open', '')
      const manualTitle = `Description created ${scenario.language}`
      await tabTo(page, title(page))
      await page.keyboard.press('ControlOrMeta+A')
      await page.keyboard.type(manualTitle)
      await chooseParent(page, ids.parentId)
      await tabTo(page, summary(page))
      const focus = await summary(page).evaluate(element => ({ visible: element.matches(':focus-visible'), width: getComputedStyle(element).outlineWidth, style: getComputedStyle(element).outlineStyle }))
      expect(focus.visible).toBe(true)
      expect(parseFloat(focus.width)).toBeGreaterThanOrEqual(2)
      expect(focus.style).not.toBe('none')
      await page.keyboard.press('Enter')
      await expect(fullDescription(page)).toHaveAttribute('open', '')
      const explanation = fullDescription(page).locator('p')
      expect(await explanation.textContent()).toBe(description)
      await expect(fullDescription(page).locator('img, a, script')).toHaveCount(0)
      expect(['pre-wrap', 'pre-line', 'break-spaces']).toContain(await explanation.evaluate(element => getComputedStyle(element).whiteSpace))
      await page.keyboard.press('Space')
      await expect(fullDescription(page)).not.toHaveAttribute('open', '')
      await page.keyboard.press('Space')
      await expect(fullDescription(page)).toHaveAttribute('open', '')
      await twoFrames(page)
      let tail = await textVisibility(explanation, marker), pages = 0
      while (!tail.visible && pages < 40) {
        await page.keyboard.press('PageDown')
        await twoFrames(page)
        expectFrame(await frameState(page))
        tail = await textVisibility(explanation, marker)
        pages++
      }
      expect(tail.found).toBe(true)
      expect(tail.visible, 'Native PageDown must make the searched final instruction fully visible and hit-testable').toBe(true)
      const read = await record(page, app, info, `${scenario.language}-full-tail-read-through-native-keyboard`, { tail, pages, focus })
      expect(read.viewport).toEqual(scenario.viewport)
      expect(read.theme).toBe(scenario.theme)
      expect(read.workspace.scrollTop).toBeGreaterThan(0)
      await page.keyboard.press('End')
      await expect.poll(() => picker(page).locator('.document-template-workspace').evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1)
      await record(page, app, info, `${scenario.language}-native-end-retains-cancel-and-create`)
      await expect(summary(page)).toBeFocused()

      await replaceQuery(page, names.beta)
      await expect(item(page, names.beta)).toHaveAttribute('aria-pressed', 'true')
      await expect(fullDescription(page)).not.toHaveAttribute('open', '')
      expect(await fullDescription(page).locator('p').textContent()).toBe(betaDescription)
      await expect(title(page)).toHaveValue(manualTitle)
      await expect(parent(page)).toHaveValue(ids.parentId)
      await tabTo(page, summary(page))
      await page.keyboard.press('Enter')
      await expect(fullDescription(page)).toHaveAttribute('open', '')
      await record(page, app, info, `${scenario.language}-effective-beta-description-replaces-alpha`)

      await replaceQuery(page, 'No description template matches this query')
      await expect(picker(page).getByText(uiText('No matching templates', '没有匹配的模板'), { exact: true })).toBeVisible()
      await expect(fullDescription(page)).toHaveCount(0)
      await expect(picker(page).locator('.document-template-preview')).toHaveCount(0)
      await expect(create(page)).toBeDisabled()
      await page.keyboard.press('Enter')
      expect(await page.evaluate(() => window.knowbook.getDocumentCatalog())).toEqual(before.catalog)
      await record(page, app, info, `${scenario.language}-no-match-has-no-stale-explanation`)
      await replaceQuery(page, names.empty)
      await expect(item(page, names.empty)).toHaveAttribute('aria-pressed', 'true')
      await expect(fullDescription(page)).toHaveCount(0)
      await expect(create(page)).toBeEnabled()
      await expect(title(page)).toHaveValue(manualTitle)
      await expect(parent(page)).toHaveValue(ids.parentId)
      await replaceQuery(page, marker)
      await expect(item(page, names.alpha)).toHaveAttribute('aria-pressed', 'true')
      await expect(fullDescription(page)).not.toHaveAttribute('open', '')
      await expect(title(page)).toHaveValue(manualTitle)
      await expect(parent(page)).toHaveValue(ids.parentId)
      expect(await fullDescription(page).locator('p').textContent()).toBe(description)
      await tabTo(page, create(page))
      await record(page, app, info, `${scenario.language}-native-create-preserves-manual-drafts`)
      await page.keyboard.press('Enter')
      await expect(picker(page)).toHaveCount(0)
      await expect(page.locator('.document-header-title')).toHaveText(manualTitle)
      const after = await page.evaluate(async language => {
        const catalog = await window.knowbook.getDocumentCatalog()
        return { catalog, templates: await window.knowbook.listDocumentTemplates(language), details: await Promise.all(catalog.map(document => window.knowbook.getDocumentDetail(document.id))) }
      }, scenario.language)
      const added = after.catalog.filter(document => !before.catalog.some(original => original.id === document.id))
      expect(added).toHaveLength(1)
      expect(added[0]).toMatchObject({ title: manualTitle, parentId: ids.parentId, path: `Description parent/${manualTitle}` })
      const saved = after.details.find(document => document?.id === added[0].id)!
      expect(saved.summary).toBe('Alpha actual summary')
      expect(saved.blocks.map(block => ({ type: block.type, content: block.content, checked: block.checked, depth: block.depth }))).toEqual([
        { type: 'paragraph', content: `Alpha actual body for ${manualTitle}.`, checked: false, depth: 0 }
      ])
      expect(`${saved.summary}\n${saved.blocks.map(block => block.content).join('\n')}`).not.toContain(marker)
      expect(after.templates).toEqual(before.templates)
      await page.reload()
      expect(await page.evaluate(id => window.knowbook.getDocumentDetail(id), added[0].id)).toEqual(saved)
      expect(errors).toEqual([])
    }, { PLAYWRIGHT_ELECTRON_LOCALE: scenario.language })
  })
}
