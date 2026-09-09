import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { SystemPluginFramePolicyInput } from '../src/shared/system-plugin'
import { WorkspaceEventBus } from '../src/main/event-bus'
import { SystemPluginHost } from '../src/main/system-plugin/host'
import { createKnowbookFullTrustServices, type KnowbookFullTrustServiceOptions } from '../src/main/system-plugin/knowbook-services'
import { disposeSystemPluginWindow, removeSystemPluginFrameResources, snapshotSystemPluginFrameResources, SystemPluginManagedResources } from '../src/main/system-plugin/managed-resources'

test('desktop SDK reports live resources, active close and tray destruction without counting raw Electron objects', async () => {
  const fixture = createFixture()
  const { services, registry, owner, dispose, notifications } = fixture
  const window = services.desktop.createWindow({ title: 'Managed window' })
  const tray = services.desktop.createTray('icon.png')
  const menu = services.desktop.createMenu([{ label: 'Plugin menu' }])
  const rawWindow = new services.desktop.electron.BrowserWindow({ title: 'Raw window' })
  const rawTray = new services.desktop.electron.Tray('raw.png')
  services.desktop.electron.Menu.buildFromTemplate([{ label: 'Raw menu' }])
  assert.deepEqual(registry.snapshot(owner.id).map(({ kind, label, revisionHash, source }) => ({ kind, label, revisionHash, source })), [
    { kind: 'window', label: 'Managed window', revisionHash: owner.revisionHash, source: 'desktop-sdk' },
    { kind: 'tray', label: 'Tray', revisionHash: owner.revisionHash, source: 'desktop-sdk' },
    { kind: 'menu', label: 'Plugin menu', revisionHash: owner.revisionHash, source: 'desktop-sdk' }
  ])
  assert.equal(notifications.count, 3)
  assert.equal(menu, fixture.menus[0])
  assert.equal(window instanceof fixture.electron.BrowserWindow, true)
  assert.equal(tray instanceof fixture.electron.Tray, true)

  const snapshot = registry.snapshot(owner.id)
  snapshot[0].label = 'mutated outside registry'
  window.setTitle('Updated title')
  assert.equal(registry.snapshot(owner.id)[0].label, 'Updated title')
  const beforeClose = notifications.count
  window.close()
  assert.ok(notifications.count > beforeClose)
  assert.deepEqual(registry.snapshot(owner.id).map((resource) => resource.kind), ['tray', 'menu'])
  const beforeDestroy = notifications.count
  tray.destroy()
  assert.ok(notifications.count > beforeDestroy)
  assert.deepEqual(registry.snapshot(owner.id).map((resource) => resource.kind), ['menu'])
  menu.closePopup()
  assert.equal(registry.snapshot(owner.id).length, 1, 'closing a popup does not dispose its reusable Menu')
  await dispose()
  await dispose()
  assert.deepEqual(registry.snapshot(owner.id), [])
  assert.equal(rawWindow.isDestroyed(), false)
  assert.equal(rawTray.isDestroyed(), false)
  rawWindow.destroy()
  rawTray.destroy()
})

test('managed resource snapshots separate owners and revisions and discard bypass-destroyed trays', () => {
  const fixture = createFixture()
  const first = new fixture.electron.Tray('first.png')
  const originalDestroy = first.destroy
  fixture.registry.forPlugin(fixture.owner).tray(first)
  const nextOwner = { ...fixture.owner, revisionHash: 'sha256:second' }
  fixture.registry.forPlugin(nextOwner).menu(fixture.electron.Menu.buildFromTemplate([{ label: 'Next revision' }]))
  fixture.registry.forPlugin({ id: 'other.plugin', revisionHash: 'sha256:other' }).tray(new fixture.electron.Tray('other.png'))
  assert.deepEqual(fixture.registry.snapshot(fixture.owner.id).map((resource) => resource.revisionHash), [fixture.owner.revisionHash, nextOwner.revisionHash])
  originalDestroy.call(first)
  assert.deepEqual(fixture.registry.snapshot(fixture.owner.id).map((resource) => resource.kind), ['menu'])
  assert.equal(fixture.registry.snapshot('other.plugin').length, 1)
  assert.deepEqual(fixture.registry.snapshot('missing.plugin'), [])
})

