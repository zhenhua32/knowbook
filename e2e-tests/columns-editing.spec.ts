import { expect, test, type Locator, type Page } from '@playwright/test'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { closeElectronApp, launchElectronApp, uiText } from './helpers/electron'

async function open(page: Page, title: string) {
  await page.locator('.tree-button', { hasText: title }).first().click()
  await expect(page.locator('.document-header-title')).toHaveText(title)
}
async function saved(page: Page, id: string) { return (await page.evaluate(id => window.knowbook.getDocumentDetail(id), id))!.blocks }
async function history(page: Page, action: 'Undo' | 'Redo') {
  await page.locator('.document-header-more-button').click()
  await page.locator('.document-header-action-menu').getByRole('button', { name: uiText(action, action === 'Undo' ? '撤销' : '重做'), exact: true }).click()
}
async function beginResize(page: Page, separator: Locator, amount: number) {
  await separator.scrollIntoViewIfNeeded()
  const box = await separator.boundingBox(); expect(box).not.toBeNull()
  const x = box!.x + box!.width / 2, y = box!.y + box!.height / 2
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + amount, y, { steps: 5 })
}

test('markdown public /columns preserves the empty host and explicitly added right-column text through reload @electron', async () => {
  test.setTimeout(120000)
  const context = await launchElectronApp({}, { editorMode: 'markdown' })
  try {
    const { page } = context, title = 'Source public slash columns', hostId = 'public-source-columns-host'
    const id = await page.evaluate(async ({ title, hostId }) => {
      const { id } = await window.knowbook.createDocument(null)
      await window.knowbook.updateDocument(id, { title, summary: '', blocks: [{ id: hostId,
        type: 'paragraph', content: '', checked: false, depth: 0, parentBlockId: null,
        tags: ['public-slash-host'], highlight: 'blue' }] })
      return id
    }, { title, hostId })
    await page.reload(); await open(page, title)
    const source = page.locator(`[data-block-id="${hostId}"] .block-inline-textarea`)
    await expect(source).toHaveValue('')
    await source.click(); await source.pressSequentially('/columns')
    const menu = page.locator('.floating-slash-command-panel')
    await expect(menu).toBeVisible()
    await expect(menu).toHaveAttribute('aria-busy', 'false')
    await expect(menu.locator('.slash-command-item-active .slash-command-id')).toHaveText('/columns')
    await expect(source).toBeFocused()
    await source.press('Enter')
    await expect(menu).toHaveCount(0)

    const group = page.locator(`[data-columns-group="${hostId}"]`), controls = group.locator('.columns-controls').first()
    await expect(controls).toBeVisible()
    await expect(group.locator(':scope > .document-columns-grid > .document-column')).toHaveCount(2)
    await expect(group.locator('.block-inline-textarea')).toHaveCount(0)
    await expect.poll(async () => (await saved(page, id)).map(block => block.type)).toEqual(['columns', 'column', 'column'])
    const emptyColumns = await saved(page, id)
    expect(emptyColumns[0]).toMatchObject({ id: hostId, type: 'columns', content: '', depth: 0, parentBlockId: null,
      tags: ['public-slash-host'], highlight: 'blue' })
    const [left, right] = emptyColumns.filter(block => block.type === 'column')
    expect(new Set(emptyColumns.map(block => block.id)).size).toBe(3)
    for (const column of [left, right]) expect(column).toMatchObject({ content: '', depth: 1,
      parentBlockId: hostId, markdownFormat: { columnWeight: 5000 } })
    expect(emptyColumns.filter(block => block.parentBlockId === left.id || block.parentBlockId === right.id)).toEqual([])

    await controls.getByRole('button', { name: uiText('Add content to column 2', '在第 2 列添加内容'), exact: true }).click()
    const leftCell = group.locator(`.document-column[data-column-id="${left.id}"]`)
    const rightCell = group.locator(`.document-column[data-column-id="${right.id}"]`)
    const addedInput = rightCell.locator('.block-inline-textarea')
    await expect(leftCell.locator('.block-inline-textarea')).toHaveCount(0)
    await expect(addedInput).toHaveCount(1)
    await expect(addedInput).toBeFocused()
    await expect(addedInput).toHaveValue('')
    await expect(addedInput).toHaveJSProperty('selectionStart', 0)
    await expect(addedInput).toHaveJSProperty('selectionEnd', 0)
    const paragraphId = await addedInput.evaluate(element => element.closest('[data-block-id]')!.getAttribute('data-block-id')!)
    expect(paragraphId).not.toBe('')
    expect(emptyColumns.some(block => block.id === paragraphId)).toBe(false)
    const content = 'Right column text after the public slash command'
    await page.keyboard.type(content)
    await expect(addedInput).toHaveValue(content)
    await page.locator('.document-header-save-button').click()
    await expect.poll(async () => (await saved(page, id)).find(block => block.id === paragraphId)?.content).toBe(content)
    const beforeReload = await saved(page, id)
    expect(beforeReload.map(block => block.type)).toEqual(['columns', 'column', 'column', 'paragraph'])
    expect(beforeReload.find(block => block.id === paragraphId)).toMatchObject({ type: 'paragraph', content,
      depth: 2, parentBlockId: right.id })
    expect(beforeReload.filter(block => block.parentBlockId === left.id)).toEqual([])
    expect(beforeReload.filter(block => block.parentBlockId === right.id).map(block => block.id)).toEqual([paragraphId])
    expect(beforeReload.find(block => block.id === hostId)).toMatchObject({ tags: ['public-slash-host'], highlight: 'blue' })

    await page.reload(); await open(page, title)
    await expect(controls).toBeVisible()
    await expect(group.locator('.document-column')).toHaveCount(2)
    await expect(leftCell.locator('.block-inline-textarea')).toHaveCount(0)
    await expect(rightCell.locator(`[data-block-id="${paragraphId}"] .block-inline-textarea`)).toHaveValue(content)
    expect(await saved(page, id)).toEqual(beforeReload)
  } finally { await closeElectronApp(context) }
})

