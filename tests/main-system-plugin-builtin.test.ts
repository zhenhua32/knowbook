import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store'
import { SystemPluginManager } from '../src/main/system-plugin/manager'
import { type BuiltinSystemPlugin, snapshotBuiltinSystemPlugins } from '../src/main/system-plugin/builtin'

const pluginId = 'theme-switcher'
function builtin(tag = 'bundled'): BuiltinSystemPlugin {
  return { id: pluginId, files: {
    'plugin.json': JSON.stringify({ schemaVersion: 3, trust: 'full', fullAccess: true,
      id: pluginId, name: '主题切换', version: '1.0.0', publisher: 'KnowBook',
      entries: { main: 'main.cjs' }, riskDeclarations: ['settings'] }),
    'main.cjs': `module.exports = { activate(api) { api.record(${JSON.stringify(tag)}) } }`
  } }
}

async function fixture(run: (context: {
  root: string
  store: KnowbookStore
  calls: string[]
  create(catalog?: readonly BuiltinSystemPlugin[]): SystemPluginManager<{ record(value: string): void }>
}) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-builtin-v3-'))
  const store = new KnowbookStore(join(root, 'knowbook.db'))
  const calls: string[] = []
  const managers: SystemPluginManager<{ record(value: string): void }>[] = []
  try {
    await run({ root, store, calls, create(catalog = [builtin()]) {
      const manager = new SystemPluginManager({
        repository: store.pluginPlatform, builtinPlugins: catalog,
        stagingRoot: join(root, 'staging'), artifactRoot: join(root, 'artifacts'),
        dataRoot: join(root, 'data'), backupRoot: join(root, 'backups'),
        backupDatabase: destination => store.backupDatabase(destination),
        services: { record: (value: string) => { calls.push(value) } }
      })
      managers.push(manager)
      return manager
    } })
  } finally {
    for (const manager of managers) await manager.destroy()
    store.destroy()
    rmSync(root, { recursive: true, force: true })
  }
}

test('built-in v3 activates on first boot without forging an install confirmation, and registers once', async () => {
  await fixture(async ({ create, store, calls }) => {
    store.saveSetting('theme-switcher.selected-theme', 'moss')
    const first = create()
    await first.startup()
    assert.equal(first.get(pluginId)?.runtime?.status, 'active')
    assert.deepEqual(calls, ['bundled'])
    assert.deepEqual(store.pluginPlatform.listSystemPluginInstallRequests(), [])
    assert.equal(first.get(pluginId)?.currentPackage?.sourceRequestId, null)
    await first.destroy()
    const second = create()
    await second.startup()
    assert.deepEqual(calls, ['bundled', 'bundled'])
    assert.equal(store.getSettingPublic('theme-switcher.selected-theme'), 'moss')
    assert.equal(store.pluginPlatform.listSystemPluginPackages(pluginId).length, 1)
    const audit = store.pluginPlatform.listSystemPluginAudit(pluginId)
      .filter(entry => entry.action === 'builtin.registered')
    assert.equal(audit.length, 1)
    assert.equal(audit[0].actor, 'system')
  })
})

test('built-in updates preserve opt-out and preferences, then re-enable the app revision', async () => {
  await fixture(async ({ create, store, calls }) => {
    const first = create()
    await first.startup()
    store.saveSetting('theme-switcher.selected-theme', 'midnight')
    await first.disable(pluginId)
    await first.destroy()
    const upgraded = create([builtin('upgraded')])
    await upgraded.startup()
    assert.equal(upgraded.get(pluginId)?.installation.enabled, false)
    assert.equal(upgraded.get(pluginId)?.runtime, null)
    assert.equal(store.getSettingPublic('theme-switcher.selected-theme'), 'midnight')
    assert.deepEqual(calls, ['bundled'])
    await upgraded.destroy()
    const disabledBoot = create([builtin('upgraded')])
    await disabledBoot.startup()
    assert.equal(disabledBoot.get(pluginId)?.installation.status, 'disabled')
    assert.equal(store.pluginPlatform.listSystemPluginAudit(pluginId)
      .filter(entry => entry.action === 'builtin.registered').length, 2)
    await disabledBoot.enable(pluginId)
    await disabledBoot.destroy()
    await create([builtin('upgraded')]).startup()
    assert.deepEqual(calls, ['bundled', 'upgraded'])
  })
})

