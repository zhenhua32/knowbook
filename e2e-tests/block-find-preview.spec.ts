import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { writeFileSync } from 'node:fs'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

const query = 'VisibleNeedle'
const longQuery = `${query}${'AbCdEfGhIjKlMnOpQrStUvWxYz'.repeat(3)}`.slice(0, 80)
const matchingContents = [
  `${'更早的正文保留在文档内，不应被修改。'.repeat(12)}${'中文前文'.repeat(9)}${longQuery}${'，这是命中词后的完整原文。'.repeat(8)}`,
  `${'Earlier paragraphs retain their original contents. '.repeat(12)}The context before the matching text: ${longQuery}${' — the remainder stays unchanged.'.repeat(8)}`,
  `${'EarlierUnbrokenDocumentText'.repeat(12)}${'W'.repeat(36)}${longQuery}${'UnbrokenTrailingText'.repeat(8)}`
]
const contents = [matchingContents[0],
  Array.from({ length: 18 }, (_, index) => `Unmatched paragraph A, line ${index + 1}.`).join('\n'),
  matchingContents[1],
  Array.from({ length: 18 }, (_, index) => `Unmatched paragraph B, line ${index + 1}.`).join('\n'),
  matchingContents[2],
  Array.from({ length: 12 }, (_, index) => `Unmatched trailing paragraph, line ${index + 1}.`).join('\n')]

function controls(page: Page) {
  const panel = page.locator('.block-find-panel')
  return { panel, input: panel.locator('.block-find-input'), count: panel.locator('.block-find-count'),
    previous: panel.getByRole('button', { name: uiText('Previous match', '上一个匹配'), exact: true }),
    next: panel.getByRole('button', { name: uiText('Next match', '下一个匹配'), exact: true }),
    close: panel.getByRole('button', { name: uiText('Close find', '关闭查找'), exact: true }),
    list: panel.locator('.block-find-results'), result: (index: number) => panel.locator(`.block-find-result[data-result-index="${index}"]`) }
}

