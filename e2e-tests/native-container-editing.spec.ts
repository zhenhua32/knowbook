import { expect, test, type Page } from '@playwright/test'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { closeElectronApp, launchElectronApp, uiText } from './helpers/electron'
import { setRichTextDomSelection } from './helpers/rich-text-selection'

type Mode = 'markdown' | 'rich'
const row = (page: Page, id: string) => page.locator(`.block-editor-row[data-block-id="${id}"]`)
const menu = (page: Page) => page.locator('.block-context-menu')
async function open(page: Page, title: string) {
  await page.locator('.tree-button', { hasText: title }).first().click()
  await expect(page.locator('.document-header-title')).toHaveText(title)
}
async function saved(page: Page, id: string) {
  return (await page.evaluate(id => window.knowbook.getDocumentDetail(id), id))!.blocks
}
const metadata = (block: Awaited<ReturnType<typeof saved>>[number]) => ({ id: block.id, type: block.type, content: block.content,
  checked: block.checked, depth: block.depth, parentBlockId: block.parentBlockId, tags: block.tags, highlight: block.highlight,
  listStart: block.listStart, markdownFormat: block.markdownFormat, language: block.language })
async function selectTitle(page: Page, mode: Mode, id: string, start: number, end = start) {
  if (mode === 'markdown') await row(page, id).locator('.block-inline-textarea').evaluate((input: HTMLTextAreaElement, range) => {
    input.focus(); input.setSelectionRange(range.start, range.end, range.start === range.end ? 'none' : 'backward')
  }, { start, end })
  else await page.locator('.knowbook-rich-text-editor').evaluate(setRichTextDomSelection, {
    from: { blockId: id, offset: start }, to: { blockId: id, offset: end }, backward: start !== end
  })
}
async function assertBackwardEmoji(page: Page, mode: Mode, id: string) {
  if (mode === 'markdown') expect(await row(page, id).locator('.block-inline-textarea').evaluate((input: HTMLTextAreaElement) =>
    [input.value.slice(input.selectionStart, input.selectionEnd), input.selectionDirection])).toEqual(['😀', 'backward'])
  else expect(await page.locator('.knowbook-rich-text-editor').evaluate(() => {
    const selection = window.getSelection()!
    return { text: selection.toString(), backward: selection.anchorNode === selection.focusNode && selection.anchorOffset > selection.focusOffset,
      blockId: selection.anchorNode?.parentElement?.closest('[data-block-id]')?.getAttribute('data-block-id') }
  })).toEqual({ text: '😀', backward: true, blockId: id })
}
async function controls(page: Page, mode: Mode, id: string, type: 'callout' | 'toggle') {
  await selectTitle(page, mode, id, 0)
  const panel = mode === 'markdown' ? row(page, id).locator('.native-container-controls') : page.locator('.native-container-controls')
  await expect(panel).toBeVisible()
  if (await panel.getAttribute('open') === null) await panel.locator('summary').click()
  await expect(panel.getByLabel(uiText(type === 'callout' ? 'Callout kind' : 'Open by default', type === 'callout' ? '提示类型' : '默认展开'))).toBeVisible()
  return panel
}

