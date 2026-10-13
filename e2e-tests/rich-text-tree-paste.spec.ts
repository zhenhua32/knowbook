import { expect, test, type Locator, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { closeElectronApp, launchElectronApp } from './helpers/electron'

const editor = (page: Page) => page.locator('.knowbook-rich-text-editor')
const rows = (page: Page) => editor(page).locator('.block-editor-row')
const row = (page: Page, id: string) => editor(page).locator(`[data-block-id="${id}"]`)

function todo(id: string, content: string, depth = 0, parentBlockId: string | null = null): DocumentBlockDraft {
  return { id, type: 'todo', content, checked: true, depth, parentBlockId, tags: [`keep-${id}`], highlight: 'blue',
    markdownFormat: { listMarker: '+', listLoose: true } }
}

function tree(nested: boolean): DocumentBlockDraft[] {
  const depth = nested ? 1 : 0
  return [
    ...(nested ? [todo('paste-outer', 'Outer')] : []),
    todo('paste-parent', 'AlphaBeta', depth, nested ? 'paste-outer' : null),
    todo('paste-child', 'Existing child', depth + 1, 'paste-parent'),
    { ...todo('paste-grandchild', 'Existing grandchild', depth + 2, 'paste-child'), type: 'bulleted-list', checked: false },
    { ...todo('paste-other-child', 'Other existing child', depth + 1, 'paste-parent'), checked: false, highlight: 'yellow' },
    todo('paste-tail', 'Tail sibling', depth, nested ? 'paste-outer' : null),
    todo('paste-tail-child', 'Tail child', depth + 1, 'paste-tail'),
    { id: 'paste-after', type: 'paragraph', content: 'After stays', checked: false, depth: 0 }
  ]
}

async function readTree(page: Page, id: string) {
  return page.evaluate(async id => (await window.knowbook.getDocumentDetail(id))!.blocks.map(
    ({ id, type, content, checked, depth, parentBlockId, tags, highlight, markdownFormat, listStart }) => ({
      id, type, content, checked, depth, parentBlockId: parentBlockId ?? null, tags: tags ?? [],
      highlight: highlight ?? null, markdownFormat: markdownFormat ?? null, listStart: listStart ?? null
    })), id)
}

async function reopen(page: Page, title: string) {
  await page.reload()
  await page.locator('.tree-button', { hasText: title }).first().click()
  await expect(page.locator('.document-header-title')).toHaveText(title)
  await expect(editor(page)).toBeVisible()
}

async function openFixture(page: Page, title: string, blocks: DocumentBlockDraft[]) {
  const id = await page.evaluate(async ({ title, blocks }) => {
    const { id } = await window.knowbook.createDocument(null)
    await window.knowbook.updateDocument(id, { title, summary: '', blocks })
    return id
  }, { title, blocks })
  await reopen(page, title)
  await expect(rows(page)).toHaveCount(blocks.length)
  return id
}

// Place a native DOM caret in the original list owner. ProseMirror state is
// deliberately not exposed to the test; paste and history use trusted keys.
async function placeCaret(page: Page, blockId: string, offset: number) {
  await editor(page).focus()
  await row(page, blockId).evaluate((block, offset) => {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
      acceptNode: node => node.parentElement?.closest('[contenteditable="false"]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
    })
    let remaining = offset
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = node.textContent?.length ?? 0
      if (remaining > length) { remaining -= length; continue }
      const range = document.createRange(), selection = window.getSelection()!
      range.setStart(node, remaining)
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
      return
    }
    throw new Error(`Caret outside block: ${block.getAttribute('data-block-id')}:${offset}`)
  }, offset)
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function caretPoint(body: Locator) {
  return body.evaluate(root => {
    const selection = window.getSelection()
    if (!selection?.anchorNode || !selection.isCollapsed) return null
    const element = selection.anchorNode.nodeType === Node.ELEMENT_NODE ? selection.anchorNode as HTMLElement : selection.anchorNode.parentElement
    const block = element?.closest<HTMLElement>('.block-editor-row')
    if (!block || !root.contains(block)) return null
    const prefix = document.createRange()
    prefix.selectNodeContents(block)
    prefix.setEnd(selection.anchorNode, selection.anchorOffset)
    return { blockId: block.dataset.blockId, offset: prefix.toString().length }
  })
}

