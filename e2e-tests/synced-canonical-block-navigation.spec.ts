import { expect, test } from '@playwright/test'
import { formatSyncedCanonicalBlockAddress } from '../src/shared/synced-canonical-block-address'
import { expectExactCanonicalFocus } from './helpers/canonical-inline'
import { hasBuiltElectronApp, uiText } from './helpers/electron'
import { withElectronFailureTrace } from './helpers/electron-failure-trace'

test.skip(!hasBuiltElectronApp(), 'Build the actual local Electron app first')

test('ordinary Markdown and Wiki canonical links focus the exact unique instance and stay put when it becomes ambiguous @electron', async ({}, info) => {
  await withElectronFailureTrace(info, async ({ page }) => {
    const seed = await page.evaluate(async () => {
      const source = await window.knowbook.createDocument(null), reader = await window.knowbook.createDocument(null)
      const second = await window.knowbook.createDocument(null)
      const sourceTitle = 'Canonical address source', readerTitle = 'Canonical address reader'
      const blockId = crypto.randomUUID(), instanceId = crypto.randomUUID(), groupId = crypto.randomUUID()
      const { document: detail } = await window.knowbook.updateDocument(source.id, { title: sourceTitle, summary: '',
        blocks: [{ id: blockId, content: 'Only one exact canonical destination', type: 'paragraph', depth: 0, parentBlockId: null, checked: false }] })
      const opening = await window.knowbook.openSyncedEditingSession({ kind: 'host', hostDocumentId: source.id })
      if (opening.status !== 'ready') throw Error('Canonical source fixture is unavailable')
      const result = await window.knowbook.invokeSyncedEditingSession({ sessionId: opening.session.sessionId, method: 'applySyncedHostStructure', input: {
        clientOperationId: crypto.randomUUID(), mode: 'command', groups: [], expectedInstances: [],
        hostsWorkingBefore: [{ documentId: source.id, expectedPersistedUpdatedAt: detail.updatedAt, workingBefore: {
          title: detail.title, summary: detail.summary, blocks: detail.blocks.map(({ sortOrder: _sort, ...block }) => ({
            ...block, parentBlockId: block.parentBlockId ?? null })) } }],
        action: { kind: 'create', documentId: source.id, selectedRootIds: [blockId], instanceId, groupId }
      } })
      if (result.status !== 'applied') throw Error('Canonical address fixture create failed: ' + result.status)
      const group = result.groups.find(row => row.groupId === groupId), block = group?.blocks.find(row => row.id === blockId)
      if (!group || !block) throw Error('Canonical group or child is absent from the real acknowledgement')
      return { sourceId: source.id, readerId: reader.id, secondId: second.id, sourceTitle, readerTitle, instanceId,
        address: { groupId, creationId: group.creationId, groupCreatedAt: group.createdAt, blockId, blockCreatedAt: block.createdAt } }
    })
    const uri = formatSyncedCanonicalBlockAddress(seed.address)
    await page.evaluate(({ readerId, readerTitle, uri }) => window.knowbook.updateDocument(readerId, { title: readerTitle, summary: '',
      blocks: [{ id: crypto.randomUUID(), content: `[Markdown destination](${uri}) [[${uri}|Wiki destination]]`,
        type: 'paragraph', depth: 0, parentBlockId: null, checked: false }] }), { readerId: seed.readerId, readerTitle: seed.readerTitle, uri })
    await page.reload()
    const heading = page.locator('.document-header-title')
    const openReader = async () => {
      await page.locator('.tree-button', { hasText: seed.readerTitle }).first().click()
      await expect(heading).toHaveText(seed.readerTitle)
      if (!(await page.locator('.document-reading-content').isVisible())) await page.locator('.document-view-toggle').click()
    }
    for (const label of ['Markdown destination', 'Wiki destination']) {
      await openReader()
      await page.getByRole('button', { name: label, exact: true }).click()
      await expect(heading).toHaveText(seed.sourceTitle)
      await expectExactCanonicalFocus(page, seed.instanceId, seed.address.blockId)
    }

    const added = await page.evaluate(async ({ sourceId, secondId, instanceId, address }) => {
      const current = await window.knowbook.resolveSyncedInlineInstance({ hostDocumentId: sourceId, groupId: address.groupId, instanceId })
      const target = await window.knowbook.getDocumentDetail(secondId)
      const session = await window.knowbook.openSyncedEditingSession({ kind: 'host', hostDocumentId: secondId })
      if (!target || session.status !== 'ready' || current.status !== 'ready') throw Error('Second actual host is unavailable')
      return window.knowbook.invokeSyncedEditingSession({ sessionId: session.session.sessionId, method: 'applySyncedHostStructure', input: {
        clientOperationId: crypto.randomUUID(), mode: 'command', expectedInstances: [],
        groups: [{ groupId: address.groupId, expectedRevision: current.snapshot.revision, expectedTopologyRevision: current.snapshot.topologyRevision }],
        hostsWorkingBefore: [{ documentId: target.id, expectedPersistedUpdatedAt: target.updatedAt, workingBefore: {
          title: target.title, summary: target.summary, blocks: target.blocks.map(({ sortOrder: _sort, ...block }) => ({
            ...block, parentBlockId: block.parentBlockId ?? null })) } }],
        action: { kind: 'insert', groupId: address.groupId, instanceId: crypto.randomUUID(),
          target: { documentId: target.id, parentBlockId: null, beforeBlockId: null, depth: 0 } }
      } })
    }, seed)
    expect(added.status).toBe('applied')
    expect(await page.evaluate(uri => window.knowbook.resolveSyncedCanonicalBlockAddress(uri), uri)).toEqual({ status: 'ambiguous-instance' })
    await openReader()
    await page.getByRole('button', { name: 'Markdown destination', exact: true }).click()
    await expect(page.getByText(uiText('This body has multiple references. Open the one you want through search.',
      '目标正文有多个引用，请通过搜索打开要查看的引用。'), { exact: true }).first()).toBeVisible()
    await expect(heading).toHaveText(seed.readerTitle)
  }, {}, { editorMode: 'markdown' })
})