async function previewGeometry(result: Locator, search: string) {
  return result.locator('.block-find-result-preview').evaluate((element, search) => {
    const preview = element as HTMLElement
    const bounds = (rect: DOMRect) => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height })
    const text = preview.textContent ?? ''
    const start = text.toLocaleLowerCase().indexOf(search.toLocaleLowerCase())
    const walker = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT)
    const nodes: { node: Text; start: number; end: number }[] = []
    let offset = 0
    while (walker.nextNode()) {
      const node = walker.currentNode as Text
      nodes.push({ node, start: offset, end: offset + node.length })
      offset += node.length
    }
    // This works with both the old plain text and later nested highlighting.
    // A DOM text match alone is insufficient: ellipsis retains unpainted text.
    const rangeFor = (from: number, to: number) => {
      const first = nodes.find(node => from >= node.start && from < node.end)
      const last = nodes.find(node => to > node.start && to <= node.end)
      if (!first || !last) return null
      const range = document.createRange()
      range.setStart(first.node, from - first.start)
      range.setEnd(last.node, to - last.start)
      return range
    }
    const clip = { left: 0, right: innerWidth, top: 0, bottom: innerHeight }
    const clipping: { tag: string; className: string; overflowX: string; overflowY: string; rect: ReturnType<typeof bounds> }[] = []
    for (let ancestor: HTMLElement | null = preview; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor)
      const clipsX = ['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowX)
      const clipsY = ['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowY)
      if (ancestor !== preview && !clipsX && !clipsY) continue
      const rect = ancestor.getBoundingClientRect()
      const left = rect.left + ancestor.clientLeft, top = rect.top + ancestor.clientTop
      if (ancestor === preview || clipsX) {
        clip.left = Math.max(clip.left, left)
        clip.right = Math.min(clip.right, left + ancestor.clientWidth)
      }
      if (ancestor === preview || clipsY) {
        clip.top = Math.max(clip.top, top)
        clip.bottom = Math.min(clip.bottom, top + ancestor.clientHeight)
      }
      clipping.push({ tag: ancestor.tagName, className: ancestor.className, overflowX: style.overflowX, overflowY: style.overflowY, rect: bounds(rect) })
    }
    const glyphs = start < 0 ? [] : Array.from(search, (_, index) => {
      const rects = Array.from(rangeFor(start + index, start + index + 1)?.getClientRects() ?? [])
        .filter(rect => rect.width > 0 && rect.height > 0).map(bounds)
      return { index, rects, visible: rects.length > 0 && rects.every(rect => rect.left >= clip.left - 0.5
        && rect.right <= clip.right + 0.5 && rect.top >= clip.top - 0.5 && rect.bottom <= clip.bottom + 0.5) }
    })
    const style = getComputedStyle(preview)
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })!
    const rgba = (value: string): number[] => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = value
      context.fillRect(0, 0, 1, 1)
      const pixel = context.getImageData(0, 0, 1, 1).data
      return [pixel[0], pixel[1], pixel[2], pixel[3] / 255]
    }
    const over = (front: number[], back: number[]) => front.slice(0, 3)
      .map((channel, index) => channel * front[3] + back[index] * (1 - front[3]))
    const luminance = (color: number[]) => {
      const [red, green, blue] = color.map(channel => {
        const value = channel / 255
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
      })
      return red * 0.2126 + green * 0.7152 + blue * 0.0722
    }
    const marks = Array.from(preview.querySelectorAll('mark')).map(mark => {
      const markStyle = getComputedStyle(mark)
      // Composite translucent mark/active-row surfaces against their actual
      // ancestors, instead of treating transparent backgrounds as white.
      const layers: number[][] = []
      for (let ancestor: Element | null = mark; ancestor; ancestor = ancestor.parentElement) {
        const background = rgba(getComputedStyle(ancestor).backgroundColor)
        layers.push(background)
        if (background[3] === 1) break
      }
      const opaqueSurface = layers.at(-1)?.[3] === 1
      const background = layers.reverse().reduce((back, front) => [...over(front, back), 1], [255, 255, 255, 1])
      const foreground = over(rgba(markStyle.color), background)
      const foregroundLight = luminance(foreground), backgroundLight = luminance(background)
      return { text: mark.textContent, color: markStyle.color, backgroundColor: markStyle.backgroundColor,
        fontWeight: parseFloat(markStyle.fontWeight), decorationLine: markStyle.textDecorationLine,
        opaqueSurface, effectiveBackground: background.slice(0, 3), effectiveForeground: foreground,
        contrast: (Math.max(foregroundLight, backgroundLight) + 0.05) / (Math.min(foregroundLight, backgroundLight) + 0.05) }
    })
    return { text, search, start, preview: bounds(preview.getBoundingClientRect()), clip, clipping,
      matchRects: Array.from(start < 0 ? [] : rangeFor(start, start + search.length)?.getClientRects() ?? []).map(bounds),
      glyphs, visibleGlyphs: glyphs.filter(glyph => glyph.visible).length,
      clientWidth: preview.clientWidth, scrollWidth: preview.scrollWidth, clientHeight: preview.clientHeight, scrollHeight: preview.scrollHeight,
      whiteSpace: style.whiteSpace, overflowWrap: style.overflowWrap, lineHeight: parseFloat(style.lineHeight),
      markCount: preview.querySelectorAll('mark').length, marks }
  }, search)
}

function expectVisibleMatch(geometry: Awaited<ReturnType<typeof previewGeometry>>, search: string) {
  expect(geometry.start).toBeGreaterThanOrEqual(0)
  expect(geometry.matchRects.length).toBeGreaterThan(0)
  expect(geometry.glyphs).toHaveLength(search.length)
  expect(geometry.visibleGlyphs).toBe(search.length)
}

function expectHighlightedMatch(geometry: Awaited<ReturnType<typeof previewGeometry>>, search: string) {
  expect(geometry.markCount).toBe(1)
  expect(geometry.marks).toHaveLength(1)
  const mark = geometry.marks[0]
  expect(mark.text).toBe(search)
  expect(mark.opaqueSurface).toBe(true)
  expect(mark.contrast).toBeGreaterThanOrEqual(4.5)
  expect(mark.fontWeight).toBeGreaterThanOrEqual(600)
  expect(mark.decorationLine).toContain('underline')
  expect(['normal', 'pre-wrap', 'pre-line']).toContain(geometry.whiteSpace)
  expect(geometry.overflowWrap).toBe('anywhere')
  expect(geometry.text.length).toBeLessThanOrEqual(122)
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1)
}

async function listGeometry(page: Page) {
  return controls(page).list.evaluate(element => ({ height: element.getBoundingClientRect().height,
    clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth, scrollTop: element.scrollTop, overflowY: getComputedStyle(element).overflowY,
    renderedItems: element.querySelectorAll('.block-find-result').length, viewportHeight: innerHeight }))
}

