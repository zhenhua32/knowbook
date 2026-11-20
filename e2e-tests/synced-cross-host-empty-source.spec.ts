import { expect, test, type Page } from '@playwright/test'
import { inlineInstance, openInlineHost, setInlineReading, withCanonicalInlineApp } from './helpers/canonical-inline'
import { hasBuiltElectronApp, uiText } from './helpers/electron'

async function historyAction(page: Page, action: 'Undo' | 'Redo') {
  await page.locator('.document-header-more-button').click()
  const label = uiText(action, action === 'Undo' ? '撤销' : '重做')
  const button = page.locator('.document-header-action-menu').getByRole('button', { name: label, exact: true })
  await expect(button).toBeEnabled()
  await button.click()
}

test.skip(!hasBuiltElectronApp(), 'Build the actual local Electron app before this acceptance slice')

for (const syntax of ['none', 'inline', 'reference-and-html'] as const) test(`moves every source root and keeps one stable blank paragraph${syntax === 'none' ? ''
  : syntax === 'inline' ? ' with two dependent pages' : ' with reference definitions and safe HTML'} across restart, Undo and Redo @electron`, async ({}, info) => {
  await withCanonicalInlineApp(info, async fixture => {
    const [source, destination] = fixture.seed.hosts
    let { page } = fixture.context()
    const instanceId = fixture.seed.instanceIds[0]
    const linkContents = (title: string, moved: boolean) => {
      const link = `${encodeURIComponent(title)}.md?view=1#^${instanceId}`
      if (syntax === 'none') return []
      if (syntax === 'inline') return [`[block](${link})`, `[[${title}#${instanceId}|kept alias]]`]
      const query = moved ? '&#38;tab&#61;2' : '&amp;tab=2'
      return [`Use [block][picked], also [picked].\n\n[picked]: <${link}> "kept title"`,
        `<a title="kept title" href="${encodeURIComponent(title)}.md?view${moved ? '&#61;' : '='}1${query}#^${instanceId}">HTML block</a>`]
    }
    const dependents = await page.evaluate(async (contents) => {
      const result = []
      for (const [index, content] of contents.entries()) {
        const { id } = await window.knowbook.createDocument(null)
        const pageTitle = `Outside link ${index}`, blockId = crypto.randomUUID()
        await window.knowbook.updateDocument(id, { title: pageTitle, summary: '', blocks: [{ id: blockId, type: 'paragraph', content, checked: false, depth: 0 }] })
        result.push({ id, title: pageTitle, blockId })
      }
      return result
    }, linkContents(source.title, false))
    // An ordinary host row and the move dialog can be available while the
    // canonical shell is still starting after a reload.
    const shellChunk = '**/CanonicalInlineShell-*.js'
    let shellRequested = false
    let resumeShell: () => void = () => {}
    if (syntax === 'inline') {
      const released = new Promise<void>(resolve => { resumeShell = resolve })
      await page.route(shellChunk, async route => {
        shellRequested = true
        await released
        await route.continue()
      })
    }
    const readPages = () => page.evaluate(async ids => Promise.all(ids.map(async id => {
      const document = await window.knowbook.getDocumentDetail(id)
      if (!document) throw new Error('The actual edited document is missing')
      return document.blocks
    })), [source.id, destination.id, ...dependents.map(page => page.id)])
    const blockIds = () => readPages().then(pages => pages.slice(0, 2).map(blocks => blocks.map(block => block.id)))
    const assertLinks = async (title: string, moved: boolean) => {
      const actual = (await readPages()).slice(2).map(blocks => blocks.map(block => [block.id, block.content]))
      const expected = linkContents(title, moved)
      expect(actual).toEqual(dependents.map(({ blockId }, index) => [[blockId, expected[index]]]))
    }
    const row = (id: string) => page.locator(`.block-editor-row[data-block-id="${id}"]`)
    const initial = [source, destination].map(host => host.blocks.map(block => block.id))
    const expectedDestination = [...initial[1], ...initial[0]]

    const dialog = page.locator('.document-block-move-dialog')
    const move = dialog.getByRole('button', { name: uiText('Move', '移动'), exact: true })
    try {
      if (dependents.length) await page.reload({ waitUntil: syntax === 'inline' ? 'domcontentloaded' : 'load' })
      await openInlineHost(page, source)
      await setInlineReading(page, false)
      const firstInput = row(source.blocks[0].id).locator('textarea.block-inline-textarea')
      await firstInput.focus()
      await expect(firstInput).toBeFocused()
      await page.keyboard.press('ControlOrMeta+a')
      await page.keyboard.press('ControlOrMeta+a')
      await expect.poll(() => page.locator('.block-editor-row-selected').evaluateAll(rows =>
        rows.map(element => element.getAttribute('data-block-id')))).toEqual(initial[0])
      await page.locator('.block-selection-toolbar').getByRole('button', {
        name: uiText('Move to document…', '移动到文档…'), exact: true
      }).click()
      await dialog.locator('.document-capture-field input').fill(destination.title)
      await dialog.locator(`input[value="${destination.id}"]`).check()
      if (syntax === 'inline') {
        await expect.poll(() => shellRequested).toBe(true)
        await expect(move).toBeDisabled()
      }
    } finally {
      resumeShell()
      if (syntax === 'inline') await page.unrouteAll({ behavior: 'wait' })
    }
    await move.click()
    await expect(dialog).toHaveCount(0)
    await expect.poll(async () => (await blockIds())[1]).toEqual(expectedDestination)
    const [blank] = (await readPages())[0]
    expect(blank).toMatchObject({ type: 'paragraph', content: '', checked: false, depth: 0, parentBlockId: null })
    expect(initial.flat()).not.toContain(blank.id)
    const final = [[blank.id], expectedDestination]
    await expect.poll(blockIds).toEqual(final)
    await expect(row(blank.id)).toBeVisible()
    await assertLinks(destination.title, true)

    await fixture.restart()
    ;({ page } = fixture.context())
    const undoHost = dependents.at(-1) ?? destination
    await page.locator('.tree-button', { hasText: undoHost.title }).first().click()
    await expect(page.locator('.document-header-title')).toHaveText(undoHost.title)
    await setInlineReading(page, false)
    if (!dependents.length) await expect(inlineInstance(page, instanceId)).toBeVisible()
    await historyAction(page, 'Undo')
    await expect.poll(blockIds).toEqual(initial)
    await assertLinks(source.title, false)
    await historyAction(page, 'Redo')
    await expect.poll(blockIds).toEqual(final)
    expect((await readPages())[0]).toEqual([blank])
    await assertLinks(destination.title, true)
  })
})
