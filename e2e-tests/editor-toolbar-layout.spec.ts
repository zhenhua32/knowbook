import { expect, test, type Locator, type Page } from '@playwright/test'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { uiText, withElectronApp } from './helpers/electron'

const paragraph = (id: string, content: string): DocumentBlockDraft => ({ id, type: 'paragraph', content, checked: false, depth: 0 })
async function openEditor(page: Page, title: string, blocks: DocumentBlockDraft[]) {
  const id = await page.evaluate(async ({ title, blocks }) => {
    const { id } = await window.knowbook.createDocument(null)
    await window.knowbook.updateDocument(id, { title, summary: '', blocks })
    return id
  }, { title, blocks })
  await page.reload()
  await page.locator('.tree-button', { hasText: title }).first().click()
  await expect(page.locator('.block-editor-row')).toHaveCount(blocks.length)
  return id
}
async function select(input: Locator, start: number, end = start) {
  await input.focus()
  await input.evaluate((element, { start, end }) => {
    const textarea = element as HTMLTextAreaElement
    textarea.setSelectionRange(start, end)
    textarea.dispatchEvent(new Event('select', { bubbles: true }))
  }, { start, end })
}
const toolbar = (input: Locator) => input.locator('..').locator(':scope > .markdown-format-toolbar')
async function rectangles(page: Page) {
  return page.locator('textarea.block-inline-textarea').evaluateAll(inputs => inputs.map(input => {
    const rect = input.getBoundingClientRect()
    return [rect.x, rect.y, rect.width, rect.height]
  }))
}
async function settled(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}
async function expectFloatingControls(input: Locator, avoidWholeTextarea = true) {
  await expect(toolbar(input)).toBeVisible()
  const geometry = await input.evaluate(element => {
    const input = element as HTMLTextAreaElement
    const toolbar = input.parentElement!.querySelector<HTMLElement>(':scope > .markdown-format-toolbar')!
    const panel = input.closest<HTMLElement>('.preview-panel')!
    const copy = (element: Element) => {
      const { top, bottom, left, right, width, height } = element.getBoundingClientRect()
      return { top, bottom, left, right, width, height }
    }
    const viewport = copy(panel)
    viewport.top = Math.max(0, viewport.top + panel.clientTop)
    viewport.bottom = Math.min(innerHeight, viewport.top + panel.clientHeight)
    viewport.left = Math.max(0, viewport.left + panel.clientLeft)
    viewport.right = Math.min(innerWidth, viewport.left + panel.clientWidth)
    return { input: copy(input), column: copy(input.parentElement!), toolbar: copy(toolbar), viewport,
      controls: [...toolbar.querySelectorAll('button')].map(button => {
        const box = copy(button)
        const hit = document.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2)
        return { box, hit: hit === button || button.contains(hit) }
      }) }
  })
  expect(geometry.toolbar.left).toBeGreaterThanOrEqual(geometry.column.left - 1)
  expect(geometry.toolbar.right).toBeLessThanOrEqual(Math.min(geometry.column.right, geometry.viewport.right) + 1)
  expect(geometry.toolbar.top).toBeGreaterThanOrEqual(geometry.viewport.top - 1)
  expect(geometry.toolbar.bottom).toBeLessThanOrEqual(geometry.viewport.bottom + 1)
  if (avoidWholeTextarea) {
    expect(geometry.toolbar.bottom <= geometry.input.top - 2 || geometry.toolbar.top >= geometry.input.bottom + 2,
      'the toolbar leaves the active text clear').toBe(true)
  }
  expect(geometry.controls).toHaveLength(9)
  for (const control of geometry.controls) {
    expect(control.hit, 'every format button remains a clickable native hit target').toBe(true)
    expect(control.box.left).toBeGreaterThanOrEqual(geometry.toolbar.left - 1)
    expect(control.box.right).toBeLessThanOrEqual(geometry.toolbar.right + 1)
    expect(control.box.top).toBeGreaterThanOrEqual(geometry.toolbar.top - 1)
    expect(control.box.bottom).toBeLessThanOrEqual(geometry.toolbar.bottom + 1)
  }
  return geometry
}