for (const fails of [false, true]) {
  test(`actual plugin host ${fails ? 'activation rollback' : 'deactivation'} clears registered resources, including a vetoed window close`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'knowbook-managed-resources-'))
    const fixture = createFixture()
    const root = join(directory, 'plugin')
    const dataRoot = join(directory, 'data')
    mkdirSync(root)
    mkdirSync(dataRoot)
    writeFileSync(join(root, 'main.cjs'), `
      module.exports.activate = (context) => {
        context.desktop.createWindow({ title: 'Lifecycle window' }).preventClose = true
        context.desktop.createMenu([{ label: 'Lifecycle menu' }])
        context.desktop.createTray('lifecycle.png')
        ${fails ? "throw new Error('fixture activation failure')" : ''}
      }
    `)
    const host = new SystemPluginHost({
      plugin: { ...fixture.owner, version: '1.0.0' },
      pluginRoot: root,
      dataRoot,
      mainEntry: 'main.cjs',
      createServices: (bindings) => createKnowbookFullTrustServices({
        ...fixture.options,
        desktopResources: fixture.registry.forPlugin(bindings.plugin),
        registerDisposable: bindings.registerDisposable
      })
    })
    try {
      if (fails) await assert.rejects(host.activate(), /fixture activation failure/)
      else {
        await host.activate()
        assert.equal(fixture.registry.snapshot(fixture.owner.id).length, 3)
        await host.deactivate()
      }
      assert.deepEqual(fixture.registry.snapshot(fixture.owner.id), [])
      assert.ok(fixture.windows.every((window) => window.isDestroyed()))
      assert.ok(fixture.trays.every((tray) => tray.isDestroyed()))
      assert.equal(fixture.menus[0].closed, true)
    } finally {
      await host.deactivate()
      rmSync(directory, { recursive: true, force: true })
    }
  })
}

test('frame summaries come from registered policies and live mapped privileged windows only', () => {
  const fixture = createFixture()
  const policy: SystemPluginFramePolicyInput = {
    pluginId: fixture.owner.id,
    revisionHash: fixture.owner.revisionHash,
    frameName: 'frame-one',
    popupName: 'popup-one',
    allowedOrigins: ['https://example.test'],
    allowPopups: true,
    allowNavigation: true,
    allowDownloads: false,
    allowPermissions: false
  }
  const policies = new Map([[policy.frameName, policy], ['other', { ...policy, pluginId: 'other', frameName: 'other' }]])
  const popup = new fixture.electron.BrowserWindow({ title: 'Privileged popup' })
  const popups = new Map([[popup.webContents.id, { frameName: policy.frameName, window: popup }]])
  const summaries = snapshotSystemPluginFrameResources(fixture.owner.id, policies, popups)
  assert.deepEqual(summaries.map((resource) => [resource.kind, resource.source]), [['frame', 'renderer-frame'], ['window', 'renderer-frame']])
  assert.equal(summaries[1].windowId, popup.id)
  assert.deepEqual(summaries[0].framePolicy, { allowPopups: true, allowNavigation: true, allowDownloads: false, allowPermissions: false })
  summaries[0].allowedOrigins!.push('https://mutated.test')
  assert.deepEqual(policy.allowedOrigins, ['https://example.test'])
  popup.close()
  assert.deepEqual(snapshotSystemPluginFrameResources(fixture.owner.id, policies, popups).map((resource) => resource.kind), ['frame'])
  policies.delete(policy.frameName)
  assert.deepEqual(snapshotSystemPluginFrameResources(fixture.owner.id, policies, popups), [])
})