function assertTree(blocks: Awaited<ReturnType<typeof readTree>>) {
  expect(new Set(blocks.map(block => block.id)).size).toBe(blocks.length)
  const ancestors: typeof blocks = []
  for (const block of blocks) {
    expect(block.depth).toBeGreaterThanOrEqual(0)
    expect(block.depth).toBeLessThanOrEqual(6)
    if (block.depth === 0) expect(block.parentBlockId).toBeNull()
    else {
      expect(['todo', 'numbered-todo', 'bulleted-list', 'numbered-list']).toContain(block.type)
      expect(ancestors[block.depth - 1]?.id).toBe(block.parentBlockId)
    }
    ancestors.length = block.depth + 1
    ancestors[block.depth] = block
  }
}

const scenarios = [
  { nested: false, html: true, label: 'root todo and HTML heading/paragraph' },
  { nested: true, html: true, label: 'nested todo and HTML heading/paragraph' },
  { nested: true, html: false, label: 'nested todo and plain-text paragraphs' }
]

for (const scenario of scenarios) test(`rich structural paste into ${scenario.label} retains the complete original child tree, history and reload @electron`, async () => {
  const context = await launchElectronApp({}, { editorMode: 'rich' })
  try {
    const { app, page } = context, title = `Rich tree paste ${scenario.label.replaceAll('/', ' and ')}`, initial = tree(scenario.nested)
    const id = await openFixture(page, title, initial), before = await readTree(page, id)
    const ownerIndex = scenario.nested ? 1 : 0
    await placeCaret(page, 'paste-parent', 5)
    await expect.poll(() => caretPoint(editor(page))).toEqual({ blockId: 'paste-parent', offset: 5 })
    await app.evaluate(({ clipboard }, html) => {
      clipboard.clear()
      clipboard.write(html ? {
        text: 'Copied heading\nCopied body',
        html: '<h2 data-block-id="foreign-tree-heading">Copied heading</h2><p data-block-id="foreign-tree-body"><strong>Copied body</strong></p>'
      } : { text: 'First paragraph\n\nSecond paragraph' })
    }, scenario.html)
    await page.keyboard.press('Control+v')
    await expect(rows(page)).toHaveCount(initial.length + 3)
    const pastedContents = scenario.html ? ['Copied heading', '**Copied body**'] : ['First paragraph', 'Second paragraph']
    await page.locator('.document-header-save-button').click()
    await expect.poll(async () => (await readTree(page, id)).map(block => block.content)).toEqual([
      ...(scenario.nested ? ['Outer'] : []), 'Alpha', 'Existing child', 'Existing grandchild', 'Other existing child',
      ...pastedContents, 'Beta', 'Tail sibling', 'Tail child', 'After stays'
    ])
    const after = await readTree(page, id)
    const firstPasted = after[ownerIndex + 4], secondPasted = after[ownerIndex + 5], suffix = after[ownerIndex + 6]
    expect(firstPasted).toMatchObject({ type: scenario.html ? 'heading-2' : 'paragraph', content: pastedContents[0], depth: 0, parentBlockId: null })
    expect(secondPasted).toMatchObject({ type: 'paragraph', content: pastedContents[1], depth: 0, parentBlockId: null })
    expect(suffix).toEqual({ ...before[ownerIndex], id: suffix.id, content: 'Beta', checked: false,
      depth: 0, parentBlockId: null, tags: [], highlight: null, listStart: null })
    for (const generated of [firstPasted, secondPasted, suffix]) {
      expect(before.some(block => block.id === generated.id)).toBe(false)
      expect(generated.id).not.toMatch(/^foreign-/)
    }
    const trailing = before.slice(ownerIndex + 4).map(block => scenario.nested && block.id === 'paste-tail'
      ? { ...block, depth: 0, parentBlockId: null }
      : scenario.nested && block.id === 'paste-tail-child' ? { ...block, depth: 1 } : block)
    const expected = [
      ...before.slice(0, ownerIndex), { ...before[ownerIndex], content: 'Alpha' },
      ...before.slice(ownerIndex + 1, ownerIndex + 4), firstPasted, secondPasted, suffix, ...trailing
    ]
    expect(after).toEqual(expected)
    assertTree(after)
    await expect(row(page, 'paste-parent').locator('input[type="checkbox"]')).toBeChecked()
    await expect(row(page, 'paste-child').locator('input[type="checkbox"]')).toBeChecked()
    await expect(row(page, 'paste-other-child').locator('input[type="checkbox"]')).not.toBeChecked()
    await expect(row(page, suffix.id).locator('input[type="checkbox"]')).not.toBeChecked()
    await editor(page).focus()
    await expect.poll(() => caretPoint(editor(page))).toEqual({ blockId: suffix.id, offset: 0 })
    await page.keyboard.press('Control+z')
    await expect(rows(page)).toHaveCount(initial.length)
    await expect(row(page, 'paste-parent')).toHaveText('AlphaBeta')
    await expect.poll(() => caretPoint(editor(page))).toEqual({ blockId: 'paste-parent', offset: 5 })
    await page.locator('.document-header-save-button').click()
    await expect.poll(() => readTree(page, id)).toEqual(before)
    await editor(page).focus()
    await page.keyboard.press('Control+Shift+z')
    await expect(rows(page)).toHaveCount(initial.length + 3)
    await expect.poll(() => caretPoint(editor(page))).toEqual({ blockId: suffix.id, offset: 0 })
    await page.locator('.document-header-save-button').click()
    await expect.poll(() => readTree(page, id)).toEqual(expected)
    await reopen(page, title)
    await expect(row(page, 'paste-parent')).toHaveText('Alpha')
    await expect(row(page, 'paste-grandchild')).toHaveText('Existing grandchild')
    await expect(row(page, suffix.id)).toHaveText('Beta')
    await expect(row(page, 'paste-parent').locator('input[type="checkbox"]')).toBeChecked()
    expect(await readTree(page, id)).toEqual(expected)
  } finally {
    await closeElectronApp(context)
  }
})

