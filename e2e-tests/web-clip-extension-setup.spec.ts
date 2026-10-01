import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { IpcMainInvokeEvent, OpenDialogOptions, OpenDialogReturnValue } from 'electron'
import type { ElectronApplication } from 'playwright'
import { mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { WebClipBridgeStatus, WebClipExtensionExportResult } from '../src/shared/contracts'
import { hasBuiltElectronApp, uiText, withElectronApp } from './helpers/electron'

type ExportHandler = (event: IpcMainInvokeEvent) => Promise<WebClipExtensionExportResult | null>
type OpenHandler = (event: IpcMainInvokeEvent) => Promise<void>
type ReadHandler = (event: IpcMainInvokeEvent) => WebClipBridgeStatus | Promise<WebClipBridgeStatus>
type Probe = {
  exports: number
  opens: number
  reads: number
  originalRead: ReadHandler
  exportEvent: IpcMainInvokeEvent | null
  lastResult: WebClipExtensionExportResult | null
  lastSuccess: WebClipExtensionExportResult | null
  pickers: Array<{ resolve: (value: OpenDialogReturnValue) => void }>
  pickerProperties: string[][]
  openPaths: string[]
  pendingOpens: Array<{ resolve: (value: string) => void }>
  clipboardCalls: number
}
type ProbeGlobal = typeof globalThis & { __knowbookExtensionSetupProbe?: Probe }

async function installProbe(app: ElectronApplication) {
  await app.evaluate(({ ipcMain, dialog, shell }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, ExportHandler | OpenHandler | ReadHandler> })._invokeHandlers
    const originalExport = handlers.get('knowbook:export-web-clip-extension') as ExportHandler
    const originalOpen = handlers.get('knowbook:open-web-clip-extension-directory') as OpenHandler
    const originalRead = handlers.get('knowbook:get-web-clip-bridge-status') as ReadHandler
    if (!originalExport || !originalOpen || !originalRead) throw new Error('Missing real extension or bridge handlers')
    const probe: Probe = { exports: 0, opens: 0, reads: 0, originalRead, exportEvent: null,
      lastResult: null, lastSuccess: null, pickers: [], pickerProperties: [], openPaths: [], pendingOpens: [], clipboardCalls: 0 }
    ;(globalThis as ProbeGlobal).__knowbookExtensionSetupProbe = probe

    // Intercept every native picker/open call before invoking the real service.
    // Neither original OS UI function is retained or called by this fixture.
    dialog.showOpenDialog = ((...args: unknown[]) => {
      const options = args.at(-1) as OpenDialogOptions
      probe.pickerProperties.push([...(options.properties ?? [])])
      return new Promise<OpenDialogReturnValue>(resolve => probe.pickers.push({ resolve }))
    }) as typeof dialog.showOpenDialog
    shell.openPath = path => {
      probe.openPaths.push(path)
      return new Promise<string>(resolve => probe.pendingOpens.push({ resolve }))
    }
    // This scenario reads/selects the path as plain text; any unexpected native
    // clipboard request is captured without touching the user's clipboard.
    ipcMain.removeHandler('knowbook:write-clipboard-text')
    ipcMain.handle('knowbook:write-clipboard-text', () => { probe.clipboardCalls++ })

    ipcMain.removeHandler('knowbook:export-web-clip-extension')
    ipcMain.handle('knowbook:export-web-clip-extension', async event => {
      probe.exports++
      probe.exportEvent = event
      const result = await originalExport(event)
      probe.lastResult = result
      if (result) probe.lastSuccess = result
      return result
    })
    ipcMain.removeHandler('knowbook:open-web-clip-extension-directory')
    ipcMain.handle('knowbook:open-web-clip-extension-directory', event => { probe.opens++; return originalOpen(event) })
    ipcMain.removeHandler('knowbook:get-web-clip-bridge-status')
    ipcMain.handle('knowbook:get-web-clip-bridge-status', event => { probe.reads++; return originalRead(event) })
  })
}

async function counts(app: ElectronApplication) {
  return app.evaluate(() => {
    const probe = (globalThis as ProbeGlobal).__knowbookExtensionSetupProbe!
    return { exports: probe.exports, opens: probe.opens, reads: probe.reads, pickers: probe.pickers.length,
      pickerProperties: probe.pickerProperties, openPaths: probe.openPaths, pendingOpens: probe.pendingOpens.length,
      lastResult: probe.lastResult, lastSuccess: probe.lastSuccess, clipboardCalls: probe.clipboardCalls }
  })
}

