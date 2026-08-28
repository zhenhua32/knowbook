import { expect, test } from '@playwright/test'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { hasBuiltElectronApp, withElectronApp } from './helpers/electron'

test.describe('Plugin UI isolation @electron', () => {
  test('loads an opaque sandbox document and blocks navigation or popups before network', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')
    let requestCount = 0
    const server = createServer((_request, response) => {
      requestCount += 1
      response.writeHead(204)
      response.end()
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const port = (server.address() as AddressInfo).port

    try {
      const targetUrl = `http://127.0.0.1:${port}/should-not-load`
      await withElectronApp(async ({ page }) => {
        const loaded = await page.evaluate(() => new Promise<boolean>((resolve) => {
          const frame = document.createElement('iframe')
          frame.sandbox.add('allow-scripts')
          const timeout = window.setTimeout(() => resolve(false), 3_000)
          const receive = (event: MessageEvent) => {
            if (event.source !== frame.contentWindow || event.data !== 'plugin-frame-loaded') return
            window.clearTimeout(timeout)
            window.removeEventListener('message', receive)
            resolve(true)
          }
          window.addEventListener('message', receive)
          frame.src = 'knowbook-plugin-ui://frame/00000000-0000-4000-8000-000000000001'
          document.body.append(frame)
        }))

        expect(loaded).toBe(true)
        await page.waitForTimeout(500)
        expect(requestCount).toBe(0)
      }, {
        KNOWBOOK_E2E_PLUGIN_UI_PROBE: '1',
        KNOWBOOK_E2E_PLUGIN_UI_TARGET: targetUrl
      })
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (
        error ? reject(error) : resolve()
      )))
    }
  })
})
