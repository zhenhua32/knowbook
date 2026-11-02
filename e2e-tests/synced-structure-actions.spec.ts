import { expect, test } from '@playwright/test'
import { hasBuiltElectronApp, uiText } from './helpers/electron'
import { withElectronFailureTrace } from './helpers/electron-failure-trace'
import { expectCanonicalRow, inlineInstance } from './helpers/canonical-inline'

// Original project 60s/default retries/workers/background Electron remain intact.
// Fixture setup uses ordinary real document IPC; tested structure RPCs are never replaced.
test.skip(!hasBuiltElectronApp(), 'Build the actual local Electron app before this acceptance slice')

test('real UI creates a shared body from the original block and inserts a picked reference into another host without copying canonical children @electron', async ({}, info) => {
  await withElectronFailureTrace(info, async ({ page }) => {
    const seed = await page.evaluate(async () => {
      const source = await window.knowbook.createDocument(null), target = await window.knowbook.createDocument(null)
      const sourceTitle = 'UI shared source', targetTitle = 'UI shared destination', childId = crypto.randomUUID(), text = 'Original UI shared paragraph 中文🙂'
      await window.knowbook.updateDocument(source.id, { title: sourceTitle, summary: 'source summary kept', blocks: [
        { id: crypto.randomUUID(), type: 'heading-1', content: sourceTitle, checked: false, depth: 0, parentBlockId: null },
        { id: childId, type: 'paragraph', content: text, checked: false, depth: 0, parentBlockId: null }
      ] })
      await window.knowbook.updateDocument(target.id, { title: targetTitle, summary: 'destination summary kept', blocks: [
        { id: crypto.randomUUID(), type: 'heading-1', content: targetTitle, checked: false, depth: 0, parentBlockId: null }
      ] })
      return { sourceId: source.id, targetId: target.id, sourceTitle, targetTitle, childId, text }
    })
    await page.reload()
    await page.locator('.tree-button', { hasText: seed.sourceTitle }).first().click()
    await expect(page.locator('.document-header-title')).toHaveText(seed.sourceTitle)
    const row = page.locator('.block-editor-row[data-block-id="' + seed.childId + '"]')
    await row.hover(); await row.locator('.block-drag-handle').click()
    const menu = page.getByRole('dialog', { name: uiText('Block actions', '内容块操作'), exact: true })
    await menu.getByRole('button', { name: uiText('Create synced block…', '创建同步块…'), exact: true }).click()
    const create = page.getByRole('dialog', { name: uiText('Create synced block', '创建同步块'), exact: true })
    await expect(create).toBeVisible()
    await create.getByRole('button', { name: uiText('Create synced block', '创建同步块'), exact: true }).click()
    await expect(create).toHaveCount(0)

    const created = await page.evaluate(async documentId => {
      const document = await window.knowbook.getDocumentDetail(documentId)
      if (!document) throw Error('Actual created host missing')
      const refs = document.blocks.filter(block => block.type === 'synced-block')
      if (refs.length !== 1) throw Error('UI create did not leave exactly one real reference')
      const groupId = JSON.parse(refs[0].content).groupId as string
      const session = await window.knowbook.openSyncedEditingSession({ kind: 'host', hostDocumentId: documentId })
      if (session.status !== 'ready') throw Error('Actual host session missing')
      const history = await window.knowbook.invokeSyncedEditingSession({ sessionId: session.session.sessionId,
        method: 'getSyncedHostHistory', input: { documentId } })
      return { host: document, groupId, instanceId: refs[0].id, history }
    }, seed.sourceId)
    expect(created.history.undoToken).not.toBeNull()
    expect(created.host.summary).toBe('source summary kept')
    expect(created.host.blocks.some(block => block.id === seed.childId || block.content.includes(seed.text))).toBe(false)
    await expectCanonicalRow(inlineInstance(page, created.instanceId), seed.childId, seed.text)

    await page.locator('.tree-button', { hasText: seed.targetTitle }).first().click()
    await expect(page.locator('.document-header-title')).toHaveText(seed.targetTitle)
    await page.locator('.document-header-more-button').click()
    await page.getByRole('button', { name: uiText('Insert synced block…', '插入同步块…'), exact: true }).click()
    const insert = page.getByRole('dialog', { name: uiText('Insert synced block', '插入同步块'), exact: true })
    await expect(insert).toBeVisible()
    await insert.locator('[data-synced-group-choice="' + created.groupId + '"] input[type="radio"]').check()
    await insert.getByRole('button', { name: uiText('Insert reference', '插入引用'), exact: true }).click()
    await expect(insert).toHaveCount(0)
    const target = await page.evaluate(async input => {
      const document = await window.knowbook.getDocumentDetail(input.documentId)
      if (!document) throw Error('Actual destination missing')
      const refs = document.blocks.filter(block => block.type === 'synced-block')
      if (refs.length !== 1) throw Error('UI insert did not leave exactly one real reference')
      const actual = await window.knowbook.resolveSyncedInlineInstance({ hostDocumentId: document.id, instanceId: refs[0].id, groupId: input.groupId })
      return { document, instanceId: refs[0].id, actual }
    }, { documentId: seed.targetId, groupId: created.groupId })
    expect(target.document.summary).toBe('destination summary kept')
    expect(target.document.blocks.some(block => block.id === seed.childId || block.content.includes(seed.text))).toBe(false)
    expect(target.actual.status).toBe('ready')
    if (target.actual.status !== 'ready') throw Error('The inserted reference was not resolved by actual Main')
    expect(target.actual.snapshot.blocks.find(block => block.id === seed.childId)?.content).toBe(seed.text)
    expect(target.actual.snapshot.instances).toHaveLength(2)
    await expectCanonicalRow(inlineInstance(page, target.instanceId), seed.childId, seed.text)
  })
})