async function finishPicker(app: ElectronApplication, directory: string | null) {
  await app.evaluate((_electron, directory) => {
    const pending = (globalThis as ProbeGlobal).__knowbookExtensionSetupProbe!.pickers.shift()
    if (!pending) throw new Error('No pending extension folder picker')
    setImmediate(() => pending.resolve({ canceled: directory === null, filePaths: directory === null ? [] : [directory] }))
  }, directory)
}

async function finishOpen(app: ElectronApplication, reason = '') {
  await app.evaluate((_electron, reason) => {
    const pending = (globalThis as ProbeGlobal).__knowbookExtensionSetupProbe!.pendingOpens.shift()
    if (!pending) throw new Error('No pending extension folder opening')
    setImmediate(() => pending.resolve(reason))
  }, reason)
}

async function inspectExport(app: ElectronApplication) {
  return app.evaluate(async ({ app }) => {
    const probe = (globalThis as ProbeGlobal).__knowbookExtensionSetupProbe!
    if (!probe.lastSuccess || !probe.exportEvent) throw new Error('No successful extension export')
    const { readFileSync, readdirSync } = process.getBuiltinModule('node:fs')
    const { join } = process.getBuiltinModule('node:path')
    const sourceDirectory = join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'web-clip-extension')
    const directory = probe.lastSuccess.directory
    const names = ['README.md', 'manifest.json', 'page-collector.js', 'popup.html', 'popup.js']
    const status = await probe.originalRead(probe.exportEvent)
    const files = names.map(name => {
      const exported = readFileSync(join(directory, name))
      return { name, bytes: exported.length, matchesBundledBytes: exported.equals(readFileSync(join(sourceDirectory, name))),
        containsDeviceToken: Boolean(status.token) && exported.includes(status.token) }
    })
    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as { manifest_version: number; version: string }
    return { isPackaged: app.isPackaged, sourceDirectory, directory, files, entries: readdirSync(directory).sort(),
      manifest, version: probe.lastSuccess.version }
  })
}

async function expectExportFiles(app: ElectronApplication, parent: string) {
  const result = await inspectExport(app)
  expect(result.directory).toBe(join(parent, 'KnowBook Web Clipper'))
  expect(result.entries).toEqual(['README.md', 'manifest.json', 'page-collector.js', 'popup.html', 'popup.js'])
  expect(result.manifest.manifest_version).toBe(3)
  expect(result.manifest.version).toBe('0.1.2')
  expect(result.version).toBe(result.manifest.version)
  expect(result.files.every(file => file.bytes > 0 && file.matchesBundledBytes && !file.containsDeviceToken)).toBe(true)
  if (process.env.KNOWBOOK_E2E_EXECUTABLE?.trim()) {
    expect(result.isPackaged).toBe(true)
    expect(result.sourceDirectory).toMatch(/[\\/]resources[\\/]web-clip-extension$/i)
  } else expect(result.isPackaged).toBe(false)
  return result.directory
}

async function openBridge(page: Page) {
  await page.getByTitle(uiText('Settings', '配置中心'), { exact: true }).click()
  await page.getByRole('tab', { name: uiText('Web clipping', '网页剪藏'), exact: true }).click()
  await expect(page.locator('.settings-bridge-panel')).toBeVisible()
}

function controls(page: Page) {
  const panel = page.locator('.settings-bridge-panel')
  const scope = panel.getByRole('region', { name: uiText('Browser extension files', '浏览器扩展安装文件'), exact: true })
  return { panel, scope, exportButton: scope.locator('.web-clip-extension-export'),
    openButton: scope.locator('.web-clip-extension-open'), feedback: scope.locator('.web-clip-extension-feedback'),
    result: scope.locator('.web-clip-extension-result'),
    token: panel.getByLabel(uiText('Authorization token', '授权令牌'), { exact: true }),
    port: panel.getByLabel(uiText('Listening port', '监听端口'), { exact: true }) }
}
type Controls = ReturnType<typeof controls>

async function expectHit(button: Locator) {
  await expect(button).toBeInViewport({ ratio: 1 })
  const hit = await button.evaluate(element => {
    const rect = element.getBoundingClientRect()
    const target = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
    return { reachable: target === element || Boolean(target && element.contains(target)),
      rect: { top: rect.top, bottom: rect.bottom }, hitTag: target?.tagName, hitClass: target?.className }
  })
  expect(hit.reachable, JSON.stringify(hit)).toBe(true)
}

async function enter(page: Page, current: Controls, button: Locator) {
  await current.scope.scrollIntoViewIfNeeded()
  await expectHit(button)
  await button.focus()
  await expect(button).toBeFocused()
  await page.keyboard.press('Enter')
}

