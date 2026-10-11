import { expect, test, type Locator, type Page } from '@playwright/test'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { withElectronApp } from './helpers/electron'

const paragraph = (id: string): DocumentBlockDraft => ({ id, content: id, type: 'paragraph', checked: false, depth: 0 })
const row = (page: Page, id: string) => page.locator(`[data-block-id="${id}"]`)
const input = (page: Page, id: string) => row(page, id).locator('textarea.block-inline-textarea')
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
async function select(textarea: Locator, start: number, end = start) {
  await textarea.focus()
  await textarea.evaluate((element, { start, end }) => {
    const input = element as HTMLTextAreaElement
    input.setSelectionRange(start, end)
    input.dispatchEvent(new Event('select', { bubbles: true }))
  }, { start, end })
}
async function selectedIds(page: Page) {
  return page.locator('.block-editor-row-selected').evaluateAll(rows => rows.map(row => row.getAttribute('data-block-id')))
}
async function expectRange(page: Page, ids: string[], focus: string, position: number) {
  await expect.poll(() => selectedIds(page)).toEqual(ids.length > 1 ? ids : [])
  await expect(input(page, focus)).toBeFocused()
  expect(await input(page, focus).evaluate(element => {
    const input = element as HTMLTextAreaElement
    return [input.selectionStart, input.selectionEnd]
  })).toEqual([position, position])
}

test('continuous Shift arrows expand, contract and reverse past the anchor with native keyup and document boundaries @electron', async () => {
  await withElectronApp(async ({ page }) => {
    const blocks = ['A', 'B', 'C', 'D'].map(paragraph)
    const id = await openEditor(page, 'Continuous keyboard block selection', blocks)
    const original = await page.evaluate(async id => (await window.knowbook.getDocumentDetail(id))?.blocks, id)
    await select(input(page, 'B'), 1)
    for (const [key, ids, focus, position] of [
      ['ArrowDown', ['B', 'C'], 'C', 1], ['ArrowDown', ['B', 'C', 'D'], 'D', 1],
      ['ArrowDown', ['B', 'C', 'D'], 'D', 1], ['ArrowUp', ['B', 'C'], 'C', 0],
      ['ArrowUp', ['B'], 'B', 0], ['ArrowUp', ['A', 'B'], 'A', 0],
      ['ArrowUp', ['A', 'B'], 'A', 0], ['ArrowDown', ['B'], 'B', 1],
      ['ArrowDown', ['B', 'C'], 'C', 1]
    ] as const) {
      // Use the browser's current focus, so every keyup reaches the moved endpoint.
      await page.keyboard.press(`Shift+${key}`)
      await expectRange(page, [...ids], focus, position)
    }
    expect(await page.evaluate(async id => (await window.knowbook.getDocumentDetail(id))?.blocks, id)).toEqual(original)
  })
})

test('keyboard range selection skips folded descendants and contracts through the same visible endpoints @electron', async () => {
  await withElectronApp(async ({ page }) => {
    const blocks: DocumentBlockDraft[] = [paragraph('Before'), { ...paragraph('Parent'), type: 'todo' },
      { ...paragraph('Child'), type: 'todo', depth: 1, parentBlockId: 'Parent' },
      { ...paragraph('Grandchild'), type: 'todo', depth: 2, parentBlockId: 'Child' }, paragraph('After')]
    await openEditor(page, 'Folded keyboard block selection', blocks)
    await row(page, 'Parent').locator('.block-collapse-toggle').click()
    await expect(row(page, 'Child')).toHaveCount(0)
    await expect(row(page, 'Grandchild')).toHaveCount(0)
    await select(input(page, 'Before'), 6)
    await page.keyboard.press('Shift+ArrowDown'); await expectRange(page, ['Before', 'Parent'], 'Parent', 6)
    await page.keyboard.press('Shift+ArrowDown'); await expectRange(page, ['Before', 'Parent', 'After'], 'After', 5)
    await page.keyboard.press('Shift+ArrowDown'); await expectRange(page, ['Before', 'Parent', 'After'], 'After', 5)
    await page.keyboard.press('Shift+ArrowUp'); await expectRange(page, ['Before', 'Parent'], 'Parent', 0)
    await page.keyboard.press('Shift+ArrowUp'); await expectRange(page, ['Before'], 'Before', 0)
    await page.keyboard.press('Shift+ArrowDown'); await expectRange(page, ['Before', 'Parent'], 'Parent', 6)
  })
})