for (const width of [1040, 760]) {
  test(`activating block format toolbars keeps textarea geometry and reversible Unicode selections at ${width}px @electron`, async () => {
    await withElectronApp(async ({ app, page }) => {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 700), width)
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
      const id = await openEditor(page, `Stable block toolbar ${width}`, [paragraph('first', 'Draft 中文 😀 text'),
        paragraph('second', 'Second text'), paragraph('third', 'Third text'), paragraph('fourth', 'Fourth text')])
      const first = page.locator('[data-block-id="first"] textarea')
      await first.focus()
      await expect(toolbar(first)).toBeVisible()
      await settled(page)
      const baseline = await rectangles(page)
      for (const blockId of ['second', 'third', 'first', 'fourth', 'first']) {
        const input = page.locator(`[data-block-id="${blockId}"] textarea`)
        await input.focus()
        await expect(toolbar(input)).toBeVisible()
        await settled(page)
        expect(await rectangles(page)).toEqual(baseline)
        await input.press('Alt+F10')
        await expect(toolbar(input).getByRole('button', { name: uiText('Bold', '粗体'), exact: true })).toBeFocused()
        await page.keyboard.press('Escape')
        await expect(input).toBeFocused()
        await input.press('Shift+Tab')
        await expect(toolbar(input).getByRole('button', { name: uiText('Background color', '背景颜色'), exact: true })).toBeFocused()
        await page.keyboard.press('Escape')
        await expect(input).toBeFocused()
        expect(await rectangles(page)).toEqual(baseline)
      }
      await select(first, 6, 11)
      await expectFloatingControls(first)
      await toolbar(first).getByRole('button', { name: uiText('Bold', '粗体'), exact: true }).click()
      await expect(first).toHaveValue('Draft **中文 😀** text')
      await expect(first).toBeFocused()
      expect(await first.evaluate(element => [(element as HTMLTextAreaElement).selectionStart, (element as HTMLTextAreaElement).selectionEnd])).toEqual([8, 13])
      await first.press('Control+z')
      await expect(first).toHaveValue('Draft 中文 😀 text')
      expect(await first.evaluate(element => [(element as HTMLTextAreaElement).selectionStart, (element as HTMLTextAreaElement).selectionEnd])).toEqual([6, 11])
      await first.press('Control+Shift+z')
      await expect(first).toHaveValue('Draft **中文 😀** text')
      await expect.poll(() => page.evaluate(async id => (await window.knowbook.getDocumentDetail(id))?.blocks[0].content, id))
        .toBe('Draft **中文 😀** text')
    })
  })
}

test('block format toolbar remains visible and clickable at scroll edges and in a narrow depth-six column @electron', async () => {
  await withElectronApp(async ({ app, page }) => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(760, 700))
    const blocks = Array.from({ length: 60 }, (_, index) => paragraph(`p-${index}`, `Paragraph ${index}`))
    for (let depth = 0; depth <= 6; depth++) blocks.push({ id: `deep-${depth}`, type: 'bulleted-list', content: `Depth ${depth}`,
      checked: false, depth, parentBlockId: depth ? `deep-${depth - 1}` : null })
    blocks.push(paragraph('after', 'After'))
    await openEditor(page, 'Format toolbar edges', blocks)
    const input = page.locator('[data-block-id="p-40"] textarea')
    await input.focus()
    for (const edge of ['top', 'bottom'] as const) {
      await select(input, 'Paragraph 40'.length)
      await input.evaluate((element, edge) => {
        const panel = element.closest<HTMLElement>('.preview-panel')!
        const bounds = panel.getBoundingClientRect()
        const input = element.getBoundingClientRect()
        panel.scrollTop += edge === 'top' ? input.top - bounds.top - 2 : input.bottom - Math.min(bounds.bottom, innerHeight) + 2
      }, edge)
      await settled(page)
      await expectFloatingControls(input)
      await toolbar(input).getByRole('button', { name: uiText('Bold', '粗体'), exact: true }).click()
      await expect(input).toHaveValue('Paragraph 40****')
      await input.press('Control+z')
      await expect(input).toHaveValue('Paragraph 40')
    }
    const deep = page.locator('[data-block-id="deep-6"] textarea')
    await select(deep, 0, 5)
    await settled(page)
    await expectFloatingControls(deep)
    await toolbar(deep).getByRole('button', { name: uiText('Italic', '斜体'), exact: true }).click()
    await expect(deep).toHaveValue('*Depth* 6')
    await deep.press('Control+z')
    await expect(deep).toHaveValue('Depth 6')
  })
})

test('long-paragraph toolbar avoids the visible caret line while table controls retain their own layout @electron', async () => {
  await withElectronApp(async ({ page }) => {
    const text = Array.from({ length: 80 }, (_, index) => `Long line ${index}`).join('\n')
    await openEditor(page, 'Long paragraph format layout', [paragraph('long', text),
      { id: 'table', type: 'table', content: '| Name | Value |\n| --- | --- |\n| Alpha | Beta |', checked: false, depth: 0 }])
    const input = page.locator('[data-block-id="long"] textarea')
    await select(input, 0)
    await input.evaluate(element => {
      const panel = element.closest<HTMLElement>('.preview-panel')!
      panel.scrollTop += element.getBoundingClientRect().top - panel.getBoundingClientRect().top - 2
    })
    await settled(page)
    const geometry = await expectFloatingControls(input, false)
    expect(geometry.toolbar.top).toBeGreaterThan(geometry.input.top + 28)
    const tableRow = page.locator('[data-block-id="table"]')
    await tableRow.scrollIntoViewIfNeeded()
    const firstCell = tableRow.locator('th[data-row="0"][data-column="0"]')
    await firstCell.click()
    await expect(firstCell.locator('textarea')).toBeFocused()
    const tools = tableRow.locator('.markdown-table-tools .markdown-format-toolbar')
    await expect(tools).toBeVisible()
    expect(await tools.evaluate(element => getComputedStyle(element).position)).toBe('static')
    expect(await tools.evaluate(element => (element as HTMLElement).style.top)).toBe('')
  })
})