async function expectFeedback(current: Controls) {
  await expect(current.scope.locator('.web-clip-extension-actions')).toBeInViewport({ ratio: 1 })
  await expect(current.feedback).toBeInViewport({ ratio: 1 })
  expect(await current.feedback.getByRole('status').evaluateAll(elements => elements.every(element => !element.closest('[aria-busy="true"]')))).toBe(true)
}

async function record(page: Page, app: ElectronApplication, current: Controls, testInfo: TestInfo, phase: string) {
  const windows = await app.evaluate(({ BrowserWindow, app }) => ({ isPackaged: app.isPackaged,
    windows: BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() })) }))
  expect(windows.windows.length).toBeGreaterThan(0)
  expect(windows.windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
  const geometry = await current.scope.evaluate(scope => {
    const rect = (element: Element) => {
      const bounds = element.getBoundingClientRect()
      return { top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right }
    }
    return { viewport: { width: innerWidth, height: innerHeight }, scope: rect(scope),
      actions: [...scope.querySelectorAll('.web-clip-extension-actions')].map(rect),
      feedback: [...scope.querySelectorAll('.web-clip-extension-feedback')].map(rect),
      activeTag: document.activeElement?.tagName, activeButton: document.activeElement?.tagName === 'BUTTON' ? document.activeElement.textContent : null }
  })
  const body = JSON.stringify({ windows, geometry, requests: await counts(app) }, null, 2)
  await testInfo.attach(phase, { body, contentType: 'application/json' })
  await page.screenshot({ path: testInfo.outputPath(`${phase}.png`), mask: [current.token] })
}

