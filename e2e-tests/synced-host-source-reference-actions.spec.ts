import { expect, test, type Page } from '@playwright/test'
import { parseSyncedBlockPayload, SYNCED_BLOCK_FENCE_INFO } from '../src/shared/syncedBlockValidation'
import { openInlineHost, setInlineReading, withCanonicalInlineApp } from './helpers/canonical-inline'
import { hasBuiltElectronApp, uiText } from './helpers/electron'
import { selectSource, sourceSelection, sourceValue } from './helpers/markdown-source'

async function hostUndo(page: Page) {
  await page.locator('.document-header-more-button').click()
  await page.locator('.document-header-action-menu').getByRole('button', { name: uiText('Undo', '撤销'), exact: true }).click()
}

async function pickSourceReference(page: Page, groupId: string, query: string) {
  const picker = page.getByRole('dialog', { name: uiText('Insert synced block', '插入同步块'), exact: true })
  await expect(picker).toBeVisible()
  await picker.getByRole('textbox', { name: uiText('Find synced blocks', '查找同步块'), exact: true }).fill(query)
  await picker.getByRole('button', { name: uiText('Search', '查找'), exact: true }).click()
  await picker.locator(`[data-synced-group-choice="${groupId}"]`).getByRole('radio').check()
  await picker.getByRole('button', { name: uiText('Insert reference', '插入引用'), exact: true }).click()
  await expect(picker).toBeHidden()
}

test.skip(!hasBuiltElectronApp(), 'Build the actual local Electron app before this acceptance slice')

