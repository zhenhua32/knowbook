import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import type { Duplex } from 'node:stream'
import { fileURLToPath } from 'node:url'
import {
  closeElectronApp,
  hasBuiltElectronApp,
  launchElectronApp,
  uiText,
  type ElectronAppContext
} from './helpers/electron'

const pluginId = 'system.e2e.full-trust-acceptance'
const fixtureRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'full-trust-acceptance'
)

test.describe('System Plugin v3 @electron', () => {
  test('requires exact approval and activates Main plus Renderer only after restart', async () => {
    test.skip(!hasBuiltElectronApp(), 'Built Electron app not found. Run npm run build before E2E tests.')

    let first: ElectronAppContext | null = null
    let restarted: ElectronAppContext | null = null
    let retainedRoot: string | null = null
    const requests: string[] = []
    const upgradedSockets = new Set<Duplex>()
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      requests.push(url.pathname)
      if (url.pathname === '/api') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: true }))
        return
      }
      if (url.pathname === '/v1/chat/completions') {
        let body = ''
        request.setEncoding('utf8')
        request.on('data', (chunk) => { body += chunk })
        request.on('end', () => {
          let received: unknown = null
          try {
            received = JSON.parse(body)
          } catch {
            received = null
          }
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({
            id: 'full-trust-ai-ok',
            authorized: request.headers.authorization === 'Bearer full-trust-e2e-key',
            received
          }))
        })
        return
      }
      if (url.pathname === '/download') {
        response.writeHead(200, {
          'content-disposition': 'attachment; filename="full-trust.txt"',
          'content-type': 'text/plain'
        })
        response.end('full trust download')
        return
      }
      if (url.pathname === '/popup') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end('<!doctype html><title>Full Trust Popup</title><p id="popup-ready">popup-ready</p>')
        return
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(fullTrustFrameHtml(url.pathname === '/navigated' ? 'navigated' : 'initial'))
    })
    server.on('upgrade', (request, socket) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/socket') {
        socket.destroy()
        return
      }
      const key = request.headers['sec-websocket-key']
      if (typeof key !== 'string') {
        socket.destroy()
        return
      }
      upgradedSockets.add(socket)
      socket.once('close', () => upgradedSockets.delete(socket))
      requests.push(url.pathname)
      const accept = createHash('sha1')
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64')
      socket.write([
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        ''
      ].join('\r\n'))
      const payload = Buffer.from('websocket-ok')
      socket.end(Buffer.concat([
        Buffer.from([0x81, payload.length]),
        payload,
        Buffer.from([0x88, 0x00])
      ]))
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const port = (server.address() as AddressInfo).port
    const frameTarget = `http://127.0.0.1:${port}/frame`
    try {
      first = await launchElectronApp({
        KNOWBOOK_E2E_FULL_TRUST_FRAME_TARGET: frameTarget
      })
      retainedRoot = first.tempRoot
      await first.app.evaluate(({ dialog }, sourceDirectory) => {
        Object.defineProperty(dialog, 'showMessageBox', {
          configurable: true,
          value: async () => ({ response: 0, checkboxChecked: false })
        })
        Object.defineProperty(dialog, 'showOpenDialog', {
          configurable: true,
          value: async () => ({ canceled: false, filePaths: [sourceDirectory] })
        })
      }, fixtureRoot)

      const prepared = await first.page.evaluate(() => (
        window.knowbook.chooseAndPrepareSystemPluginInstall()
      ))
      expect(prepared?.pluginId).toBe(pluginId)
      expect(prepared?.status).toBe('awaiting-confirmation')
      expect(prepared?.artifactSha256).toMatch(/^[a-f0-9]{64}$/)

      await openPluginsPage(first.page)
      const request = first.page.locator('.system-plugin-request').filter({
        hasText: 'Full Trust Acceptance'
      }).first()
      await expect(request).toBeVisible()
      await expect(request.locator('.plugin-status')).toHaveText('awaiting-confirmation')
      await expect(request).toContainText(`SHA-256: ${prepared!.artifactSha256}`)
      for (const risk of [
        'ai',
        'background-service',
        'database',
        'electron',
        'environment',
        'filesystem',
        'network',
        'node',
        'raw-sqlite',
        'renderer',
        'secrets',
        'settings',
        'subprocess',
        'user-data',
        'unsandboxed-frame'
      ]) await expect(request).toContainText(risk)

      const confirm = request.getByRole('button', { name: uiText('Confirm system install', '确认系统安装') })
      const exactId = request.locator('.plugin-field input')
      await expect(confirm).toBeDisabled()
      await request.locator('input[type="checkbox"]').check()
      await exactId.fill('system.e2e.wrong-artifact')
      await expect(confirm).toBeDisabled()
      await exactId.fill(pluginId)
      await expect(confirm).toBeEnabled()
      await confirm.click()
      await expect.poll(async () => {
        const status = await request.locator('.plugin-status').textContent()
        if (status === 'pending-restart') return status
        const message = await first?.page.locator('.flash-message').textContent().catch(() => null)
        const logRoot = retainedRoot
          ? join(retainedRoot, 'system-plugins', 'logs', pluginId)
          : null
        const dependencyLog = logRoot && existsSync(logRoot)
          ? readdirSync(logRoot).map((name) => readFileSync(join(logRoot, name), 'utf8')).join('\n')
          : ''
        const detail = [message, dependencyLog].filter(Boolean).join('\n')
        return detail ? `${status ?? 'unknown'}: ${detail}` : (status ?? 'unknown')
      }, { message: 'Full Trust confirmation must publish and prepare the exact artifact' })
        .toBe('pending-restart')

      await closeElectronApp(first, { preserveUserData: true })
      first = null
      restarted = await launchElectronApp({
        KNOWBOOK_E2E_FULL_TRUST_FRAME_TARGET: frameTarget
      }, { userDataRoot: retainedRoot })

      const activationMarker = join(
        retainedRoot,
        'system-plugins',
        'data',
        pluginId,
        'activated.json'
      )
      await expect.poll(() => existsSync(activationMarker)).toBe(true)
      const activation = JSON.parse(readFileSync(activationMarker, 'utf8')) as {
        pluginId: string
        revisionHash: string
        nodeVersion: string
      }
      expect(activation.pluginId).toBe(pluginId)
      expect(activation.revisionHash).toBe(`sha256:${prepared!.artifactSha256}`)
      expect(activation.nodeVersion).toBeTruthy()

      const capabilitiesMarker = join(
        retainedRoot,
        'system-plugins',
        'data',
        pluginId,
        'capabilities.json'
      )
      await expect.poll(() => existsSync(capabilitiesMarker)).toBe(true)
      const capabilities = JSON.parse(readFileSync(capabilitiesMarker, 'utf8')) as {
        filesystem: { dataRootExists: boolean; userDataPath: string }
        runtime: {
          nodeVersion: string
          electronVersion: string
          appVersion: string
          childOutput: string
          npmDependency: { source: string; value: number }
        }
        environment: { frameTargetMatches: boolean }
        network: { ok: boolean }
        ai: {
          configured: boolean
          id: string
          authorized: boolean
          prompt: string | null
          seed: number | null
          toolName: string | null
          apiKeyAccessible: boolean
        }
        documents: { movedPath: string; parentDeleted: boolean; childDeleted: boolean }
        database: { updatedTitle: string | null; deleted: boolean }
        rawSql: { sqliteVersion: string; documentCount: number }
        store: { documentCount: number }
        settings: { value: string | null; deleted: boolean }
        electron: { mainWindowCount: number }
      }
      expect(capabilities.filesystem).toEqual({
        dataRootExists: true,
        userDataPath: retainedRoot
      })
      expect(capabilities.runtime).toMatchObject({
        nodeVersion: activation.nodeVersion,
        childOutput: 'full-trust-child-ok',
        npmDependency: { source: 'offline-npm-ci', value: 42 }
      })
      expect(capabilities.runtime.electronVersion).toBeTruthy()
      expect(capabilities.runtime.appVersion).toBeTruthy()
      expect(capabilities.environment.frameTargetMatches).toBe(true)
      expect(capabilities.network.ok).toBe(true)
      expect(capabilities.ai).toEqual({
        configured: true,
        id: 'full-trust-ai-ok',
        authorized: true,
        prompt: 'Full Trust arbitrary prompt',
        seed: 7,
        toolName: 'full_trust_tool',
        apiKeyAccessible: true
      })
      expect(capabilities.documents).toEqual({
        movedPath: 'Full Trust E2E Child',
        parentDeleted: true,
        childDeleted: true
      })
      expect(capabilities.database).toEqual({
        updatedTitle: 'Full Trust E2E Entity Updated',
        deleted: true
      })
      expect(capabilities.rawSql.sqliteVersion).toBeTruthy()
      expect(capabilities.rawSql.documentCount).toBe(capabilities.store.documentCount)
      expect(capabilities.settings).toEqual({ value: 'accepted', deleted: true })
      expect(capabilities.electron.mainWindowCount).toBeGreaterThanOrEqual(1)

      const activePlugin = await restarted.page.evaluate(async (id) => (
        (await window.knowbook.listSystemPlugins()).find((plugin) => plugin.pluginId === id) ?? null
      ), pluginId)
      const frameActivationError = await restarted.page.evaluate(() => (
        document.documentElement.dataset.fullTrustFrameError ?? null
      ))
      expect(frameActivationError).toBeNull()
      expect(activePlugin).toMatchObject({
        pluginId,
        enabled: true,
        status: 'active',
        lastError: null
      })
      expect(activePlugin?.dependencyJobs).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'install',
          packageManager: 'npm',
          command: ['npm', 'ci', '--ignore-scripts'],
          status: 'succeeded',
          exitCode: 0
        })
      ]))

      const serviceRpcMarker = join(
        retainedRoot,
        'system-plugins',
        'data',
        pluginId,
        'service-rpc.json'
      )
      await expect.poll(() => existsSync(serviceRpcMarker)).toBe(true)
      const serviceRpc = JSON.parse(readFileSync(serviceRpcMarker, 'utf8')) as {
        ping: { pluginId: string; revisionHash: string }
        paths: { userData: string }
        protocolVersion: number
      }
      expect(serviceRpc.protocolVersion).toBe(1)
      expect(serviceRpc.ping).toMatchObject({
        pluginId,
        revisionHash: `sha256:${prepared!.artifactSha256}`
      })
      expect(serviceRpc.paths.userData).toBe(retainedRoot)

      await openDashboardPage(restarted.page)
      const rendererContribution = restarted.page.getByTestId('full-trust-acceptance')
      await expect(rendererContribution).toBeVisible()
      await expect(rendererContribution).toContainText(`System Plugin v3 active: ${pluginId}`)
      await expect(rendererContribution).toHaveAttribute(
        'data-plugin-revision',
        `sha256:${prepared!.artifactSha256}`
      )

      const frameElement = restarted.page.locator('iframe[data-testid="full-trust-acceptance-frame"]')
      await expect(frameElement).toBeVisible()
      await expect(restarted.page.locator('style[data-full-trust-style="acceptance-global-style"]'))
        .toHaveCount(1)
      const frame = restarted.page.frameLocator('iframe[data-testid="full-trust-acceptance-frame"]')
      await expect(frame.locator('#page-kind')).toHaveText('initial')
      await expect(frame.locator('#network-result')).toHaveText('network-ok')
      await expect(frame.locator('#websocket-result')).toHaveText('websocket-ok')
      expect(requests).toContain('/api')
      expect(requests).toContain('/socket')

      await frame.locator('#request-permission').click()
      await expect(frame.locator('#permission-result')).toHaveText('granted')

      const popupPromise = restarted.app.waitForEvent('window')
      await frame.locator('#open-popup').click()
      const popup = await popupPromise
      await popup.waitForLoadState('domcontentloaded')
      await expect(popup.locator('#popup-ready')).toHaveText('popup-ready')
      const popupRuntime = await popup.evaluate(() => ({
        hasRequire: typeof (globalThis as typeof globalThis & { require?: unknown }).require === 'function',
        nodeVersion: (
          globalThis as typeof globalThis & { process?: { versions?: { node?: string } } }
        ).process?.versions?.node ?? null
      }))
      expect(popupRuntime.hasRequire).toBe(true)
      expect(popupRuntime.nodeVersion).toBeTruthy()

      await restarted.app.evaluate(({ session }) => {
        const target = globalThis as typeof globalThis & {
          __knowbookFullTrustDownloadProbe?: Promise<{
            prevented: boolean
            suggestedFilename: string
            url: string
          }>
        }
        target.__knowbookFullTrustDownloadProbe = new Promise((resolve) => {
          session.defaultSession.once('will-download', (event, item) => {
            resolve({
              prevented: event.defaultPrevented,
              suggestedFilename: item.getFilename(),
              url: item.getURL()
            })
            item.cancel()
          })
        })
      })
      await frame.locator('#download-file').click()
      const download = await restarted.app.evaluate(async () => {
        const target = globalThis as typeof globalThis & {
          __knowbookFullTrustDownloadProbe?: Promise<{
            prevented: boolean
            suggestedFilename: string
            url: string
          }>
        }
        const result = await target.__knowbookFullTrustDownloadProbe
        delete target.__knowbookFullTrustDownloadProbe
        return result
      })
      expect(download).toEqual({
        prevented: false,
        suggestedFilename: 'full-trust.txt',
        url: `http://127.0.0.1:${port}/download`
      })

      await frame.locator('#navigate-frame').click()
      await expect(frame.locator('#page-kind')).toHaveText('navigated')
      expect(requests).toContain('/navigated')

      await openPluginsPage(restarted.page)
      const installed = restarted.page.locator('.system-plugin-request').filter({
        hasText: 'Full Trust Acceptance'
      }).first()
      await expect(installed.locator('.plugin-status')).toHaveText('active')

      await restarted.page.evaluate(async (id) => {
        await window.knowbook.setSystemPluginEnabled({ pluginId: id, enabled: false })
      }, pluginId)
      await expect(restarted.page.locator('iframe[data-testid="full-trust-acceptance-frame"]'))
        .toHaveCount(0)
      await expect(restarted.page.locator('style[data-full-trust-style="acceptance-global-style"]'))
        .toHaveCount(0)
      await expect.poll(() => popup.isClosed()).toBe(true)
    } finally {
      if (first) await closeElectronApp(first)
      if (restarted) await closeElectronApp(restarted)
      if (!first && !restarted && retainedRoot && existsSync(retainedRoot)) {
        rmSync(retainedRoot, { recursive: true, force: true })
      }
      for (const socket of upgradedSockets) socket.destroy()
      upgradedSockets.clear()
      await new Promise<void>((resolve, reject) => server.close((error) => (
        error ? reject(error) : resolve()
      )))
    }
  })
})

