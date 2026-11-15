import { expect, test, type Page } from '@playwright/test'
import { inlineInstance, openInlineHost, setInlineReading, withCanonicalInlineApp } from './helpers/canonical-inline'
import { hasBuiltElectronApp, uiText } from './helpers/electron'

async function undo(page: Page) {
  await page.locator('.document-header-more-button').click()
  await page.locator('.document-header-action-menu').getByRole('button', { name: uiText('Undo', '撤销'), exact: true }).click()
}

test.skip(!hasBuiltElectronApp(), 'Build the actual local Electron app before this acceptance slice')

test('direct toolbar and row delete remove only the chosen reference roots and each use one Main Undo @electron', async ({}, info) => {
  await withCanonicalInlineApp(info, async fixture => {
    const { seed } = fixture, { page } = fixture.context(), [host, peer] = seed.hosts
    const [ordinary, first, second] = host.blocks
    const persisted = () => page.evaluate(async ({ hostId, groupId }) => {
      const document = await window.knowbook.getDocumentDetail(hostId)
      const opened = await window.knowbook.openSyncedEditingSession({ kind: 'host', hostDocumentId: hostId })
      if (!document || opened.status !== 'ready') throw new Error('The actual host session is unavailable')
      const sessionId = opened.session.sessionId
      const history = await window.knowbook.invokeSyncedEditingSession({ sessionId,
        method: 'getSyncedHostHistory', input: { documentId: hostId } })
      const group = (await window.knowbook.invokeSyncedEditingSession({ sessionId, method: 'getSyncedGroupSnapshots',
        input: { groupIds: [groupId] } })).items[0]
      if (group?.status !== 'ready') throw new Error('The actual group is unavailable')
      return { ids: document.blocks.map(block => block.id), history, canonical: group.snapshot.blocks,
        instanceIds: group.snapshot.instances.map(instance => instance.instanceId).sort() }
    }, { hostId: host.id, groupId: seed.groupId })
    await openInlineHost(page, host); await setInlineReading(page, false)
    const original = await persisted(), row = (id: string) => page.locator('.block-editor-row[data-block-id="' + id + '"]')
    const start = await row(ordinary.id).boundingBox(), end = await row(first.id).boundingBox()
    if (!start || !end) throw new Error('Both host rows must be visible')
    await page.mouse.move(start.x + 2, start.y + Math.min(10, start.height / 2)); await page.mouse.down()
    await page.mouse.move(end.x + 2, end.y + Math.min(10, end.height / 2), { steps: 4 }); await page.mouse.up()
    await expect(page.locator('.block-editor-row-selected')).toHaveCount(2)
    await page.locator('.block-selection-toolbar').getByRole('button', { name: uiText('Delete', '删除'), exact: true }).click()
    await expect.poll(async () => (await persisted()).ids).toEqual([second.id])
    const deletedRange = await persisted()
    expect(deletedRange.canonical).toEqual(original.canonical)
    expect(deletedRange.instanceIds).toEqual([second.id, peer.blocks[1].id].sort())
    expect(deletedRange.history.undoToken).not.toBe(original.history.undoToken)
    await undo(page)
    await expect.poll(async () => (await persisted()).ids).toEqual(original.ids)
    expect((await persisted()).history.redoToken).toBe(deletedRange.history.undoToken)

    await row(second.id).hover(); await row(second.id).locator('.block-drag-handle').click()
    const menu = page.getByRole('dialog', { name: uiText('Block actions', '内容块操作'), exact: true })
    await menu.getByRole('button', { name: uiText('Delete', '删除'), exact: true }).click()
    await expect.poll(async () => (await persisted()).ids).toEqual([ordinary.id, first.id])
    const deletedRow = await persisted()
    expect(deletedRow.history.undoToken).not.toBe(deletedRange.history.undoToken)
    expect(deletedRow.instanceIds).toEqual([first.id, peer.blocks[1].id].sort())
    await expect(inlineInstance(page, first.id)).toBeVisible()
    await undo(page)
    await expect.poll(async () => (await persisted()).ids).toEqual(original.ids)
    const restored = await persisted()
    expect(restored.history.redoToken).toBe(deletedRow.history.undoToken)
    expect(restored.canonical).toEqual(original.canonical)
  })
})
