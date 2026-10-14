import { expect, test, type Page } from '@playwright/test'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { closeElectronApp, launchElectronApp } from './helpers/electron'
import { setRichTextDomSelection } from './helpers/rich-text-selection'

const editor = (page: Page) => page.locator('.knowbook-rich-text-editor')
const rows = (page: Page) => editor(page).locator('.block-editor-row')
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
async function readBlocks(page: Page, id: string) {
  return page.evaluate(async id => (await window.knowbook.getDocumentDetail(id))!.blocks.map(block => ({
    id: block.id, type: block.type, content: block.content, checked: block.checked, depth: block.depth,
    parentBlockId: block.parentBlockId ?? null, language: block.language ?? null,
    tags: block.tags ?? [], highlight: block.highlight ?? null,
    listStart: block.listStart ?? null, markdownFormat: block.markdownFormat ?? null
  })), id)
}
type SavedBlocks = Awaited<ReturnType<typeof readBlocks>>
function structure(blocks: SavedBlocks) {
  return blocks.map(block => ({ type: block.type, content: block.content, checked: block.checked, depth: block.depth,
    parentIndex: block.parentBlockId ? blocks.findIndex(parent => parent.id === block.parentBlockId) : null,
    language: block.language, listStart: block.listStart, markdownFormat: block.markdownFormat }))
}
async function observeClipboard(page: Page, kind: 'copy' | 'paste') {
  await editor(page).evaluate((root, kind) => {
    const target = window as unknown as { nativeForestClipboard?: ClipboardSnapshot }
    delete target.nativeForestClipboard
    // Observe the trusted native event after the product handler without altering it.
    root.addEventListener(kind, event => {
      const data = (event as ClipboardEvent).clipboardData
      target.nativeForestClipboard = { plain: data?.getData('text/plain') ?? '', html: data?.getData('text/html') ?? '',
        internal: data?.getData('application/x-knowbook-markdown') ?? '', prevented: event.defaultPrevented }
    }, { once: true })
  }, kind)
}
async function clipboardSnapshot(page: Page) {
  await expect.poll(() => page.evaluate(() => (window as unknown as { nativeForestClipboard?: ClipboardSnapshot })
    .nativeForestClipboard?.plain)).not.toBeUndefined()
  return (await page.evaluate(() => (window as unknown as { nativeForestClipboard?: ClipboardSnapshot }).nativeForestClipboard))!
}
async function settleSelection(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

// Native clipboard transfer, DOM Range and trusted keys exercise the public editor.
test('rich native clipboard preserves mixed container formats and parents with fresh identities, one undo and reload @electron', async () => {
  test.setTimeout(150000)
  const context = await launchElectronApp({}, { editorMode: 'rich' })
  try {
    const { app, page } = context
    const sourceTitle = 'Native mixed clipboard source', destinationTitle = 'Native mixed clipboard destination'
    const owner = 'native-clipboard-owner', body = 'native-clipboard-body', toggle = 'native-clipboard-toggle', leaf = 'native-clipboard-leaf'
    const blocks: DocumentBlockDraft[] = [
      { id: owner, type: 'callout', content: '**Notice**', checked: false, depth: 0, tags: ['private-owner'], highlight: 'yellow',
        markdownFormat: { calloutKind: 'warning', calloutIcon: 'pin', calloutTone: 'red' } },
      { id: body, type: 'paragraph', content: 'Mixed **body** with [link](https://example.test/native)', checked: false,
        depth: 1, parentBlockId: owner, tags: ['private-body'] },
      { id: toggle, type: 'toggle', content: 'Details', checked: false, depth: 1, parentBlockId: owner,
        tags: ['private-toggle'], markdownFormat: { toggleDefaultOpen: true } },
      { id: leaf, type: 'paragraph', content: 'Child 中文😀', checked: false, depth: 2, parentBlockId: toggle,
        tags: ['private-leaf'], highlight: 'blue' },
      { id: 'native-clipboard-outside', type: 'paragraph', content: 'Outside remains', checked: false, depth: 0, tags: ['private-outside'] }
    ]
    const destinationBlock: DocumentBlockDraft = { id: 'native-clipboard-destination', type: 'paragraph', content: 'Replace destination', checked: false, depth: 0 }
    const sourceId = await createFixture(page, sourceTitle, blocks)
    const destinationId = await createFixture(page, destinationTitle, [destinationBlock])
    await page.reload(); await openDocument(page, sourceTitle)
    await expect(rows(page)).toHaveCount(blocks.length)
    const sourceBefore = await readBlocks(page, sourceId), destinationBefore = await readBlocks(page, destinationId)
    await expect(rows(page).nth(3)).toBeVisible()
    await observeClipboard(page, 'copy')
    await editor(page).evaluate(setRichTextDomSelection, {
      from: { blockId: owner, offset: 0 }, to: { blockId: leaf, offset: blocks[3].content.length }, backward: true
    })
    await settleSelection(page)
    await expect.poll(() => editor(page).evaluate(() => window.getSelection()?.toString())).toContain('Child 中文😀')
    expect(await editor(page).evaluate(() => window.getSelection()?.toString())).not.toContain('Outside remains')
    await page.keyboard.press('Control+c')
    const copied = await clipboardSnapshot(page)
    expect(copied.prevented).toBe(true)
    expect(copied.internal).toBe(copied.plain)
    expect(copied.plain).toContain('data-knowbook-container="callout-v1"')
    expect(copied.plain).toContain('data-knowbook-container="toggle-v1"')
    expect(copied.plain).toContain('Mixed **body** with [link](https://example.test/native)')
    expect(copied.plain).not.toContain('Outside remains')
    for (const source of sourceBefore) { expect(copied.plain).not.toContain(source.id); for (const tag of source.tags) expect(copied.plain).not.toContain(tag) }
    expect(copied.html).toContain('data-knowbook-markdown-source="true"')
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(copied.plain)
    const html = await app.evaluate(({ clipboard }) => clipboard.readHTML())
    const semantics = await page.evaluate(html => {
      const document = new DOMParser().parseFromString(html, 'text/html')
      return { sentinel: document.querySelector('[data-knowbook-markdown-source="true"]') !== null,
        callout: document.querySelector('aside')?.getAttribute('data-callout-tone'),
        toggle: document.querySelector('details')?.hasAttribute('open'),
        strong: [...document.querySelectorAll('strong')].map(node => node.textContent),
        link: document.querySelector('a')?.getAttribute('href'), executable: document.querySelectorAll('script,iframe,object,embed').length }
    }, html)
    expect(semantics).toEqual({ sentinel: true, callout: 'red', toggle: true, strong: ['Notice', 'body'],
      link: 'https://example.test/native', executable: 0 })
    expect(await readBlocks(page, sourceId)).toEqual(sourceBefore)

    await openDocument(page, destinationTitle)
    await expect(rows(page)).toHaveCount(1)
    await observeClipboard(page, 'paste')
    // Select the external paragraph including its block boundaries via public DOM.
    await editor(page).evaluate(root => {
      ;(root as HTMLElement).focus()
      const range = root.ownerDocument.createRange(); range.selectNodeContents(root)
      const selection = root.ownerDocument.defaultView!.getSelection()!
      selection.removeAllRanges(); selection.addRange(range)
    })
    await settleSelection(page)
    await page.keyboard.press('Control+v')
    const pastedEvent = await clipboardSnapshot(page)
    expect(pastedEvent.plain).toBe(copied.plain)
    expect(pastedEvent.html).toContain('data-knowbook-markdown-source="true"')
    // The operating system may strip the custom MIME; both public fallback cases
    // are covered by renderer-native-container-clipboard.test.tsx.
    await expect(rows(page)).toHaveCount(4)
    await expect(rows(page).first()).toHaveAttribute('data-native-container', 'callout')
    await expect(rows(page).first()).toHaveAttribute('data-native-container-tone', 'red')
    await expect(rows(page).first().locator('strong')).toHaveText('Notice')
    await expect(rows(page).nth(1).locator('strong')).toHaveText('body')
    await expect(rows(page).nth(1).locator('a')).toHaveAttribute('href', 'https://example.test/native')
    await expect(rows(page).nth(2)).toHaveAttribute('data-native-container', 'toggle')
    await expect(rows(page).last()).toContainText('Child 中文😀')
    await expect.poll(async () => structure(await readBlocks(page, destinationId))).toEqual(structure(sourceBefore.slice(0, 4)))
    const pasted = await readBlocks(page, destinationId)
    expect(new Set(pasted.map(block => block.id)).size).toBe(4)
    for (const block of pasted) {
      expect(sourceBefore.some(source => source.id === block.id)).toBe(false)
      expect(block.id).not.toBe(destinationBlock.id)
      expect(block.tags).toEqual([]); expect(block.highlight).toBeNull()
    }
    expect(await readBlocks(page, sourceId)).toEqual(sourceBefore)

    await page.keyboard.press('Control+z')
    await expect(rows(page)).toHaveCount(1)
    await expect(rows(page).first()).toHaveAttribute('data-block-id', destinationBlock.id!)
    await expect(rows(page).first()).toHaveText('Replace destination')
    await expect.poll(() => readBlocks(page, destinationId)).toEqual(destinationBefore)
    await page.keyboard.press('Control+y')
    await expect(rows(page)).toHaveCount(4)
    await expect.poll(() => readBlocks(page, destinationId)).toEqual(pasted)
    await page.locator('.document-header-save-button').click()
    await expect.poll(() => readBlocks(page, destinationId)).toEqual(pasted)
    await page.reload(); await openDocument(page, destinationTitle)
    await expect(rows(page)).toHaveCount(4)
    await expect(rows(page).first()).toHaveAttribute('data-native-container-tone', 'red')
    await expect(rows(page).last()).toContainText('Child 中文😀')
    expect(await readBlocks(page, destinationId)).toEqual(pasted)
    await openDocument(page, sourceTitle)
    await expect(rows(page)).toHaveCount(5)
    expect(await readBlocks(page, sourceId)).toEqual(sourceBefore)
  } finally { await closeElectronApp(context) }
})
