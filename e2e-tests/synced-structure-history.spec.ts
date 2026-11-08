import { expect, test, type Page } from '@playwright/test'
import { hasBuiltElectronApp, uiText } from './helpers/electron'
import { withElectronFailureTrace } from './helpers/electron-failure-trace'
import { inlineInstance, expectCanonicalRow, openInlineHost, withCanonicalInlineApp } from './helpers/canonical-inline'

// Use the existing 60s test budget/default retries/workers and background
// Electron helper. No mutation RPC or production callback is replaced.
test.skip(!hasBuiltElectronApp(), 'Build the actual local Electron app first')
async function historyAction(page: Page, direction: 'undo' | 'redo') {
  await page.locator('.document-header-more-button').click()
  const button = page.locator('.document-header-action-menu').getByRole('button', {
    name: direction === 'undo' ? uiText('Undo', '撤销') : uiText('Redo', '重做'), exact: true })
  await expect(button).toBeEnabled()
  await button.click()
}

test('real header Undo and Redo cross UI create and ordinary editing while retaining Main ownership and both redo sides @electron', async ({}, info) => {
  await withElectronFailureTrace(info, async ({ page }) => {
    const seed = await page.evaluate(async () => {
      const host = await window.knowbook.createDocument(null), childId = crypto.randomUUID(), ordinaryId = crypto.randomUUID()
      const title = 'UI actual structure history', canonical = 'Original source owned by canonical after create'
      await window.knowbook.updateDocument(host.id, { title, summary: 'full host summary stays', blocks: [
        { id: childId, type: 'paragraph', content: canonical, checked: false, depth: 0, parentBlockId: null },
        { id: ordinaryId, type: 'paragraph', content: 'Ordinary B before', checked: false, depth: 0, parentBlockId: null }
      ] })
      return { hostId: host.id, title, childId, ordinaryId, canonical }
    })
    await page.reload()
    await page.locator('.tree-button', { hasText: seed.title }).first().click()
    await expect(page.locator('.document-header-title')).toHaveText(seed.title)
    const source = page.locator('[data-block-id="' + seed.childId + '"]')
    await source.hover(); await source.locator('.block-drag-handle').click()
    await page.getByRole('dialog', { name: uiText('Block actions', '内容块操作'), exact: true })
      .getByRole('button', { name: uiText('Create synced block…', '创建同步块…'), exact: true }).click()
    const dialog = page.getByRole('dialog', { name: uiText('Create synced block', '创建同步块'), exact: true })
    await dialog.getByRole('button', { name: uiText('Create synced block', '创建同步块'), exact: true }).click()
    await expect(dialog).toHaveCount(0)
    const created = await page.evaluate(async hostId => {
      const actual = await window.knowbook.getDocumentDetail(hostId)
      const reference = actual?.blocks.find(block => block.type === 'synced-block')
      if (!actual || !reference) throw Error('Actual Main create receipt was not adopted')
      return { instanceId: reference.id, groupId: JSON.parse(reference.content).groupId as string }
    }, seed.hostId)
    await expectCanonicalRow(inlineInstance(page, created.instanceId), seed.childId, seed.canonical)
    const ordinary = page.locator('[data-block-id="' + seed.ordinaryId + '"] textarea')
    await ordinary.fill('Ordinary B after')
    await historyAction(page, 'undo')
    await expect(ordinary).toHaveValue('Ordinary B before')
    await expect(inlineInstance(page, created.instanceId)).toBeVisible()
    await historyAction(page, 'undo')
    await expect(page.locator('[data-block-id="' + seed.childId + '"] textarea')).toHaveValue(seed.canonical)
    await expect(inlineInstance(page, created.instanceId)).toHaveCount(0)
    const undone = await page.evaluate(id => window.knowbook.getDocumentDetail(id), seed.hostId)
    expect(undone?.blocks.some(block => block.type === 'synced-block')).toBe(false)
    expect(undone?.blocks.find(block => block.id === seed.childId)?.content).toBe(seed.canonical)
    await historyAction(page, 'redo')
    await expectCanonicalRow(inlineInstance(page, created.instanceId), seed.childId, seed.canonical)
    await expect(ordinary).toHaveValue('Ordinary B before')
    await historyAction(page, 'redo')
    await expect(ordinary).toHaveValue('Ordinary B after')
    const redone = await page.evaluate(id => window.knowbook.getDocumentDetail(id), seed.hostId)
    expect(redone?.summary).toBe('full host summary stays')
    expect(redone?.blocks.some(block => block.id === seed.childId || block.content.includes(seed.canonical))).toBe(false)
    expect(redone?.blocks.filter(block => block.type === 'synced-block').map(block => block.id)).toEqual([created.instanceId])
  })
})

test('unsync replaces only the selected reference with independently editable blocks and keeps their identities across Undo and Redo @electron', async ({}, info) => {
  await withCanonicalInlineApp(info, async fixture => {
    const { seed } = fixture, { page } = fixture.context()
    const [selectedId, otherId] = seed.instanceIds, host = seed.hosts[0]
    await openInlineHost(page, host)
    const selected = inlineInstance(page, selectedId), other = inlineInstance(page, otherId)
    await expectCanonicalRow(selected, seed.primaryId, seed.primaryText)
    const unsync = selected.getByRole('button', { name: uiText('Detach synced block…', '解除同步…'), exact: true })
    const title = uiText('Detach synced block', '解除同步')
    const dialog = page.getByRole('dialog', { name: title, exact: true })
    await unsync.click()
    await dialog.getByRole('button', { name: uiText('Cancel', '取消'), exact: true }).click()
    await expect(selected).toBeVisible()
    await unsync.click()
    await dialog.getByRole('button', { name: uiText('Detach', '解除同步'), exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(selected).toHaveCount(0)
    await expectCanonicalRow(other, seed.primaryId, seed.primaryText)

    const read = () => page.evaluate(id => window.knowbook.getDocumentDetail(id), host.id)
    const after = await read()
    const copies = after?.blocks.filter(block => !host.blocks.some(original => original.id === block.id)) ?? []
    expect(copies.map(block => block.content)).toEqual([seed.primaryText, seed.secondaryText])
    expect(copies.map(block => block.id)).not.toContain(seed.primaryId)
    expect(copies.map(block => block.id)).not.toContain(seed.secondaryId)
    expect(after?.blocks.map(block => block.id)).toEqual(host.blocks.flatMap(block => block.id === selectedId ? copies.map(copy => copy.id) : [block.id]))
    expect(after?.summary).toBe(host.summary)

    await historyAction(page, 'undo')
    await expectCanonicalRow(selected, seed.primaryId, seed.primaryText)
    expect((await read())?.blocks.map(block => block.id)).toEqual(host.blocks.map(block => block.id))
    await historyAction(page, 'redo')
    await expect(selected).toHaveCount(0)
    expect((await read())?.blocks.map(block => block.id)).toEqual(after?.blocks.map(block => block.id))

    const text = seed.primaryText + ' independently edited'
    await page.locator(`.block-editor-row[data-block-id="${copies[0].id}"] textarea`).fill(text)
    await expect.poll(async () => (await read())?.blocks.find(block => block.id === copies[0].id)?.content).toBe(text)
    await expectCanonicalRow(other, seed.primaryId, seed.primaryText)
    await openInlineHost(page, seed.hosts[1])
    await expectCanonicalRow(inlineInstance(page, seed.instanceIds[2]), seed.primaryId, seed.primaryText)
  })
})
