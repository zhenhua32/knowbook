import { expect, test, type Page } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import type { EditorCloseRequest } from '../src/shared/editor-close'
import { hasBuiltElectronApp, uiText, waitForBuiltinPluginReadiness } from './helpers/electron'
import { expectSource, sourceValue } from './helpers/markdown-source'
import { appendCanonicalText, closeEvents, expectCanonicalRow, expectHostReferencesUnchanged, inlineInstance, observeRealEditorClose,
  openInlineHost, withCanonicalInlineApp } from './helpers/canonical-inline'

test.skip(!hasBuiltElectronApp(), 'Build the actual local Electron app before running reload admission')
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

type ReloadKeyboardProbe = { snapshot: () => unknown; cleanup: () => void }
type ReloadProbeGlobal = typeof globalThis & { __reloadKeyboardProbe?: ReloadKeyboardProbe }
async function observeReloadKeyboard(app: ElectronApplication) {
  await app.evaluate(({ BrowserWindow, Menu }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents
    const inputs: unknown[] = [], navigation: unknown[] = [], menus: unknown[] = []
    const input = (event: unknown, value: unknown) => {
      const e = event as { defaultPrevented?: boolean }, key = value as Record<string, unknown>
      inputs.push({ type: key.type, key: key.key, code: key.code, control: key.control, meta: key.meta,
        shift: key.shift, alt: key.alt, prevented: e.defaultPrevented, focused: contents.isFocused() })
    }
    const navigate = (_event: unknown, url: unknown, inPlace: unknown, mainFrame: unknown) => navigation.push({ url, inPlace, mainFrame })
    const visit = (menu: Electron.Menu | null) => { for (const item of menu?.items ?? []) {
      if (/reload/i.test(item.id + ' ' + (item.role ?? ''))) menus.push({ id: item.id, role: item.role, label: item.label })
      if (item.submenu) visit(item.submenu)
    } }
    visit(Menu.getApplicationMenu())
    contents.on('before-input-event', input); contents.on('did-start-navigation', navigate)
    ;(globalThis as ReloadProbeGlobal).__reloadKeyboardProbe = {
      snapshot: () => ({ inputs, navigation, menus, url: contents.getURL() }),
      cleanup: () => { contents.removeListener('before-input-event', input); contents.removeListener('did-start-navigation', navigate) }
    }
  })
}

async function clickActualReloadMenu(app: ElectronApplication, force = false): Promise<void> {
  await app.evaluate(({ BrowserWindow, Menu }, force) => {
    const menu = Menu.getApplicationMenu()
    if (!menu) throw new Error('The real application menu is absent')
    const id = force ? 'knowbook-editor-force-reload' : 'knowbook-editor-reload'
    const item = menu.getMenuItemById(id), window = BrowserWindow.getAllWindows()[0]
    if (!item || !window || window.isDestroyed() || !item.enabled || item.role) throw new Error('The real guarded host Reload menu item is not installed')
    // Call the installed native MenuItem wrapper using Electron's documented
    // signature; no synthetic IPC event, handler replacement or fake ACK.
    item.click({ triggeredByAccelerator: false }, window, window.webContents)
  }, force)
}

async function pressHostReloadKey(app: ElectronApplication, keyCode: string, modified = false): Promise<void> {
  await app.evaluate(({ BrowserWindow }, { keyCode, modified }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents
    const modifiers: Array<'meta' | 'control'> = modified ? [process.platform === 'darwin' ? 'meta' : 'control'] : []
    // Deliver genuine Electron input to the host's before-input-event route;
    // CDP's page keyboard can bypass it while the window stays backgrounded.
    contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  }, { keyCode, modified })
}

async function expectBlockedReload(page: Page, trigger: () => Promise<unknown>): Promise<void> {
  const before = await closeEvents(page)
  await trigger()
  await expect.poll(async () => (await closeEvents(page)).cancelled.length).toBe(before.cancelled.length + 1)
  const after = await closeEvents(page), request = after.requests.at(-1)!, cancelled = after.cancelled.at(-1)!
  expect(after.requests).toHaveLength(before.requests.length + 1)
  expect(request.reason).toBe('reload')
  expect(request.requestId).not.toBe(before.requests.at(-1)?.requestId)
  expect(cancelled).toMatchObject({ requestId: request.requestId, reason: 'reload' })
  await expect.poll(() => page.evaluate(() => document.documentElement.inert)).toBe(false)
}