for (const mode of ['markdown', 'rich'] as const) test(`${mode} columns share actual layout controls, stable subtrees, atomic history and reading layout @electron`, async () => {
  test.setTimeout(150000)
  const context = await launchElectronApp({}, { editorMode: mode })
  try {
    const { page } = context
    await page.setViewportSize({ width: 1440, height: 1120 })
    const title = `Columns ${mode}`, groupId = `columns-${mode}`, leftId = `left-${mode}`, rightId = `right-${mode}`
    const taskId = `task-${mode}`, childId = `child-${mode}`, rightTextId = `text-${mode}`
    const blocks: DocumentBlockDraft[] = [
      { id: groupId, type: 'columns', content: '', checked: false, depth: 0, parentBlockId: null, tags: ['group-tag'] },
      { id: leftId, type: 'column', content: '', checked: false, depth: 1, parentBlockId: groupId, markdownFormat: { columnWeight: 4000 } },
      { id: taskId, type: 'numbered-todo', content: 'Left task 😀', checked: true, depth: 2, parentBlockId: leftId,
        listStart: 4, markdownFormat: { listMarker: ')' }, tags: ['task-tag'], highlight: 'yellow' },
      { id: childId, type: 'todo', content: 'Nested child stays with task', checked: false, depth: 3, parentBlockId: taskId },
      { id: rightId, type: 'column', content: '', checked: false, depth: 1, parentBlockId: groupId, markdownFormat: { columnWeight: 6000 } },
      { id: rightTextId, type: 'paragraph', content: 'Right body text', checked: false, depth: 2, parentBlockId: rightId },
      { id: `tail-${mode}`, type: 'paragraph', content: 'After the columns', checked: false, depth: 0, parentBlockId: null }
    ]
    const id = await page.evaluate(async ({ title, blocks }) => {
      const { id } = await window.knowbook.createDocument(null)
      await window.knowbook.updateDocument(id, { title, summary: '', blocks }); return id
    }, { title, blocks })
    await page.reload(); await open(page, title)
    const group = page.locator(`[data-columns-group="${groupId}"]`), controls = group.locator('.columns-controls').first()
    await expect(controls).toBeVisible()
    const cells = group.locator(':scope > .document-columns-grid > .document-column, :scope > .columns-grid > .document-column')
    await expect(cells).toHaveCount(2)
    const left = await cells.nth(0).boundingBox(), right = await cells.nth(1).boundingBox()
    expect(left).not.toBeNull(); expect(right).not.toBeNull()
    expect(right!.x).toBeGreaterThan(left!.x + left!.width - 2)
    expect(Math.abs(right!.y - left!.y)).toBeLessThan(3)
    expect(Math.abs(left!.width / (left!.width + right!.width) - 0.4)).toBeLessThan(0.02)

    const original = await saved(page, id), ratio = controls.getByLabel(uiText('Column 1 width percent', '第 1 列宽度百分比'))
    if (mode === 'markdown') {
      const body = page.locator(`[data-block-id="${rightTextId}"] .block-inline-textarea`)
      await body.fill('Right body text edited')
      await expect.poll(async () => (await saved(page, id)).find(block => block.id === rightTextId)?.content).toBe('Right body text edited')
      await body.press('Control+z')
      await expect.poll(async () => (await saved(page, id)).find(block => block.id === rightTextId)?.content).toBe('Right body text')
      await body.press('Control+y')
      await expect.poll(async () => (await saved(page, id)).find(block => block.id === rightTextId)?.content).toBe('Right body text edited')
      await body.press('Control+z')
      await expect.poll(async () => (await saved(page, id)).find(block => block.id === rightTextId)?.content).toBe('Right body text')
    }
    await ratio.fill('35'); await ratio.press('Enter')
    await expect.poll(async () => (await saved(page, id)).filter(block => block.type === 'column').map(block => block.markdownFormat?.columnWeight)).toEqual([3500, 6500])
    await history(page, 'Undo')
    await expect.poll(async () => (await saved(page, id)).filter(block => block.type === 'column').map(block => block.markdownFormat?.columnWeight)).toEqual([4000, 6000])
    await history(page, 'Redo')
    await expect.poll(async () => (await saved(page, id)).filter(block => block.type === 'column').map(block => block.markdownFormat?.columnWeight)).toEqual([3500, 6500])
    const beforeResize = await saved(page, id), separator = controls.getByRole('separator', { name: uiText('Resize column 1', '调整第 1 列宽度') })
    await beginResize(page, separator, 45)
    await expect(controls).toHaveAttribute('data-columns-gesture', 'preview')
    expect((await saved(page, id)).filter(block => block.type === 'column').map(block => block.markdownFormat?.columnWeight)).toEqual([3500, 6500])
    await page.keyboard.press('Escape'); await page.mouse.up()
    await expect(controls).not.toHaveAttribute('data-columns-gesture', 'preview')
    await page.locator('.document-header-save-button').click()
    expect(await saved(page, id)).toEqual(beforeResize)
    await beginResize(page, separator, 45); await page.mouse.up()
    await expect.poll(async () => (await saved(page, id)).find(block => block.id === leftId)?.markdownFormat?.columnWeight).toBeGreaterThan(3500)
    const resized = await saved(page, id)
    expect(resized.filter(block => block.type === 'column').reduce((sum, block) => sum + block.markdownFormat!.columnWeight!, 0)).toBe(10000)
    await history(page, 'Undo')
    await expect.poll(async () => (await saved(page, id)).filter(block => block.type === 'column').map(block => block.markdownFormat?.columnWeight)).toEqual([3500, 6500])
    await history(page, 'Redo')
    await expect.poll(async () => (await saved(page, id)).filter(block => block.type === 'column').map(block => block.markdownFormat?.columnWeight))
      .toEqual(resized.filter(block => block.type === 'column').map(block => block.markdownFormat?.columnWeight))

    await controls.getByRole('button', { name: uiText('Move column 2 left', '第 2 列左移') }).click()
    await expect.poll(async () => (await saved(page, id)).filter(block => block.type === 'column').map(block => block.id)).toEqual([rightId, leftId])
    await history(page, 'Undo')
    await expect.poll(async () => (await saved(page, id)).filter(block => block.type === 'column').map(block => block.id)).toEqual([leftId, rightId])
    await controls.getByRole('button', { name: uiText('Drag column 2', '拖动第 2 列') }).dragTo(controls.locator('.column-tools').nth(0))
    await expect.poll(async () => (await saved(page, id)).filter(block => block.type === 'column').map(block => block.id)).toEqual([rightId, leftId])
    await history(page, 'Undo')
    await expect.poll(async () => (await saved(page, id)).filter(block => block.type === 'column').map(block => block.id)).toEqual([leftId, rightId])
    for (const contentId of [taskId, childId, rightTextId]) expect((await saved(page, id)).find(block => block.id === contentId))
      .toEqual(original.find(block => block.id === contentId))

    await controls.getByRole('button', { name: uiText('Add column', '添加列'), exact: true }).click()
    await expect.poll(async () => (await saved(page, id)).filter(block => block.type === 'column').length).toBe(3)
    const addedId = (await saved(page, id)).filter(block => block.type === 'column').at(-1)!.id
    expect((await saved(page, id)).filter(block => block.parentBlockId === addedId)).toEqual([])
    await controls.getByRole('button', { name: uiText('Add content to column 3', '在第 3 列添加内容') }).click()
    await expect.poll(async () => (await saved(page, id)).filter(block => block.parentBlockId === addedId).length).toBe(1)
    const added = (await saved(page, id)).find(block => block.parentBlockId === addedId)!
    expect(added.type).toBe('paragraph'); expect(added.content).toBe('')
    await controls.getByRole('button', { name: uiText('Remove column 3 and keep content', '移除第 3 列并保留内容') }).click()
    await expect.poll(async () => (await saved(page, id)).filter(block => block.type === 'column').length).toBe(2)
    expect((await saved(page, id)).find(block => block.id === added.id)?.parentBlockId).toBe(rightId)
    await page.locator('.document-header-save-button').click(); await page.reload(); await open(page, title)
    await expect(group.locator('.document-column')).toHaveCount(2)
    await expect(controls).toBeVisible()
    await page.screenshot({ path: `test-results/stage6/columns-${mode}.png`, fullPage: true })
    await page.locator('.document-view-toggle').click()
    await expect(group.locator('.columns-controls')).toHaveCount(0)
    const readingCells = group.locator(':scope > .document-columns-grid > .document-column')
    await expect(readingCells).toHaveCount(2)
    await expect(readingCells.nth(0)).toContainText('Left task')
    await expect(readingCells.nth(1)).toContainText('Right body text')
    const readingLeft = await readingCells.nth(0).boundingBox(), readingRight = await readingCells.nth(1).boundingBox()
    expect(readingRight!.x).toBeGreaterThan(readingLeft!.x + readingLeft!.width - 2)
    await page.locator('.document-view-toggle').click()
    await controls.getByRole('button', { name: uiText('Unwrap columns, keep content', '取消分栏，保留内容') }).click()
    await expect.poll(async () => (await saved(page, id)).some(block => block.type === 'column' || block.type === 'columns')).toBe(false)
    const unwrapped = await saved(page, id)
    expect(unwrapped.find(block => block.id === childId)?.parentBlockId).toBe(taskId)
    expect(unwrapped.find(block => block.id === taskId)?.tags).toEqual(['task-tag'])
    expect(unwrapped.find(block => block.id === taskId)?.checked).toBe(true)
    await history(page, 'Undo')
    await expect(controls).toBeVisible()
    await expect.poll(async () => (await saved(page, id)).filter(block => block.type === 'column').length).toBe(2)
  } finally { await closeElectronApp(context) }
})
