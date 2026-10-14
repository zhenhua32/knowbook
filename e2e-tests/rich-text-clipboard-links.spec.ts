import { setRichTextDomSelection } from './helpers/rich-text-selection'
import { expect, test, type Locator, type Page } from '@playwright/test'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { closeElectronApp, launchElectronApp, uiText } from './helpers/electron'

const editor = (page: Page) => page.locator('.knowbook-rich-text-editor')
const rows = (page: Page) => editor(page).locator('.block-editor-row')
const paragraph = (id: string, content: string): DocumentBlockDraft => ({ id, type: 'paragraph', content, checked: false, depth: 0 })
type Point = { blockId: string; offset: number }
type ClipboardSnapshot = { plain: string; html: string; internal: string; prevented: boolean }

async function createFixture(page: Page, title: string, blocks: DocumentBlockDraft[]) {
  return page.evaluate(async ({ title, blocks }) => {
    const { id } = await window.knowbook.createDocument(null)
    await window.knowbook.updateDocument(id, { title, summary: '', blocks })
    return id
  }, { title, blocks })
}

async function openDocument(page: Page, title: string) {
  await page.locator('.tree-button', { hasText: title }).first().click()
  await expect(page.locator('.document-header-title')).toHaveText(title)
  await expect(editor(page)).toBeVisible()
}

async function reopen(page: Page, title: string) {
  await page.reload()
  await openDocument(page, title)
}

async function readBlocks(page: Page, id: string) {
  return page.evaluate(async id => (await window.knowbook.getDocumentDetail(id))!.blocks.map(
    ({ id, type, content, checked, depth, parentBlockId, language, tags, highlight }) => ({
      id, type, content, checked, depth, parentBlockId: parentBlockId ?? null,
      language: language ?? null, tags: tags ?? [], highlight: highlight ?? null
    })), id)
}

async function save(page: Page) {
  await page.locator('.document-header-save-button').click()
}

