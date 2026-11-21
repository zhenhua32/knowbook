import { expect, test, type Page } from '@playwright/test'
import { markdownEngine, type MarkdownEnvironment } from '../src/shared/markdownEngine'
import { inlineInstance, openInlineHost, setInlineReading, withCanonicalInlineApp } from './helpers/canonical-inline'
import { hasBuiltElectronApp, uiText } from './helpers/electron'

async function undo(page: Page) {
  await page.locator('.document-header-more-button').click()
  await page.locator('.document-header-action-menu').getByRole('button', { name: uiText('Undo', '撤销'), exact: true }).click()
}

test.skip(!hasBuiltElectronApp(), 'Build the actual local Electron app before this acceptance slice')

test('mixed Duplicate from toolbar, shortcut and block menu creates a fresh shared instance without touching the OS clipboard @electron', async ({}, info) => {
  await withCanonicalInlineApp(info, async fixture => {
    const { seed } = fixture, { page, app } = fixture.context(), host = seed.hosts[0]
    const [ordinary, first, second] = host.blocks
    const row = (id: string) => page.locator('.block-editor-row[data-block-id="' + id + '"]')
    const read = () => page.evaluate(id => window.knowbook.getDocumentDetail(id), host.id)
    const clipboard = () => app.evaluate(({ clipboard }) => ({ text: clipboard.readText(), html: clipboard.readHTML() }))
    await openInlineHost(page, host); await setInlineReading(page, false)
    await app.evaluate(({ clipboard }) => clipboard.write({ text: 'Duplicate sentinel', html: '<p>Duplicate sentinel</p>' }))
    const originalClipboard = await clipboard(), original = (await read())!.blocks
    for (const entry of ['toolbar', 'shortcut', 'menu'] as const) {
      // Undo restores the editor's former focus and can scroll a row behind
      // the sticky header. Use points the browser can actually hit.
      await row(ordinary.id).evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }))
      const points = async () => page.evaluate(ids => ids.map(id => {
        const element = document.querySelector(`.block-editor-row[data-block-id="${id}"]`)
        if (!element) return null
        const bounds = element.getBoundingClientRect()
        const x = bounds.x + 2, y = bounds.y + Math.min(10, bounds.height / 2)
        return document.elementFromPoint(x, y)?.closest('.block-editor-row') === element ? { x, y } : null
      }), [ordinary.id, first.id])
      let endpoints: Awaited<ReturnType<typeof points>> = []
      await expect.poll(async () => {
        endpoints = await points()
        return endpoints.every(point => point !== null)
      }, { message: `Both host rows must accept the pointer before ${entry} Duplicate` }).toBe(true)
      const [start, end] = endpoints
      if (!start || !end) throw new Error('Both host rows must be visible')
      await page.mouse.move(start.x, start.y); await page.mouse.down()
      await page.mouse.move(end.x, end.y, { steps: 4 }); await page.mouse.up()
      await expect.poll(() => page.locator('.block-editor-row-selected').evaluateAll(rows => rows.map(row => row.getAttribute('data-block-id'))),
        { message: `Select both original host rows before ${entry} Duplicate` }).toEqual([ordinary.id, first.id])
      if (entry === 'shortcut') await row(ordinary.id).locator('textarea.block-inline-textarea').press('Control+Shift+D')
      else {
        if (entry === 'menu') await row(ordinary.id).locator('.block-drag-handle').click()
        const controls = entry === 'toolbar' ? page.locator('.block-selection-toolbar') : page.getByRole('dialog', { name: uiText('Block actions', '内容块操作') })
        await controls.getByRole('button', { name: uiText('Duplicate', entry === 'toolbar' ? '复制副本' : '复制'), exact: true }).click()
      }
      const error = page.getByRole('dialog', { name: uiText('Block edit', '正文块编辑') })
      await expect.poll(async () => await error.isVisible() ? error.getByRole('alert').textContent()
        : (await read())?.blocks.map(block => block.type)).toEqual(['paragraph', 'synced-block', 'paragraph', 'synced-block', 'synced-block'])
      const [oldOrdinary, oldReference, newOrdinary, newReference, tail] = (await read())!.blocks
      expect([oldOrdinary.id, oldReference.id, tail.id]).toEqual([ordinary.id, first.id, second.id])
      expect(newOrdinary.id).not.toBe(ordinary.id)
      expect(newOrdinary.content).toBe(ordinary.content)
      expect(newReference.id).not.toBe(first.id)
      expect(newReference.content).toBe(first.content)
      const resolved = await page.evaluate(input => window.knowbook.resolveSyncedInlineInstance(input),
        { hostDocumentId: host.id, instanceId: newReference.id, groupId: seed.groupId })
      expect(resolved.status).toBe('ready')
      expect(await clipboard()).toEqual(originalClipboard)
      await undo(page)
      await expect.poll(async () => (await read())?.blocks).toEqual(original)
    }
  })
})

