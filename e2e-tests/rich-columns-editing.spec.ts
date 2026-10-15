import { expect, test, type Page } from '@playwright/test'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { closeElectronApp, launchElectronApp, uiText } from './helpers/electron'
import { setRichTextDomSelection } from './helpers/rich-text-selection'

const editor = (page: Page) => page.locator('.knowbook-rich-text-editor')
const row = (page: Page, id: string) => editor(page).locator(`[data-block-id="${id}"]`).first()
async function open(page: Page, title: string) {
  await page.locator('.tree-button', { hasText: title }).first().click()
  await expect(page.locator('.document-header-title')).toHaveText(title)
}
async function saved(page: Page, id: string) {
  return page.evaluate(async id => (await window.knowbook.getDocumentDetail(id))!.blocks.map(block => ({
    id: block.id, type: block.type, content: block.content, depth: block.depth, parentBlockId: block.parentBlockId ?? null,
    checked: block.checked, markdownFormat: block.markdownFormat ?? null, listStart: block.listStart ?? null,
    language: block.language ?? null, tags: block.tags ?? [], highlight: block.highlight ?? null
  })), id)
}
async function seed(page: Page, title: string, blocks: DocumentBlockDraft[]) {
  const id = await page.evaluate(async ({ title, blocks }) => {
    const { id } = await window.knowbook.createDocument(null)
    await window.knowbook.updateDocument(id, { title, summary: '', blocks }); return id
  }, { title, blocks })
  await page.reload(); await open(page, title)
  return id
}
async function select(page: Page, from: string, start: number, to = from, end = start, backward = false) {
  await editor(page).evaluate(setRichTextDomSelection, { from: { blockId: from, offset: start }, to: { blockId: to, offset: end }, backward })
}

test('rich nested columns retain cross-column selection, table portal history, mixed subtree moves and fold bookmarks @electron', async ({}, info) => {
  test.setTimeout(150000)
  const context = await launchElectronApp({}, { editorMode: 'rich' })
  try {
    const { page } = context
    await page.setViewportSize({ width: 1450, height: 1100 })
    const title = 'Rich columns shared editor', group = 'rich-columns-group', left = 'rich-columns-left', right = 'rich-columns-right'
    const alpha = 'rich-columns-alpha', beta = 'rich-columns-beta', tableId = 'rich-columns-table', toggle = 'rich-columns-toggle', child = 'rich-columns-child'
    const blocks: DocumentBlockDraft[] = [
      { id: group, type: 'columns', content: '', checked: false, depth: 0 },
      { id: left, type: 'column', content: '', checked: false, depth: 1, parentBlockId: group, markdownFormat: { columnWeight: 4000 } },
      { id: alpha, type: 'paragraph', content: 'Alpha😀Tail', checked: false, depth: 2, parentBlockId: left, tags: ['private-alpha'], highlight: 'blue' },
      { id: tableId, type: 'table', content: '| A | B |\n| - | - |\n| 中文😀 alpha | second |', checked: false, depth: 2, parentBlockId: left, tags: ['table-tag'] },
      { id: right, type: 'column', content: '', checked: false, depth: 1, parentBlockId: group, markdownFormat: { columnWeight: 6000 } },
      { id: beta, type: 'paragraph', content: 'Beta😀End', checked: false, depth: 2, parentBlockId: right },
      { id: toggle, type: 'toggle', content: 'Details', checked: false, depth: 2, parentBlockId: right, markdownFormat: { toggleDefaultOpen: true } },
      { id: child, type: 'paragraph', content: 'Child😀Tail', checked: false, depth: 3, parentBlockId: toggle, tags: ['child-tag'] }
    ]
    const id = await seed(page, title, blocks), original = await saved(page, id)
    await expect(editor(page)).toHaveCount(1)
    await expect(row(page, tableId).locator('.markdown-table-editor')).toBeVisible()
    const geometry = await page.evaluate(({ left, right }) => {
      const a = document.querySelector(`[data-block-id="${left}"]`)!.getBoundingClientRect()
      const b = document.querySelector(`[data-block-id="${right}"]`)!.getBoundingClientRect()
      return { left: a.x, right: b.x, firstTop: a.y, secondTop: b.y, firstWidth: a.width, secondWidth: b.width }
    }, { left, right })
    expect(geometry.right).toBeGreaterThan(geometry.left + geometry.firstWidth - 2)
    expect(Math.abs(geometry.firstTop - geometry.secondTop)).toBeLessThan(2)
    expect(geometry.firstWidth / geometry.secondWidth).toBeCloseTo(2 / 3, 1)

    await select(page, alpha, 5, beta, 4, true)
    await page.keyboard.press('Control+b')
    await expect.poll(async () => (await saved(page, id)).find(block => block.id === alpha)!.content).toContain('**😀Tail**')
    await expect.poll(async () => (await saved(page, id)).find(block => block.id === beta)!.content).toContain('**Beta**')
    await page.keyboard.press('Control+z')
    await expect.poll(() => saved(page, id)).toEqual(original)
    expect(await editor(page).evaluate(() => {
      const selection = window.getSelection()!
      return { anchor: selection.anchorNode?.parentElement?.closest('[data-block-id]')?.getAttribute('data-block-id'),
        head: selection.focusNode?.parentElement?.closest('[data-block-id]')?.getAttribute('data-block-id') }
    })).toEqual({ anchor: beta, head: alpha })

    const table = row(page, tableId).locator('.markdown-table-editor')
    await table.locator('[data-row="1"][data-column="0"]').click()
    const input = table.locator('textarea')
    await input.evaluate((input: HTMLTextAreaElement) => { input.focus(); input.setSelectionRange(0, 4, 'backward') })
    await input.press('Control+b')
    await expect.poll(async () => (await saved(page, id)).find(block => block.id === tableId)!.content).toContain('**中文😀** alpha')
    await input.press('Control+z')
    await expect.poll(() => saved(page, id)).toEqual(original)
    await expect(input).toBeFocused()
    expect(await input.evaluate((input: HTMLTextAreaElement) => [input.selectionStart, input.selectionEnd, input.selectionDirection])).toEqual([0, 4, 'backward'])

    await select(page, alpha, 2)
    await page.getByLabel(uiText('Move to column', '移动到列'), { exact: true }).selectOption(right)
    await expect.poll(async () => (await saved(page, id)).find(block => block.id === alpha)!.parentBlockId).toBe(right)
    expect((await saved(page, id)).find(block => block.id === alpha)!.tags).toEqual(['private-alpha'])
    await editor(page).focus(); await page.keyboard.press('Control+z')
    await expect.poll(() => saved(page, id)).toEqual(original)
    await page.keyboard.press('Control+y')
    await expect.poll(async () => (await saved(page, id)).find(block => block.id === alpha)!.parentBlockId).toBe(right)
    await page.keyboard.press('Control+z')
    await expect.poll(() => saved(page, id)).toEqual(original)

    await select(page, child, 5, child, 7, true)
    const collapse = row(page, toggle).getByRole('button', { name: uiText('Collapse block', '折叠块') })
    await collapse.click()
    await expect(row(page, child)).toBeHidden()
    await row(page, toggle).getByRole('button', { name: uiText('Expand block', '展开块') }).click()
    await expect(row(page, child)).toBeVisible()
    expect(await editor(page).evaluate(() => window.getSelection()?.toString())).toBe('😀')
    await expect.poll(() => saved(page, id)).toEqual(original)
    await page.screenshot({ path: info.outputPath('rich-columns-mixed.png'), fullPage: true })
  } finally { await closeElectronApp(context) }
})