function fullTrustFrameHtml(pageKind: 'initial' | 'navigated'): string {
  return `<!doctype html>
<meta charset="utf-8">
<p id="page-kind">${pageKind}</p>
<p id="network-result">pending</p>
<p id="websocket-result">pending</p>
<p id="permission-result">pending</p>
<button id="request-permission">permission</button>
<button id="open-popup">popup</button>
<a id="download-file" href="/download" download>download</a>
<button id="navigate-frame">navigate</button>
<script>
fetch('/api').then((response) => response.json()).then((value) => {
  document.querySelector('#network-result').textContent = value.ok ? 'network-ok' : 'network-failed'
}).catch(() => {
  document.querySelector('#network-result').textContent = 'network-failed'
})
const socket = new WebSocket('ws://' + location.host + '/socket')
socket.addEventListener('message', (event) => {
  document.querySelector('#websocket-result').textContent = event.data
  socket.close()
})
socket.addEventListener('error', () => {
  const result = document.querySelector('#websocket-result')
  if (result.textContent === 'pending') result.textContent = 'websocket-failed'
})
document.querySelector('#request-permission').addEventListener('click', async () => {
  document.querySelector('#permission-result').textContent = await Notification.requestPermission()
})
document.querySelector('#open-popup').addEventListener('click', () => {
  const popupName = new URL(location.href).searchParams.get('popupName')
  open('/popup', popupName)
})
document.querySelector('#navigate-frame').addEventListener('click', () => {
  const popupName = new URL(location.href).searchParams.get('popupName')
  location.href = '/navigated?popupName=' + encodeURIComponent(popupName)
})
</script>`
}

async function openPluginsPage(page: ElectronAppContext['page']): Promise<void> {
  const button = page.locator('button.nav-icon-btn')
    .and(page.getByTitle(uiText('Plugins', '插件中心')))
    .first()
  await button.click()
  await expect(button).toHaveClass(/active/)
}

async function openDashboardPage(page: ElectronAppContext['page']): Promise<void> {
  const button = page.locator('button.nav-icon-btn')
    .and(page.getByTitle(uiText('Dashboard', '总览')))
    .first()
  await button.click()
  await expect(button).toHaveClass(/active/)
}
