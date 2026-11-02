import { expect, test, type Page } from '@playwright/test'
import { hasBuiltElectronApp, uiText } from './helpers/electron'
import { withElectronFailureTrace } from './helpers/electron-failure-trace'
import { inlineInstance, expectCanonicalRow } from './helpers/canonical-inline'

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
