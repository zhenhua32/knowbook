import { expect, test, type Locator } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import { withElectronApp, uiText } from './helpers/electron'
import { sourceEditingBlocks } from '../tests/fixtures/markdown-source-performance'

// Measure inside the renderer, starting at the trusted input/click/keydown
// event. Two animation frames include a rendering opportunity, not OS display latency.
async function measureNextFrame(target: Locator, eventName: 'input' | 'click' | 'keydown', name: string) {
  await target.evaluate((element, { eventName, name }) => {
    const listener = (event: Event) => {
      if (eventName === 'keydown' && (event as KeyboardEvent).key.toLowerCase() !== 'b') return
      element.removeEventListener(eventName, listener, true)
      if (!event.isTrusted) throw new Error('Expected trusted input')
      const start = performance.now()
      const frame = () => requestAnimationFrame(() => requestAnimationFrame(() => performance.measure(name, { start, end: performance.now() })))
      if (name === 'source-open-frame' && !document.querySelector('.document-markdown-source textarea')) {
        const observer = new MutationObserver(() => {
          if (document.querySelector('.document-markdown-source textarea')) { observer.disconnect(); frame() }
        })
        observer.observe(document.body, { childList: true, subtree: true })
      } else frame()
    }
    element.addEventListener(eventName, listener, { capture: true })
  }, { eventName, name })
}