async function record(page: Page, app: ElectronApplication, testInfo: TestInfo, phase: string, geometry: unknown) {
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable(), bounds: window.getBounds()
  })))
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  const state = await page.evaluate(() => ({ viewport: { width: innerWidth, height: innerHeight },
    theme: document.documentElement.dataset.theme, activeTag: document.activeElement?.tagName,
    activeLabel: document.activeElement?.getAttribute('aria-label'), count: document.querySelector('.block-find-count')?.textContent,
    activeResult: document.querySelector('.block-find-result-active')?.getAttribute('data-result-index'),
    documentScrollTop: document.querySelector<HTMLElement>('[data-testid="document-scroll-region"]')?.scrollTop }))
  const body = JSON.stringify({ windows, state, geometry }, null, 2)
  writeFileSync(testInfo.outputPath(`${phase}.json`), body, 'utf8')
  await testInfo.attach(phase, { body, contentType: 'application/json' })
  await page.screenshot({ path: testInfo.outputPath(`${phase}.png`) })
}

async function expectSelected(page: Page, resultIndex: number) {
  const current = controls(page)
  await expect(current.input).toBeFocused()
  await expect(current.count).toHaveText(`${resultIndex + 1} / 3`)
  await expect(current.result(resultIndex)).toHaveClass(/block-find-result-active/)
  const row = page.locator(`.block-editor-row[data-block-index="${resultIndex * 2}"]`)
  await expect(row.locator('textarea')).toHaveValue(matchingContents[resultIndex])
  await expect.poll(() => row.evaluate(element => element.getBoundingClientRect().top
    - element.closest('.preview-panel')!.querySelector('.document-sticky-header')!.getBoundingClientRect().bottom)).toBeGreaterThanOrEqual(10)
  await expect.poll(() => row.evaluate(element => element.getBoundingClientRect().top
    - element.closest('.preview-panel')!.querySelector('.document-sticky-header')!.getBoundingClientRect().bottom)).toBeLessThan(20)
}