test('Shift click and drag selections resume from their endpoint while text selection and IME remain native @electron', async () => {
  await withElectronApp(async ({ page }) => {
    await openEditor(page, 'Mouse and native keyboard selections', ['A', 'B', 'C', 'D', 'E'].map(paragraph))
    await select(input(page, 'B'), 1)
    await input(page, 'D').click({ modifiers: ['Shift'] })
    await expect(input(page, 'B')).toBeFocused()
    await expect.poll(() => selectedIds(page)).toEqual(['B', 'C', 'D'])
    await page.keyboard.press('Shift+ArrowDown'); await expectRange(page, ['B', 'C', 'D', 'E'], 'E', 1)

    // A new editor session resets selection state before the real mouse handlers run.
    await openEditor(page, 'Dragged keyboard block selection', ['A', 'B', 'C', 'D'].map(content => ({ ...paragraph(`drag-${content}`), content })))
    await select(input(page, 'drag-A'), 1)
    await input(page, 'drag-A').dispatchEvent('mousedown', { buttons: 1, button: 0 })
    await input(page, 'drag-A').evaluate((element) => {
      element.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, buttons: 1,
        relatedTarget: document.querySelector('[data-block-id="drag-C"]') }))
    })
    await input(page, 'drag-C').dispatchEvent('mouseup', { button: 0 })
    await expect.poll(() => selectedIds(page)).toEqual(['drag-A', 'drag-B', 'drag-C'])
    await expect(input(page, 'drag-A')).toBeFocused()
    await page.keyboard.press('Shift+ArrowDown'); await expectRange(page, ['drag-A', 'drag-B', 'drag-C', 'drag-D'], 'drag-D', 1)

    await openEditor(page, 'Native text and IME selection', [paragraph('Before'), paragraph('Text'), paragraph('After')])
    await select(input(page, 'Text'), 4)
    await page.keyboard.press('Shift+ArrowDown'); await expectRange(page, ['Text', 'After'], 'After', 5)
    await page.keyboard.press('Shift+ArrowUp'); await expectRange(page, ['Text'], 'Text', 0)
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Shift+ArrowDown')
    await expect(input(page, 'Text')).toBeFocused(); expect(await selectedIds(page)).toEqual([])
    expect(await input(page, 'Text').evaluate(element => {
      const input = element as HTMLTextAreaElement
      return [input.selectionStart, input.selectionEnd]
    })).toEqual([1, 4])
    await select(input(page, 'Text'), 2)
    await page.keyboard.press('Shift+ArrowUp')
    await expect(input(page, 'Text')).toBeFocused()
    expect(await selectedIds(page)).toEqual([])
    expect(await input(page, 'Text').evaluate(element => {
      const input = element as HTMLTextAreaElement
      return [input.selectionStart, input.selectionEnd]
    })).toEqual([0, 2])
    await select(input(page, 'Text'), 0, 4)
    await page.keyboard.press('Shift+ArrowDown')
    await expect(input(page, 'Text')).toBeFocused(); expect(await selectedIds(page)).toEqual([])
    await select(input(page, 'Text'), 4)
    const prevented = await input(page, 'Text').evaluate(element => {
      const event = new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, isComposing: true,
        bubbles: true, cancelable: true })
      element.dispatchEvent(event)
      return event.defaultPrevented
    })
    expect(prevented).toBe(false)
    await expect(input(page, 'Text')).toBeFocused(); expect(await selectedIds(page)).toEqual([])
  })
})

async function clipboardFixture(textarea: Locator, type: 'copy' | 'cut') {
  return textarea.evaluate((element, type) => {
    const textarea = element as HTMLTextAreaElement
    const data = new DataTransfer()
    data.setData('text/plain', textarea.value.slice(textarea.selectionStart, textarea.selectionEnd))
    const event = new ClipboardEvent(type, { bubbles: true, cancelable: true, clipboardData: data })
    textarea.dispatchEvent(event)
    return { prevented: event.defaultPrevented, text: data.getData('text/plain') }
  }, type)
}

test('Ctrl+A switches from an old block range to native text copy/cut and then to all blocks, including empty blocks @electron', async () => {
  await withElectronApp(async ({ page }) => {
    const id = await openEditor(page, 'Select all clipboard ownership', ['A', 'B', 'C', 'D'].map(paragraph))
    const original = await page.evaluate(async id => (await window.knowbook.getDocumentDetail(id))?.blocks, id)
    await select(input(page, 'B'), 1)
    await page.keyboard.press('Shift+ArrowDown'); await expectRange(page, ['B', 'C'], 'C', 1)
    const imePrevented = await input(page, 'C').evaluate(element => {
      const event = new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, isComposing: true, bubbles: true, cancelable: true })
      element.dispatchEvent(event)
      return event.defaultPrevented
    })
    expect(imePrevented).toBe(false)
    await expectRange(page, ['B', 'C'], 'C', 1)
    await page.keyboard.press('Control+a')
    await expect(input(page, 'C')).toBeFocused()
    expect(await selectedIds(page)).toEqual([])
    expect(await input(page, 'C').evaluate(element => {
      const input = element as HTMLTextAreaElement
      return [input.selectionStart, input.selectionEnd]
    })).toEqual([0, 1])
    expect(await clipboardFixture(input(page, 'C'), 'copy')).toEqual({ prevented: false, text: 'C' })
    expect(await clipboardFixture(input(page, 'C'), 'cut')).toEqual({ prevented: false, text: 'C' })
    await expect(input(page, 'C')).toHaveValue('C')
    expect(await page.evaluate(async id => (await window.knowbook.getDocumentDetail(id))?.blocks, id)).toEqual(original)
    await page.keyboard.press('Control+a')
    await expect.poll(() => selectedIds(page)).toEqual(['A', 'B', 'C', 'D'])
    expect(await clipboardFixture(input(page, 'C'), 'copy')).toEqual({ prevented: true, text: 'A\n\nB\n\nC\n\nD' })
    expect(await page.evaluate(async id => (await window.knowbook.getDocumentDetail(id))?.blocks, id)).toEqual(original)

    await openEditor(page, 'Empty select all clipboard ownership', [paragraph('Before'), { ...paragraph('Empty'), content: '' }, paragraph('After')])
    await select(input(page, 'Empty'), 0)
    await page.keyboard.press('Control+a')
    await expect.poll(() => selectedIds(page)).toEqual(['Before', 'Empty', 'After'])
    await expect(input(page, 'Empty')).toBeFocused()
    await expect(input(page, 'Empty')).toHaveValue('')
  })
})
