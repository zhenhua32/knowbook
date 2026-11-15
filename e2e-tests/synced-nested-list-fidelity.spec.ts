import { expect, test } from '@playwright/test'
import { inlineInstance, openInlineHost, setInlineReading, withCanonicalInlineApp } from './helpers/canonical-inline'
import { hasBuiltElectronApp } from './helpers/electron'

test.skip(!hasBuiltElectronApp(), 'Build the actual local Electron app before this acceptance slice')

test('keeps an existing nested synchronized reference through host editing, save and cold reopening @electron', async ({}, info) => {
  await withCanonicalInlineApp(info, async fixture => {
    const host = fixture.seed.hosts[0], instanceId = fixture.seed.instanceIds[1]
    const parent = host.blocks.find(block => block.type === 'bulleted-list')!
    expect(host.blocks.find(block => block.id === instanceId)).toMatchObject({ parentBlockId: parent.id, depth: 1 })
    let { page } = fixture.context()
    const row = (id: string) => page.locator(`.block-editor-row[data-block-id="${id}"]`)
    const indentation = () => row(instanceId).evaluateAll(elements => elements.map(element => (element as HTMLElement).style.paddingLeft))
    const read = () => page.evaluate(id => window.knowbook.getDocumentDetail(id), host.id)

    await openInlineHost(page, host)
    await setInlineReading(page, false)
    await expect(inlineInstance(page, instanceId)).toBeVisible()
    await expect.poll(indentation).toEqual(['24px'])
    const editor = row(parent.id).locator('textarea.block-inline-textarea')
    const updated = parent.content + ' edited without moving the reference'
    await editor.fill(updated)
    await page.keyboard.press('ControlOrMeta+s')
    await expect.poll(async () => (await read())?.blocks.find(block => block.id === parent.id)?.content).toBe(updated)
    expect((await read())?.blocks.find(block => block.id === instanceId)).toMatchObject({ parentBlockId: parent.id, depth: 1 })
    await expect.poll(indentation).toEqual(['24px'])

    await fixture.restart()
    ;({ page } = fixture.context())
    await openInlineHost(page, host)
    await setInlineReading(page, false)
    await expect(inlineInstance(page, instanceId)).toBeVisible()
    await expect.poll(indentation).toEqual(['24px'])
    await expect(row(parent.id).locator('textarea.block-inline-textarea')).toHaveValue(updated)
  }, 2, true)
})
