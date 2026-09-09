import { expect, test } from '@playwright/test'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { closeElectronApp, launchElectronApp, uiText, type ElectronAppContext } from './helpers/electron'

test('uninstall UI keeps private data for reinstall or deletes it after restart @data-retention', async ({}, testInfo) => {
  test.setTimeout(180_000)
  expect(process.platform).toBe('win32')
  expect(process.env.KNOWBOOK_E2E_EXECUTABLE, 'Run npm run test:packaged-data-retention.').toBeTruthy()
  const source = mkdtempSync(join(tmpdir(), 'knowbook retention source '))
  const profile = mkdtempSync(join(tmpdir(), 'knowbook retention 工作区 '))
  const pluginId = 'system.e2e.data-retention'
  const dataPath = join(profile, 'system-plugins/data', pluginId)
  const marker = join(dataPath, 'state.json')
  const snapshots: unknown[] = []
  const stages: string[] = []
  let context: ElectronAppContext | null = null
  let stage = 'install'
  let failure: unknown
  const state = () => context!.page.evaluate(async (id) => (await window.knowbook.listSystemPlugins()).find((item) => item.pluginId === id) ?? null, pluginId)
  const boot = async () => {
    if (context) await closeElectronApp(context, { preserveUserData: true })
    context = null
    context = await launchElectronApp({}, { userDataRoot: profile })
  }
  const install = async () => {
    await context!.app.evaluate(({ dialog }, directory) => {
      Object.defineProperty(dialog, 'showOpenDialog', { configurable: true, value: async () => ({ canceled: false, filePaths: [directory] }) })
      Object.defineProperty(dialog, 'showMessageBox', { configurable: true, value: async () => ({ response: 0 }) })
    }, source)
    const request = await context!.page.evaluate(() => window.knowbook.chooseAndPrepareSystemPluginInstall())
    if (!request) throw new Error('Expected retention example request.')
    await context!.page.evaluate((input) => window.knowbook.resolveSystemPluginInstallRequest({
      requestId: input.id, pluginId: input.pluginId, artifactSha256: input.artifactSha256,
      decision: 'confirm', acknowledgeSystemAccess: true
    }), { id: request.id, pluginId: request.pluginId, artifactSha256: request.artifactSha256 })
    return request.artifactSha256
  }
  const openUninstall = async () => {
    const nav = context!.page.locator('button.nav-icon-btn').and(context!.page.getByTitle(uiText('Plugins', '插件中心'))).first()
    await nav.click()
    const button = context!.page.locator('.system-plugin-request').filter({ hasText: 'Data retention acceptance' })
      .getByRole('button', { name: uiText('Uninstall', '卸载') })
    await button.click()
    return context!.page.getByRole('dialog', { name: /Data retention acceptance/ })
  }
  try {
    cpSync(resolve('examples/system-plugin-v3-starter'), source, { recursive: true })
    const manifest = JSON.parse(readFileSync(join(source, 'plugin.json'), 'utf8'))
    Object.assign(manifest, { id: pluginId, name: 'Data retention acceptance', entries: { main: 'main.cjs' } })
    delete manifest.background
    writeFileSync(join(source, 'plugin.json'), JSON.stringify(manifest))
    await boot()
    expect(await context!.app.evaluate(({ app }) => app.isPackaged)).toBe(true)
    const hash = await install()
    await boot()
    await expect.poll(async () => (await state())?.status).toBe('active')
    const first = JSON.parse(readFileSync(marker, 'utf8'))
    expect(first.activations).toBe(1)
    stages.push(stage)

    stage = 'cancel-keeps-plugin-active'
    let dialog = await openUninstall()
    await expect(dialog.getByRole('radio', { name: uiText('Keep data for a future reinstall', '保留数据，重新安装时继续使用') })).toBeChecked()
    await dialog.screenshot({ path: testInfo.outputPath('uninstall-options.png') })
    await dialog.getByRole('button', { name: uiText('Cancel', '取消') }).click()
    expect((await state())?.status).toBe('active')
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual(first)
    stages.push(stage)

    stage = 'keep-data-uninstall'
    dialog = await openUninstall()
    await dialog.getByRole('button', { name: uiText('Confirm uninstall', '确认卸载') }).click()
    await expect.poll(async () => (await state())?.status).toBe('uninstall-pending')
    expect((await state())?.preserveDataOnUninstall).toBe(true)
    snapshots.push({ stage, state: await state() })
    await boot()
    expect(await state()).toBeNull()
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual(first)
    for (const directory of ['artifacts', 'runtime']) expect(existsSync(join(profile, 'system-plugins', directory, pluginId, hash))).toBe(false)
    expect(existsSync(join(profile, 'system-plugins/logs', pluginId))).toBe(false)
    stages.push(stage)

    stage = 'reinstall-reuses-existing-data'
    expect(await install()).toBe(hash)
    await boot()
    await expect.poll(async () => (await state())?.status).toBe('active')
    const reused = JSON.parse(readFileSync(marker, 'utf8'))
    expect(reused).toEqual({ ...first, activations: 2 })
    snapshots.push({ stage, retained: first, reused })
    stages.push(stage)

    stage = 'delete-data-uninstall'
    dialog = await openUninstall()
    await dialog.getByRole('radio', { name: uiText('Also delete plugin data', '同时删除插件专属数据') }).check()
    await dialog.getByRole('button', { name: uiText('Confirm uninstall', '确认卸载') }).click()
    await expect.poll(async () => (await state())?.status).toBe('uninstall-pending')
    expect((await state())?.preserveDataOnUninstall).toBe(false)
    snapshots.push({ stage, state: await state() })
    await boot()
    expect(await state()).toBeNull()
    expect(existsSync(dataPath)).toBe(false)
    for (const directory of ['artifacts', 'runtime']) expect(existsSync(join(profile, 'system-plugins', directory, pluginId, hash))).toBe(false)
    stages.push(stage)
  } catch (error) { failure = error; throw error }
  finally {
    const cleanupErrors: string[] = []
    try { if (context) await closeElectronApp(context, { preserveUserData: true }) } catch (error) { cleanupErrors.push(String(error)) }
    for (const directory of [source, profile]) try { rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch (error) { cleanupErrors.push(String(error)) }
    const evidencePath = testInfo.outputPath('data-retention-evidence.json')
    writeFileSync(evidencePath, JSON.stringify({ stages, snapshots, failedStage: failure ? stage : null, failure: failure ? String(failure) : null, cleanupErrors }, null, 2))
    await testInfo.attach('data-retention-evidence', { path: evidencePath, contentType: 'application/json' })
    if (!failure && cleanupErrors.length) throw new Error(cleanupErrors.join('\n'))
  }
})
