import { expect, test } from '@playwright/test'
import type { PluginUiPreparationRequest, PluginUiPreparationResult } from '../src/shared/plugin-ui'
import { withElectronApp } from './helpers/electron'

test('iframe preparation loads its production chunk only on demand and validates the opaque frame handshake @electron', async () => {
  await withElectronApp(async ({ app, page }) => {
    // Chromium does not expose every file:// module through Resource Timing.
    // Debugger events include both modules loaded at startup and later imports.
    const session = await page.context().newCDPSession(page)
    const parsedModules = new Set<string>()
    session.on('Debugger.scriptParsed', ({ url }) => parsedModules.add(url))
    await session.send('Debugger.enable')
    const host = page.locator('[data-plugin-ui-preparation-host="true"]')
    await expect(host).toHaveCount(1)
    const loadedBatch = () => [...parsedModules]
      .some(url => /PluginUiPreparationBatch-[^/]+\.js/.test(url))
    expect(await loadedBatch()).toBe(false)

    await app.evaluate(({ ipcMain, protocol }) => {
      const fixture = globalThis as typeof globalThis & { preparationReports: unknown[] }
      fixture.preparationReports = []
      ipcMain.removeHandler('knowbook:report-plugin-ui-preparation')
      ipcMain.handle('knowbook:report-plugin-ui-preparation', (_event, result) => {
        fixture.preparationReports.push(result)
      })
      // Replace the registered probe document only in this isolated test profile.
      // The real preload, production chunk and MessageChannel remain in use.
      protocol.unhandle('knowbook-plugin-ui')
      protocol.handle('knowbook-plugin-ui', () => new Response(`<!doctype html><script>
        let approve;
        addEventListener('message', event => {
          if (event.source !== parent) return;
          if (event.data.type === 'fixture:approve') { if (approve) approve(); return; }
          if (event.data.type !== 'knowbook:init' || !event.ports[0]) return;
          const port = event.ports[0];
          const message = {type:'knowbook:ready', owner:event.data.owner,
            contributionId:event.data.contributionId, slot:event.data.slot};
          port.postMessage({...message, owner:{...message.owner, runId:'incorrect-run'}});
          approve = () => port.postMessage(message);
          parent.postMessage('fixture:handshake-connected', '*');
        });
      </script>`, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }))
    })
    const reports = () => app.evaluate(() => (globalThis as typeof globalThis & {
      preparationReports: PluginUiPreparationResult[]
    }).preparationReports)
    const send = (request: PluginUiPreparationRequest) => app.evaluate(({ BrowserWindow }, request) => {
      BrowserWindow.getAllWindows()[0].webContents.send('knowbook:plugin-ui-prepare', request)
    }, request)
    const identity: PluginUiPreparationRequest['identity'] = {
      pluginId: 'preparation-fixture', revisionId: 'revision', runId: 'run',
      grantSetId: 'grants', scope: { kind: 'app' }
    }
    await send({ requestId: 'empty-fixture', identity, frames: [] })
    await expect.poll(reports).toEqual([{ requestId: 'empty-fixture', identity, status: 'ready' }])
    expect(await loadedBatch()).toBe(false)

    await page.evaluate(() => {
      document.documentElement.dataset.preparationConnected = 'false'
      const receive = (event: MessageEvent) => {
        const frame = document.querySelector<HTMLIFrameElement>('[data-plugin-ui-preparation-host] iframe')
        if (event.source !== frame?.contentWindow || event.data !== 'fixture:handshake-connected') return
        document.documentElement.dataset.preparationConnected = 'true'
        window.removeEventListener('message', receive)
      }
      window.addEventListener('message', receive)
    })
    const request: PluginUiPreparationRequest = {
      requestId: 'frame-fixture', identity, frames: [{ slot: 'workspace.dashboard',
        contributionId: 'fixture-frame', title: 'Cold preparation fixture', height: 100,
        src: 'knowbook-plugin-ui://frame/00000000-0000-4000-8000-000000000001' }]
    }
    await send(request)
    const frame = host.locator('iframe')
    await expect(frame).toHaveAttribute('sandbox', 'allow-scripts')
    await expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer')
    await expect(page.locator('html')).toHaveAttribute('data-preparation-connected', 'true')
    await expect.poll(loadedBatch, { timeout: 2_000 }).toBe(true)
    // An identity mismatch must not mark the actual preparation as ready.
    await page.waitForTimeout(100)
    expect(await reports()).toHaveLength(1)
    await frame.evaluate((element: HTMLIFrameElement) => {
      element.contentWindow!.postMessage({ type: 'fixture:approve' }, '*')
    })
    await expect.poll(reports).toEqual([
      { requestId: 'empty-fixture', identity, status: 'ready' },
      { requestId: 'frame-fixture', identity, status: 'ready' }
    ])
    await expect(frame).toHaveCount(0)
    await send(request)
    await page.waitForTimeout(100)
    expect(await reports()).toHaveLength(2)
    await expect(frame).toHaveCount(0)
    await session.detach()
  }, { KNOWBOOK_E2E_PLUGIN_UI_PROBE: '1', KNOWBOOK_E2E_PLUGIN_UI_TARGET: 'http://127.0.0.1:1/unused-fixture' })
})