test('frame removal destroys a popup that cancels beforeunload and retains registration if native destruction fails', () => {
  const fixture = createFixture()
  const policy: SystemPluginFramePolicyInput = {
    pluginId: fixture.owner.id, revisionHash: fixture.owner.revisionHash,
    frameName: 'vetoed-frame', popupName: 'vetoed-popup', allowedOrigins: ['https://example.test'],
    allowPopups: true, allowNavigation: true, allowDownloads: false, allowPermissions: false
  }
  const popup = new fixture.electron.BrowserWindow({ title: 'Vetoed popup' })
  fixture.windows[0].preventClose = true
  const policies = new Map([[policy.frameName, policy]])
  const popups = new Map([[popup.webContents.id, { frameName: policy.frameName, window: popup }]])
  const originalDestroy = popup.destroy
  popup.destroy = () => { throw new Error('native destruction failed') }
  assert.throws(() => removeSystemPluginFrameResources(policy.frameName, policies, popups), /native destruction failed/)
  assert.equal(popup.isDestroyed(), false)
  assert.equal(popups.size, 1)
  assert.equal(policies.size, 1)
  assert.equal(snapshotSystemPluginFrameResources(fixture.owner.id, policies, popups).length, 2)

  popup.destroy = originalDestroy
  removeSystemPluginFrameResources(policy.frameName, policies, popups)
  assert.equal(popup.isDestroyed(), true)
  assert.equal(popups.size, 0)
  assert.equal(policies.size, 0)
  assert.deepEqual(snapshotSystemPluginFrameResources(fixture.owner.id, policies, popups), [])
})

test('window disposal still attempts native destruction if a plugin close listener throws', () => {
  const fixture = createFixture()
  const popup = new fixture.electron.BrowserWindow()
  popup.close = () => { throw new Error('close listener failed') }
  assert.throws(() => disposeSystemPluginWindow(popup), /close listener failed/)
  assert.equal(popup.isDestroyed(), true)
  disposeSystemPluginWindow(popup)
})

function createFixture() {
  const windows: FakeWindow[] = []
  const trays: FakeTray[] = []
  const menus: Array<{ items: Array<{ label?: string }>; closed: boolean; closePopup(): void }> = []
  class FakeWindow extends EventEmitter {
    readonly id = windows.length + 1
    readonly webContents = { id: this.id + 100 }
    private destroyed = false
    private title: string
    preventClose = false
    constructor(options: Electron.BrowserWindowConstructorOptions = {}) {
      super()
      this.title = options.title ?? ''
      windows.push(this)
    }
    isDestroyed(): boolean { return this.destroyed }
    getTitle(): string { return this.title }
    setTitle(title: string): void { this.title = title; this.emit('page-title-updated') }
    close(): void { if (!this.preventClose) this.destroy() }
    destroy(): void {
      if (this.destroyed) return
      this.destroyed = true
      this.emit('closed')
    }
  }
  class FakeTray {
    private destroyed = false
    constructor(_image: Electron.NativeImage | string) { trays.push(this) }
    isDestroyed(): boolean { return this.destroyed }
    destroy(): void { this.destroyed = true }
  }
  const electron = {
    BrowserWindow: FakeWindow,
    Tray: FakeTray,
    Menu: {
      buildFromTemplate(items: Array<{ label?: string }>) {
        const menu = { items, closed: false, closePopup() { this.closed = true } }
        menus.push(menu)
        return menu
      },
      getApplicationMenu: () => null,
      setApplicationMenu: () => undefined
    }
  } as unknown as KnowbookFullTrustServiceOptions['electron']
  const notifications = { count: 0 }
  const registry = new SystemPluginManagedResources(() => { notifications.count += 1 })
  const owner = { id: 'test.managed.resources', revisionHash: 'sha256:first' }
  const disposables: Array<() => void | Promise<void>> = []
  const options: KnowbookFullTrustServiceOptions = {
    store: {} as KnowbookFullTrustServiceOptions['store'],
    sqlite: {} as KnowbookFullTrustServiceOptions['sqlite'],
    workspaceEventBus: new WorkspaceEventBus(),
    electron,
    getMainWindow: () => null,
    getAiCredentials: () => ({ enabled: false, apiKey: null, baseUrl: '', model: '' }),
    notifyWorkspaceMutation: () => undefined,
    registerDisposable: (dispose) => { disposables.push(dispose) },
    desktopResources: registry.forPlugin(owner),
    paths: { userData: '', appData: '', documents: '', downloads: '', temp: '' }
  }
  return {
    options, electron, registry, owner, windows, trays, menus, notifications,
    services: createKnowbookFullTrustServices(options),
    async dispose() { for (const dispose of [...disposables].reverse()) await dispose() }
  }
}