test('host Source moves, copies and picks a shared reference through local history and commits one Main undo boundary @electron', async ({}, info) => {
  await withCanonicalInlineApp(info, async fixture => {
    const { seed } = fixture, { page } = fixture.context(), host = seed.hosts[0]
    const [ordinary, first, second] = host.blocks
    expect(host.blocks.map(block => block.type)).toEqual(['paragraph', 'synced-block', 'synced-block'])
    const read = () => page.evaluate(id => window.knowbook.getDocumentDetail(id), host.id)
    const ids = async () => (await read())?.blocks.map(block => block.id)
    const bindings = () => page.evaluate(async ({ hostId, groupId }) => {
      const opened = await window.knowbook.openSyncedEditingSession({ kind: 'host', hostDocumentId: hostId })
      if (opened.status !== 'ready') throw new Error('The actual host session is unavailable')
      const result = await window.knowbook.invokeSyncedEditingSession({ sessionId: opened.session.sessionId,
        method: 'getSyncedGroupSnapshots', input: { groupIds: [groupId] } })
      const group = result.items[0]
      if (group?.status !== 'ready') throw new Error('The actual group is unavailable')
      return Object.fromEntries(group.snapshot.instances.map(instance => [instance.instanceId, instance]))
    }, { hostId: host.id, groupId: seed.groupId })
    await openInlineHost(page, host); await setInlineReading(page, false)
    const originalRows = (await read())!.blocks, originalBindings = await bindings()
    await page.locator('.document-header-more-button').click()
    await page.getByRole('button', { name: uiText('Edit Markdown source', '编辑 Markdown 源码'), exact: true }).click()
    const dialog = page.getByRole('dialog', { name: uiText('Edit host body source', '编辑宿主正文源码'), exact: true })
    const source = dialog.getByRole('textbox', { name: uiText('Host body Markdown source', '宿主正文 Markdown 源码'), exact: true })
    const button = (english: string, chinese: string) => dialog.getByRole('button', { name: uiText(english, chinese), exact: true })
    const original = await sourceValue(source), fence = '```' + SYNCED_BLOCK_FENCE_INFO
    const firstAt = original.indexOf(fence), secondAt = original.indexOf(fence, firstAt + fence.length)
    expect(firstAt).toBeGreaterThan(0)
    expect(secondAt).toBeGreaterThan(firstAt)
    const selected = original.slice(firstAt, secondAt), moved = selected + original.slice(0, firstAt) + original.slice(secondAt)
    expect(original.slice(firstAt - 2, firstAt)).toBe('\n\n')
    expect(original.slice(secondAt - 2, secondAt)).toBe('\n\n')

    // Two occurrences have identical public text. This is a real command and
    // a real undo entry despite an unchanged document string.
    await selectSource(source, secondAt - 2, original.length)
    await button('Move reference selection', '移动引用选区').click()
    await selectSource(source, firstAt - 2)
    await button('Move to cursor', '移动到光标处').click()
    expect(await sourceValue(source)).toBe(original)
    await expect(button('Undo', '撤销')).toBeEnabled()
    await button('Undo', '撤销').click()
    expect(await sourceSelection(source)).toEqual({ from: secondAt - 2, to: original.length })

    await selectSource(source, firstAt, secondAt)
    await button('Move reference selection', '移动引用选区').click()
    await selectSource(source, 0)
    await button('Move to cursor', '移动到光标处').click()
    expect(await sourceValue(source)).toBe(moved)
    await button('Undo', '撤销').click()
    expect(await sourceValue(source)).toBe(original)
    expect(await sourceSelection(source)).toEqual({ from: firstAt, to: secondAt })
    await button('Redo', '重做').click()
    expect(await sourceValue(source)).toBe(moved)

    // A placement captures the exact draft. Typing keeps the new text and
    // invalidates the old capture instead of moving coordinates from a stale W.
    await button('Copy reference selection', '复制引用选区').click()
    await selectSource(source, selected.length + ordinary.content.length)
    await page.keyboard.insertText(' edited')
    const edited = await sourceValue(source)
    expect(edited).toContain(ordinary.content + ' edited')
    await button('Copy to cursor', '复制到光标处').click()
    await expect(dialog.getByRole('alert')).toBeVisible()
    expect(await sourceValue(source)).toBe(edited)
    await button('Undo', '撤销').click()
    expect(await sourceValue(source)).toBe(moved)

    await selectSource(source, 0, selected.length)
    await button('Copy reference selection', '复制引用选区').click()
    await selectSource(source, selected.length)
    await button('Copy to cursor', '复制到光标处').click()
    const copied = selected + moved
    expect(await sourceValue(source)).toBe(copied)
    await button('Undo', '撤销').click()
    expect(await sourceValue(source)).toBe(moved)
    await button('Redo', '重做').click()
    expect(await sourceValue(source)).toBe(copied)
    expect(await ids()).toEqual([ordinary.id, first.id, second.id])

    await selectSource(source, copied.length)
    await button('Insert existing synced block', '插入已有同步块').click()
    await pickSourceReference(page, seed.groupId, seed.query)
    const inserted = copied + '\n\n' + original.slice(secondAt)
    expect(await sourceValue(source)).toBe(inserted)
    await button('Undo', '撤销').click()
    expect(await sourceValue(source)).toBe(copied)
    expect(await sourceSelection(source)).toEqual({ from: copied.length, to: copied.length })
    await button('Redo', '重做').click()
    expect(await sourceValue(source)).toBe(inserted)
    expect(await ids()).toEqual([ordinary.id, first.id, second.id])
    expect(await bindings()).toEqual(originalBindings)

    await button('Apply changes', '应用更改').click()
    await expect(dialog).toBeHidden()
    const saved = (await read())!.blocks, fresh = saved[1], picked = saved[4]
    expect(saved.map(block => block.id)).toEqual([first.id, fresh.id, ordinary.id, second.id, picked.id])
    expect(host.blocks.map(block => block.id)).not.toContain(fresh.id)
    expect(fresh.id).toMatch(/^[0-9a-f-]{36}$/i)
    expect(fresh.type).toBe('synced-block')
    expect(parseSyncedBlockPayload(fresh.content)).toEqual(parseSyncedBlockPayload(first.content))
    expect([...host.blocks.map(block => block.id), fresh.id]).not.toContain(picked.id)
    expect(picked.id).toMatch(/^[0-9a-f-]{36}$/i)
    expect(picked.type).toBe('synced-block')
    expect(parseSyncedBlockPayload(picked.content)).toEqual(parseSyncedBlockPayload(first.content))
    expect(saved[2]).toEqual({ ...originalRows[0], sortOrder: saved[2].sortOrder })
    const savedBindings = await bindings()
    expect(savedBindings[fresh.id]).toMatchObject({ instanceId: fresh.id, hostDocumentId: host.id })
    expect(savedBindings[picked.id]).toMatchObject({ instanceId: picked.id, hostDocumentId: host.id })
    for (const instanceId of seed.instanceIds) {
      const { bindingVersion, hostDocumentId, parentBlockId, depth } = originalBindings[instanceId]
      expect(savedBindings[instanceId]).toMatchObject({ bindingVersion, hostDocumentId, parentBlockId, depth })
    }
    await hostUndo(page)
    await expect.poll(ids).toEqual([ordinary.id, first.id, second.id])
    expect(await bindings()).toEqual(originalBindings)

    await page.locator('.document-header-more-button').click()
    await page.getByRole('button', { name: uiText('Edit Markdown source', '编辑 Markdown 源码'), exact: true }).click()
    const reopened = await sourceValue(source), firstRef = reopened.indexOf(fence), secondRef = reopened.indexOf(fence, firstRef + fence.length)
    expect(firstRef).toBeGreaterThan(0)
    expect(secondRef).toBeGreaterThan(firstRef)
    await selectSource(source, firstRef, secondRef)
    await source.press('Backspace')
    const removed = reopened.slice(0, firstRef) + reopened.slice(secondRef)
    expect(await sourceValue(source)).toBe(removed)
    await button('Undo', '撤销').click()
    expect(await sourceValue(source)).toBe(reopened)
    await button('Redo', '重做').click()
    expect(await sourceValue(source)).toBe(removed)
    await button('Apply changes', '应用更改').click()
    await expect(dialog).toBeHidden()
    await expect.poll(ids).toEqual([ordinary.id, second.id])
    expect(Object.keys(await bindings()).sort()).toEqual(seed.instanceIds.filter(id => id !== first.id).sort())
    await hostUndo(page)
    await expect.poll(ids).toEqual([ordinary.id, first.id, second.id])
  })
})