test('F5, Ctrl/Cmd+R, force menu and typed reload all preserve unapplied Source and cancel with their real Main nonce @electron', async ({}, info) => {
  await withCanonicalInlineApp(info, async fixture => {
    const { page, app } = fixture.context(), { seed } = fixture
    await openInlineHost(page, seed.hosts[0])
    const instance = inlineInstance(page, seed.instanceIds[0])
    await expectCanonicalRow(instance, seed.primaryId, seed.primaryText)
    await observeRealEditorClose(page)
    await instance.getByRole('button', { name: uiText('Edit source', '编辑源码'), exact: true }).click()
    const source = page.getByRole('textbox', { name: uiText('Shared body Markdown source', '共享正文 Markdown 源码'), exact: true })
    await expect(source).toBeVisible()
    const before = await sourceValue(source), suffix = ' retained through actual reload attempt 中文🙂'
    await source.press(mod + '+End'); await page.keyboard.insertText(suffix)
    await expectSource(source, before + suffix)
    await observeReloadKeyboard(app)
    try {
    const triggers = [
      () => pressHostReloadKey(app, 'F5'),
      () => pressHostReloadKey(app, 'R', true),
      () => clickActualReloadMenu(app, true),
      () => page.evaluate(() => window.knowbook.requestEditorReload())
    ]
    for (const trigger of triggers) {
      await expectBlockedReload(page, trigger)
      await expectSource(source, before + suffix)
      await expectHostReferencesUnchanged(page, seed)
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
    }
    await source.press(mod + '+End'); await page.keyboard.insertText(' still editable')
    await expectSource(source, before + suffix + ' still editable')
    await page.getByRole('dialog', { name: uiText('Edit shared body source', '编辑共享正文源码'), exact: true })
      .getByRole('button', { name: uiText('Cancel', '取消'), exact: true }).click()
    await expect(source).toHaveCount(0)
    await expectCanonicalRow(instance, seed.primaryId, seed.primaryText)
    } finally {
      const main = await app.evaluate(() => {
        const probe = (globalThis as ReloadProbeGlobal).__reloadKeyboardProbe
        const value = probe?.snapshot(); probe?.cleanup(); delete (globalThis as ReloadProbeGlobal).__reloadKeyboardProbe
        return value
      }).catch(error => ({ error: String(error) }))
      const renderer = await closeEvents(page).catch(error => ({ error: String(error) }))
      const raw = await sourceValue(source).catch(error => String(error))
      await info.attach('reload-keyboard-observation', { body: Buffer.from(JSON.stringify({ main, renderer, raw }, null, 2)), contentType: 'application/json' })
    }
  })
})

test('the actual Reload menu drains canonical W before real navigation and remounts the same persisted three references without shutting down @electron', async ({}, info) => {
  await withCanonicalInlineApp(info, async fixture => {
    const context = fixture.context(), { page, app } = context, { seed } = fixture
    await openInlineHost(page, seed.hosts[0])
    await expectCanonicalRow(inlineInstance(page, seed.instanceIds[0]), seed.primaryId, seed.primaryText)
    const requests: EditorCloseRequest[] = [], prefix = '[canonical-reload-passive-request]'
    page.on('console', message => {
      if (message.text().startsWith(prefix)) requests.push(JSON.parse(message.text().slice(prefix.length)) as EditorCloseRequest)
    })
    await page.evaluate(prefix => {
      // Passive real-event observation survives navigation in the test host;
      // the renderer still owns its genuine flush and ACK implementation.
      window.knowbook.onEditorCloseRequest(request => console.info(prefix + JSON.stringify(request)))
    }, prefix)
    const finalText = seed.primaryText + ' saved by reload drain'
    await appendCanonicalText(page, seed.instanceIds[0], seed.primaryId, seed.primaryText, ' saved by reload drain')
    await expectCanonicalRow(inlineInstance(page, seed.instanceIds[1]), seed.primaryId, finalText)
    const pid = await app.evaluate(() => process.pid), loaded = page.waitForEvent('domcontentloaded')
    await clickActualReloadMenu(app)
    await loaded
    await expect(page.getByTestId('shell')).toBeVisible()
    await waitForBuiltinPluginReadiness(context, { freshProfile: false })
    await expect.poll(() => requests.length).toBe(1)
    expect(requests[0].reason).toBe('reload')
    expect(await app.evaluate(() => process.pid)).toBe(pid)
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
    await openInlineHost(page, seed.hosts[0])
    for (const id of seed.instanceIds.slice(0, 2)) await expectCanonicalRow(inlineInstance(page, id), seed.primaryId, finalText)
    const persisted = await page.evaluate(input => window.knowbook.resolveSyncedInlineInstance(input), {
      hostDocumentId: seed.hosts[0].id, instanceId: seed.instanceIds[0], groupId: seed.groupId
    })
    expect(persisted.status).toBe('ready')
    if (persisted.status !== 'ready') throw new Error('The actual reloaded group disappeared')
    expect(persisted.snapshot.blocks.find(block => block.id === seed.primaryId)?.content).toBe(finalText)
    await openInlineHost(page, seed.hosts[1])
    await expectCanonicalRow(inlineInstance(page, seed.instanceIds[2]), seed.primaryId, finalText)
    await expectHostReferencesUnchanged(page, seed)
  })
})
