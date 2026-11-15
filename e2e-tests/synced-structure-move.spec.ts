import { expect, test } from '@playwright/test'
import { openInlineHost, setInlineReading, withCanonicalInlineApp } from './helpers/canonical-inline'
import { hasBuiltElectronApp, uiText } from './helpers/electron'

test.skip(!hasBuiltElectronApp(), 'Build the actual local Electron app before this acceptance slice')

test('the block toolbar moves mixed host roots with stable bindings and one Main Undo @electron', async ({}, info) => {
  await withCanonicalInlineApp(info, async fixture => {
    const { seed } = fixture, { page } = fixture.context(), host = seed.hosts[0]
    const [ordinary, first, second] = host.blocks
    const persisted = () => page.evaluate(async ({ hostId, groupId }) => {
      const detail = await window.knowbook.getDocumentDetail(hostId)
      const opened = await window.knowbook.openSyncedEditingSession({ kind: 'host', hostDocumentId: hostId })
      if (!detail || opened.status !== 'ready') throw new Error('The actual host session is unavailable')
      const sessionId = opened.session.sessionId
      const history = await window.knowbook.invokeSyncedEditingSession({ sessionId,
        method: 'getSyncedHostHistory', input: { documentId: hostId } })
      const group = (await window.knowbook.invokeSyncedEditingSession({ sessionId, method: 'getSyncedGroupSnapshots',
        input: { groupIds: [groupId] } })).items[0]
      if (group?.status !== 'ready') throw new Error('The actual group is unavailable')
      return { blocks: detail.blocks.map(({ sortOrder: _sortOrder, ...row }) => row), history, instances: group.snapshot.instances,
        canonical: group.snapshot.blocks }
    }, { hostId: host.id, groupId: seed.groupId })
    await openInlineHost(page, host); await setInlineReading(page, false)
    const original = await persisted()
    expect(original.blocks.map(row => row.id)).toEqual([ordinary.id, first.id, second.id])
    const row = (id: string) => page.locator('.block-editor-row[data-block-id="' + id + '"]')
    const editor = row(ordinary.id).locator('textarea.block-inline-textarea')
    const toolbar = page.locator('.block-selection-toolbar')
    // Use the host row gutter so the pointer never enters the independent
    // canonical editor nested inside the second row.
    const start = await row(ordinary.id).boundingBox(), end = await row(first.id).boundingBox()
    if (!start || !end) throw new Error('Both host rows must be visible')
    await editor.focus(); await editor.press('End')
    await page.mouse.move(start.x + 2, start.y + Math.min(10, start.height / 2))
    await page.mouse.down()
    await page.mouse.move(end.x + 2, end.y + Math.min(10, end.height / 2), { steps: 4 })
    await page.mouse.up()
    await expect(page.locator('.block-editor-row-selected')).toHaveCount(2)
    await toolbar.getByRole('button', { name: uiText('Move Down', '下移') }).click()
    await expect.poll(async () => (await persisted()).blocks.map(row => row.id)).toEqual([second.id, ordinary.id, first.id])
    const moved = await persisted()
    expect(moved.blocks).toEqual([original.blocks[2], original.blocks[0], original.blocks[1]])
    expect(moved.instances).toEqual(original.instances)
    expect(moved.canonical).toEqual(original.canonical)
    expect(moved.history.undoToken).not.toBeNull()
    expect(moved.history.undoToken).not.toBe(original.history.undoToken)
    await page.locator('.document-header-more-button').click()
    await page.locator('.document-header-action-menu').getByRole('button', { name: uiText('Undo', '撤销'), exact: true }).click()
    await expect.poll(async () => (await persisted()).blocks).toEqual(original.blocks)
    const undone = await persisted()
    expect(undone.instances).toEqual(original.instances)
    expect(undone.history.undoToken).toBe(original.history.undoToken)
    expect(undone.history.redoToken).toBe(moved.history.undoToken)
  })
})
