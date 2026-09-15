import { expect, test } from '@playwright/test'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { cp } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Duplex } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { handleFullTrustAiRequest, type FullTrustAiProbe } from './helpers/full-trust-ai'
import { closeElectronApp, launchElectronApp, uiText, type ElectronAppContext } from './helpers/electron'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixtureRoot = join(repoRoot, 'e2e-tests', 'fixtures', 'system-capabilities')
const baselineRoot = join(repoRoot, 'e2e-tests', 'fixtures', 'full-trust-acceptance')
const pluginId = 'system.e2e.capabilities'

test('one reviewed plugin exercises native, desktop, dedicated preload and renderer capabilities @system-capabilities', async ({}, testInfo) => {
  test.setTimeout(300_000)
  test.skip(process.platform !== 'win32', 'The agreed real-host acceptance scope is Windows.')
  test.skip(!process.env.KNOWBOOK_E2E_EXECUTABLE, 'Use the packaged capabilities runner.')
  const root = mkdtempSync(join(tmpdir(), 'knowbook 十二能力 '))
  const source = join(root, '插件 source')
  const selected = join(root, '用户选择目录')
  const token = randomUUID()
  const scheme = `knowbook-capability-${token}`
  const registryKey = `HKCU\\Software\\Classes\\${scheme}`
  const externalUrl = `${scheme}://probe/?token=${token}`
  const sockets = new Set<Duplex>()
  const aiProbe: FullTrustAiProbe = { openedStreams: new Set(), closedStreams: new Set() }
  const externalCalls: Array<{ url: string; token: string; pid: number; execPath: string }> = []
  const requests: string[] = []
  let current: ElectronAppContext | null = null
  let profile: string | null = null
  let registered = false
  let stage = 'fixture-preparation'
  let failure: string | null = null
  const completedStages: string[] = []
  const snapshots: unknown[] = []
  const cleanupErrors: string[] = []
  let binarySha256 = ''
  let ownedDetachedPid: number | null = null
  const revisions: string[] = []
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    requests.push(pathname)
    if (handleFullTrustAiRequest(request, response, aiProbe)) return
    if (pathname === '/external') {
      let body = ''
      request.on('data', (chunk) => { body += chunk })
      request.on('end', () => {
        try { externalCalls.push(JSON.parse(body)); response.end('ok') }
        catch { response.writeHead(400); response.end('invalid') }
      })
      return
    }
    if (pathname === '/api') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true }))
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(pathname === '/popup' ? '<p id="popup-ready">capability-popup</p>' : frameHtml())
  })
  let tlsServer: ReturnType<typeof createHttpsServer> | null = null
  server.on('upgrade', (request, socket) => {
    const key = request.headers['sec-websocket-key']
    if (typeof key !== 'string') { socket.destroy(); return }
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    requests.push('/socket')
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'))
    const payload = Buffer.from('capability-websocket')
    socket.end(Buffer.concat([Buffer.from([0x81, payload.length]), payload, Buffer.from([0x88, 0x00])]))
  })
  try {
    tlsServer = createHttpsServer({
      key: readFileSync(join(fixtureRoot, 'tls-key.pem')),
      cert: readFileSync(join(fixtureRoot, 'tls-cert.pem'))
    }, (_request, response) => response.end('trusted-local-tls'))
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    await new Promise<void>((resolve, reject) => { tlsServer!.once('error', reject); tlsServer!.listen(0, '127.0.0.1', resolve) })
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const env = { KNOWBOOK_E2E_FULL_TRUST_FRAME_TARGET: `${origin}/frame` }
    mkdirSync(selected)
    // Async cp preserves Unicode paths on Node 22 Windows runners where cpSync can omit files.
    await cp(fixtureRoot, source, { recursive: true })
    copyFileSync(join(baselineRoot, 'main.cjs'), join(source, 'baseline-main.cjs'))
    await cp(join(baselineRoot, 'vendor'), join(source, 'vendor'), { recursive: true })
    for (const name of ['package.json', 'package-lock.json']) copyFileSync(join(baselineRoot, name), join(source, name))
    const lock = JSON.parse(readFileSync(join(source, 'package-lock.json'), 'utf8'))
    lock.packages['node_modules/full-trust-local-dependency'] = { resolved: 'vendor/full-trust-local-dependency', link: true }
    lock.packages['vendor/full-trust-local-dependency'] = { version: '1.0.0' }
    writeFileSync(join(source, 'package-lock.json'), JSON.stringify(lock))
    const manifest = JSON.parse(readFileSync(join(baselineRoot, 'plugin.json'), 'utf8'))
    Object.assign(manifest, { id: pluginId, name: 'System Capabilities Acceptance' })
    writeFileSync(join(source, 'plugin.json'), JSON.stringify(manifest))
    writeFileSync(join(source, 'fixture.json'), JSON.stringify({ token, selectedDirectory: selected, externalUrl,
      tlsUrl: `https://127.0.0.1:${(tlsServer.address() as AddressInfo).port}` }))
    writeFileSync(join(source, '.npmrc'), 'offline=true\naudit=false\nfund=false\n')
    mkdirSync(join(source, 'native'))
    const nativeSource = join(repoRoot, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')
    binarySha256 = createHash('sha256').update(readFileSync(nativeSource)).digest('hex')
    copyFileSync(nativeSource, join(source, 'native', 'better_sqlite3.node'))

    // The only registered scheme is this run's UUID. The handler accepts only the exact
    // controlled URL and launches the external helper hidden, with no default-app changes.
    expect(spawnSync('reg.exe', ['query', registryKey], { windowsHide: true }).status).toBe(1)
    const handler = join(root, 'hidden-handler.vbs')
    const command = [process.execPath, join(source, 'external.cjs'), externalUrl, `${origin}/external`, token]
      .map((argument) => `"${argument}"`).join(' ')
    writeFileSync(handler, [
      'If WScript.Arguments.Count <> 1 Then WScript.Quit 2',
      `Set probeFile = CreateObject("Scripting.FileSystemObject").CreateTextFile(${vbsString(join(root, 'external-handler-url.txt'))}, True, True)`,
      'probeFile.WriteLine WScript.Arguments.Item(0)',
      'probeFile.Close',
      `If WScript.Arguments.Item(0) <> ${vbsString(externalUrl)} Then WScript.Quit 3`,
      `CreateObject("WScript.Shell").Run ${vbsString(command)}, 0, False`
    ].join('\r\n'), 'utf16le')
    // A UTF-16 BOM is required by Windows Script Host.
    writeFileSync(handler, Buffer.concat([Buffer.from([0xff, 0xfe]), readFileSync(handler)]))
    registered = true
    reg(['add', registryKey, '/ve', '/d', 'URL:KnowBook controlled capability probe', '/f'])
    reg(['add', registryKey, '/v', 'URL Protocol', '/d', '', '/f'])
    reg(['add', `${registryKey}\\shell\\open\\command`, '/ve', '/d', `"${join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wscript.exe')}" "${handler}" "%1"`, '/f'])

    stage = 'exact-review-and-install'
    current = await launchElectronApp(env)
    profile = current.tempRoot
    await current.app.evaluate(({ dialog }, directory) => {
      Object.defineProperty(dialog, 'showOpenDialog', { configurable: true, value: async () => ({ canceled: false, filePaths: [directory] }) })
      Object.defineProperty(dialog, 'showMessageBox', { configurable: true, value: async () => ({ response: 0 }) })
    }, source)
    const prepared = await current.page.evaluate(() => window.knowbook.chooseAndPrepareSystemPluginInstall())
    expect(prepared).toMatchObject({ pluginId, status: 'awaiting-confirmation' })
    expect(existsSync(join(selected, 'plugin-write.txt'))).toBe(false)
    expect(externalCalls).toHaveLength(0)
    await current.page.evaluate(async (request) => {
      await window.knowbook.resolveSystemPluginInstallRequest({
        requestId: request.id, pluginId: request.pluginId,
        artifactSha256: request.artifactSha256, acknowledgeSystemAccess: true, decision: 'confirm'
      })
    }, { id: prepared!.id, pluginId, artifactSha256: prepared!.artifactSha256 })
    const revision = `sha256:${prepared!.artifactSha256}`
    revisions.push(prepared!.artifactSha256)
    expect(existsSync(join(selected, 'plugin-write.txt'))).toBe(false)
    completedStages.push(stage)

    for (let run = 1; run <= 2; run += 1) {
      stage = run === 1 ? 'packaged-capabilities' : 'same-plugin-restart'
      await closeElectronApp(current, { preserveUserData: true })
      current = null
      if (run === 1) execFileSync(join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe'), [
        '--import', 'tsx', join(repoRoot, 'e2e-tests', 'helpers', 'prepare-capabilities-v2.ts'), profile, `${origin}/v2-must-not-load`
      ], { cwd: repoRoot, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 30000, stdio: 'pipe' })
      current = await launchElectronApp(env, { userDataRoot: profile })
      await expect.poll(async () => (await current!.page.evaluate(async (id) => (
        (await window.knowbook.listSystemPlugins()).find((item) => item.pluginId === id)
      ), pluginId))?.status, { timeout: 30000 }).toBe('active')
      const dataRoot = join(profile, 'system-plugins', 'data', pluginId)
      const marker = join(dataRoot, 'desktop-evidence.json')
      await expect.poll(() => existsSync(marker) ? readJson(marker).native.visits.length : 0).toBe(run)
      const desktop = readJson(marker)
      const baseline = readJson(join(dataRoot, 'capabilities.json'))
      await expect.poll(() => existsSync(join(dataRoot, 'service-rpc.json'))).toBe(true)
      await expect.poll(() => readJson(join(dataRoot, 'service-history.json')).length).toBe(run)
      await expect.poll(() => readJson(join(dataRoot, 'service-rpc.json')).pid).toBe(readJson(join(dataRoot, 'service-history.json')).at(-1).pid)
      snapshots.push({ desktop, baseline, service: readJson(join(dataRoot, 'service-rpc.json')) })
      expect(readJson(join(dataRoot, 'service-history.json'))).toHaveLength(run)
      expect(desktop).toMatchObject({
        revisionHash: revision,
        priorSetting: run === 1 ? null : 'survives-host-restart',
        filesystem: { selectedDirectory: selected, roundTrip: revision, transaction: 'transaction-ok' },
        native: { answer: 42, sha256: binarySha256, platform: 'win32', packaged: true },
        clipboard: `KnowBook capability clipboard ${token}`,
        preload: {
          proof: 'dedicated-preload-filesystem-proof', isolated: true,
          reply: { pluginId, revisionHash: revision, echo: 'renderer-to-dedicated-preload-to-main' }
        },
        desktop: { trayDestroyed: false, menuItems: 1 }
      })
      expect(desktop.tls).toEqual({ trusted: { status: 200, body: 'trusted-local-tls' }, untrustedError: 'DEPTH_ZERO_SELF_SIGNED_CERT' })
      expect(desktop.native.modules).toBeTruthy()
      if (run === 2) expect(desktop.priorConfig).toEqual({ theme: 'dark', aiModel: 'full-trust-e2e-model' })
      expect(baseline.runtime).toMatchObject({ childOutput: 'full-trust-child-ok', npmDependency: { value: 42 } })
      expect(baseline.network.ok).toBe(true)
      expect(baseline.ai).toMatchObject({ authorized: true, prompt: 'Full Trust arbitrary prompt', cancelledStream: 'AbortError', raw: { status: 418 } })
      expect(baseline.ai).toMatchObject({ seed: 7, toolName: 'full_trust_tool', apiKeyAccessible: true,
        completionError: 'AI request failed (429): {"error":{"message":"controlled-rate-limit"}}',
        streamError: 'AI request failed (429): {"error":{"message":"controlled-rate-limit"}}', invalidJsonError: 'SyntaxError' })
      expect(baseline.rawSql.documentCount).toBe(baseline.store.documentCount)
      expect(baseline.ai.streamText).toContain('你好')
      expect(baseline.documents).toMatchObject({ parentDeleted: true, childDeleted: true, movedPath: 'Full Trust E2E Child' })
      expect(baseline.database).toEqual({ updatedTitle: 'Full Trust E2E Entity Updated', deleted: true })
      await expect.poll(() => externalCalls.length).toBe(run)
      expect(externalCalls[run - 1]).toMatchObject({ url: externalUrl, token, execPath: process.execPath })
      expect(externalCalls[run - 1].pid).not.toBe(current.app.process().pid)
      await expect.poll(() => processIsAlive(externalCalls[run - 1].pid)).toBe(false)
      expect(await current.app.evaluate(({ clipboard }) => clipboard.readText())).toBe(desktop.clipboard)
      expect(await current.app.evaluate(() => {
        const objects = (globalThis as any).__knowbookCapabilityObjects
        objects.menu.getMenuItemById('capability-action').click()
        return { tray: !objects.tray.isDestroyed(), window: !objects.window.isDestroyed() }
      })).toEqual({ tray: true, window: true })
      expect(readJson(join(dataRoot, 'menu-click.json'))).toEqual({ clicked: true })
      await current.page.locator('button.nav-icon-btn').and(current.page.getByTitle(uiText('Dashboard', '总览'))).first().click()
      await expect(current.page.getByTestId('system-capability-react')).toHaveAttribute('data-revision', revision)
      const dom = current.page.getByTestId('system-capability-dom')
      await expect(dom).toHaveAttribute('data-command-result', 'command-ok')
      await expect(dom).toHaveCSS('color', 'rgb(17, 34, 51)')
      await current.page.keyboard.press('Control+Alt+k')
      await expect(dom).toHaveAttribute('data-command-source', 'keyboard')
      await expect(current.page.locator('html')).toHaveAttribute('data-theme', 'dark')
      const frame = current.page.frameLocator('[data-testid="system-capability-frame"]')
      // Registration first loads the remote page, then adds the exact popup token.
      // Wait for that final document, not an already-ready initial navigation.
      await expect.poll(() => frame.locator('body').evaluate(() => new URL(location.href).searchParams.get('popupName'))).toBeTruthy()
      await expect(frame.locator('#http')).toHaveText('http-ok')
      await expect(frame.locator('#socket')).toHaveText('capability-websocket')
      const popupPromise = current.app.waitForEvent('window')
      await frame.locator('#popup').click()
      const popup = await popupPromise
      await expect(popup.locator('#popup-ready')).toHaveText('capability-popup')
      expect(await popup.evaluate(() => typeof (globalThis as any).require)).toBe('function')
      const opaqueElement = current.page.locator('iframe[title="V2 capability comparison"]')
      await expect(opaqueElement).toHaveAttribute('sandbox', 'allow-scripts')
      await expect(opaqueElement).toHaveAttribute('src', /^knowbook-plugin-ui:\/\/frame\//)
      const opaqueFrame = current.page.frameLocator('iframe[title="V2 capability comparison"]')
      await expect(opaqueFrame.locator('#v2-node')).toHaveText('undefined')
      const windowCount = await current.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
      // Workspace notifications may remount this dashboard contribution after
      // the click. Capture Chromium's rejection itself rather than a DOM marker
      // belonging to the replaced frame document.
      await expect.poll(async () => opaqueFrame.locator('body').evaluate(async (_body, target) => {
        try { await fetch(target); return 'unexpected-network-success' }
        catch (error) { return (error as Error).name }
      }, `${origin}/v2-must-not-load`).catch(() => 'frame-replaced')).toBe('TypeError')
      snapshots.push({ v2NetworkDenial: 'Actual opaque frame fetch rejected with TypeError; controlled server received no request.' })
      await opaqueFrame.locator('#v2-popup-attack').click()
      await opaqueFrame.locator('#v2-navigation-attack').click()
      await new Promise(resolve => setTimeout(resolve, 500))
      expect(await current.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(windowCount)
      expect(requests).not.toContain('/v2-must-not-load')
      const resourceEvidence = await verifyManagedResources(current, revision, origin, desktop.desktop.windowId)
      snapshots.push(resourceEvidence)
      const summary = await getPluginSummary(current)
      const activePackageId = summary!.availablePackages.find(item => item.artifactSha256 === prepared!.artifactSha256)!.packageId
      const mainPid = await current.app.evaluate(() => process.pid)
      const rendererPid = await (await current.app.browserWindow(current.page)).evaluate(window => window.webContents.getOSProcessId())
      const componentRuns = ['main', 'renderer', 'service'].map(component => summary!.recentRuns.find(item => item.component === component && item.packageId === activePackageId)!)
      expect(componentRuns.map(item => ({ component: item.component, status: item.status, pid: item.pid }))).toEqual([
        { component: 'main', status: 'ready', pid: mainPid },
        { component: 'renderer', status: 'ready', pid: rendererPid },
        { component: 'service', status: 'ready', pid: readJson(join(dataRoot, 'service-rpc.json')).pid }
      ])
      expect(new Set(componentRuns.map(item => item.pid)).size).toBe(3)
      snapshots.push({ independentComponentRuns: componentRuns, observedPids: { main: mainPid, renderer: rendererPid, service: readJson(join(dataRoot, 'service-rpc.json')).pid } })
      const mainLogPath = summary!.recentRuns.find(item => item.component === 'main')?.logPath
      const serviceLogPath = summary!.recentRuns.find(item => item.component === 'service')?.logPath
      expect(mainLogPath).toBeTruthy()
      expect(mainLogPath).not.toBe(serviceLogPath)
      await expect.poll(() => readFileSync(mainLogPath!, 'utf8')).toContain(`CONTROLLED_CAPABILITY_MAIN_ASYNC ${revision}`)
      const mainLog = readFileSync(mainLogPath!, 'utf8')
      expect(mainLog).toContain('[stdout] CONTROLLED_CAPABILITY_MAIN_ACTIVATE')
      expect(mainLog).toContain('CONTROLLED_CAPABILITY_MAIN_FRAGMENT authorization=Bearer [REDACTED]')
      expect(mainLog).toContain('[stderr] CONTROLLED_CAPABILITY_MAIN_ERROR password=[REDACTED]')
      expect(mainLog).not.toContain('capability-fake')
      expect(mainLog).not.toContain('CONTROLLED_CAPABILITY_SERVICE_START')
      await expect.poll(() => readFileSync(serviceLogPath!, 'utf8')).toContain('CONTROLLED_CAPABILITY_SERVICE_START')
      expect(readFileSync(serviceLogPath!, 'utf8')).not.toContain('CONTROLLED_CAPABILITY_MAIN_')
      const dependencyLogs = summary!.dependencyJobs.map(job => job.logPath).filter((path): path is string => Boolean(path))
      expect(dependencyLogs.length).toBeGreaterThan(0)
      for (const dependencyLog of dependencyLogs) {
        expect(dependencyLog).not.toBe(mainLogPath)
        expect(readFileSync(dependencyLog, 'utf8')).not.toContain('CONTROLLED_CAPABILITY_MAIN_')
      }
      await current.page.locator('button.nav-icon-btn').and(current.page.getByTitle(uiText('Plugins', '插件中心'))).first().click()
      const activeCard = current.page.locator('.system-plugin-installation').filter({ hasText: pluginId })
      if (await activeCard.locator('.system-plugin-details').getAttribute('open') === null) {
        await activeCard.locator('.system-plugin-details > summary').click()
      }
      const resourcePanel = activeCard.getByTestId('system-plugin-managed-resources')
      await expect(resourcePanel.locator('[data-resource-kind]')).toHaveCount(5)
      await expect(resourcePanel.locator('[data-resource-source="desktop-sdk"]')).toHaveCount(3)
      await expect(resourcePanel.locator('[data-resource-source="renderer-frame"]')).toHaveCount(2)
      await expect(activeCard.getByTestId('system-plugin-main-log')).toContainText(mainLogPath!)
      await expect(activeCard.getByTestId('system-plugin-main-log')).toContainText(revision)
      for (const component of ['main', 'renderer']) {
        const componentPanel = activeCard.locator(`[data-testid="system-plugin-runtime-component"][data-component="${component}"]`)
        await expect(componentPanel).toHaveCount(1)
        await expect(componentPanel).toHaveAttribute('data-run-status', 'ready')
        await expect(componentPanel).toContainText(revision)
        await expect(componentPanel).toContainText(`PID ${component === 'main' ? mainPid : rendererPid}`)
        await componentPanel.screenshot({ path: testInfo.outputPath(`component-${component}-active-${run}.png`) })
      }
      await current.page.locator('.system-plugin-request').filter({ hasText: pluginId }).first()
        .screenshot({ path: testInfo.outputPath(`component-states-active-${run}.png`) })
      await popup.close()
      await expect.poll(async () => (await getPluginSummary(current!))!.managedResources
        .filter(item => item.kind === 'window' && item.source === 'renderer-frame').length).toBe(0)
      await expect(resourcePanel.locator('[data-resource-kind]')).toHaveCount(4)
      await current.page.locator('button.nav-icon-btn').and(current.page.getByTitle(uiText('Dashboard', '总览'))).first().click()
      snapshots.push({ mainLogPath, serviceLogPath, dependencyLogs, mainLogRedacted: true })
      completedStages.push(stage)
    }

    stage = 'live-data-and-settings-refresh'
    await current.app.evaluate(({ dialog }, directory) => {
      Object.defineProperty(dialog, 'showOpenDialog', { configurable: true, value: async () => ({ canceled: false, filePaths: [directory] }) })
    }, selected)
    await current.page.evaluate(() => {
      const state = { notifications: 0 }
      ;(globalThis as any).__capabilityWorkspace = state
      ;(globalThis as any).__capabilityUnsubscribe = window.knowbook.onWorkspaceMutated(() => { state.notifications += 1 })
    })
    const mutations = await current.app.evaluate(async () => (globalThis as any).__knowbookCapabilityMutate())
    expect(mutations).toMatchObject({ movedPath: 'Capability Child', movedDescendantPath: 'Capability Child/Capability Grandchild', deleted: true, bulkDeleted: true })
    expect(mutations.selectedRoundTrip).toBe('selected-directory-round-trip')
    expect(mutations.events.filter((event: any) => event.type === 'document.deleted')).toHaveLength(3)
    expect(mutations.linksBefore.some((link: any) => link.id === mutations.linkedDocumentId)).toBe(true)
    expect(mutations.linksAfterMove.find((link: any) => link.id === mutations.linkedDocumentId).label).toBe('Capability Child/Capability Grandchild')
    expect(mutations.linksAfterDelete.some((link: any) => link.id === mutations.linkedDocumentId)).toBe(false)
    expect(mutations.events.every((event: any) => event.originPluginId === pluginId && event.correlationId && event.causationId)).toBe(true)
    expect(mutations.events.find((event: any) => event.type === 'document.moved').affectedDocumentIds).toContain(mutations.events.find((event: any) => event.documentTitle === 'Capability Grandchild').documentId)
    expect(mutations.bulkUpdated.every((entity: any) => entity.fieldValues[mutations.column.id] === 'Done')).toBe(true)
    expect(mutations.view.name).toBe('Capability View Updated')
    await expect.poll(() => current!.page.evaluate(() => (globalThis as any).__capabilityWorkspace.notifications)).toBeGreaterThan(0)
    await expect(current.page.locator('html')).toHaveAttribute('data-theme', 'light')
    // Read through the real Renderer preload after notifications, and compare with raw SQL.
    const uiData = await current.page.evaluate(async ({ documentId, databaseId }) => ({
      document: await window.knowbook.getDocumentDetail(documentId),
      entities: await window.knowbook.getDatabaseEntities(databaseId),
      views: await window.knowbook.getDatabaseSavedViews(databaseId),
      home: await window.knowbook.getHomeData()
    }), { documentId: mutations.visible.id, databaseId: mutations.database.id })
    expect(uiData.document?.title).toBe(mutations.visible.title)
    expect(uiData.entities.map((entity) => ({ id: entity.id, title: entity.title }))).toEqual(mutations.raw)
    expect(uiData.views.some((view) => view.name === 'Capability View Updated')).toBe(true)
    expect(uiData.home.appearanceTheme).toBe('light')
    expect(uiData.home.aiConfig.model).toBe('full-trust-e2e-model')
    await expect(current.page.getByTestId('capability-live-data')).toContainText(mutations.visible.title)
    await expect(current.page.getByTestId('capability-live-data')).toContainText('Capability Visible Entity')
    await expect(current.page.getByTestId('capability-live-data')).toContainText('full-trust-e2e-model')
    const deletedData = await current.app.evaluate(async () => (globalThis as any).__knowbookCapabilityCleanupData())
    expect(deletedData).toEqual({ viewsDeleted: true, columnsDeleted: true, entitiesDeleted: true, databaseDeleted: true, rawCount: 0 })
    await expect(current.page.getByTestId('capability-live-data')).not.toContainText('Capability Visible Entity')
    await expect(current.page.getByTestId('capability-live-data')).not.toContainText(mutations.visible.title)
    await current.page.evaluate(() => (globalThis as any).__capabilityUnsubscribe())
    const hostDocument = await current.page.evaluate(() => window.knowbook.createDocument(null))
    try {
      const subscriberLog = (await getPluginSummary(current))!.recentRuns.find(item => item.component === 'main')!.logPath!
      await expect.poll(() => readFileSync(subscriberLog, 'utf8')).toContain(`CONTROLLED_CAPABILITY_MAIN_EVENT ${hostDocument.id}`)
      await expect.poll(() => readFileSync(subscriberLog, 'utf8')).toContain(`CONTROLLED_CAPABILITY_MAIN_EVENT_ASYNC ${hostDocument.id}`)
      snapshots.push({ hostTriggeredSubscriberLog: { documentId: hostDocument.id, logPath: subscriberLog, synchronousAndAsync: true } })
    } finally { await current.page.evaluate(id => window.knowbook.deleteDocument(id), hostDocument.id) }
    snapshots.push({ mutations, uiData, deletedData })
    completedStages.push(stage)

    stage = 'service-heartbeat-crash-limit-and-stop'
    const serviceData = join(profile, 'system-plugins', 'data', pluginId)
    const heartbeat = join(serviceData, 'service-heartbeat.json')
    await expect.poll(() => readJson(heartbeat).elapsedMs, { timeout: 20000 }).toBeGreaterThanOrEqual(10000)
    const beforeCrash = readJson(heartbeat)
    const historyBeforeCrash = readJson(join(serviceData, 'service-history.json'))
    writeFileSync(join(serviceData, 'crash-service.json'), 'controlled crash trigger')
    await expect.poll(async () => {
      const plugin = await current!.page.evaluate(async (id) => (await window.knowbook.listSystemPlugins()).find(item => item.pluginId === id), pluginId)
      return plugin?.status
    }, { timeout: 60000 }).toBe('safe-mode-disabled')
    const afterCrash = await current.page.evaluate(async (id) => (await window.knowbook.listSystemPlugins()).find(item => item.pluginId === id), pluginId)
    // One durable service run records all supervisor restarts; process history and
    // compiler-style log markers independently prove six actual process exits.
    const crashRun = afterCrash!.recentRuns.find(run => run.component === 'service' && run.restartCount === 5)
    expect(crashRun).toBeTruthy()
    expect(afterCrash!.safeModeDisabled).toBe(true)
    expect(JSON.stringify(afterCrash!.lastError)).toContain('restart limit 5 reached')
    const stoppedHistory = readJson(join(serviceData, 'service-history.json'))
    expect(stoppedHistory.length).toBe(historyBeforeCrash.length + 5)
    expect(new Set(stoppedHistory.slice(-6).map((entry: any) => entry.pid)).size).toBe(6)
    expect(readFileSync(crashRun!.logPath!, 'utf8').match(/CONTROLLED_CAPABILITY_SERVICE_CRASH/g)).toHaveLength(6)
    await new Promise(resolve => setTimeout(resolve, 1000))
    expect(readJson(join(serviceData, 'service-history.json'))).toEqual(stoppedHistory)
    rmSync(join(serviceData, 'crash-service.json'))
    await current.app.evaluate(({ dialog }) => {
      Object.defineProperty(dialog, 'showMessageBox', { configurable: true, value: async () => ({ response: 0 }) })
    })
    await current.page.evaluate(async id => window.knowbook.recoverSystemPlugin({ pluginId: id }), pluginId)
    await closeElectronApp(current, { preserveUserData: true })
    current = null
    current = await launchElectronApp(env, { userDataRoot: profile })
    await expect.poll(async () => {
      const plugin = await current!.page.evaluate(async id => (await window.knowbook.listSystemPlugins()).find(item => item.pluginId === id), pluginId)
      return plugin?.status
    }).toBe('active')
    await current.page.evaluate(async id => window.knowbook.stopSystemPluginService({ pluginId: id }), pluginId)
    await current.page.evaluate(async (id) => window.knowbook.startSystemPluginService({ pluginId: id }), pluginId)
    await expect.poll(() => readJson(heartbeat).pid).not.toBe(beforeCrash.pid)
    await expect.poll(async () => {
      const plugin = await current!.page.evaluate(async (id) => (await window.knowbook.listSystemPlugins()).find(item => item.pluginId === id), pluginId)
      return plugin?.recentRuns.some(run => run.component === 'service' && run.status === 'ready')
    }).toBe(true)
    await current.page.evaluate(async (id) => window.knowbook.stopSystemPluginService({ pluginId: id }), pluginId)
    await expect.poll(async () => {
      const plugin = await current!.page.evaluate(async (id) => (await window.knowbook.listSystemPlugins()).find(item => item.pluginId === id), pluginId)
      return plugin?.recentRuns.some(run => run.component === 'service' && (run.status === 'ready' || run.status === 'starting'))
    }).toBe(false)
    snapshots.push({ beforeCrash, crashRun, stoppedHistory })
    completedStages.push(stage)

    stage = 'same-plugin-detached-upgrade-and-adoption'
    manifest.version = '2.0.0'
    manifest.background.mode = 'detached'
    writeFileSync(join(source, 'plugin.json'), JSON.stringify(manifest))
    await current.app.evaluate(({ dialog }, directory) => {
      Object.defineProperty(dialog, 'showOpenDialog', { configurable: true, value: async () => ({ canceled: false, filePaths: [directory] }) })
      Object.defineProperty(dialog, 'showMessageBox', { configurable: true, value: async () => ({ response: 0 }) })
    }, source)
    const detachedRequest = await current.page.evaluate(() => window.knowbook.chooseAndPrepareSystemPluginInstall())
    expect(detachedRequest?.status).toBe('awaiting-confirmation')
    await current.page.evaluate(request => window.knowbook.resolveSystemPluginInstallRequest({
      requestId: request.id, pluginId: request.pluginId, artifactSha256: request.artifactSha256,
      acknowledgeSystemAccess: true, decision: 'confirm'
    }), { id: detachedRequest!.id, pluginId, artifactSha256: detachedRequest!.artifactSha256 })
    revisions.push(detachedRequest!.artifactSha256)
    await closeElectronApp(current, { preserveUserData: true })
    current = null
    current = await launchElectronApp(env, { userDataRoot: profile })
    // A spawned service can report ready before the host has persisted its
    // Windows identity and committed the Main/Renderer activation transaction.
    await expect.poll(async () => {
      const plugin = await current!.page.evaluate(async id => (await window.knowbook.listSystemPlugins()).find(item => item.pluginId === id), pluginId)
      return { status: plugin?.status, version: plugin?.currentVersion, sha256: plugin?.currentArtifactSha256 }
    }, { timeout: 30000 }).toEqual({ status: 'active', version: '2.0.0', sha256: detachedRequest!.artifactSha256 })
    await expect.poll(async () => {
      const plugin = await current!.page.evaluate(async id => (await window.knowbook.listSystemPlugins()).find(item => item.pluginId === id), pluginId)
      return plugin?.recentRuns.some(run => run.component === 'detached' && run.status === 'ready')
    }).toBe(true)
    await expect.poll(() => readJson(join(serviceData, 'service-rpc.json')).ping.revisionHash).toBe(`sha256:${detachedRequest!.artifactSha256}`)
    await expect.poll(() => readJson(heartbeat).pid).toBe(readJson(join(serviceData, 'service-rpc.json')).pid)
    const detachedBefore = readJson(heartbeat)
    ownedDetachedPid = detachedBefore.pid
    snapshots.push({ detachedBefore })
    await closeElectronApp(current, { preserveUserData: true, preserveDetachedChildren: true })
    current = null
    await expect.poll(() => readJson(heartbeat).ticks).toBeGreaterThan(detachedBefore.ticks + 3)
    expect(readJson(heartbeat).pid).toBe(detachedBefore.pid)
    current = await launchElectronApp(env, { userDataRoot: profile })
    await expect.poll(async () => {
      const plugin = await current!.page.evaluate(async id => (await window.knowbook.listSystemPlugins()).find(item => item.pluginId === id), pluginId)
      return plugin?.status
    }, { timeout: 30000 }).toBe('active')
    await expect.poll(async () => {
      const plugin = await current!.page.evaluate(async id => (await window.knowbook.listSystemPlugins()).find(item => item.pluginId === id), pluginId)
      return plugin?.recentRuns.find(run => run.component === 'detached' && run.status === 'ready')?.pid
    }).toBe(detachedBefore.pid)
    await expect.poll(() => readJson(join(serviceData, 'service-reconnect.json')).ticks).toBeGreaterThan(detachedBefore.ticks + 4)
    const detachedAfter = readJson(join(serviceData, 'service-reconnect.json'))
    expect(detachedAfter).toMatchObject({ pid: detachedBefore.pid, ping: { pluginId, revisionHash: `sha256:${detachedRequest!.artifactSha256}` } })
    await current.page.evaluate(async id => window.knowbook.stopSystemPluginService({ pluginId: id }), pluginId)
    await expect.poll(() => {
      return processIsAlive(detachedBefore.pid)
    }).toBe(false)
    snapshots.push({ detachedBefore, detachedAfter })
    completedStages.push(stage)

    stage = 'disable-and-dispose'
    const disposalFrame = current.page.frameLocator('[data-testid="system-capability-frame"]')
    await expect.poll(() => disposalFrame.locator('body').evaluate(() => new URL(location.href).searchParams.get('popupName'))).toBeTruthy()
    await expect(disposalFrame.locator('#http')).toHaveText('http-ok')
    await expect(disposalFrame.locator('#socket')).toHaveText('capability-websocket')
    const disposalPopupSource = await disposalFrame.locator('body').evaluate(() => ({ url: location.href, popupName: new URL(location.href).searchParams.get('popupName') }))
    const disposalFramePolicy = (await getPluginSummary(current))!.managedResources.find(item => item.kind === 'frame')!
    snapshots.push({ disposalPopupSource, disposalFramePolicy })
    expect(disposalPopupSource.popupName).toBe(disposalFramePolicy.frameName!.replace('knowbook-full-trust-frame:', 'knowbook-full-trust-popup:'))
    const [disposalPopup] = await Promise.all([
      current.app.waitForEvent('window', { timeout: 10000 }),
      disposalFrame.locator('body').evaluate(() => { window.open('/popup', new URL(location.href).searchParams.get('popupName')!) })
    ])
    await expect(disposalPopup.locator('#popup-ready')).toHaveText('capability-popup')
    // Playwright otherwise auto-accepts beforeunload dialogs, overriding the
    // native veto under test. Electron may cancel before CDP handles it.
    disposalPopup.on('dialog', dialog => {
      void dialog.dismiss().catch(error => {
        snapshots.push({ beforeUnloadDialogDismiss: String(error) })
      })
    })
    await disposalPopup.evaluate(() => {
      ;(window as any).__capabilityBeforeUnloadCount = 0
      window.onbeforeunload = () => { (window as any).__capabilityBeforeUnloadCount += 1; return false }
    })
    const ownedPopup = (await getPluginSummary(current))!.managedResources.find(item => item.kind === 'window' && item.source === 'renderer-frame')!
    expect(ownedPopup).toBeTruthy()
    await current.app.evaluate(({ BrowserWindow }, id) => { BrowserWindow.fromId(id)!.close() }, ownedPopup.windowId!)
    await expect.poll(() => disposalPopup.evaluate(() => (window as any).__capabilityBeforeUnloadCount)).toBe(1)
    expect(disposalPopup.isClosed()).toBe(false)
    expect((await getPluginSummary(current))!.managedResources.some(item => item.id === ownedPopup.id)).toBe(true)
    const finalMainLogPath = (await getPluginSummary(current))!.recentRuns.find(item => item.component === 'main')!.logPath!
    const clipboardBeforeDisable = await current.app.evaluate(({ clipboard }) => {
      const text = clipboard.readText()
      return { textSha256: process.getBuiltinModule('node:crypto').createHash('sha256').update(text).digest('hex') }
    })
    const ownedClipboardSha256 = createHash('sha256').update(`KnowBook capability clipboard ${token}`).digest('hex')
    const restoredClipboardSha256 = clipboardBeforeDisable.textSha256 === ownedClipboardSha256
      ? readJson(join(serviceData, 'desktop-evidence.json')).clipboardOriginalSha256
      : clipboardBeforeDisable.textSha256
    await current.app.evaluate(() => {
      const objects = (globalThis as any).__knowbookCapabilityObjects
      objects.popupClosed = false
      objects.menu.popup({ window: objects.window, callback: () => { objects.popupClosed = true } })
    })
    await current.page.evaluate(async (id) => window.knowbook.setSystemPluginEnabled({ pluginId: id, enabled: false }), pluginId)
    await expect(current.page.getByTestId('system-capability-dom')).toHaveCount(0)
    await expect(current.page.getByTestId('system-capability-react')).toHaveCount(0)
    await expect(current.page.locator('style[data-full-trust-style="capability-style"]')).toHaveCount(0)
    expect(await current.app.evaluate(({ clipboard }) => {
      const objects = (globalThis as any).__knowbookCapabilityObjects
      return { windowDestroyed: objects.window.isDestroyed(), trayDestroyed: objects.tray.isDestroyed(),
        clipboardSha256: process.getBuiltinModule('node:crypto').createHash('sha256').update(clipboard.readText()).digest('hex') }
    })).toEqual({ windowDestroyed: true, trayDestroyed: true, clipboardSha256: restoredClipboardSha256 })
    expect(await current.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
    await expect.poll(() => current!.app.evaluate(() => (globalThis as any).__knowbookCapabilityObjects.popupClosed)).toBe(true)
    expect(disposalPopup.isClosed()).toBe(true)
    expect((await getPluginSummary(current))!.managedResources).toEqual([])
    const disposedSummary = (await getPluginSummary(current))!
    const disposedPackageId = disposedSummary.availablePackages.find(item => item.artifactSha256 === detachedRequest!.artifactSha256)!.packageId
    const disposedComponents = ['main', 'renderer', 'detached'].map(component => disposedSummary.recentRuns.find(item => item.component === component && item.packageId === disposedPackageId)!)
    expect(disposedComponents.map(item => ({ component: item.component, status: item.status }))).toEqual([
      { component: 'main', status: 'stopped' }, { component: 'renderer', status: 'stopped' }, { component: 'detached', status: 'stopped' }
    ])
    await expect.poll(() => readFileSync(finalMainLogPath, 'utf8')).toContain(`CONTROLLED_CAPABILITY_MAIN_DEACTIVATE sha256:${detachedRequest!.artifactSha256}`)
    const finalMainLog = readFileSync(finalMainLogPath, 'utf8')
    expect(finalMainLog).toContain('CONTROLLED_CAPABILITY_MAIN_DISPOSE api_key=[REDACTED]')
    expect(finalMainLog).not.toContain('capability-fake')
    await cp(join(profile, 'system-plugins', 'logs', pluginId), testInfo.outputPath('verified-plugin-logs'), { recursive: true })
    for (const helper of externalCalls) await expect.poll(() => processIsAlive(helper.pid)).toBe(false)
    await current.page.locator('button.nav-icon-btn').and(current.page.getByTitle(uiText('Plugins', '插件中心'))).first().click()
    const disabledCard = current.page.locator('.system-plugin-installation').filter({ hasText: pluginId })
    if (await disabledCard.locator('.system-plugin-details').getAttribute('open') === null) {
      await disabledCard.locator('.system-plugin-details > summary').click()
    }
    await expect(disabledCard.getByTestId('system-plugin-managed-resources').locator('[data-resource-kind]')).toHaveCount(0)
    for (const component of ['main', 'renderer']) {
      const componentPanel = disabledCard.locator(`[data-testid="system-plugin-runtime-component"][data-component="${component}"]`)
      await expect(componentPanel).toHaveAttribute('data-run-status', 'stopped')
      await componentPanel.screenshot({ path: testInfo.outputPath(`component-${component}-disabled.png`) })
    }
    await current.page.locator('.system-plugin-request').filter({ hasText: pluginId }).first()
      .screenshot({ path: testInfo.outputPath('component-states-disabled.png') })
    snapshots.push({ disposedComponents })
    snapshots.push({ managedResourcesDisposed: true, popupBeforeUnloadVetoOverridden: true, mainDeactivationLogged: true, allExternalHelpersExited: true })
    completedStages.push(stage)

    stage = 'uninstall'
    await current.app.evaluate(({ dialog }) => {
      Object.defineProperty(dialog, 'showMessageBox', { configurable: true, value: async () => ({ response: 0 }) })
    })
    await current.page.evaluate(async (id) => window.knowbook.uninstallSystemPlugin({ pluginId: id, preserveData: false }), pluginId)
    await closeElectronApp(current, { preserveUserData: true })
    current = null
    current = await launchElectronApp(env, { userDataRoot: profile })
    expect(await current.page.evaluate(async (id) => (await window.knowbook.listSystemPlugins()).some((item) => item.pluginId === id), pluginId)).toBe(false)
    for (const name of ['artifacts', 'runtime']) for (const revision of revisions) {
      expect(existsSync(join(profile, 'system-plugins', name, pluginId, revision))).toBe(false)
    }
    for (const name of ['data', 'logs']) expect(existsSync(join(profile, 'system-plugins', name, pluginId))).toBe(false)
    completedStages.push(stage)
  } catch (error) {
    failure = error instanceof Error ? error.stack ?? error.message : String(error)
    throw error
  } finally {
    if (current) {
      try { snapshots.push({ finalPluginState: await current.page.evaluate(async id => (await window.knowbook.listSystemPlugins()).find(item => item.pluginId === id), pluginId) }) }
      catch (error) { snapshots.push({ finalPluginStateError: String(error) }) }
    }
    if (profile) for (const name of ['service-error.json', 'service-exit.json', 'service-heartbeat-error.json']) {
      const marker = join(profile, 'system-plugins', 'data', pluginId, name)
      if (existsSync(marker)) snapshots.push({ diagnostic: name, value: readJson(marker) })
    }
    if (ownedDetachedPid) snapshots.push({ detachedAliveBeforeCleanup: processIsAlive(ownedDetachedPid), pid: ownedDetachedPid })
    if (existsSync(join(root, 'external-handler-url.txt'))) {
      mkdirSync(testInfo.outputPath(), { recursive: true })
      copyFileSync(join(root, 'external-handler-url.txt'), testInfo.outputPath('external-handler-url.txt'))
    }
    if (profile) {
      const logRoot = join(profile, 'system-plugins', 'logs', pluginId)
      if (existsSync(logRoot)) await cp(logRoot, testInfo.outputPath('plugin-logs'), { recursive: true })
    }
    if (current) {
      try {
        await current.page.evaluate(async id => {
          const plugin = (await window.knowbook.listSystemPlugins()).find(item => item.pluginId === id)
          if (!plugin) return
          if (plugin.enabled && plugin.status === 'active') await window.knowbook.stopSystemPluginService({ pluginId: id })
          if (plugin.enabled) await window.knowbook.setSystemPluginEnabled({ pluginId: id, enabled: false })
        }, pluginId)
      } catch (error) { cleanupErrors.push(`Plugin cleanup: ${String(error)}`) }
      try { await closeElectronApp(current) } catch (error) { cleanupErrors.push(String(error)) }
    }
    if (ownedDetachedPid && processIsAlive(ownedDetachedPid)) {
      try {
        execFileSync('taskkill.exe', ['/pid', String(ownedDetachedPid), '/T', '/F'], { windowsHide: true, stdio: 'pipe' })
        await expect.poll(() => processIsAlive(ownedDetachedPid!)).toBe(false)
      } catch (error) { cleanupErrors.push(`Owned detached process cleanup: ${String(error)}`) }
    }
    if (registered) {
      try {
        reg(['delete', registryKey, '/f'])
        expect(spawnSync('reg.exe', ['query', registryKey], { windowsHide: true }).status).toBe(1)
      } catch (error) { cleanupErrors.push(String(error)) }
    }
    for (const socket of sockets) socket.destroy()
    server.closeAllConnections()
    tlsServer?.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    if (tlsServer) await new Promise<void>((resolve) => tlsServer!.close(() => resolve()))
    if (!cleanupErrors.length) {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      if (profile && existsSync(profile)) rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
    const output = testInfo.outputPath('capabilities-evidence.json')
    mkdirSync(dirname(output), { recursive: true })
    writeFileSync(output, JSON.stringify({
      pluginId, completedStages, failedStage: failure ? stage : null, failure, cleanupErrors,
      binarySha256, externalCalls, requests, snapshots,
      matrix: capabilityMatrix(!failure && cleanupErrors.length === 0 && completedStages.includes('uninstall'))
    }, null, 2))
    await testInfo.attach('capabilities-evidence', { path: output, contentType: 'application/json' })
    expect(cleanupErrors, 'The controlled URI handler and temporary profile must be removed.').toEqual([])
  }
})

function reg(args: string[]): void {
  execFileSync('reg.exe', args, { windowsHide: true, stdio: 'pipe' })
}
async function getPluginSummary(context: ElectronAppContext) {
  return context.page.evaluate(async id => (await window.knowbook.listSystemPlugins()).find(item => item.pluginId === id), pluginId)
}

async function verifyManagedResources(context: ElectronAppContext, revisionHash: string, origin: string, windowId: number) {
  await expect.poll(async () => (await getPluginSummary(context))!.managedResources.length).toBe(5)
  const initial = (await getPluginSummary(context))!.managedResources
  expect(initial.every(item => item.revisionHash === revisionHash)).toBe(true)
  expect(new Set(initial.map(item => item.id)).size).toBe(initial.length)
  expect(initial).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'window', source: 'desktop-sdk', windowId }),
    expect.objectContaining({ kind: 'menu', source: 'desktop-sdk', label: 'KnowBook controlled capability action' }),
    expect.objectContaining({ kind: 'tray', source: 'desktop-sdk' }),
    expect.objectContaining({ kind: 'frame', source: 'renderer-frame', allowedOrigins: ['about:', origin],
      framePolicy: { allowPopups: true, allowNavigation: true, allowDownloads: true, allowPermissions: true } }),
    expect.objectContaining({ kind: 'window', source: 'renderer-frame' })
  ]))
  const transient = await context.app.evaluate(() => (globalThis as any).__knowbookCapabilityCreateTransientResources())
  await expect.poll(async () => (await getPluginSummary(context))!.managedResources.length).toBe(7)
  const during = (await getPluginSummary(context))!.managedResources
  expect(during.some(item => item.windowId === transient.windowId)).toBe(true)
  expect(during.some(item => item.windowId === transient.rawWindowId)).toBe(false)
  await context.app.evaluate(() => {
    const objects = (globalThis as any).__knowbookCapabilityTransient
    objects.window.close()
    objects.tray.destroy()
    objects.rawWindow.destroy()
  })
  await expect.poll(async () => (await getPluginSummary(context))!.managedResources.length).toBe(5)
  const after = (await getPluginSummary(context))!.managedResources
  expect(after.some(item => item.windowId === transient.windowId)).toBe(false)
  expect(after.filter(item => item.kind === 'tray')).toHaveLength(1)
  return { managedResources: initial, transientResources: during, proactivelyReleased: after }
}
function vbsString(value: string): string { return `"${value.replaceAll('"', '""')}"` }
function readJson(path: string): any { return JSON.parse(readFileSync(path, 'utf8')) }
function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}
function frameHtml(): string {
  return `<!doctype html><meta charset="utf-8"><p id="http">pending</p><p id="socket">pending</p><button id="popup">popup</button><script>
fetch('/api').then(r=>r.json()).then(r=>document.querySelector('#http').textContent=r.ok?'http-ok':'failed');
const ws=new WebSocket('ws://'+location.host+'/socket');ws.onmessage=e=>{document.querySelector('#socket').textContent=e.data;ws.close()};
document.querySelector('#popup').onclick=()=>open('/popup',new URL(location.href).searchParams.get('popupName'));
</script>`
}
function capabilityMatrix(completed: boolean) {
  // Exact rows from plan section 9. Partial rows remain explicit even when this spec passes.
  return [
    { id: 1, covered: 'selected directory read/write; raw SQLite transaction; Store reads', missing: [] },
    { id: 2, covered: 'Node/Electron versions; real child process; BrowserWindow', missing: [] },
    { id: 3, covered: 'HTTP; WebSocket; AI stream cancellation/error; remote frame; trusted TLS and untrusted certificate rejection', missing: [] },
    { id: 4, covered: 'offline npm ci dependency require; actual packaged SQLite .node load', missing: [] },
    { id: 5, covered: 'arbitrary messages; stream; cancellation; raw response; HTTP/JSON errors', missing: [] },
    { id: 6, covered: 'create/move subtree; descendant paths and links; leaf-first subtree deletion; attributed events; live Renderer refresh', missing: [] },
    { id: 7, covered: 'database/column/view/entity CRUD; bulk mutation; raw SQLite and Renderer preload consistency', missing: [] },
    { id: 8, covered: 'real clipboard; controlled external URI process and HTTP receipt; window/preload; Menu; Tray; disposal', missing: [] },
    { id: 9, covered: 'ordinary setting persists across restart; live theme and AI config visible in Renderer', missing: [] },
    { id: 10, covered: 'React slot; real preload read; dedicated preload IPC; DOM/CSS; command/shortcut; cleanup', missing: [] },
    { id: 11, covered: 'remote unsandboxed frame HTTP/WebSocket and privileged popup; same-host v2 frame navigation/popup blocked before network', missing: [] },
    { id: 12, covered: 'app-lifetime RPC/restart; continuous heartbeat; six controlled crashes reach restart limit; explicit stop/restart; same-plugin detached revision survives host quit, is adopted with same PID and reconnects RPC; explicit stop and uninstall cleanup', missing: [] }
  ].map((row) => ({ ...row, status: !completed ? 'not-proven' : row.missing.length ? 'partial' : 'passed' }))
}
