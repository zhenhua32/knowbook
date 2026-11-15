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

test('moves a persisted list owner and its nested synchronized reference, with cold Undo and Redo @electron', async ({}, info) => {
  await withCanonicalInlineApp(info, async fixture => {
    const [source, destination] = fixture.seed.hosts, instanceId = fixture.seed.instanceIds[1]
    const owner = source.blocks.find(block => block.type === 'bulleted-list')!
    const ref = source.blocks.find(block => block.id === instanceId)!
    expect(ref).toMatchObject({ parentBlockId: owner.id, depth: 1 })
    let { page } = fixture.context()
    const row = (id: string) => page.locator(`.block-editor-row[data-block-id="${id}"]`)
    const read = () => page.evaluate(async ids => Promise.all(ids.map(async documentId => {
      const host = await window.knowbook.getDocumentDetail(documentId)
      if (!host) throw new Error('The actual host detail is missing')
      return host.blocks.map(({ id, type, content, checked, depth, parentBlockId }) =>
        ({ id, type, content, checked, depth, parentBlockId: parentBlockId ?? null }))
    })), [source.id, destination.id])
    const initial = [source.blocks, destination.blocks]
    const final = [source.blocks.filter(block => block.id !== owner.id && block.id !== ref.id), [...destination.blocks, owner, ref]]

    await openInlineHost(page, source)
    await setInlineReading(page, false)
    await expect(inlineInstance(page, instanceId)).toBeVisible()
    await expect(row(instanceId)).toHaveCSS('padding-left', '24px')
    expect(await read()).toEqual(initial)
    await row(owner.id).click({ button: 'right' })
    await page.locator('.block-context-menu').getByRole('button', {
      name: uiText('Move to document…', '移动到文档…'), exact: true
    }).click()
    const dialog = page.locator('.document-block-move-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText(/Move 2 blocks|移动.*2/)).toBeVisible()
    await dialog.locator('.document-capture-field input').fill(destination.title)
    await dialog.locator(`input[value="${destination.id}"]`).check()
    await dialog.getByRole('button', { name: uiText('Move', '移动'), exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect.poll(read).toEqual(final)

    await fixture.restart()
    ;({ page } = fixture.context())
    await openInlineHost(page, destination)
    await setInlineReading(page, false)
    await expect(row(owner.id)).toBeVisible()
    await expect(inlineInstance(page, instanceId)).toBeVisible()
    await expect(row(instanceId)).toHaveCSS('padding-left', '24px')
    await historyAction(page, 'Undo')
    await expect.poll(read).toEqual(initial)
    await historyAction(page, 'Redo')
    await expect.poll(read).toEqual(final)
    await expect(row(instanceId)).toHaveCSS('padding-left', '24px')
  }, 2, true)
})