test('host Source picks the first shared reference into a truly ordinary document and undoes the single Main commit @electron', async ({}, info) => {
  await withCanonicalInlineApp(info, async fixture => {
    const { page } = fixture.context(), { seed } = fixture
    const host = await page.evaluate(async () => {
      const created = await window.knowbook.createDocument(null)
      await window.knowbook.updateDocument(created.id, { title: 'Ordinary Source picker destination', summary: 'Keep this ordinary summary',
        blocks: [{ id: crypto.randomUUID(), type: 'paragraph', content: 'An ordinary paragraph', checked: false, depth: 0, parentBlockId: null }] })
      const actual = await window.knowbook.getDocumentDetail(created.id)
      if (!actual) throw new Error('The actual ordinary host was not created')
      return actual
    })
    await page.reload()
    await page.locator('.tree-button', { hasText: host.title }).first().click({ noWaitAfter: true })
    await expect(page.locator('.document-header-title')).toHaveText(host.title)
    await setInlineReading(page, false)
    const read = () => page.evaluate(id => window.knowbook.getDocumentDetail(id), host.id)
    const history = () => page.evaluate(async documentId => {
      const opened = await window.knowbook.openSyncedEditingSession({ kind: 'host', hostDocumentId: documentId })
      if (opened.status !== 'ready') throw new Error('The actual host session is unavailable')
      return window.knowbook.invokeSyncedEditingSession({ sessionId: opened.session.sessionId,
        method: 'getSyncedHostHistory', input: { documentId } })
    }, host.id)
    expect((await read())?.blocks).toEqual(host.blocks)
    await expect(history()).rejects.toThrow(/宿主同步历史状态尚未初始化/)
    await page.locator('.document-header-more-button').click()
    await page.getByRole('button', { name: uiText('Edit Markdown source', '编辑 Markdown 源码'), exact: true }).click()
    const dialog = page.getByRole('dialog', { name: uiText('Edit host body source', '编辑宿主正文源码'), exact: true })
    const source = dialog.getByRole('textbox', { name: uiText('Markdown body source', 'Markdown 正文源码'), exact: true })
    const original = await sourceValue(source)
    await selectSource(source, original.length)
    await dialog.getByRole('button', { name: uiText('Insert existing synced block', '插入已有同步块'), exact: true }).click()
    await pickSourceReference(page, seed.groupId, seed.query)
    expect(await sourceValue(source)).toBe(original + '\n\n```' + SYNCED_BLOCK_FENCE_INFO + '\n' + JSON.stringify({ version: 1, groupId: seed.groupId }) + '\n```')
    expect((await read())?.blocks).toEqual(host.blocks)
    await expect(history()).rejects.toThrow(/宿主同步历史状态尚未初始化/)
    await dialog.getByRole('button', { name: uiText('Apply changes', '应用更改'), exact: true }).click()
    await expect(dialog).toBeHidden()
    const saved = (await read())!
    expect(saved.blocks.map(block => block.type)).toEqual(['paragraph', 'synced-block'])
    expect(saved.blocks[0]).toEqual(host.blocks[0]); expect(saved.summary).toBe(host.summary)
    const reference = saved.blocks[1]
    expect(reference.id).toMatch(/^[0-9a-f-]{36}$/i)
    expect(parseSyncedBlockPayload(reference.content).groupId).toBe(seed.groupId)
    const group = await page.evaluate(input => window.knowbook.resolveSyncedInlineInstance(input),
      { hostDocumentId: host.id, instanceId: reference.id, groupId: seed.groupId })
    expect(group.status).toBe('ready')
    if (group.status !== 'ready') throw new Error('The newly inserted reference did not resolve')
    expect(group.snapshot.blocks.find(block => block.id === seed.primaryId)?.content).toBe(seed.primaryText)
    const written = await history()
    expect(written.undoToken).not.toBeNull()
    await hostUndo(page)
    await expect.poll(async () => (await read())?.blocks).toEqual(host.blocks)
    expect(await history()).toMatchObject({ undoToken: null, redoToken: written.undoToken })
  })
})