for (const language of ['en-US', 'zh-CN'] as const) {
  test(`find previews keep the matched text readable and keyboard navigation intact (${language}) @electron`, async ({}, testInfo) => {
    test.skip(!hasBuiltElectronApp(), 'Run npm run build first.')
    await withElectronApp(async ({ page, app }) => {
      const title = language === 'zh-CN' ? '查找摘要可读性样本' : 'Find preview readability sample'
      const denseTitle = language === 'zh-CN' ? '查找摘要密集匹配' : 'Find preview bounded match list'
      const blocks: DocumentBlockDraft[] = contents.map(content => ({ type: 'paragraph', content, checked: false, depth: 0 }))
      const denseBlocks: DocumentBlockDraft[] = Array.from({ length: 72 }, (_, index) => ({
        type: 'paragraph', content: `${index + 1}: ${matchingContents[index % 3]}`, checked: false, depth: 0
      }))
      const ids = await page.evaluate(async ({ language, title, denseTitle, blocks, denseBlocks }) => {
        await window.knowbook.saveSetting('ui.language', language)
        await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
        const primary = await window.knowbook.createDocument(null)
        await window.knowbook.updateDocument(primary.id, { title, summary: 'Literal matches late in unchanged text.', blocks })
        const dense = await window.knowbook.createDocument(null)
        await window.knowbook.updateDocument(dense.id, { title: denseTitle, summary: '', blocks: denseBlocks })
        return { primary: primary.id, dense: dense.id }
      }, { language, title, denseTitle, blocks, denseBlocks })
      await page.reload()
      await expect(page.getByTestId('shell')).toBeVisible()
      await page.setViewportSize({ width: 1180, height: 760 })
      await page.locator('.tree-button', { hasText: title }).first().focus()
      await page.keyboard.press('Enter')
      await expect(page.locator('.block-editor-row')).toHaveCount(contents.length)
      const before = await page.evaluate(async ids => ({ primary: await window.knowbook.getDocumentDetail(ids.primary),
        dense: await window.knowbook.getDocumentDetail(ids.dense) }), ids)
      expect(before.primary).not.toBeNull()
      expect(before.dense).not.toBeNull()
      await page.keyboard.press('Control+f')
      const current = controls(page)
      await expect(current.input).toBeFocused()
      await current.input.fill(longQuery)
      await expect(current.count).toHaveText('1 / 3')
      const supported = await previewGeometry(current.result(0), longQuery)
      await record(page, app, testInfo, 'supported-width-long-literal-query-before-visibility', supported)

      // Renderer-responsive 760px viewport; native minimum bounds are retained
      // and reported separately, without pretending the OS window was resized.
      await page.setViewportSize({ width: 760, height: language === 'zh-CN' ? 850 : 640 })
      await current.input.fill(query)
      await expect(current.input).toBeFocused()
      await expect(current.count).toHaveText('1 / 3')
      const narrow = await previewGeometry(current.result(0), query)
      const inactive = await previewGeometry(current.result(1), query)
      await record(page, app, testInfo, 'narrow-first-match-before-visibility', { ...narrow, inactiveMatch: inactive })
      // Both screenshots precede assertions: the baseline must prove actual
      // clipped glyphs, rather than merely the absence of a new mark element.
      expectVisibleMatch(supported, longQuery)
      expectVisibleMatch(narrow, query)
      expectHighlightedMatch(supported, longQuery)
      expectHighlightedMatch(narrow, query)
      expectHighlightedMatch(inactive, query)
      expect(narrow.preview.height).toBeGreaterThan(narrow.lineHeight * 1.5)
      expect(narrow.start).toBe(37) // leading ellipsis plus the preserved 36-character context
      await expect(current.panel.locator('.block-find-result')).toHaveCount(3)
      await page.keyboard.press('Enter'); await expectSelected(page, 0)
      await page.keyboard.press('Enter'); await expectSelected(page, 1)
      let geometry = await previewGeometry(current.result(1), query)
      await record(page, app, testInfo, 'second-english-match-selected', geometry)
      expectVisibleMatch(geometry, query)
      expectHighlightedMatch(geometry, query)
      await page.keyboard.press('Enter'); await expectSelected(page, 2)
      geometry = await previewGeometry(current.result(2), query)
      await record(page, app, testInfo, 'third-unbroken-match-selected', geometry)
      expectVisibleMatch(geometry, query)
      expectHighlightedMatch(geometry, query)

      // Activate a non-current result with genuine Tab/Space, then Enter.
      await page.keyboard.press('Tab'); await expect(current.previous).toBeFocused()
      await page.keyboard.press('Tab'); await expect(current.next).toBeFocused()
      await page.keyboard.press('Tab'); await expect(current.close).toBeFocused()
      await page.keyboard.press('Tab'); await expect(current.result(0)).toBeFocused()
      await page.keyboard.press('Space'); await expectSelected(page, 0)
      await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); await page.keyboard.press('Tab')
      await page.keyboard.press('Tab'); await page.keyboard.press('Tab')
      await expect(current.result(1)).toBeFocused()
      await page.keyboard.press('Enter'); await expectSelected(page, 1)
      await page.keyboard.press('Escape')
      await expect(current.panel).toHaveCount(0)
      await expect(page.locator('.document-navigation-bar').getByRole('button', { name: uiText('Find', '查找'), exact: true })).toBeFocused()

      await page.locator('.tree-button', { hasText: denseTitle }).first().focus()
      await page.keyboard.press('Enter')
      await expect(page.locator('.block-editor-row')).toHaveCount(denseBlocks.length)
      await page.keyboard.press('Control+f')
      await expect(current.input).toBeFocused()
      await current.input.fill(query)
      await expect(current.count).toHaveText('1 / 72')
      await expect(current.list.locator('.block-find-result')).toHaveCount(60)
      let list = await listGeometry(page)
      await record(page, app, testInfo, 'dense-results-bounded-before-navigation', list)
      expect(list.height).toBeLessThanOrEqual(Math.min(list.viewportHeight * 0.22, 170) + 1)
      expect(list.scrollHeight).toBeGreaterThan(list.clientHeight)
      expect(list.overflowY).toBe('auto')
      expect(list.scrollWidth).toBeLessThanOrEqual(list.clientWidth + 1)
      await page.keyboard.press('Shift+Enter')
      await expect(current.count).toHaveText('72 / 72')
      await expect(current.result(71)).toHaveClass(/block-find-result-active/)
      await expect(current.input).toBeFocused()
      list = await listGeometry(page)
      geometry = await previewGeometry(current.result(71), query)
      await record(page, app, testInfo, 'dense-last-current-match-readable', { list, preview: geometry })
      expect(list.renderedItems).toBeLessThanOrEqual(60)
      expect(list.height).toBeLessThanOrEqual(Math.min(list.viewportHeight * 0.22, 170) + 1)
      expect(list.scrollTop).toBeGreaterThan(0)
      expectVisibleMatch(geometry, query)
      expectHighlightedMatch(geometry, query)
      await page.keyboard.press('Enter')
      await expect(current.count).toHaveText('1 / 72')
      await expect(current.input).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(current.panel).toHaveCount(0)
      const after = await page.evaluate(async ids => ({ primary: await window.knowbook.getDocumentDetail(ids.primary),
        dense: await window.knowbook.getDocumentDetail(ids.dense) }), ids)
      expect(after).toEqual(before)
      await record(page, app, testInfo, 'preview-navigation-complete-content-unchanged', { list })
    })
  })
}
