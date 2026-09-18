import { expect, test } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { withElectronApp, uiText } from './helpers/electron'
import { advancedMarkdown } from '../tests/fixtures/markdown-advanced'

test('advanced Markdown previews, navigation, invalid input and file round trips work together @electron', async () => {
  test.setTimeout(180_000)
  await withElectronApp(async ({ app, page, tempRoot }) => {
    await page.route('https://example.test/callout.png', (route) => route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7isAAAAASUVORK5CYII=', 'base64') }))
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const id = await page.evaluate(async () => {
      const { id } = await window.knowbook.createDocument(null)
      await window.knowbook.updateDocument(id, { title: 'Advanced', summary: '', blocks: [{ type: 'paragraph', content: '', checked: false, depth: 0 }] })
      return id
    })
    const reopen = async () => { await page.reload(); await page.locator('.tree-button', { hasText: 'Advanced' }).first().click() }
    await reopen()
    await page.locator('textarea.block-inline-textarea').first().evaluate((element, source) => {
      const input = element as HTMLTextAreaElement
      input.focus()
      const data = new DataTransfer()
      data.setData('text/plain', source)
      input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }))
    }, advancedMarkdown.replace('> > Keep ==important== text.', '> > Keep ==important== text. ![Callout image](https://example.test/callout.png)').replace('| [^note] |', '| [^note] ^[Table note] |'))
    const diagram = page.locator('.markdown-mermaid')
    await expect.poll(() => diagram.locator('img').evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    await expect(page.locator('.markdown-footnotes > ol > li')).toHaveCount(5)
    await expect(page.locator('.markdown-footnote-reference button')).toHaveCount(8)
    await expect(page.locator('.block-table-content .markdown-inline-math')).toHaveCount(1)
    await expect(page.locator('.markdown-advanced-preview mark strong')).toHaveText('bold')
    await expect(page.locator('.markdown-footnote-missing')).toHaveText('[^missing]')
    await expect.poll(async () => (await page.evaluate((id) => window.knowbook.getDocumentDetail(id), id))?.blocks.some((block) => block.content.includes('[^note]:'))).toBe(true)

    await page.locator('.document-view-toggle').click()
    await expect(page.locator('.document-reading-row.type-table .markdown-footnote-reference button')).toHaveCount(2)
    const callout = page.locator('details[data-callout="tip"]')
    await expect(callout).toHaveAttribute('open', '')
    const nested = callout.locator('details[data-callout="warning"]')
    await expect(nested).not.toHaveAttribute('open')
    await expect(nested.locator('img')).toBeHidden()
    await nested.locator('summary').click()
    await expect(nested.locator('mark')).toBeVisible()
    await expect(nested.locator('img')).toBeVisible()
    const reference = page.locator('.document-reading-row.type-paragraph .markdown-footnote-reference button').first()
    const referenceId = await reference.getAttribute('id')
    await reference.click()
    await expect(page.locator('.markdown-footnotes > ol > li').first()).toBeFocused()
    await page.locator('.document-reading-row.type-heading-1 .reading-collapse').click()
    await expect(reference).toHaveCount(0)
    await page.locator('.markdown-footnotes > ol > li').first().locator('.markdown-footnote-backref').first().click()
    await expect(page.locator(`[id=${JSON.stringify(referenceId)}]`)).toBeFocused()
    await page.locator('.markdown-toc button').last().click()
    await expect(page.locator('.document-reading-row.type-heading-2').last()).toBeInViewport()
    await callout.scrollIntoViewIfNeeded()
    await page.screenshot({ path: 'test-results/markdown-advanced-reading.png' })
    await diagram.scrollIntoViewIfNeeded()
    await expect.poll(() => diagram.locator('img').evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    await page.screenshot({ path: 'test-results/markdown-advanced-diagram.png' })

    await page.locator('.document-view-toggle').click()
    const code = page.locator('textarea.type-code')
    const originalCode = await code.inputValue()
    await code.fill('flowchart LR\n  A[unfinished')
    await expect(diagram.locator('.markdown-render-error')).toBeVisible()
    await expect(diagram.locator('pre')).toContainText('A[unfinished')
    await expect(diagram.locator('img')).toHaveCount(0)
    await code.fill('sequenceDiagram\n  Alice->>Bob: Ready')
    await expect.poll(() => diagram.locator('img').evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    await code.fill(originalCode)
    const math = page.locator('textarea.type-math').first()
    const originalMath = await math.inputValue()
    await math.fill('\\invalid{x}')
    await expect(math.locator('xpath=ancestor::*[contains(@class,"block-editor-row")][1]').locator('.markdown-render-error')).toContainText('\\invalid{x}')
    await math.fill(originalMath)
    await expect(page.locator('.markdown-render-error')).toHaveCount(0)
    await expect.poll(async () => (await page.evaluate((id) => window.knowbook.getDocumentDetail(id), id))?.blocks.find((block) => block.type === 'math')?.content).toBe(originalMath)
    const before = (await page.evaluate((id) => window.knowbook.getDocumentDetail(id), id))!.blocks
    await reopen()
    await expect.poll(() => diagram.locator('img').evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)

    const directory = join(tempRoot, 'advanced-export')
    mkdirSync(directory)
    const filePath = join(directory, 'Advanced.md')
    await app.evaluate(({ dialog }, { directory, filePath }) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as typeof dialog.showSaveDialog
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [directory] })) as typeof dialog.showOpenDialog
      dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox
    }, { directory, filePath })
    const exportFile = async () => {
      writeFileSync(filePath, '')
      await page.locator('.document-header-more-button').click()
      await page.locator('.document-header-action-menu').getByRole('button', { name: uiText('Save MD', '导出 Markdown') }).click()
      await expect.poll(() => readFileSync(filePath, 'utf8')).toContain('[^note]: Definition')
      return readFileSync(filePath, 'utf8')
    }
    const exported = await exportFile()
    expect(exported).toContain('[!tip]+ A **formatted** title[^tip]')
    expect(exported).toContain('```mermaid')
    expect(exported).toContain('[TOC]')
    await page.evaluate(() => window.knowbook.restoreBackupFromFolder())
    await reopen()
    const after = (await page.evaluate((id) => window.knowbook.getDocumentDetail(id), id))!.blocks
    const content = (blocks: typeof after) => blocks.map(({ type, content, checked, depth, markdownFormat, language }) => ({ type, content, checked, depth, markdownFormat, language }))
    expect(content(after)).toEqual(content(before))
    expect(await exportFile()).toBe(exported)
    expect(errors).toEqual([])
  })
})

test('Mermaid initialization directives cannot enable active HTML or callbacks @electron', async () => {
  await withElectronApp(async ({ page }) => {
    await page.evaluate(async () => {
      const { id } = await window.knowbook.createDocument(null)
      await window.knowbook.updateDocument(id, { title: 'Diagram safety', summary: '', blocks: [{ type: 'code', language: 'mermaid', checked: false, depth: 0,
        content: '%%{init: {"securityLevel":"loose","htmlLabels":true,"flowchart":{"htmlLabels":true}}}%%\nflowchart LR\n A["<b>Label</b>"]-->B[End]\n click A "javascript:window.__diagramExecuted=true"' }] })
    })
    await page.reload()
    await page.locator('.tree-button', { hasText: 'Diagram safety' }).first().click()
    const preview = page.locator('.markdown-mermaid')
    await expect(preview.locator('img')).toBeVisible()
    const svg = await preview.locator('img').getAttribute('src')
    expect(decodeURIComponent(svg!)).not.toMatch(/<script|<foreignObject|(?:xlink:)?href="javascript:|onerror=/i)
    await preview.locator('img').click()
    expect(await page.evaluate(() => '__diagramExecuted' in window)).toBe(false)
  })
})
