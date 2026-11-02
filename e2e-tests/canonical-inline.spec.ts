import { expect, test } from '@playwright/test'
import { hasBuiltElectronApp, uiText } from './helpers/electron'
import { expectSource, sourceValue } from './helpers/markdown-source'
import {
  appendCanonicalText, assertRealCloseBlocked, expectCanonicalRow, expectExactCanonicalFocus, expectHostReferencesUnchanged,
  inlineInstance, observeRealEditorClose, openInlineHost, saveCanonical, setInlineReading, withCanonicalInlineApp
} from './helpers/canonical-inline'

// All cases keep the existing 60s timeout, project retries/workers, hidden
// Electron helper and independent profile. No tested Main IPC is mocked.
test.skip(!hasBuiltElectronApp(), 'Build the actual local Electron app before running this acceptance slice')

test('canonical body expands in reading, Markdown and rich hosts; three references persist one shared body without host copies @electron', async ({}, info) => {
  await withCanonicalInlineApp(info, async fixture => {
    const { seed } = fixture
    let { page } = fixture.context()
    await openInlineHost(page, seed.hosts[0])
    await setInlineReading(page, true)
    for (const id of seed.instanceIds.slice(0, 2)) {
      await expectCanonicalRow(inlineInstance(page, id), seed.primaryId, seed.primaryText)
      await expect(inlineInstance(page, id).locator('.ProseMirror')).toHaveCount(0)
    }
    await expectHostReferencesUnchanged(page, seed)

    await setInlineReading(page, false)
    const modes = page.getByRole('group', { name: uiText('Editing mode', '编辑模式'), exact: true })
    await expect(modes.getByRole('button', { name: 'Markdown', exact: true })).toHaveAttribute('aria-pressed', 'true')
    const plainText = seed.primaryText + ' through Markdown host'
    await appendCanonicalText(page, seed.instanceIds[0], seed.primaryId, seed.primaryText, ' through Markdown host')
    for (const id of seed.instanceIds.slice(0, 2)) await expectCanonicalRow(inlineInstance(page, id), seed.primaryId, plainText)
    await saveCanonical(page, seed, seed.instanceIds[0], plainText)
    await expectHostReferencesUnchanged(page, seed)

    await modes.getByRole('button', { name: uiText('Rich text', '富文本'), exact: true }).click()
    await expect(modes.getByRole('button', { name: uiText('Rich text', '富文本'), exact: true })).toHaveAttribute('aria-pressed', 'true')
    const finalText = plainText + ' through rich host'
    // Use the second actual instance's own PM view. Its trusted key input must
    // update the first instance through the one shared group controller.
    await appendCanonicalText(page, seed.instanceIds[1], seed.primaryId, plainText, ' through rich host')
    for (const id of seed.instanceIds.slice(0, 2)) await expectCanonicalRow(inlineInstance(page, id), seed.primaryId, finalText)
    await saveCanonical(page, seed, seed.instanceIds[1], finalText)
    await expectHostReferencesUnchanged(page, seed)

    await openInlineHost(page, seed.hosts[1])
    await expectCanonicalRow(inlineInstance(page, seed.instanceIds[2]), seed.primaryId, finalText)
    await setInlineReading(page, true)
    await expectCanonicalRow(inlineInstance(page, seed.instanceIds[2]), seed.primaryId, finalText)
    await expect(inlineInstance(page, seed.instanceIds[2]).locator('.ProseMirror')).toHaveCount(0)
    await expectHostReferencesUnchanged(page, seed)

    // Fully stop the real host before reusing its profile. There is no live
    // SQLite replacement, recovery-epoch edit or prebuilt snapshot injection.
    await fixture.restart()
    page = fixture.context().page
    await openInlineHost(page, seed.hosts[0])
    for (const id of seed.instanceIds.slice(0, 2)) await expectCanonicalRow(inlineInstance(page, id), seed.primaryId, finalText)
    await saveCanonical(page, seed, seed.instanceIds[0], finalText)
    await openInlineHost(page, seed.hosts[1])
    await expectCanonicalRow(inlineInstance(page, seed.instanceIds[2]), seed.primaryId, finalText)
    await expectHostReferencesUnchanged(page, seed)
  })
})

