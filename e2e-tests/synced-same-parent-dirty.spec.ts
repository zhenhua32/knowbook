import { expect, test, type Page } from '@playwright/test'
import type { IpcMainInvokeEvent } from 'electron'
import type { SyncedEditingRequest } from '../src/shared/synced-editing-session'
import { appendCanonicalText, expectCanonicalRow, inlineInstance, openInlineHost, setInlineReading, withCanonicalInlineApp } from './helpers/canonical-inline'
import { hasBuiltElectronApp, uiText } from './helpers/electron'

async function historyAction(page: Page, action: 'Undo' | 'Redo') {
  await page.locator('.document-header-more-button').click()
  const label = uiText(action, action === 'Undo' ? '撤销' : '重做')
  const button = page.locator('.document-header-action-menu').getByRole('button', { name: label, exact: true })
  await expect(button).toBeEnabled()
  await button.click()
}

test.skip(!hasBuiltElectronApp(), 'Build the actual local Electron app before this acceptance slice')

for (const crash of [false, true]) test(`same-parent reorder preserves unsaved synchronized text through ${crash ? 'a crash after Main COMMIT' : 'lost acknowledgements and Undo/Redo'} @electron`, async ({}, info) => {
  await withCanonicalInlineApp(info, async fixture => {
    let { page } = fixture.context()
    const { seed } = fixture, host = seed.hosts[0]
    const [ordinary, reference, tail] = host.blocks, instanceId = seed.instanceIds[0], suffix = ' move should not write this'
    const read = () => page.evaluate(async ({ host, instanceId, groupId, primaryId }) => {
      const document = await window.knowbook.getDocumentDetail(host)
      const group = await window.knowbook.resolveSyncedInlineInstance({ hostDocumentId: host, instanceId, groupId })
      if (!document || group.status !== 'ready') throw new Error('Actual host or group unavailable')
      return { ids: document.blocks.map(block => block.id), contents: group.snapshot.blocks.find(block => block.id === primaryId)?.content,
        revision: group.snapshot.revision, topology: group.snapshot.topologyRevision, history: group.snapshot.history,
        instances: group.snapshot.instances }
    }, { host: host.id, groupId: seed.groupId, instanceId, primaryId: seed.primaryId })
    await openInlineHost(page, host)
    await setInlineReading(page, false)
    const before = await read()
    const paused = await page.evaluateHandle(() => {
      const set = window.setTimeout.bind(window), timers: number[] = []
      window.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
        if (delay !== 800) return set(callback, delay, ...args)
        const timer = set(() => {}, 2_147_000_000); timers.push(timer); return timer
      }) as typeof window.setTimeout
      return () => { window.setTimeout = set; for (const timer of timers) window.clearTimeout(timer) }
    })
    try {
      await appendCanonicalText(page, instanceId, seed.primaryId, seed.primaryText, suffix)
      expect(await read()).toEqual(before)
      const hostPid = await fixture.context().app.evaluate(({ app, ipcMain }, { crash, profile }) => {
        if (process.env.KNOWBOOK_E2E_BACKGROUND !== '1' || app.getPath('userData') !== profile) {
          throw new Error('The exact independent background test profile is required')
        }
        type Handler = (event: IpcMainInvokeEvent, request: SyncedEditingRequest) => Promise<unknown> | unknown
        const channel = 'knowbook:invoke-synced-editing-session'
        const handler = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers.get(channel)
        if (!handler) throw new Error('The actual Main structure handler is missing')
        const withhold = new Set(['applySyncedHostStructure', 'restoreSyncedHostOperation'])
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, async (event, request: SyncedEditingRequest) => {
          const result = await handler(event, request)
          if (result && typeof result === 'object' && 'status' in result && result.status === 'applied' && withhold.delete(request.method)) {
            if (crash) process.kill(process.pid, 'SIGKILL')
            throw new Error('Test transport withheld an actually committed response')
          }
          return result
        })
        return process.pid
      }, { crash, profile: fixture.context().tempRoot })
      const row = (id: string) => page.locator(`.block-editor-row[data-block-id="${id}"]`)
      const source = await row(ordinary.id).boundingBox(), destination = await row(reference.id).boundingBox()
      if (!source || !destination) throw new Error('The real selected rows are unavailable')
      await page.mouse.move(source.x + 2, source.y + Math.min(10, source.height / 2))
      await page.mouse.down()
      await page.mouse.move(destination.x + 2, destination.y + Math.min(10, destination.height / 2), { steps: 4 })
      await page.mouse.up()
      await expect.poll(() => page.locator('.block-editor-row-selected').evaluateAll(items =>
        items.map(item => item.getAttribute('data-block-id')))).toEqual([ordinary.id, reference.id])
      await row(ordinary.id).locator('textarea.block-inline-textarea').press('Alt+ArrowDown')
      const final = { ...before, ids: [tail.id, ordinary.id, reference.id] }
      if (crash) {
        await expect.poll(() => {
          try { process.kill(hostPid, 0); return false }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; throw error }
        }).toBe(true)
        await fixture.restart()
        ;({ page } = fixture.context())
        await openInlineHost(page, host); await setInlineReading(page, false)
        await expect.poll(read).toEqual(final)
        await page.getByRole('button', { name: /检查保留的编辑草稿|Review retained editor drafts/ }).click()
        const panel = page.getByRole('dialog', { name: uiText('Retained editor drafts', '保留的编辑草稿'), exact: true })
        await panel.getByRole('button', { name: new RegExp(seed.query) }).click()
        await panel.getByRole('button', { name: uiText('Restore', '恢复'), exact: true }).click()
        await expect(panel).toHaveCount(0)
        await expectCanonicalRow(inlineInstance(page, instanceId), seed.primaryId, seed.primaryText + suffix)
        expect(await read()).toEqual(final)
        return
      }
      await expect.poll(read).toEqual(final)
      await expect.poll(() => page.locator('.block-editor-row').evaluateAll(items =>
        items.filter(item => item.parentElement?.closest('.synced-inline-instance') === null).map(item => item.getAttribute('data-block-id'))))
        .toEqual(final.ids)
      await expectCanonicalRow(inlineInstance(page, instanceId), seed.primaryId, seed.primaryText + suffix)
      await historyAction(page, 'Undo')
      await expect.poll(read).toEqual(before)
      await expectCanonicalRow(inlineInstance(page, instanceId), seed.primaryId, seed.primaryText + suffix)
      await historyAction(page, 'Redo')
      await expect.poll(read).toEqual(final)
      await expectCanonicalRow(inlineInstance(page, instanceId), seed.primaryId, seed.primaryText + suffix)
    } finally { await paused.evaluate(restore => restore()).catch(() => {}); await paused.dispose() }
  })
})
