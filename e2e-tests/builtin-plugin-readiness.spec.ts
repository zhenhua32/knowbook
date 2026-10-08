import { expect, test } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import {
  closeElectronApp, hasBuiltElectronApp, launchElectronApp, waitForBuiltinPluginReadiness,
  withElectronApp, type ElectronAppContext
} from './helpers/electron'

test('fresh built-in renderers commit before fixture setup and rebuild after an immediate reload @electron', async ({}, info) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  await withElectronApp(async context => {
    const before = await waitForBuiltinPluginReadiness(context, { freshProfile: true })
    await context.page.evaluate(async () => {
      await window.knowbook.saveSetting('ui.language', 'en-US')
      await window.knowbook.saveSetting('appearance.theme', 'dark')
    })
    await context.page.reload()
    const after = await waitForBuiltinPluginReadiness(context, { freshProfile: true })
    const revisions = (snapshot: typeof before) => snapshot.plugins.map(plugin => ({ id: plugin.pluginId, artifact: plugin.currentArtifactSha256 })).sort((a, b) => a.id.localeCompare(b.id))
    expect(revisions(after)).toEqual(revisions(before))
    await context.page.locator('[data-page-id="settings"]').click()
    await context.page.getByRole('tab', { name: 'Appearance', exact: true }).click()
    await context.page.getByTestId('theme-option-cloud').click()
    await expect(context.page.getByTestId('theme-option-cloud')).toHaveAttribute('aria-pressed', 'true')
    await expect(context.page.locator('html')).toHaveAttribute('data-knowbook-theme-switcher', 'cloud')
    await expect(context.page.locator('html')).toHaveAttribute('data-theme', 'dark')
    writeFileSync(info.outputPath('builtin-reload-readiness.json'), JSON.stringify({ before, after }, null, 2))
  })
})

test('a retained theme opt-out stays disabled while the translator commits on restart @electron', async ({}, info) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  test.setTimeout(90_000)
  let context: ElectronAppContext | null = await launchElectronApp()
  try {
    const profile = context.tempRoot
    await context.page.evaluate(() => window.knowbook.setSystemPluginEnabled({ pluginId: 'theme-switcher', enabled: false }))
    await closeElectronApp(context, { preserveUserData: true }); context = null
    context = await launchElectronApp({}, { userDataRoot: profile })
    const snapshot = await waitForBuiltinPluginReadiness(context)
    expect(snapshot.plugins.find(plugin => plugin.pluginId === 'theme-switcher')).toMatchObject({ source: 'builtin', enabled: false, status: 'disabled', runtimeStatus: null })
    expect(snapshot.contributions.find(contribution => contribution.pluginId === 'theme-switcher')?.entries).toEqual([])
    expect(snapshot.plugins.find(plugin => plugin.pluginId === 'document-translator')).toMatchObject({ source: 'builtin', enabled: true, status: 'active', runtimeStatus: 'active' })
    writeFileSync(info.outputPath('builtin-opt-out-readiness.json'), JSON.stringify(snapshot, null, 2))
  } finally {
    if (context) await closeElectronApp(context)
  }
})

test('fresh safe mode registers pending built-ins without forcing their activation @electron', async ({}, info) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  await withElectronApp(async context => {
    const snapshot = await waitForBuiltinPluginReadiness(context, { freshProfile: true, safeMode: true })
    for (const plugin of snapshot.plugins) {
      expect(plugin).toMatchObject({ source: 'builtin', enabled: true, safeModeDisabled: false, status: 'pending-restart', runtimeStatus: null, currentArtifactSha256: null, lastError: null })
      expect(plugin.pendingArtifactSha256).toMatch(/^[a-f0-9]{64}$/)
    }
    expect(snapshot.contributions.every(contribution => contribution.entries?.length === 0)).toBe(true)
    await expect(context.page.locator('style[data-full-trust-plugin="theme-switcher"], style[data-full-trust-plugin="document-translator"]')).toHaveCount(0)
    writeFileSync(info.outputPath('builtin-safe-mode-readiness.json'), JSON.stringify(snapshot, null, 2))
  }, { KNOWBOOK_SYSTEM_PLUGIN_SAFE_MODE: '1' })
})