// Use Chromium's DOM selection and trusted keys, never a ProseMirror test API.
async function selectRich(page: Page, from: Point, to = from, backward = false) {
  await editor(page).evaluate(setRichTextDomSelection, { from, to, backward })
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function selectionPoints(body: Locator) {
  return body.evaluate(root => {
    const selection = window.getSelection()
    if (!selection?.anchorNode || !selection.focusNode) return null
    const point = (node: Node, offset: number) => {
      const element = node.nodeType === Node.ELEMENT_NODE ? node as HTMLElement : node.parentElement
      const row = element?.closest<HTMLElement>('.block-editor-row')
      if (!row || !root.contains(row)) return null
      const prefix = document.createRange()
      prefix.selectNodeContents(row)
      prefix.setEnd(node, offset)
      return { blockId: row.dataset.blockId, offset: prefix.toString().length }
    }
    return { anchor: point(selection.anchorNode, selection.anchorOffset), head: point(selection.focusNode, selection.focusOffset) }
  })
}

test('native rich text copy and cross-document paste preserve Markdown, semantic HTML and source blocks with fresh identities @electron', async () => {
  const context = await launchElectronApp({}, { editorMode: 'rich' })
  try {
    const { app, page } = context, title = 'Native rich clipboard source', destinationTitle = 'Native rich clipboard destination'
    const blocks: DocumentBlockDraft[] = [
      { ...paragraph('native-copy-first', '**Bold** and `inline`'), tags: ['private-source'], highlight: 'yellow' },
      paragraph('native-copy-second', 'Second paragraph'),
      { id: 'native-copy-code', type: 'code', content: 'const text = "<script>safe text</script>";\nconsole.log(text)',
        language: 'javascript', checked: false, depth: 0 },
      { id: 'native-copy-table', type: 'table', content: '| Name | Value |\n| --- | --- |\n| One | **Two** |', checked: false, depth: 0 },
      { id: 'native-copy-math', type: 'math', content: 'x^2 + y^2 = z^2', checked: false, depth: 0 },
      paragraph('native-copy-last', 'Last paragraph')
    ]
    const sourceId = await createFixture(page, title, blocks)
    const destinationId = await createFixture(page, destinationTitle, [paragraph('native-copy-destination', 'Replace destination')])
    await reopen(page, title)
    await expect(rows(page)).toHaveCount(blocks.length)
    const before = await readBlocks(page, sourceId)
    await editor(page).evaluate(root => {
      const target = window as unknown as { richClipboardSnapshot?: ClipboardSnapshot }
      delete target.richClipboardSnapshot
      // Observe the actual native event after the editor handler; do not alter it.
      root.addEventListener('copy', event => {
        const data = (event as ClipboardEvent).clipboardData
        target.richClipboardSnapshot = {
          plain: data?.getData('text/plain') ?? '', html: data?.getData('text/html') ?? '',
          internal: data?.getData('application/x-knowbook-markdown') ?? '', prevented: event.defaultPrevented
        }
      }, { once: true })
    })
    await editor(page).focus()
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Control+c')
    await expect.poll(() => page.evaluate(() => (window as unknown as { richClipboardSnapshot?: ClipboardSnapshot }).richClipboardSnapshot?.plain))
      .toContain('Last paragraph')
    const copied = (await page.evaluate(() => (window as unknown as { richClipboardSnapshot?: ClipboardSnapshot }).richClipboardSnapshot))!
    expect(copied.prevented).toBe(true)
    expect(copied.internal).toBe(copied.plain)
    expect(copied.plain).toContain('**Bold** and `inline`')
    expect(copied.plain).toContain('```javascript')
    expect(copied.plain).toContain(blocks[2].content)
    expect(copied.plain).toContain('| One | **Two** |')
    expect(copied.plain).toContain('$$\nx^2 + y^2 = z^2\n$$')
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(copied.plain)
    const nativeHtml = await app.evaluate(({ clipboard }) => clipboard.readHTML())
    const htmlSemantics = await page.evaluate(html => {
      const document = new DOMParser().parseFromString(html, 'text/html')
      return {
        strong: Array.from(document.querySelectorAll('strong')).map(element => element.textContent),
        code: document.querySelector('pre code')?.textContent,
        table: document.querySelector('table')?.textContent,
        executableElements: document.querySelectorAll('script, iframe, object, embed').length
      }
    }, nativeHtml)
    expect(htmlSemantics.strong).toContain('Bold')
    expect(htmlSemantics.code?.trimEnd()).toBe(blocks[2].content)
    expect(htmlSemantics.table).toContain('One')
    expect(htmlSemantics.table).toContain('Two')
    expect(htmlSemantics.executableElements).toBe(0)
    expect(await readBlocks(page, sourceId)).toEqual(before)

    await openDocument(page, destinationTitle)
    await editor(page).focus()
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Control+v')
    await expect(rows(page)).toHaveCount(blocks.length)
    await expect(rows(page).first().locator('strong')).toHaveText('Bold')
    await expect(rows(page).first().locator('code')).toHaveText('inline')
    const table = editor(page).getByRole('grid', { name: uiText('Editable table', '可编辑表格') })
    await expect(table).toHaveCount(1)
    await expect(table).toBeVisible()
    await expect(table).toContainText('One')
    await expect(table.locator('strong')).toHaveText('Two')
    await expect(editor(page).locator('.rich-text-source-preview pre code')).toContainText('<script>safe text</script>')
    await save(page)
    await expect.poll(async () => (await readBlocks(page, destinationId)).map(({ type, content, language }) => ({
      type, content: content.trimEnd(), language
    }))).toEqual(before.map(({ type, content, language }) => ({ type, content: content.trimEnd(), language })))
    const pasted = await readBlocks(page, destinationId)
    expect(new Set(pasted.map(block => block.id)).size).toBe(blocks.length)
    for (const block of pasted) {
      expect(before.some(original => original.id === block.id)).toBe(false)
      expect(block.id).not.toBe('native-copy-destination')
    }
    expect(await readBlocks(page, sourceId)).toEqual(before)
    await reopen(page, destinationTitle)
    await expect(rows(page).first().locator('strong')).toHaveText('Bold')
    expect(await readBlocks(page, destinationId)).toEqual(pasted)
  } finally {
    await closeElectronApp(context)
  }
})

test('native partial cross-paragraph cut keeps the surviving identity and undo restores the backward DOM selection @electron', async () => {
  const context = await launchElectronApp({}, { editorMode: 'rich' })
  try {
    const { app, page } = context, title = 'Native rich partial cut'
    const blocks = [paragraph('native-cut-first', 'abcdef'), paragraph('native-cut-second', 'ghijkl'), paragraph('native-cut-tail', 'Tail stays')]
    const id = await createFixture(page, title, blocks)
    await reopen(page, title)
    const before = await readBlocks(page, id)
    const from = { blockId: 'native-cut-first', offset: 2 }, to = { blockId: 'native-cut-second', offset: 4 }
    await selectRich(page, from, to, true)
    await expect.poll(() => selectionPoints(editor(page))).toEqual({ anchor: to, head: from })
    await page.keyboard.press('Control+x')
    await expect(rows(page)).toHaveCount(2)
    await expect(rows(page).first()).toHaveText('abkl')
    await expect(rows(page).first()).toHaveAttribute('data-block-id', 'native-cut-first')
    await expect(rows(page).last()).toHaveText('Tail stays')
    const cut = await app.evaluate(({ clipboard }) => clipboard.readText())
    expect(cut).toContain('cdef')
    expect(cut).toContain('ghij')
    expect(cut).not.toContain('Tail stays')
    await page.keyboard.press('Control+z')
    await expect(rows(page)).toHaveCount(3)
    await expect(rows(page).nth(0)).toHaveText('abcdef')
    await expect(rows(page).nth(1)).toHaveText('ghijkl')
    await expect.poll(() => selectionPoints(editor(page))).toEqual({ anchor: to, head: from })
    await save(page)
    await expect.poll(() => readBlocks(page, id)).toEqual(before)
    await reopen(page, title)
    expect(await readBlocks(page, id)).toEqual(before)
  } finally {
    await closeElectronApp(context)
  }
})

test('real Ctrl+K opens the rich text link form without global search and saves the selected text link @electron', async () => {
  const context = await launchElectronApp({}, { editorMode: 'rich' })
  try {
    const { page } = context, title = 'Rich native link keyboard', url = 'https://example.test/link?q=1'
    const id = await createFixture(page, title, [paragraph('native-link-text', 'Select this phrase')])
    await reopen(page, title)
    await selectRich(page, { blockId: 'native-link-text', offset: 7 }, { blockId: 'native-link-text', offset: 11 })
    await page.keyboard.press('Control+k')
    const form = page.locator('.rich-text-link-form')
    const address = form.getByRole('textbox', { name: uiText('Link URL', '链接地址'), exact: true })
    await expect(address).toBeFocused()
    await expect(page.locator('.global-search-modal')).toHaveCount(0)
    await address.fill(url)
    await form.getByRole('button', { name: uiText('Apply', '应用'), exact: true }).click()
    await expect(form).toHaveCount(0)
    await expect(rows(page).first().locator('a')).toHaveText('this')
    await expect(rows(page).first().locator('a')).toHaveAttribute('href', url)
    await expect(rows(page).first()).toHaveText('Select this phrase')
    await expect(page.locator('.global-search-modal')).toHaveCount(0)
    await save(page)
    await expect.poll(async () => (await readBlocks(page, id))[0].content).toContain(`[this](${url})`)
    await reopen(page, title)
    await expect(rows(page).first().locator('a')).toHaveText('this')
    await expect(rows(page).first().locator('a')).toHaveAttribute('href', url)
  } finally {
    await closeElectronApp(context)
  }
})

test('applying an old link selection after real body input reports stale text and keeps editing without adding the wrong link @electron', async () => {
  const context = await launchElectronApp({}, { editorMode: 'rich' })
  try {
    const { page } = context, title = 'Rich stale link selection', original = 'Original phrase'
    const id = await createFixture(page, title, [paragraph('stale-link-text', original)])
    await reopen(page, title)
    await selectRich(page, { blockId: 'stale-link-text', offset: 0 }, { blockId: 'stale-link-text', offset: 8 })
    await page.keyboard.press('Control+k')
    const form = page.locator('.rich-text-link-form')
    await form.getByRole('textbox', { name: uiText('Link URL', '链接地址'), exact: true }).fill('https://example.test/stale')
    await selectRich(page, { blockId: 'stale-link-text', offset: original.length })
    await page.keyboard.insertText(' changed')
    await expect(rows(page).first()).toHaveText(original + ' changed')
    await form.getByRole('button', { name: uiText('Apply', '应用'), exact: true }).click()
    await expect(page.locator('.rich-text-document').getByRole('status'))
      .toHaveText(uiText('The text changed. Select the link text again.', '正文已变化，请重新选择链接文字。'))
    await expect(rows(page).first().locator('a')).toHaveCount(0)
    await expect(rows(page).first()).toHaveText(original + ' changed')
    await form.getByRole('button', { name: uiText('Cancel', '取消'), exact: true }).click()
    await selectRich(page, { blockId: 'stale-link-text', offset: (original + ' changed').length })
    await page.keyboard.insertText('!')
    await expect(rows(page).first()).toHaveText(original + ' changed!')
    await save(page)
    await expect.poll(async () => (await readBlocks(page, id))[0].content).toBe(original + ' changed!')
    await reopen(page, title)
    await expect(rows(page).first().locator('a')).toHaveCount(0)
    await expect(rows(page).first()).toHaveText(original + ' changed!')
  } finally {
    await closeElectronApp(context)
  }
})