test('safe mode registers built-ins without loading code and preserves crash quarantine', async () => {
  await fixture(async ({ create, calls, store }) => {
    const safe = create()
    await safe.startup({ safeMode: true })
    assert.deepEqual(calls, [])
    assert.equal(safe.get(pluginId)?.installation.enabled, true)
    await safe.destroy()
    const failed = create([{ ...builtin(), files: { ...builtin().files,
      'main.cjs': 'module.exports = { activate() { throw new Error("controlled failure") } }'
    } }])
    await failed.startup()
    assert.equal(failed.get(pluginId)?.installation.safeModeDisabled, true)
    await failed.destroy()
    const healthy = create()
    await healthy.startup()
    assert.equal(healthy.get(pluginId)?.installation.safeModeDisabled, true)
    assert.deepEqual(calls, [])
    assert.equal(store.pluginPlatform.listSystemPluginInstallRequests().length, 0)
  })
})

test('previous external installation migrates to app bytes; reserved IDs cannot be replaced or uninstalled', async () => {
  await fixture(async ({ create, root, store, calls }) => {
    const source = join(root, 'external-source')
    mkdirSync(source)
    for (const [name, content] of Object.entries(builtin('external').files)) writeFileSync(join(source, name), content)
    const oldApp = create([])
    const request = await oldApp.prepareInstallFromDirectory({ sourceDirectory: source, reason: 'Fixture', requestedBy: 'user' })
    await oldApp.resolveInstallRequest({ requestId: request.id, pluginId,
      artifactSha256: request.artifactSha256, actor: 'user', decision: 'confirm', acknowledgeSystemAccess: true })
    await oldApp.startup()
    await oldApp.destroy()
    store.saveSetting('theme-switcher.selected-theme', 'paper')
    const current = create()
    await current.startup()
    assert.deepEqual(calls, ['external', 'bundled'])
    assert.equal(store.getSettingPublic('theme-switcher.selected-theme'), 'paper')
    await assert.rejects(current.prepareInstallFromDirectory({ sourceDirectory: source, reason: 'Override', requestedBy: 'user' }), /内置插件/)
    await assert.rejects(current.requestUninstall(pluginId), /内置插件/)
    await assert.rejects(current.rollback(pluginId), /内置插件/)
    assert.equal(store.pluginPlatform.listSystemPluginInstallRequests().length, 1)
  })
})

test('built-in artifact tampering disables it, and runtime redirects cannot change the bundled entry', async () => {
  await fixture(async ({ create, calls, root, store }) => {
    const first = create()
    await first.startup()
    const published = first.get(pluginId)!.currentPackage!
    await first.destroy()
    const redirected = join(root, 'redirected')
    mkdirSync(redirected)
    writeFileSync(join(redirected, 'main.cjs'), builtin('redirected').files['main.cjs'])
    store.pluginPlatform.updateSystemPluginPackage(published.id, { runtimeFingerprint: { runtimeRoot: redirected } })
    const next = create()
    await next.startup()
    assert.deepEqual(calls, ['bundled', 'bundled'])
    await next.destroy()
    writeFileSync(join(published.artifactPath, 'main.cjs'), builtin('tampered').files['main.cjs'])
    const tampered = create()
    await tampered.startup()
    assert.equal(tampered.get(pluginId)?.installation.safeModeDisabled, true)
    assert.deepEqual(calls, ['bundled', 'bundled'])
  })
})

test('built-in catalog cannot request dependency scripts, service execution, or paths outside its artifact', () => {
  assert.throws(() => snapshotBuiltinSystemPlugins([{ ...builtin(), files: { ...builtin().files, '../main.cjs': '' } }]), /file path/)
  const manifest = JSON.parse(builtin().files['plugin.json'])
  manifest.entries.service = 'main.cjs'
  assert.throws(() => snapshotBuiltinSystemPlugins([{ ...builtin(), files: { ...builtin().files,
    'plugin.json': JSON.stringify(manifest) } }]), /self-contained/)
})