test('unapplied canonical and host Source buffers block real X and quit, receive cancellation and retain their exact working text @electron', async ({}, info) => {
  await withCanonicalInlineApp(info, async fixture => {
    const { seed } = fixture, context = fixture.context(), { page } = context
    await openInlineHost(page, seed.hosts[0])
    await expectCanonicalRow(inlineInstance(page, seed.instanceIds[0]), seed.primaryId, seed.primaryText)
    await observeRealEditorClose(page)

    for (const kind of ['canonical', 'host'] as const) {
      if (kind === 'canonical') {
        await inlineInstance(page, seed.instanceIds[0]).getByRole('button', { name: uiText('Edit source', '编辑源码'), exact: true }).click()
      } else {
        await page.locator('.document-header-more-button').click()
        await page.getByRole('button', { name: uiText('Edit Markdown source', '编辑 Markdown 源码'), exact: true }).click()
      }
      const dialog = page.getByRole('dialog', { name: kind === 'canonical'
        ? uiText('Edit shared body source', '编辑共享正文源码') : uiText('Edit host body source', '编辑宿主正文源码'), exact: true })
      await expect(dialog).toBeVisible()
      const editor = dialog.getByRole('textbox', { name: kind === 'canonical'
        ? uiText('Shared body Markdown source', '共享正文 Markdown 源码') : uiText('Host body Markdown source', '宿主正文 Markdown 源码'), exact: true })
      await expect(editor).toBeVisible()
      const initial = await sourceValue(editor), suffix = ' unapplied-' + kind + '-中文🙂'
      await editor.press('Control+End')
      await page.keyboard.insertText(suffix)
      await expectSource(editor, initial + suffix)

      for (const reason of ['window', 'quit'] as const) {
        // Calls actual BrowserWindow.close/app.quit in Main. The passive probe
        // records only Main's real nonce and its matching cancelled event.
        await assertRealCloseBlocked(context, reason)
        await expect(dialog).toBeVisible()
        await expectSource(editor, initial + suffix)
        await expectHostReferencesUnchanged(page, seed)
        const saved = await page.evaluate(input => window.knowbook.resolveSyncedInlineInstance(input), {
          hostDocumentId: seed.hosts[0].id, instanceId: seed.instanceIds[0], groupId: seed.groupId
        })
        expect(saved.status).toBe('ready')
        if (saved.status !== 'ready') throw new Error('The actual saved group disappeared during blocked close')
        expect(saved.snapshot.blocks.find(block => block.id === seed.primaryId)?.content).toBe(seed.primaryText)
      }
      // Matching cancellation really unlocks input, rather than merely leaving
      // a frozen DOM around the old buffer. Explicit user Cancel discards it.
      await editor.press('Control+End'); await page.keyboard.insertText(' still-editable')
      await expectSource(editor, initial + suffix + ' still-editable')
      await dialog.getByRole('button', { name: uiText('Cancel', '取消'), exact: true }).click()
      await expect(dialog).toHaveCount(0)
      await expectCanonicalRow(inlineInstance(page, seed.instanceIds[0]), seed.primaryId, seed.primaryText)
      await expectHostReferencesUnchanged(page, seed)
    }
    // Positive close admission after explicit Cancel prevents an always-blocked
    // or never-ready renderer from satisfying only the negative assertions.
    const closed = context.app.waitForEvent('close')
    await context.app.evaluate(({ app }) => { app.quit() })
    await closed
  })
})

test('canonical search selects the exact same-host instance and opaque child, then a different host occurrence @electron', async ({}, info) => {
  await withCanonicalInlineApp(info, async fixture => {
    const { seed } = fixture, { page } = fixture.context()
    await openInlineHost(page, seed.hosts[0])
    await setInlineReading(page, true)
    await expectCanonicalRow(inlineInstance(page, seed.instanceIds[0]), seed.primaryId, seed.primaryText)
    expect(seed.primaryId).toContain('\0')

    // Two results have the same host and canonical child. Only the genuine
    // instance locator distinguishes them; no snippet/content scan picks one.
    for (const [target, host] of [[seed.instanceIds[1], seed.hosts[0]], [seed.instanceIds[2], seed.hosts[1]]] as const) {
      await page.getByTitle(uiText('Search', '搜索'), { exact: true }).click()
      const query = page.getByLabel(uiText('Keywords', '关键词'), { exact: true })
      await expect(query).toBeVisible()
      await query.fill(seed.query)
      await query.press('Enter')
      await expect(page.getByTestId('workspace-search-total')).toHaveAttribute('data-total-number', '3')
      await expect(page.getByTestId('workspace-search-result')).toHaveCount(3)
      const tuples = await page.getByTestId('workspace-search-result').evaluateAll(rows => rows.map(row => ({
        documentId: (row as HTMLElement).dataset.documentId, instanceId: (row as HTMLElement).dataset.instanceId, blockId: (row as HTMLElement).dataset.blockId
      })))
      expect(tuples.sort((a, b) => a.instanceId!.localeCompare(b.instanceId!))).toEqual(seed.instanceIds.map((instanceId, index) => ({
        documentId: seed.hosts[index === 2 ? 1 : 0].id, instanceId, blockId: seed.primaryId
      })).sort((a, b) => a.instanceId.localeCompare(b.instanceId)))
      const result = page.locator('[data-testid="workspace-search-result"][data-instance-id="' + target + '"]')
      await expect(result).toHaveCount(1)
      await result.getByRole('button', { name: uiText('Go to block', '定位内容块'), exact: true }).click()
      await expect(page.locator('.document-header-title')).toHaveText(host.title)
      await expectCanonicalRow(inlineInstance(page, target), seed.primaryId, seed.primaryText)
      await expectExactCanonicalFocus(page, target, seed.primaryId)
      if (target === seed.instanceIds[1]) {
        await expect.poll(() => inlineInstance(page, seed.instanceIds[0]).locator('[data-block-id]').evaluateAll((rows, id) =>
          rows.some(row => (row as HTMLElement).dataset.blockId === id && row.classList.contains('block-editor-row-highlighted')), seed.primaryId)).toBe(false)
      }
      await expectHostReferencesUnchanged(page, seed)
    }
  })
})