for (const language of ['en-US', 'zh-CN'] as const) {
  test(`offline browser extension export retains its real files and supports keyboard retries (${language}) @electron`, async ({}, testInfo) => {
    test.skip(!hasBuiltElectronApp(), 'Run npm run build first.')
    await withElectronApp(async ({ app, page, tempRoot }) => {
      const firstParent = join(tempRoot, '扩展导出 first')
      const secondParent = join(tempRoot, '扩展导出 second')
      mkdirSync(firstParent)
      mkdirSync(secondParent)
      await page.evaluate(async language => {
        await window.knowbook.updateWebClipBridgeSettings({ enabled: false, port: 4321 })
        await window.knowbook.saveSetting('ui.language', language)
        await window.knowbook.saveSetting('appearance.theme', language === 'zh-CN' ? 'dark' : 'light')
      }, language)
      await page.reload()
      await expect(page.getByTestId('shell')).toBeVisible()
      await page.setViewportSize({ width: 760, height: language === 'zh-CN' ? 850 : 640 })
      await installProbe(app)
      const time = new Date('2026-10-02T00:00:00Z')
      await page.clock.install({ time })
      await page.clock.pauseAt(new Date(time.getTime() + 1))
      await openBridge(page)
      const current = controls(page)
      await expect(current.scope).toBeVisible()
      await expect(current.port).toHaveValue('4321')
      await expect(current.token).toHaveAttribute('type', 'password')
      const token = await current.token.inputValue()
      expect(Boolean(token)).toBe(true)
      await expect(current.openButton).toHaveCount(0)
      await expect(current.exportButton).toHaveAccessibleName(uiText('Export browser extension', '导出浏览器扩展'))

      // Same-frame attempts must reach the real picker only once. Cancel stays silent.
      await current.scope.scrollIntoViewIfNeeded()
      await expectHit(current.exportButton)
      await current.exportButton.focus()
      await current.exportButton.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click() })
      await expect.poll(async () => (await counts(app)).pickers).toBe(1)
      expect((await counts(app)).exports).toBe(1)
      await expect(current.exportButton).toBeDisabled()
      await expect(current.exportButton).toHaveAttribute('aria-busy', 'true')
      await expect(current.feedback.getByRole('status')).toHaveText(uiText('Choose an export location in the folder picker.', '在文件夹选择窗口中选择导出位置。'))
      await expectFeedback(current)
      await finishPicker(app, null)
      await expect(current.exportButton).toBeEnabled()
      await expect(current.exportButton).toBeFocused()
      await expect(current.feedback.getByRole('status')).toHaveCount(0)
      await expect(current.feedback.getByRole('alert')).toHaveCount(0)
      await expect(current.result).toHaveCount(0)
      expect(readdirSync(firstParent)).toEqual([])
      expect((await counts(app)).lastResult).toBeNull()
      await expect(page.locator('.app-notifications .app-notification')).toHaveCount(0)

      await enter(page, current, current.exportButton)
      await expect.poll(async () => (await counts(app)).pickers).toBe(1)
      expect((await counts(app)).exports).toBe(2)
      await current.exportButton.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click() })
      expect((await counts(app)).exports).toBe(2)
      const readsBefore = (await counts(app)).reads
      await page.clock.runFor(4001)
      await expect.poll(async () => (await counts(app)).reads).toBeGreaterThan(readsBefore)
      await expect.poll(async () => (await current.token.inputValue()) === token).toBe(true)
      await expect(current.token).toHaveAttribute('type', 'password')
      await expect(current.port).toHaveValue('4321')
      await expectFeedback(current)
      await record(page, app, current, testInfo, 'real-export-pending')
      await finishPicker(app, firstParent)
      await expect(current.exportButton).toBeEnabled()
      await expect(current.exportButton).toBeFocused()
      await expect(current.exportButton).toHaveAccessibleName(uiText('Export extension again', '重新导出扩展'))
      const directory = await expectExportFiles(app, firstParent)
      await expect(current.result.locator('dd').first()).toHaveText(directory)
      await expect(current.result.locator('dd').last()).toHaveText('0.1.2')
      await expect(current.feedback.getByRole('status')).toHaveText(uiText('Extension exported. Open the folder to see its files.', '扩展已导出，可以打开目录查看安装文件。'))
      const selectedPath = await current.result.locator('dd').first().evaluate(element => {
        const range = document.createRange()
        range.selectNodeContents(element)
        const selection = document.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
        return selection?.toString()
      })
      expect(selectedPath).toBe(directory)
      await page.evaluate(() => document.getSelection()?.removeAllRanges())
      expect((await counts(app)).clipboardCalls).toBe(0)
      expect((await counts(app)).pickerProperties.every(properties => properties.includes('openDirectory') && properties.includes('createDirectory'))).toBe(true)

      await page.getByRole('button', { name: uiText('Dashboard', '总览'), exact: true }).click()
      await expect(page.locator('[data-page-id="dashboard"]')).toHaveAttribute('aria-current', 'page')
      await openBridge(page)
      await expect(current.result.locator('dd').first()).toHaveText(directory)
      await expect(current.openButton).toBeEnabled()
      await expect(current.feedback.getByRole('status')).toHaveCount(0)

      // Cancelling a subsequent picker keeps both the renderer and real service result.
      await enter(page, current, current.exportButton)
      await expect.poll(async () => (await counts(app)).pickers).toBe(1)
      await finishPicker(app, null)
      await expect(current.exportButton).toBeFocused()
      await expect(current.result.locator('dd').first()).toHaveText(directory)
      await expect(current.feedback.getByRole('status')).toHaveCount(0)
      expect((await counts(app)).lastResult).toBeNull()
      expect((await counts(app)).lastSuccess?.directory).toBe(directory)
      await expectExportFiles(app, firstParent)

      await enter(page, current, current.openButton)
      await expect.poll(async () => (await counts(app)).pendingOpens).toBe(1)
      await expect(current.exportButton).toBeDisabled()
      await expect(current.openButton).toHaveAttribute('aria-busy', 'true')
      await expect(current.feedback.getByRole('status')).toHaveText(uiText('Opening the exported extension folder.', '正在打开已导出的扩展目录。'))
      await current.openButton.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click() })
      expect((await counts(app)).opens).toBe(1)
      await finishOpen(app, 'Controlled export folder opening failure')
      const openError = current.feedback.getByRole('alert')
      await expect(openError).toHaveText('Controlled export folder opening failure')
      await expect(openError).toHaveAttribute('data-action-kind', 'open')
      await expect(current.feedback.getByRole('status')).toHaveCount(0)
      await expect(current.openButton).toBeFocused()
      await expect(current.result.locator('dd').first()).toHaveText(directory)
      await record(page, app, current, testInfo, 'open-failure-result-retained')
      await expectFeedback(current)
      await expectHit(current.openButton)
      await page.keyboard.press('Enter')
      await expect.poll(async () => (await counts(app)).pendingOpens).toBe(1)
      await finishOpen(app)
      await expect(current.openButton).toBeEnabled()
      await expect(current.openButton).toBeFocused()
      await expect(openError).toHaveCount(0)
      expect((await counts(app)).openPaths).toEqual([directory, directory])
      await expect(current.feedback.getByRole('status')).toHaveText(uiText('Export folder opened.', '导出目录已打开。'))

      // The real exporter rejects an existing directory without replacing its files.
      await enter(page, current, current.exportButton)
      await expect.poll(async () => (await counts(app)).pickers).toBe(1)
      await finishPicker(app, firstParent)
      await expect(current.feedback.getByRole('alert')).toContainText('already exists')
      await expect(current.feedback.getByRole('alert')).toHaveAttribute('data-action-kind', 'export')
      await expect(current.exportButton).toBeFocused()
      await expect(current.result.locator('dd').first()).toHaveText(directory)
      await expectExportFiles(app, firstParent)

      // A real picker remains single-flight across category, language and page
      // changes. Its late result updates the cache without announcing success.
      await enter(page, current, current.exportButton)
      await expect.poll(async () => (await counts(app)).pickers).toBe(1)
      await page.getByRole('tab', { name: uiText('General', '通用'), exact: true }).click()
      const languageSelect = page.getByLabel(uiText('Interface language', '界面语言'), { exact: true })
      const otherLanguage = language === 'en-US' ? 'zh-CN' : 'en-US'
      await languageSelect.selectOption(otherLanguage)
      await languageSelect.focus()
      await expect(languageSelect).toBeFocused()
      await page.getByRole('tab', { name: uiText('Web clipping', '网页剪藏'), exact: true }).click()
      await expect(current.scope).toHaveAccessibleName(otherLanguage === 'zh-CN' ? '浏览器扩展安装文件' : 'Browser extension files')
      await expect(current.exportButton).toBeDisabled()
      await expect(current.openButton).toBeDisabled()
      const exportsBeforePageLeave = (await counts(app)).exports
      const documents = page.getByRole('button', { name: uiText('Documents', '文档'), exact: true })
      await documents.click()
      await openBridge(page)
      await expect(current.exportButton).toBeDisabled()
      await expect(current.exportButton).toHaveAttribute('aria-busy', 'true')
      await expect(current.openButton).toBeDisabled()
      await expect(current.feedback.getByRole('status')).toHaveText(uiText('Choose an export location in the folder picker.', '在文件夹选择窗口中选择导出位置。'))
      await expect(current.result.locator('dd').first()).toHaveText(directory)
      await current.exportButton.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click() })
      expect((await counts(app)).exports).toBe(exportsBeforePageLeave)
      expect((await counts(app)).pickers).toBe(1)
      await current.port.focus()
      await expect(current.port).toBeFocused()
      await finishPicker(app, secondParent)
      await expect.poll(async () => (await counts(app)).lastSuccess?.directory).toBe(join(secondParent, 'KnowBook Web Clipper'))
      await expect(current.exportButton).toBeEnabled()
      await expect(current.port).toBeFocused()
      const secondDirectory = await expectExportFiles(app, secondParent)
      await expect(current.result.locator('dd').first()).toHaveText(secondDirectory)
      await expect(current.feedback.getByRole('status')).toHaveCount(0)
      await expect(current.feedback.getByRole('alert')).toHaveCount(0)

      // A late native-open failure after leaving Settings is silent on return.
      await enter(page, current, current.openButton)
      await expect.poll(async () => (await counts(app)).pendingOpens).toBe(1)
      await documents.click()
      await expect(documents).toBeFocused()
      await finishOpen(app, 'Controlled obsolete folder opening failure')
      await expect(documents).toBeFocused()
      await openBridge(page)
      await expect(current.openButton).toBeEnabled()
      await expect(current.result.locator('dd').first()).toHaveText(secondDirectory)
      await expect(current.exportButton).toHaveAccessibleName(uiText('Export extension again', '重新导出扩展'))
      await expect(current.feedback.getByRole('alert')).toHaveCount(0)
      await expect(current.feedback.getByRole('status')).toHaveCount(0)
      expect((await counts(app)).lastSuccess?.directory).toBe(secondDirectory)
      await expectExportFiles(app, secondParent)
      await expect(current.token).toHaveAttribute('type', 'password')
      await expect.poll(async () => (await current.token.inputValue()) === token).toBe(true)
      expect((await counts(app)).clipboardCalls).toBe(0)
      await current.scope.scrollIntoViewIfNeeded()
      await record(page, app, current, testInfo, 'late-actions-silent-and-files-current')
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await enter(page, current, current.openButton)
      await expect.poll(async () => (await counts(app)).pendingOpens).toBe(1)
      expect((await counts(app)).openPaths.at(-1)).toBe(secondDirectory)
      await finishOpen(app)
      await expect(current.openButton).toBeFocused()
      await expect(current.feedback.getByRole('status')).toHaveText(uiText('Export folder opened.', '导出目录已打开。'))
    })
  })
}