for (const count of [800, 4000]) test(`full Markdown source input and batch formatting stay responsive for ${count} blocks @electron`, async () => {
  test.setTimeout(240_000)
  await withElectronApp(async ({ page }) => {
    const blocks = sourceEditingBlocks(count)
    const { id, ids } = await page.evaluate(async blocks => {
      const { id } = await window.knowbook.createDocument(null)
      await window.knowbook.updateDocument(id, { title: 'Large source editing', summary: '', blocks })
      return { id, ids: (await window.knowbook.getDocumentDetail(id))!.blocks.map(block => block.id) }
    }, blocks)
    await page.reload()
    await page.locator('.tree-button', { hasText: 'Large source editing' }).click()
    await expect(page.locator('[data-block-index]')).toHaveCount(count, { timeout: 60_000 })
    const open = async () => {
      await page.locator('.document-header-more-button').click()
      const button = page.locator('.document-header-action-menu').getByRole('button', { name: uiText('Edit Markdown source', '编辑 Markdown 源码'), exact: true })
      await measureNextFrame(button, 'click', 'source-open-frame')
      await button.click()
    }
    const profiler = process.env.KNOWBOOK_PROFILE_MARKDOWN === '1' ? await page.context().newCDPSession(page) : null
    if (profiler) { await profiler.send('Profiler.enable'); await profiler.send('Profiler.start') }
    const dialog = page.locator('.document-markdown-source')
    const editor = dialog.getByRole('textbox', { name: uiText('Markdown body source', 'Markdown 正文源码') })
    try { await open(); await expect(editor).toBeFocused({ timeout: 60_000 }) }
    finally {
      if (profiler) {
        mkdirSync('test-results', { recursive: true })
        writeFileSync(`test-results/markdown-source-open-${count}.cpuprofile`, JSON.stringify((await profiler.send('Profiler.stop')).profile))
        await profiler.detach()
      }
    }
    const original = await editor.inputValue()
    const entries = (name: string) => page.evaluate(name => performance.getEntriesByName(name).map(entry => entry.duration), name)
    let inputCount = 0
    for (const index of [1, Math.floor(count / 2) + 1, count - 2]) {
      await editor.evaluate((input, index) => {
        const textarea = input as HTMLTextAreaElement, prefix = `段落 ${index} `
        const caret = textarea.value.indexOf(prefix) + prefix.length
        if (caret < prefix.length) throw new Error('Missing paragraph')
        textarea.setSelectionRange(caret, caret)
      }, index)
      for (const text of ['中文', '日本語', '한글', '🙂', ' editing ']) {
        await measureNextFrame(editor, 'input', 'source-input-frame')
        await page.keyboard.insertText(text)
        await expect.poll(async () => (await entries('source-input-frame')).length).toBe(++inputCount)
      }
    }
    const edited = await editor.inputValue()
    let formatted = ''
    for (let index = 0; index < 9; index++) {
      await editor.press('Control+a')
      await measureNextFrame(editor, 'keydown', 'source-format-frame')
      await editor.press('Control+b')
      await expect.poll(async () => (await entries('source-format-frame')).length).toBe(index + 1)
      formatted = await editor.inputValue()
      expect(formatted).toContain('## **章节 0 · Source editing**')
      expect(formatted).toContain('**段落 1 中文日本語한글🙂 editing ')
      if (index < 8) { await editor.press('Control+z'); await expect(editor).toHaveValue(edited) }
    }
    await editor.press('Control+z'); await expect(editor).toHaveValue(edited)
    await editor.press('Control+Shift+Z'); await expect(editor).toHaveValue(formatted)
    const apply = dialog.getByRole('button', { name: uiText('Apply changes', '应用更改'), exact: true })
    await measureNextFrame(apply, 'click', 'source-apply-frame')
    await apply.click()
    await expect(editor).toHaveCount(0)
    await expect.poll(async () => (await page.evaluate(id => window.knowbook.getDocumentDetail(id), id))?.blocks[1].content,
      { timeout: 30_000 }).toMatch(/^\*\*段落 1 中文日本語한글🙂 editing /)
    const saved = (await page.evaluate(id => window.knowbook.getDocumentDetail(id), id))!
    expect(saved.blocks.map(block => block.id)).toEqual(ids)
    expect(saved.blocks.map(block => block.tags)).toEqual(blocks.map(block => block.tags))
    for (let index = 19; index < count; index += 20) expect(saved.blocks[index].content).toBe(blocks[index].content)
    await expect.poll(async () => (await entries('source-apply-frame')).length).toBe(1)
    const metrics = []
    for (const [name, warmups, ceilingMs] of [
      ['source-open-frame', 0, 3000], ['source-input-frame', 0, 500],
      ['source-format-frame', 2, 1500], ['source-apply-frame', 0, 8000]
    ] as const) {
      const samplesMs = (await entries(name)).slice(warmups), sorted = samplesMs.toSorted((a, b) => a - b)
      metrics.push({ name, warmups, samplesMs, medianMs: sorted[Math.floor(sorted.length / 2)],
        p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], ceilingMs })
    }
    await page.reload(); await page.locator('.tree-button', { hasText: 'Large source editing' }).click()
    await open(); await expect(editor).toHaveValue(formatted)
    mkdirSync('test-results', { recursive: true })
    const sourceFiles = ['src/renderer/src/components/DocumentMarkdownSourceDialog.tsx',
      'src/renderer/src/utils/markdownSourceDraft.ts', 'src/renderer/src/utils/markdownFormatting.ts', 'src/shared/markdown.ts']
    writeFileSync(`test-results/markdown-source-frame-${count}.json`, JSON.stringify({ recordedAt: new Date().toISOString(),
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(),
      workingTreeChanged: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', windowsHide: true }).trim()),
      sourceFiles, sourceFingerprint: createHash('sha256').update(sourceFiles.map(path => path + '\n' + readFileSync(path, 'utf8').replace(/\r\n/g, '\n')).join('\n')).digest('hex'),
      blocks: count, characters: original.length, sourceSha256: createHash('sha256').update(original).digest('hex'),
      environment: { platform: process.platform, cpu: os.cpus()[0]?.model, renderer: await page.evaluate(() => navigator.userAgent) },
      method: 'Trusted event to second animation frame; opening also waits for the lazy editor DOM. GPU disabled. Input at beginning/middle/end. Format: two warmups and seven samples. Open/apply each have one sample. Ceilings detect regressions, not OS screen latency or competitor performance.',
      reload: true, blockIds: true, tags: true, literalCode: true, metrics }, null, 2) + '\n')
    await page.screenshot({ path: `test-results/markdown-source-frame-${count}.png` })
    for (const metric of metrics) expect(metric.p95Ms, JSON.stringify(metric)).toBeLessThan(metric.ceilingMs)
  })
})