test('UI refuses an unsupported heading creation selection and keeps the original host body intact @electron', async ({}, info) => {
  await withElectronFailureTrace(info, async ({ page }) => {
    const before = await page.evaluate(async () => {
      const created = await window.knowbook.createDocument(null), headingId = crypto.randomUUID()
      await window.knowbook.updateDocument(created.id, { title: 'Unsupported heading stays', summary: 'untouched summary', blocks: [
        { id: headingId, type: 'heading-1', content: 'Unsupported heading stays', checked: false, depth: 0, parentBlockId: null },
        { id: crypto.randomUUID(), type: 'paragraph', content: 'Original complete W remains', checked: false, depth: 0, parentBlockId: null }
      ] })
      return { document: await window.knowbook.getDocumentDetail(created.id), headingId }
    })
    if (!before.document) throw Error('Original fixture missing')
    await page.reload()
    await page.locator('.tree-button', { hasText: before.document.title }).first().click()
    await expect(page.locator('.document-header-title')).toHaveText(before.document.title)
    const row = page.locator('.block-editor-row[data-block-id="' + before.headingId + '"]')
    await row.hover(); await row.locator('.block-drag-handle').click()
    await page.getByRole('dialog', { name: uiText('Block actions', '内容块操作'), exact: true })
      .getByRole('button', { name: uiText('Create synced block…', '创建同步块…'), exact: true }).click()
    await expect(page.getByRole('dialog', { name: uiText('Create synced block', '创建同步块'), exact: true })).toHaveCount(0)
    await expect(page.getByText(uiText('Creating from a heading selection is not supported; the original body is retained.', '当前不能将含标题的选区转为同步块，原正文已保留。'), { exact: true })).toBeVisible()
    const after = await page.evaluate(id => window.knowbook.getDocumentDetail(id), before.document.id)
    expect(after).toEqual(before.document)
    expect(after?.blocks.some(block => block.type === 'synced-block')).toBe(false)
  })
})