test('rich columns create through the public toolbar and accept a real IME composition in an explicitly added empty column @electron', async () => {
  test.setTimeout(120000)
  const context = await launchElectronApp({}, { editorMode: 'rich' })
  try {
    const { page } = context, title = 'Rich columns IME'
    const id = await seed(page, title, [{ id: 'rich-columns-seed', type: 'paragraph', content: 'Keep source identity', checked: false, depth: 0, tags: ['keep'] }])
    await select(page, 'rich-columns-seed', 3)
    await page.getByRole('button', { name: uiText('Columns', '分栏'), exact: true }).click()
    await expect.poll(async () => (await saved(page, id)).filter(block => block.type === 'columns').length).toBe(1)
    let stored = await saved(page, id)
    const columns = stored.filter(block => block.type === 'column')
    expect(columns.map(block => block.markdownFormat?.columnWeight)).toEqual([5000, 5000])
    expect(stored.find(block => block.id === 'rich-columns-seed')!.parentBlockId).toBe(columns[0].id)
    expect(stored.some(block => block.parentBlockId === columns[1].id)).toBe(false)
    await page.getByRole('button', { name: uiText('Add content to column 2', '在第 2 列添加内容'), exact: true }).click()
    await expect.poll(async () => (await saved(page, id)).filter(block => block.parentBlockId === columns[1].id).length).toBe(1)
    stored = await saved(page, id)
    const added = stored.find(block => block.parentBlockId === columns[1].id)!
    await expect(editor(page)).toBeFocused()
    expect(await editor(page).evaluate(() => {
      const selection = window.getSelection()!
      const anchor = selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode?.parentElement
      const block = anchor?.closest('[data-block-id]')
      const range = document.createRange()
      range.selectNodeContents(block!); range.setEnd(selection.anchorNode!, selection.anchorOffset)
      const content = range.cloneContents()
      content.querySelectorAll('[contenteditable="false"]').forEach(element => element.remove())
      return { blockId: block?.getAttribute('data-block-id'), offset: content.textContent?.length ?? 0, collapsed: selection.isCollapsed }
    })).toEqual({ blockId: added.id, offset: 0, collapsed: true })
    const cdp = await page.context().newCDPSession(page)
    try {
      await cdp.send('Input.imeSetComposition', { text: '中文输入', selectionStart: 4, selectionEnd: 4 })
      await expect(row(page, added.id)).toContainText('中文输入')
      await cdp.send('Input.insertText', { text: '中文输入' })
    } finally { await cdp.detach() }
    await expect.poll(async () => (await saved(page, id)).find(block => block.id === added.id)!.content).toBe('中文输入')
    expect((await saved(page, id)).filter(block => block.parentBlockId === columns[1].id).map(block => block.id)).toEqual([added.id])
    expect((await saved(page, id)).find(block => block.id === 'rich-columns-seed')!.tags).toEqual(['keep'])
    await page.locator('.document-header-save-button').click()
    const beforeReload = await saved(page, id)
    await page.reload(); await open(page, title)
    await expect(row(page, added.id)).toContainText('中文输入')
    expect(await saved(page, id)).toEqual(beforeReload)
  } finally { await closeElectronApp(context) }
})