test('mixed block toolbar copy and cut paste fresh real references, while external text stays independent @electron', async ({}, info) => {
  await withCanonicalInlineApp(info, async fixture => {
    const { seed } = fixture, { page, app } = fixture.context(), [host, peer] = seed.hosts
    const [ordinary, first, second] = host.blocks
    const row = (id: string) => page.locator('.block-editor-row[data-block-id="' + id + '"]')
    const textarea = (id: string) => row(id).locator('textarea.block-inline-textarea')
    const toolbar = page.locator('.block-selection-toolbar')
    const read = (documentId: string) => page.evaluate(id => window.knowbook.getDocumentDetail(id), documentId)
    const ids = async (id: string) => (await read(id))?.blocks.map(block => block.id)
    const selectRows = async (firstId: string, secondId: string) => {
      const rowIds = [firstId, secondId]
      await row(firstId).evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }))
      const points = () => page.evaluate(async blockIds => {
        const measure = () => blockIds.map(id => {
          const element = document.querySelector(`.block-editor-row[data-block-id="${id}"]`)
          if (!element) return null
          const bounds = element.getBoundingClientRect()
          // Use the host row's top padding above its buttons and embedded editor.
          const x = bounds.x + 24, y = bounds.y + 2
          return document.elementFromPoint(x, y) === element ? { x, y } : null
        })
        const before = measure()
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
        return measure().map((point, index) => point && point.x === before[index]?.x && point.y === before[index]?.y ? point : null)
      }, rowIds)
      let endpoints: Awaited<ReturnType<typeof points>> = []
      await expect.poll(async () => {
        endpoints = await points()
        return endpoints.every(point => point !== null)
      }, { message: 'Both rows must accept the drag outside the sticky header' }).toBe(true)
      const [start, end] = endpoints
      if (!start || !end) throw new Error('Both rows must accept the drag')
      const selectedIds = () => page.locator('.block-editor-row-selected').evaluateAll(rows => rows.map(row => row.getAttribute('data-block-id')))
      await page.mouse.move(start.x, start.y)
      await page.mouse.down()
      try {
        await page.mouse.move(end.x, end.y)
        await expect.poll(selectedIds, { message: 'Select both host rows while the mouse button is held' }).toEqual(rowIds)
      } finally {
        await page.mouse.up()
      }
      await expect.poll(selectedIds).toEqual(rowIds)
    }
    await openInlineHost(page, host); await setInlineReading(page, false)
    await selectRows(ordinary.id, first.id)
    await toolbar.getByRole('button', { name: uiText('Copy Blocks', '复制块'), exact: true }).click()
    const clipboard = () => app.evaluate(({ clipboard }) => ({ text: clipboard.readText(), html: clipboard.readHTML() }))
    // A previous app process may have left the same HTML marker on the OS clipboard.
    const waitForSyncedClipboard = async (expectedText: string) => {
      let snapshot = { text: '', html: '' }
      await expect.poll(async () => {
        snapshot = await clipboard()
        return snapshot
      }).toEqual({
        text: expect.stringContaining(expectedText),
        html: expect.stringContaining('data-knowbook-synced-clipboard')
      })
      return snapshot.text
    }
    const copiedText = await waitForSyncedClipboard(seed.primaryText)
    expect(copiedText).toContain(ordinary.content)
    expect(copiedText).not.toContain(seed.groupId)
    expect(await ids(host.id)).toEqual([ordinary.id, first.id, second.id])

    await openInlineHost(page, peer); await setInlineReading(page, false)
    const oldPeerIds = peer.blocks.map(block => block.id), peerTextarea = textarea(peer.blocks[0].id)
    await peerTextarea.click(); await peerTextarea.press('End')
    type ClipboardEvidence = HTMLTextAreaElement & { pasteEvidence?: { trusted: boolean; hasMarker: boolean } }
    await peerTextarea.evaluate(element => {
      const textarea = element as ClipboardEvidence
      textarea.addEventListener('paste', event => {
        textarea.pasteEvidence = { trusted: event.isTrusted,
          hasMarker: event.clipboardData?.getData('text/html').includes('data-knowbook-synced-clipboard') ?? false }
      }, { once: true })
    })
    await peerTextarea.press('Control+v')
    await expect.poll(() => peerTextarea.evaluate(element => (element as ClipboardEvidence).pasteEvidence)).toEqual({ trusted: true, hasMarker: true })
    const failureDialog = page.getByRole('dialog', { name: uiText('Block edit', '正文块编辑') })
    await expect.poll(async () => {
      if (await failureDialog.isVisible()) return failureDialog.getByRole('alert').textContent()
      return (await read(peer.id))?.blocks.length
    }).toBe(oldPeerIds.length + 2)
    const peerAfter = (await read(peer.id))!.blocks, [anchor, freshOrdinary, freshRef, last] = peerAfter
    expect([anchor.id, last.id]).toEqual(oldPeerIds)
    expect(freshOrdinary.content).toBe(ordinary.content)
    expect(freshOrdinary.id).not.toBe(ordinary.id)
    expect(freshRef.type).toBe('synced-block')
    expect(freshRef.id).not.toBe(first.id)
    expect(JSON.parse(freshRef.content).groupId).toBe(seed.groupId)
    await undo(page)
    await expect.poll(() => ids(peer.id)).toEqual(oldPeerIds)

    // Replacing the native clipboard with byte-identical text removes the
    // original HTML marker. That paste must remain independent Markdown.
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), copiedText)
    await peerTextarea.click(); await peerTextarea.press('Control+a'); await peerTextarea.press('Control+v')
    await expect.poll(async () => (await read(peer.id))?.blocks.some(block => block.content === seed.primaryText)).toBe(true)
    expect((await read(peer.id))?.blocks.filter(block => block.type === 'synced-block').map(block => block.id)).toEqual([oldPeerIds[1]])

    await openInlineHost(page, host); await setInlineReading(page, false)
    await selectRows(ordinary.id, first.id)
    await toolbar.getByRole('button', { name: uiText('Cut', '剪切'), exact: true }).click()
    await expect.poll(async () => await failureDialog.isVisible()
      ? failureDialog.getByRole('alert').textContent() : ids(host.id)).toEqual([second.id])
    await waitForSyncedClipboard(seed.primaryText)
    await undo(page)
    await expect.poll(() => ids(host.id)).toEqual([ordinary.id, first.id, second.id])

    // Put an actual reference definition and named note into the canonical
    // body through its genuine Main session, then copy both visible instances.
    await page.evaluate(async ({ hostId, instanceId, groupId, use, definitions }) => {
      const opened = await window.knowbook.openSyncedEditingSession({ kind: 'instance', hostDocumentId: hostId, instanceId, groupId })
      if (opened.status !== 'ready' || !opened.snapshot) throw new Error('Actual shared body unavailable')
      const snapshot = opened.snapshot, instance = opened.instance
      if (!instance) throw new Error('Actual shared instance unavailable')
      const result = await window.knowbook.invokeSyncedEditingSession({ sessionId: opened.session.sessionId, method: 'updateSyncedBlockGroup',
        input: { clientOperationId: crypto.randomUUID(), groupId, expectedRevision: snapshot.revision, expectedTopologyRevision: snapshot.topologyRevision,
          expectedInstanceBinding: { instanceId, hostDocumentId: hostId, bindingVersion: instance.bindingVersion },
          blocks: snapshot.blocks.map(({ createdAt: _createdAt, ...block }, index) => ({ ...block, content: index === 0 ? use : definitions })) } })
      if (result.status !== 'saved') throw new Error('The actual shared definitions were not stored')
    }, { hostId: host.id, instanceId: first.id, groupId: seed.groupId, use: 'Canonical [target][same] [^note]',
      definitions: '[same]: https://example.test/shared\n\n[^note]: Shared note' })
    // The Main reply can arrive before both nested editors finish rendering the new group.
    for (const instance of [first, second]) {
      await expect(inlineInstance(page, instance.id).locator('.ProseMirror')).toContainText(/Canonical (?:\[target\]|target)/)
    }
    await selectRows(first.id, second.id)
    await toolbar.getByRole('button', { name: uiText('Copy Blocks', '复制块'), exact: true }).click()
    const projection = await waitForSyncedClipboard('Shared note'), env: MarkdownEnvironment = {}
    const parsed = markdownEngine.parse(projection, env)
    expect(Object.values(env.references ?? {}).map(reference => reference.href)).toEqual(['https://example.test/shared', 'https://example.test/shared'])
    expect(Object.keys((env.footnotes as { refs?: Record<string, number> } | undefined)?.refs ?? {})).toHaveLength(2)
    const observed = parsed.flatMap(token => token.children ?? [])
    const labels = (type: string) => observed.flatMap(token => token.type === type && typeof token.meta?.label === 'string' ? [token.meta.label] : [])
    expect(new Set(labels('link_open')).size).toBe(2)
    expect(new Set(labels('footnote_ref')).size).toBe(2)
    expect(projection).not.toContain(seed.groupId)
  })
})