for (const mode of ['markdown', 'rich'] as const) test(`${mode} native mixed containers preserve forest identity, authored settings, personal folds and one title undo @electron`, async () => {
  test.setTimeout(150000)
  const context = await launchElectronApp({}, { editorMode: mode })
  try {
    const { page } = context
    await page.setViewportSize({ width: 1360, height: 1050 })
    const title = `Native container ${mode}`, owner = `native-${mode}-owner`, child = `native-${mode}-child`, grandchild = `native-${mode}-grandchild`
    const toggle = `native-${mode}-toggle`, hidden = `native-${mode}-hidden`
    const blocks: DocumentBlockDraft[] = [
      { id: owner, type: 'bulleted-list', content: 'Title😀Tail', checked: false, depth: 0, tags: ['owner-tag'], highlight: 'blue' },
      { id: child, type: 'numbered-todo', content: 'Original checked child', checked: true, depth: 1, parentBlockId: owner,
        listStart: 4, markdownFormat: { listMarker: ')', listLoose: true }, tags: ['child-tag'], highlight: 'yellow' },
      { id: grandchild, type: 'todo', content: 'Original grandchild', checked: false, depth: 2, parentBlockId: child },
      { id: toggle, type: 'toggle', content: 'Default closed', checked: false, depth: 0, markdownFormat: { toggleDefaultOpen: false } },
      { id: hidden, type: 'paragraph', content: 'Hidden forest remains authored', checked: false, depth: 1, parentBlockId: toggle, tags: ['hidden-tag'] }
    ]
    const documentId = await page.evaluate(async ({ title, blocks }) => {
      const { id } = await window.knowbook.createDocument(null)
      await window.knowbook.updateDocument(id, { title, summary: '', blocks }); return id
    }, { title, blocks })
    await page.reload(); await open(page, title)
    const original = await saved(page, documentId)
    await expect(row(page, hidden)).toBeHidden()
    if (mode === 'rich') {
      await expect(row(page, child)).toHaveAttribute('data-list-number', '4')
      const prefix = await row(page, child).evaluate(element => getComputedStyle(element, '::before').content)
      expect(prefix).toContain('4'); expect(prefix).toContain('.')
    }
    await row(page, owner).click({ button: 'right' })
    await menu(page).getByRole('button', { name: uiText('Callout', '提示块'), exact: true }).click()
    await expect(menu(page)).toHaveCount(0)
    await expect(row(page, owner)).toHaveAttribute('data-native-container', 'callout')
    await expect.poll(async () => (await saved(page, documentId)).find(block => block.id === owner)?.type).toBe('callout')
    let panel = await controls(page, mode, owner, 'callout')
    await panel.getByLabel(uiText('Callout kind', '提示类型')).selectOption('warning')
    await panel.getByLabel(uiText('Callout icon', '提示图标')).selectOption('pin')
    await panel.getByLabel(uiText('Callout tone', '提示颜色')).selectOption('red')
    await expect(row(page, owner)).toHaveAttribute('data-native-container-tone', 'red')
    await expect(row(page, owner).locator('[data-native-container-icon="pin"]')).toBeVisible()
    await expect.poll(async () => (await saved(page, documentId)).find(block => block.id === owner)?.markdownFormat)
      .toEqual({ calloutKind: 'warning', calloutIcon: 'pin', calloutTone: 'red' })
    for (const id of [child, grandchild, hidden]) expect(metadata((await saved(page, documentId)).find(block => block.id === id)!))
      .toEqual(metadata(original.find(block => block.id === id)!))

    await panel.getByLabel(uiText('Child block type', '子块类型')).selectOption('quote')
    await panel.getByRole('button', { name: uiText('Add child block', '添加子块'), exact: true }).click()
    await expect.poll(async () => (await saved(page, documentId)).filter(block => block.type === 'quote' && block.parentBlockId === owner).length).toBe(1)
    const quote = (await saved(page, documentId)).find(block => block.type === 'quote' && block.parentBlockId === owner)!
    if (mode === 'markdown') {
      await expect(row(page, quote.id).locator('.block-inline-textarea')).toBeFocused()
      expect(await row(page, quote.id).locator('.block-inline-textarea').evaluate((input: HTMLTextAreaElement) =>
        [input.selectionStart, input.selectionEnd])).toEqual([0, 0])
    } else {
      await expect(page.locator('.knowbook-rich-text-editor')).toBeFocused()
      expect(await page.locator('.knowbook-rich-text-editor').evaluate(() => {
        const selection = window.getSelection()!
        const block = (selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode?.parentElement)?.closest('[data-block-id]')
        const range = document.createRange(); range.selectNodeContents(block!); range.setEnd(selection.anchorNode!, selection.anchorOffset)
        const content = range.cloneContents(); content.querySelectorAll('[contenteditable="false"]').forEach(element => element.remove())
        return { blockId: block?.getAttribute('data-block-id'), offset: content.textContent?.length ?? 0, collapsed: selection.isCollapsed }
      })).toEqual({ blockId: quote.id, offset: 0, collapsed: true })
    }
    await page.keyboard.insertText('Mixed quote child')
    await expect.poll(async () => (await saved(page, documentId)).find(block => block.id === quote.id)?.content).toBe('Mixed quote child')
    await page.screenshot({ path: `test-results/stage5/native-container-${mode}.png`, fullPage: true })
    const beforeEnter = await saved(page, documentId)
    await selectTitle(page, mode, owner, 5, 7)
    await assertBackwardEmoji(page, mode, owner)
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await saved(page, documentId)).find(block => block.id === owner)?.content).toBe('Title')
    const split = await saved(page, documentId), tail = split.find(block => block.content === 'Tail')!
    expect(tail.type).toBe('paragraph'); expect(tail.parentBlockId).toBe(owner); expect(tail.depth).toBe(1)
    expect(split[1].id).toBe(tail.id)
    expect(split.filter(block => block.type === 'callout').map(block => block.id)).toEqual([owner])
    for (const id of [child, grandchild, quote.id, hidden]) expect(metadata(split.find(block => block.id === id)!))
      .toEqual(metadata(beforeEnter.find(block => block.id === id)!))
    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await saved(page, documentId)).map(metadata)).toEqual(beforeEnter.map(metadata))
    await assertBackwardEmoji(page, mode, owner)
    await page.keyboard.press('Control+y')
    await expect.poll(async () => (await saved(page, documentId)).map(metadata)).toEqual(split.map(metadata))

    panel = await controls(page, mode, toggle, 'toggle')
    const authoredOpen = panel.getByLabel(uiText('Open by default', '默认展开'))
    await expect(authoredOpen).not.toBeChecked()
    await authoredOpen.check()
    await expect(row(page, hidden)).toBeVisible()
    await expect.poll(async () => (await saved(page, documentId)).find(block => block.id === toggle)?.markdownFormat?.toggleDefaultOpen).toBe(true)
    await authoredOpen.uncheck()
    await expect(row(page, hidden)).toBeHidden()
    await expect.poll(async () => (await saved(page, documentId)).find(block => block.id === toggle)?.markdownFormat?.toggleDefaultOpen).toBe(false)
    await row(page, toggle).locator('.native-toggle-control').click()
    await expect(row(page, hidden)).toBeVisible()
    await expect(panel.getByLabel(uiText('Open by default', '默认展开'))).not.toBeChecked()
    await expect.poll(async () => (await saved(page, documentId)).find(block => block.id === toggle)?.markdownFormat?.toggleDefaultOpen).toBe(false)
    await page.locator('.document-header-save-button').click()
    await page.reload(); await open(page, title)
    await expect(row(page, hidden)).toBeVisible()
    expect(metadata((await saved(page, documentId)).find(block => block.id === hidden)!)).toEqual(metadata(original.find(block => block.id === hidden)!))
    await expect(row(page, owner)).toHaveAttribute('data-native-container-tone', 'red')
    await selectTitle(page, mode, owner, 0)
    const input = mode === 'markdown' ? row(page, owner).locator('.block-inline-textarea') : page.locator('.knowbook-rich-text-editor')
    const beforeIme = (await saved(page, documentId)).map(metadata)
    await input.evaluate(element => {
      element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '中' }))
      element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', isComposing: true }))
      element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }))
    })
    await page.locator('.document-header-save-button').click()
    expect((await saved(page, documentId)).map(metadata)).toEqual(beforeIme)
    await page.locator('.document-view-toggle').click()
    const readingOwner = page.locator(`.document-reading-row[data-block-id="${owner}"]`)
    await expect(readingOwner).toContainText('Title')
    await expect(page.locator(`.document-reading-row[data-block-id="${quote.id}"]`)).toContainText('Mixed quote child')
    const readingToggle = page.locator(`.document-reading-row[data-block-id="${toggle}"]`)
    await readingToggle.locator('.reading-collapse').click()
    await expect(page.locator(`.document-reading-row[data-block-id="${hidden}"]`)).toBeHidden()
    expect((await saved(page, documentId)).map(metadata)).toEqual(beforeIme)
  } finally { await closeElectronApp(context) }
})
