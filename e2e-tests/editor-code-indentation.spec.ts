import { expect, test, type Locator, type Page } from '@playwright/test'
import { withElectronApp } from './helpers/electron'

const editor = (page: Page) => page.locator('[data-block-id="indent-code"] textarea.block-inline-textarea')
async function openCode(page: Page, title: string, content: string) {
  const id = await page.evaluate(async ({ title, content }) => {
    const { id } = await window.knowbook.createDocument(null)
    await window.knowbook.updateDocument(id, { title, summary: '', blocks: [
      { id: 'indent-code', type: 'code', content, language: 'python', depth: 0, checked: false,
        tags: ['source'], highlight: 'yellow' },
      { id: 'indent-after', type: 'paragraph', content: 'Keep this block', depth: 0, checked: false }
    ] })
    return id
  }, { title, content })
  await page.reload()
  await page.locator('.tree-button', { hasText: title }).first().click()
  await expect(page.locator('.block-editor-row')).toHaveCount(2)
  return id
}
async function select(input: Locator, start: number, end = start, direction: 'forward' | 'backward' | 'none' = 'none') {
  await input.focus()
  await input.evaluate((element: HTMLTextAreaElement, { start, end, direction }) => {
    element.setSelectionRange(start, end, direction)
    element.dispatchEvent(new Event('select', { bubbles: true }))
  }, { start, end, direction })
}
async function expectSelection(input: Locator, start: number, end: number, direction?: 'forward' | 'backward') {
  await expect(input).toBeFocused()
  expect(await input.evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd])).toEqual([start, end])
  if (direction) expect(await input.evaluate((element: HTMLTextAreaElement) => element.selectionDirection)).toBe(direction)
}
async function read(page: Page, id: string) {
  return page.evaluate(async id => (await window.knowbook.getDocumentDetail(id))!.blocks.map(
    ({ id, type, content, language, tags, highlight, depth, checked }) => ({ id, type, content, language, tags, highlight, depth, checked })), id)
}

test('code indentation keeps backwards Unicode selections and separate undo steps through save and reload @electron', async () => {
  await withElectronApp(async ({ page }) => {
    const title = 'Code indentation keeps selected source'
    const original = 'one 中文 😀\ntwo()\nthree'
    const once = '  one 中文 😀\n  two()\nthree'
    const twice = '    one 中文 😀\n    two()\nthree'
    const id = await openCode(page, title, original)
    const before = await read(page, id)
    const input = editor(page)
    await select(input, 4, 15, 'backward')
    await page.keyboard.press('Tab')
    await expect(input).toHaveValue(once)
    await expectSelection(input, 6, 19, 'backward')
    await page.keyboard.press('Tab')
    await expect(input).toHaveValue(twice)
    await expectSelection(input, 8, 23, 'backward')
    await page.keyboard.press('Control+z')
    await expect(input).toHaveValue(once)
    await expectSelection(input, 6, 19, 'backward')
    await page.keyboard.press('Control+z')
    await expect(input).toHaveValue(original)
    await expectSelection(input, 4, 15, 'backward')
    await page.keyboard.press('Control+Shift+z')
    await expect(input).toHaveValue(once)
    await expectSelection(input, 6, 19, 'backward')
    await page.keyboard.press('Control+Shift+z')
    await expect(input).toHaveValue(twice)
    await page.keyboard.press('Shift+Tab')
    await expect(input).toHaveValue(once)
    await expectSelection(input, 6, 19, 'backward')
    const after = before.map(block => block.id === 'indent-code' ? { ...block, content: once } : block)
    await expect.poll(() => read(page, id)).toEqual(after)
    await page.reload()
    await page.locator('.tree-button', { hasText: title }).first().click()
    await expect(editor(page)).toHaveValue(once)
    expect(await read(page, id)).toEqual(after)
  })
})

test('code indentation excludes a following line at column zero and a no-op outdent keeps redo @electron', async () => {
  await withElectronApp(async ({ page }) => {
    const original = 'one\ntwo\nthree'
    await openCode(page, 'Code indentation line boundary and redo', original)
    const input = editor(page)
    await select(input, 0, 4, 'backward')
    await page.keyboard.press('Tab')
    await expect(input).toHaveValue('  one\ntwo\nthree')
    await expectSelection(input, 2, 6, 'backward')
    await page.keyboard.press('Control+z')
    await expect(input).toHaveValue(original)
    await expectSelection(input, 0, 4, 'backward')
    await page.keyboard.press('Shift+Tab')
    await expect(input).toHaveValue(original)
    await expectSelection(input, 0, 4, 'backward')
    await page.keyboard.press('Control+Shift+z')
    await expect(input).toHaveValue('  one\ntwo\nthree')
    await expectSelection(input, 2, 6, 'backward')
  })
})

