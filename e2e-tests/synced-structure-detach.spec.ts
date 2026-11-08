import { expect, test } from '@playwright/test'
import { hasBuiltElectronApp, uiText } from './helpers/electron'
import { withElectronFailureTrace } from './helpers/electron-failure-trace'
import { expectCanonicalRow, inlineInstance } from './helpers/canonical-inline'

test.skip(!hasBuiltElectronApp(), 'Build the actual local Electron app first')

test('the exact inline instance detaches into ordinary blocks and header history restores the same copy identities @electron', async ({}, info) => {
  await withElectronFailureTrace(info, async ({ page }) => {
    const seed = await page.evaluate(async () => {
      const source = await window.knowbook.createDocument(null), target = await window.knowbook.createDocument(null)
      const sourceTitle = 'Detach original shared body', title = 'Detach selected reference'
      const childId = crypto.randomUUID(), targetBodyId = crypto.randomUUID(), originalInstanceId = crypto.randomUUID()
      const groupId = crypto.randomUUID(), instanceId = crypto.randomUUID(), body = 'Canonical text before detach 中文🙂'
      const paragraph = (id: string, content: string) => ({ id, content, type: 'paragraph' as const, depth: 0, parentBlockId: null, checked: false })
      await window.knowbook.updateDocument(source.id, { title: sourceTitle, summary: '', blocks: [paragraph(childId, body)] })
      await window.knowbook.updateDocument(target.id, { title, summary: 'Detached host summary', blocks: [paragraph(targetBodyId, 'Retained ordinary text')] })
      const readOpening = async (id: string) => {
        const document = await window.knowbook.getDocumentDetail(id)
        const opened = await window.knowbook.openSyncedEditingSession({ kind: 'host', hostDocumentId: id })
        if (!document || opened.status !== 'ready') throw Error('Actual structure fixture host unavailable')
        return { sessionId: opened.session.sessionId, opening: { documentId: id, expectedPersistedUpdatedAt: document.updatedAt,
          workingBefore: { title: document.title, summary: document.summary, blocks: document.blocks.map(({ sortOrder: _sort, ...block }) => ({
            ...block, parentBlockId: block.parentBlockId ?? null })) } } }
      }
      const origin = await readOpening(source.id)
      const created = await window.knowbook.invokeSyncedEditingSession({ sessionId: origin.sessionId, method: 'applySyncedHostStructure', input: {
        clientOperationId: crypto.randomUUID(), mode: 'command', hostsWorkingBefore: [origin.opening], groups: [], expectedInstances: [],
        action: { kind: 'create', documentId: source.id, selectedRootIds: [childId], instanceId: originalInstanceId, groupId }
      } })
      const group = created.status === 'applied' ? created.groups.find(item => item.groupId === groupId) : undefined
      if (!group) throw Error('Genuine Main create failed: ' + created.status)
      const destination = await readOpening(target.id)
      const inserted = await window.knowbook.invokeSyncedEditingSession({ sessionId: destination.sessionId, method: 'applySyncedHostStructure', input: {
        clientOperationId: crypto.randomUUID(), mode: 'command', hostsWorkingBefore: [destination.opening], expectedInstances: [],
        groups: [{ groupId, expectedRevision: group.revision, expectedTopologyRevision: group.topologyRevision }],
        action: { kind: 'insert', groupId, instanceId, target: { documentId: target.id, parentBlockId: null, beforeBlockId: null, depth: 0 } }
      } })
      if (inserted.status !== 'applied') throw Error('Genuine Main insert failed: ' + inserted.status)
      return { sourceId: source.id, targetId: target.id, title, childId, body, groupId, originalInstanceId, instanceId, targetBodyId, originalRevision: group.revision }
    })
    await page.reload()
    await page.locator('.tree-button', { hasText: seed.title }).first().click()
    await expect(page.locator('.document-header-title')).toHaveText(seed.title)
    const instance = inlineInstance(page, seed.instanceId)
    await expectCanonicalRow(instance, seed.childId, seed.body)
    const detach = instance.getByRole('button', { name: uiText('Detach synced block…', '解除同步…'), exact: true })
    const dialog = page.getByRole('dialog', { name: uiText('Detach synced block', '解除同步'), exact: true })
    const persisted = () => page.evaluate(id => window.knowbook.getDocumentDetail(id), seed.targetId)
    const before = await persisted()
    await detach.click()
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: uiText('Cancel', '取消'), exact: true }).click()
    await expect(dialog).toHaveCount(0)
    expect(await persisted()).toEqual(before)

    await detach.click()
    await dialog.getByRole('button', { name: uiText('Detach', '解除同步'), exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(instance).toHaveCount(0)
    const after = await persisted()
    const copy = after?.blocks.find(block => block.content === seed.body)
    if (!copy || copy.id === seed.childId || copy.id === seed.instanceId) throw Error('No actual independent copy in the ordinary host')
    expect(after?.summary).toBe('Detached host summary')
    expect(after?.blocks.find(block => block.id === seed.targetBodyId)?.content).toBe('Retained ordinary text')
    const ordinary = page.locator('[data-block-id="' + copy.id + '"] textarea')
    await expect(ordinary).toHaveValue(seed.body)
    const surviving = await page.evaluate(input => window.knowbook.resolveSyncedInlineInstance({ hostDocumentId: input.sourceId,
      instanceId: input.originalInstanceId, groupId: input.groupId }), seed)
    if (surviving.status !== 'ready') throw Error('Original instance no longer resolves')
    expect(surviving.snapshot.revision).toBe(seed.originalRevision)
    expect(surviving.snapshot.instances.map(row => row.instanceId)).toEqual([seed.originalInstanceId])
    expect(surviving.snapshot.blocks.find(block => block.id === seed.childId)?.content).toBe(seed.body)

    const history = async (direction: 'undo' | 'redo') => {
      await page.locator('.document-header-more-button').click()
      await page.locator('.document-header-action-menu').getByRole('button', {
        name: direction === 'undo' ? uiText('Undo', '撤销') : uiText('Redo', '重做'), exact: true }).click()
    }
    await history('undo')
    await expectCanonicalRow(instance, seed.childId, seed.body)
    expect((await persisted())?.blocks).toEqual(before?.blocks)
    await history('redo')
    await expect(ordinary).toHaveValue(seed.body)
    expect((await persisted())?.blocks).toEqual(after?.blocks)
  })
})