test('native screenshot paste into a nested todo owner keeps descendants, attachment integrity and the original undo caret @electron', async () => {
  const context = await launchElectronApp({}, { editorMode: 'rich' })
  try {
    const { app, page, tempRoot } = context, title = 'Rich tree screenshot paste', initial = tree(true)
    const id = await openFixture(page, title, initial), before = await readTree(page, id)
    const image = Buffer.from(await page.evaluate(() => {
      const canvas = document.createElement('canvas')
      canvas.width = 128; canvas.height = 96
      const context = canvas.getContext('2d')!
      context.fillStyle = '#1e293b'; context.fillRect(0, 0, 128, 96)
      context.fillStyle = '#5eead4'; context.fillRect(12, 14, 100, 22)
      context.fillStyle = '#3b82f6'; context.fillRect(12, 50, 44, 30)
      return canvas.toDataURL('image/png').split(',')[1]
    }), 'base64')
    await placeCaret(page, 'paste-parent', 5)
    await app.evaluate(({ clipboard, nativeImage }, data) => {
      clipboard.clear()
      clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(data)))
    }, [...image])
    await page.keyboard.press('Control+v')
    await expect(rows(page)).toHaveCount(initial.length + 2)
    const preview = editor(page).locator('[data-image-presentation] img.image-presentation-image')
    await expect(preview).toBeVisible()
    await expect.poll(() => preview.evaluate((image: HTMLImageElement) => [image.naturalWidth, image.naturalHeight]))
      .toEqual([128, 96])
    await page.locator('.document-header-save-button').click()
    await expect.poll(async () => (await readTree(page, id)).map(block => block.content).filter(content => !content.startsWith('![')))
      .toEqual(['Outer', 'Alpha', 'Existing child', 'Existing grandchild', 'Other existing child', 'Beta', 'Tail sibling', 'Tail child', 'After stays'])
    const after = await readTree(page, id), imageBlock = after[5], suffix = after[6]
    expect(imageBlock).toMatchObject({ type: 'paragraph', checked: false, depth: 0, parentBlockId: null })
    expect(imageBlock.content).toMatch(/^!\[.*\.png\]\(<file:[^>]+>\)$/)
    const attachmentUrl = imageBlock.content.match(/<([^>]+)>/)![1]
    const attachmentPath = fileURLToPath(attachmentUrl)
    expect(relative(tempRoot, attachmentPath)).not.toMatch(/^(?:\.\.(?:[\\/]|$)|[A-Za-z]:|[\\/])/)
    expect(existsSync(attachmentPath)).toBe(true)
    const importedBytes = readFileSync(attachmentPath), hash = createHash('sha256').update(importedBytes).digest('hex')
    expect(basename(dirname(attachmentPath))).toBe(hash)
    expect(basename(dirname(dirname(attachmentPath)))).toBe(hash.slice(0, 2))
    const attachment = await page.evaluate(url => window.knowbook.getAttachment(url), attachmentUrl)
    expect(attachment).toMatchObject({ url: attachmentUrl, kind: 'image', size: importedBytes.length })
    expect(suffix).toEqual({ ...before[1], id: suffix.id, content: 'Beta', checked: false,
      depth: 0, parentBlockId: null, tags: [], highlight: null, listStart: null })
    for (const generated of [imageBlock, suffix]) expect(before.some(block => block.id === generated.id)).toBe(false)
    const expected = [before[0], { ...before[1], content: 'Alpha' }, ...before.slice(2, 5), imageBlock, suffix,
      { ...before[5], depth: 0, parentBlockId: null }, { ...before[6], depth: 1 }, before[7]]
    expect(after).toEqual(expected)
    assertTree(after)
    await expect(row(page, 'paste-parent').locator('input[type="checkbox"]')).toBeChecked()
    await expect(row(page, 'paste-child').locator('input[type="checkbox"]')).toBeChecked()
    await expect(row(page, suffix.id).locator('input[type="checkbox"]')).not.toBeChecked()
    await editor(page).focus()
    await expect.poll(() => caretPoint(editor(page))).toEqual({ blockId: suffix.id, offset: 0 })
    await page.keyboard.press('Control+z')
    await expect(rows(page)).toHaveCount(initial.length)
    await expect(preview).toHaveCount(0)
    await expect.poll(() => caretPoint(editor(page))).toEqual({ blockId: 'paste-parent', offset: 5 })
    await page.locator('.document-header-save-button').click()
    await expect.poll(() => readTree(page, id)).toEqual(before)
    expect(existsSync(attachmentPath)).toBe(true)
    await editor(page).focus()
    await page.keyboard.press('Control+Shift+z')
    await expect(rows(page)).toHaveCount(initial.length + 2)
    await expect(preview).toBeVisible()
    await expect.poll(() => caretPoint(editor(page))).toEqual({ blockId: suffix.id, offset: 0 })
    await page.locator('.document-header-save-button').click()
    await expect.poll(() => readTree(page, id)).toEqual(expected)
    await reopen(page, title)
    await expect(preview).toBeVisible()
    await expect.poll(() => preview.evaluate((image: HTMLImageElement) => [image.naturalWidth, image.naturalHeight]))
      .toEqual([128, 96])
    expect(await readTree(page, id)).toEqual(expected)
    expect(createHash('sha256').update(readFileSync(attachmentPath)).digest('hex')).toBe(hash)
  } finally {
    await closeElectronApp(context)
  }
})
