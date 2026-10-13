import { expect, test, type Locator, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { serializeImageFigure, type ImagePresentation } from '../src/shared/markdownMedia'
import { collectMarkdownImageOccurrences } from '../src/shared/markdownMediaOccurrences'
import { closeElectronApp, launchElectronApp } from './helpers/electron'

type EditorMode = 'rich' | 'markdown'
const images = (page: Page) => page.locator('.preview-panel [data-image-presentation]')
const first = (page: Page) => images(page).nth(0)
const second = (page: Page) => images(page).nth(1)
const frame = (image: Locator) => image.locator('.image-presentation-frame')
const width = (image: Locator) => frame(image).evaluate(node => Number.parseFloat((node as HTMLElement).style.width))
const assetHash = (url: string) => createHash('sha256').update(readFileSync(fileURLToPath(url))).digest('hex')
const paragraph = (id: string, content: string): DocumentBlockDraft => ({ id, type: 'paragraph', content, checked: false, depth: 0 })

async function fixture(page: Page, title: string) {
  // Produce actual PNG bytes in Chromium, then import through the real IPC.
  // The persisted managed file is also the oracle for non-destructive edits.
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 640; canvas.height = 360
    const context = canvas.getContext('2d')!
    context.fillStyle = '#0f172a'; context.fillRect(0, 0, 640, 360)
    context.fillStyle = '#22d3ee'; context.fillRect(0, 0, 160, 180)
    context.fillStyle = '#fbbf24'; context.fillRect(480, 180, 160, 180)
    context.fillStyle = '#f472b6'; context.fillRect(160, 90, 320, 180)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  const url = await page.evaluate(async bytes => {
    const [asset] = await window.knowbook.importAttachments([{ name: 'Presentation same [1].png', bytes: new Uint8Array(bytes) }])
    return asset.url
  }, Array.from(Buffer.from(png, 'base64')))
  const firstValue: ImagePresentation = { src: url, alt: 'First original alt', caption: 'First original caption', width: 280, align: 'left' }
  const secondValue: ImagePresentation = { src: url, alt: 'Second untouched alt', caption: 'Second untouched caption', width: 240, align: 'left' }
  const content = `${serializeImageFigure(firstValue)}\n\n${serializeImageFigure(secondValue)}`
  const blocks = [paragraph('presentation-before', 'Before images'), paragraph('presentation-images', content), paragraph('presentation-after', 'After images')]
  const id = await page.evaluate(async ({ title, blocks }) => {
    const { id } = await window.knowbook.createDocument(null)
    await window.knowbook.updateDocument(id, { title, summary: '', blocks })
    return id
  }, { title, blocks })
  await reopen(page, title)
  await expect(images(page)).toHaveCount(2)
  await expect.poll(() => first(page).locator('.block-rich-media-image').evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(640)
  return { id, url, originalHash: assetHash(url), firstValue, secondValue }
}

async function reopen(page: Page, title: string) {
  await page.reload()
  await page.locator('.tree-button', { hasText: title }).first().click()
  await expect(page.locator('.document-header-title')).toHaveText(title)
}

async function savedImages(page: Page, id: string) {
  const detail = await page.evaluate(id => window.knowbook.getDocumentDetail(id), id)
  const block = detail?.blocks.find(block => block.id === 'presentation-images')
  expect(block).toBeDefined()
  return collectMarkdownImageOccurrences(block!.content).map(occurrence => occurrence.presentation)
}

async function save(page: Page) { await page.locator('.document-header-save-button').click() }

async function focusBody(page: Page, mode: EditorMode) {
  if (mode === 'markdown') {
    await page.locator('.block-editor-row[data-block-id="presentation-before"] textarea.block-inline-textarea').focus()
    return
  }
  const editor = page.locator('.knowbook-rich-text-editor')
  await editor.focus()
  // Use a real DOM Range as the rich editor's selection, then deliver actual
  // undo keys. This does not invoke the editor's transaction/history APIs.
  await editor.evaluate(root => {
    const row = root.querySelector('[data-block-id="presentation-before"]')!
    const text = document.createTreeWalker(row, NodeFilter.SHOW_TEXT).nextNode()!
    const range = document.createRange()
    range.setStart(text, 0); range.collapse(true)
    const selection = window.getSelection()!
    selection.removeAllRanges(); selection.addRange(range)
  })
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function selectImage(image: Locator) {
  await frame(image).click()
  await expect(image.locator('[data-image-controls]')).toBeVisible()
}

async function drag(page: Page, handle: Locator, delta: { x: number; y: number }, cancel = false, interior = { x: .5, y: .5 }) {
  await handle.scrollIntoViewIfNeeded()
  const bounds = await handle.boundingBox()
  expect(bounds).not.toBeNull()
  const start = { x: bounds!.x + bounds!.width * interior.x, y: bounds!.y + bounds!.height * interior.y }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  try {
    await page.mouse.move(start.x + delta.x, start.y + delta.y, { steps: 12 })
    if (cancel) await page.keyboard.press('Escape')
  } finally { await page.mouse.up() }
}

for (const mode of ['rich', 'markdown'] as const) {
  test(`${mode} image resize, crop, caption and alt edits preserve occurrences, history and original bytes @electron`, async ({}, testInfo) => {
    test.setTimeout(120000)
    const context = await launchElectronApp({}, { editorMode: mode })
    try {
      const { page } = context
      await page.setViewportSize({ width: 1360, height: 1000 })
      const title = `Image presentation ${mode}`
      const editedCaption = '可见说明 / visible caption\n\n独立第二段 / second paragraph'
      const { id, url, originalHash, firstValue, secondValue } = await fixture(page, title)
      await selectImage(first(page))
      await drag(page, first(page).locator('[data-image-resize]'), { x: 80, y: 45 })
      await expect.poll(() => width(first(page))).toBe(360)
      await focusBody(page, mode)
      await page.keyboard.press('Control+z')
      // One undo must revert the entire gesture, including every mouse move.
      await expect.poll(() => width(first(page))).toBe(280)
      await save(page)
      await expect.poll(() => savedImages(page, id)).toEqual([firstValue, secondValue])

      await selectImage(first(page))
      await drag(page, first(page).locator('[data-image-resize]'), { x: 80, y: 45 })
      await expect.poll(() => width(first(page))).toBe(360)
      await drag(page, first(page).locator('[data-image-resize]'), { x: 55, y: 30 }, true)
      await expect.poll(() => width(first(page))).toBe(360)
      await first(page).locator('[data-image-align-button="right"]').click()
      await expect(first(page)).toHaveAttribute('data-image-align', 'right')
      await expect(second(page)).toHaveAttribute('data-image-align', 'left')

      await first(page).locator('[data-image-crop-toggle]').click()
      const stage = first(page).locator('[data-image-crop-stage]')
      await stage.scrollIntoViewIfNeeded()
      const stageBounds = (await stage.boundingBox())!
      // The corner's visible inner quadrant is the trusted mouse target.
      await drag(page, first(page).locator('[data-image-crop-handle="nw"]'), { x: stageBounds.width * .1, y: stageBounds.height * .15 }, false, { x: .8, y: .8 })
      const croppedLeft = await first(page).locator('.block-rich-media-image').evaluate((image: HTMLImageElement) => image.style.left)
      expect(Number.parseFloat(croppedLeft)).toBeLessThan(-5)
      await drag(page, first(page).locator('[data-image-crop-area]'), { x: stageBounds.width * .03, y: 0 }, true)
      expect(await first(page).locator('.block-rich-media-image').evaluate((image: HTMLImageElement) => image.style.left)).toBe(croppedLeft)
      await first(page).locator('[data-image-crop-toggle]').click()

      await first(page).locator('[data-image-alt-input]').fill('独立替代文本 / independent alt')
      await first(page).locator('[data-image-alt-input]').press('Enter')
      await expect(first(page).locator('.block-rich-media-image')).toHaveAttribute('alt', '独立替代文本 / independent alt')
      await expect(first(page).locator('[data-image-caption]')).toHaveText('First original caption')
      await first(page).locator('[data-image-caption-input]').fill(editedCaption)
      // Save immediately blurs the caption. Its synchronous commit must be
      // included in this same save, without a second click or explicit wait.
      await save(page)
      await expect.poll(async () => (await savedImages(page, id))[0].caption).toBe(editedCaption)
      const changed = await savedImages(page, id)
      expect(changed[0]).toMatchObject({ src: url, alt: '独立替代文本 / independent alt', caption: editedCaption, align: 'right', width: 360 })
      expect(changed[0].crop?.x).toBeCloseTo(.1, 2)
      expect(changed[0].crop?.y).toBeCloseTo(.15, 2)
      expect(changed[0].crop?.width).toBeCloseTo(.9, 2)
      expect(changed[0].crop?.height).toBeCloseTo(.85, 2)
      expect(changed[1]).toEqual(secondValue)

      await selectImage(first(page))
      await first(page).locator('[data-image-open-original]').click()
      const preview = page.locator('.attachment-image-dialog')
      await expect(preview).toBeVisible()
      await expect(preview.getByRole('status')).toContainText('640 × 360')
      await expect(preview.locator('h2')).toHaveText('独立替代文本 / independent alt')
      await page.keyboard.press('Escape')
      await expect(preview).toHaveCount(0)

      await first(page).locator('[data-image-editor-close]').click()
      await selectImage(second(page))
      await second(page).locator('[data-image-align-button="center"]').click()
      await second(page).locator('[data-image-caption-input]').fill('Only the second occurrence changed')
      await save(page)
      await expect.poll(async () => (await savedImages(page, id))[1].caption).toBe('Only the second occurrence changed')
      const persisted = await savedImages(page, id)
      expect(persisted[0]).toEqual(changed[0])
      expect(persisted[1]).toEqual({ ...secondValue, align: 'center', caption: 'Only the second occurrence changed' })
      expect(assetHash(url)).toBe(originalHash)

      await reopen(page, title)
      await expect(images(page)).toHaveCount(2)
      await expect.poll(() => width(first(page))).toBe(360)
      await expect(first(page)).toHaveAttribute('data-image-align', 'right')
      await expect(second(page)).toHaveAttribute('data-image-align', 'center')
      await expect(first(page).locator('[data-image-caption]')).toHaveText(editedCaption)
      await expect(second(page).locator('.block-rich-media-image')).toHaveAttribute('alt', secondValue.alt)
      await page.locator('.document-view-toggle').click()
      await expect(page.locator('.document-view-toggle')).toHaveAttribute('aria-pressed', 'true')
      await expect(images(page)).toHaveCount(2)
      await expect(images(page).locator('[data-image-controls]')).toHaveCount(0)
      await expect(first(page).locator('[data-image-caption]')).toHaveText(editedCaption)
      await expect(first(page).locator('.block-rich-media-image')).toHaveAttribute('alt', '独立替代文本 / independent alt')
      await expect.poll(() => first(page).locator('.block-rich-media-image').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(640)
      await expect.poll(() => first(page).locator('.block-rich-media-image').evaluate((image: HTMLImageElement) => Number.parseFloat(image.style.left))).toBeLessThan(-5)
      const cropGeometry = await first(page).evaluate(node => {
        const viewport = node.querySelector('.image-presentation-viewport')!, image = node.querySelector('img')!
        return { overflow: getComputedStyle(viewport).overflow, viewport: viewport.getBoundingClientRect().toJSON(), image: image.getBoundingClientRect().toJSON() }
      })
      expect(cropGeometry.overflow).toBe('hidden')
      expect(cropGeometry.image.x).toBeLessThan(cropGeometry.viewport.x)
      expect(cropGeometry.image.width).toBeGreaterThan(cropGeometry.viewport.width)
      for (const presentation of await images(page).all()) {
        const geometry = await presentation.evaluate(node => ({
          frame: node.querySelector('.image-presentation-frame')!.getBoundingClientRect().toJSON(),
          caption: node.querySelector('[data-image-caption]')!.getBoundingClientRect().toJSON()
        }))
        expect(Math.abs(geometry.caption.x - geometry.frame.x)).toBeLessThan(1)
        expect(Math.abs(geometry.caption.width - geometry.frame.width)).toBeLessThan(1)
      }
      expect(assetHash(url)).toBe(originalHash)
      await page.screenshot({ path: testInfo.outputPath(`image-presentation-${mode}-reading.png`), fullPage: true })
    } finally { await closeElectronApp(context) }
  })

  test(`${mode} linked and unsupported images keep their own occurrence and surrounding source @electron`, async ({}, testInfo) => {
    const context = await launchElectronApp({}, { editorMode: mode })
    try {
      const { page } = context
      const title = `Image source boundaries ${mode}`
      const { id, url, originalHash } = await fixture(page, title)
      const original = `Before [![Linked](${url})](https://example.test) Middle <img src="${url}" alt="Unsupported" width="50%"> After ![Normal](${url})`
      await page.evaluate(async ({ id, title, content }) => window.knowbook.updateDocument(id, { title, summary: '', blocks: [
        { id: 'presentation-before', type: 'paragraph', content: 'Before images', checked: false, depth: 0 },
        { id: 'presentation-images', type: 'paragraph', content, checked: false, depth: 0 },
        { id: 'presentation-after', type: 'paragraph', content: 'After images', checked: false, depth: 0 }
      ] }), { id, title, content: original })
      await reopen(page, title)
      const linked = images(page).filter({ has: page.locator('img[alt="Linked"]') })
      const normal = images(page).filter({ has: page.locator('img[alt="Normal"]') })
      await expect(linked).toHaveCount(1)
      await expect(normal).toHaveCount(1)
      await expect(page.locator('.preview-panel img[alt="Unsupported"]')).toBeVisible()
      if (mode === 'rich') {
        await expect(page.locator('.rich-text-source-preview img[alt="Linked"]')).toBeHidden()
        await expect(page.locator('.rich-text-source-preview img[alt="Normal"]')).toBeHidden()
      }
      await selectImage(linked)
      const caption = '段内第一行\n\n第二段说明'
      await linked.locator('[data-image-caption-input]').fill(caption)
      await save(page)
      const detail = await page.evaluate(id => window.knowbook.getDocumentDetail(id), id)
      const content = detail!.blocks.find(block => block.id === 'presentation-images')!.content
      expect(content).toContain(`](https://example.test) Middle <img src="${url}" alt="Unsupported" width="50%"> After ![Normal](${url})`)
      expect(content).toContain('Before [<figure')
      const persisted = await savedImages(page, id)
      expect(persisted.map(image => image.alt)).toEqual(['Linked', 'Normal'])
      expect(persisted[0].caption).toBe(caption)
      expect(persisted[1].caption).toBe('')
      await reopen(page, title)
      await page.locator('.document-view-toggle').click()
      await expect(page.locator('.preview-panel img')).toHaveCount(3)
      await expect(page.locator('.preview-panel img[alt="Linked"]')).toBeVisible()
      await expect(page.locator('.preview-panel img[alt="Unsupported"]')).toBeVisible()
      await expect(page.locator('.preview-panel img[alt="Normal"]')).toBeVisible()
      await expect(images(page).filter({ has: page.locator('img[alt="Linked"]') }).locator('[data-image-caption]')).toHaveText(caption)
      expect(assetHash(url)).toBe(originalHash)
      await page.screenshot({ path: testInfo.outputPath(`image-source-boundaries-${mode}.png`), fullPage: true })
    } finally { await closeElectronApp(context) }
  })
}