test('code outdent handles tabs and partial space indentation while caret Tab remains an insertion @electron', async () => {
  await withElectronApp(async ({ page }) => {
    const original = '  alpha()\n\tbeta()\n gamma()\nzero()'
    await openCode(page, 'Code indentation with mixed whitespace', original)
    const input = editor(page)
    await select(input, 14)
    await page.keyboard.press('Shift+Tab')
    await expect(input).toHaveValue('  alpha()\nbeta()\n gamma()\nzero()')
    await expectSelection(input, 13, 13)
    await page.keyboard.press('Tab')
    await expect(input).toHaveValue('  alpha()\nbet  a()\n gamma()\nzero()')
    await expectSelection(input, 15, 15)
    await page.keyboard.press('Control+z')
    await expect(input).toHaveValue('  alpha()\nbeta()\n gamma()\nzero()')
    await expectSelection(input, 13, 13)
    await page.keyboard.press('Control+z')
    await expect(input).toHaveValue(original)
    await expectSelection(input, 14, 14)
    await select(input, 0, original.length, 'backward')
    await page.keyboard.press('Shift+Tab')
    const outdented = 'alpha()\nbeta()\ngamma()\nzero()'
    await expect(input).toHaveValue(outdented)
    await expectSelection(input, 0, outdented.length, 'backward')
    await page.keyboard.press('Control+z')
    await expect(input).toHaveValue(original)
    await expectSelection(input, 0, original.length, 'backward')
  })
})

test('typing immediately after code indentation restores the new backward selection on undo @electron', async () => {
  await withElectronApp(async ({ page }) => {
    await openCode(page, 'Code indentation and subsequent typing history', 'abcd')
    const input = editor(page)
    await select(input, 1)
    await page.keyboard.press('Tab')
    await expect(input).toHaveValue('a  bcd')
    await select(input, 4, 6, 'backward')
    await page.keyboard.type('X')
    await expect(input).toHaveValue('a  bX')
    await expectSelection(input, 5, 5)
    await page.keyboard.press('Control+z')
    await expect(input).toHaveValue('a  bcd')
    await expectSelection(input, 4, 6, 'backward')
    await page.keyboard.press('Control+z')
    await expect(input).toHaveValue('abcd')
    await expectSelection(input, 1, 1)
    await page.keyboard.press('Control+Shift+z')
    await expect(input).toHaveValue('a  bcd')
    await expectSelection(input, 4, 6, 'backward')
    await page.keyboard.press('Control+Shift+z')
    await expect(input).toHaveValue('a  bX')
    await expectSelection(input, 5, 5)
  })
})

test('literal source indentation preserves math HTML frontmatter and table contents through history and reload @electron', async () => {
  await withElectronApp(async ({ page }) => {
    const title = 'Literal source indentation keeps all source blocks'
    const sources = [
      { type: 'math' as const, content: 'x + y\n= z' },
      { type: 'html' as const, content: '<div>\n  <p>Keep 中文 😀</p>\n</div>' },
      { type: 'frontmatter' as const, content: 'tags:\n  - keep' },
      { type: 'table' as const, content: '| Name |\n| --- |\n| Keep |' }
    ]
    const id = await page.evaluate(async ({ title, sources }) => {
      const { id } = await window.knowbook.createDocument(null)
      await window.knowbook.updateDocument(id, { title, summary: '', blocks: sources.map(source => ({
        id: `indent-${source.type}`, ...source, depth: 0, checked: false,
        tags: ['source'], highlight: 'yellow' as const
      })) })
      return id
    }, { title, sources })
    await page.reload()
    await page.locator('.tree-button', { hasText: title }).first().click()
    await expect(page.locator('.block-editor-row')).toHaveCount(sources.length)
    const before = await read(page, id)
    for (const source of sources) {
      const row = page.locator(`[data-block-id="indent-${source.type}"]`)
      if (source.type === 'table') await row.locator('.markdown-table-source summary').click()
      const input = row.locator('textarea.block-inline-textarea')
      const indented = source.content.split('\n').map(line => `  ${line}`).join('\n')
      await select(input, 0, source.content.length, 'backward')
      await page.keyboard.press('Tab')
      await expect(input).toHaveValue(indented)
      await expectSelection(input, 2, indented.length, 'backward')
      await page.keyboard.press('Shift+Tab')
      await expect(input).toHaveValue(source.content)
      await expectSelection(input, 0, source.content.length, 'backward')
      await page.keyboard.press('Control+z')
      await expect(input).toHaveValue(indented)
      await expectSelection(input, 2, indented.length, 'backward')
      await page.keyboard.press('Control+Shift+z')
      await expect(input).toHaveValue(source.content)
      await expectSelection(input, 0, source.content.length, 'backward')
      await page.keyboard.press('Tab')
      await expect(input).toHaveValue(indented)
    }
    const after = before.map(block => ({
      ...block, content: block.content.split('\n').map(line => `  ${line}`).join('\n')
    }))
    await expect.poll(() => read(page, id)).toEqual(after)
    await page.reload()
    await page.locator('.tree-button', { hasText: title }).first().click()
    expect(await read(page, id)).toEqual(after)
    for (const source of sources) {
      const row = page.locator(`[data-block-id="indent-${source.type}"]`)
      if (source.type === 'table') await row.locator('.markdown-table-source summary').click()
      await expect(row.locator('textarea.block-inline-textarea')).toHaveValue(
        source.content.split('\n').map(line => `  ${line}`).join('\n'))
    }
  })
})
