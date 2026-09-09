'use strict'

// The test copies the existing acceptance Main into this exact, reviewed artifact.
const baseline = require('./baseline-main.cjs')
let activeRevision = null

module.exports = {
  async activate(context) {
    activeRevision = context.plugin.revisionHash
    console.log(`CONTROLLED_CAPABILITY_MAIN_ACTIVATE ${activeRevision}`)
    process.stdout.write('CONTROLLED_CAPABILITY_MAIN_FRAGMENT authorization=Bearer capability-fake')
    process.stdout.write('-bearer-value\n')
    console.error('CONTROLLED_CAPABILITY_MAIN_ERROR password=capability-fake-password')
    await new Promise(resolve => setTimeout(() => {
      console.log(`CONTROLLED_CAPABILITY_MAIN_ASYNC ${activeRevision}`)
      resolve()
    }, 20))
    context.registerDisposable(() => console.log('CONTROLLED_CAPABILITY_MAIN_DISPOSE api_key=capability-fake-key'), 'Main output disposal proof')
    context.registerDisposable(context.events.subscribe(event => {
      if (event.type !== 'document.created') return
      console.log(`CONTROLLED_CAPABILITY_MAIN_EVENT ${event.documentId}`)
      void Promise.resolve().then(() => console.log(`CONTROLLED_CAPABILITY_MAIN_EVENT_ASYNC ${event.documentId}`))
    }), 'Main subscriber output proof')
    const priorConfig = { theme: context.settings.getAppearanceTheme(), aiModel: context.settings.getAiConfig().model }
    await baseline.activate(context)
    const fs = context.require('node:fs')
    const path = context.require('node:path')
    const electron = context.desktop.electron
    const dataRoot = context.plugin.dataRoot
    const config = context.require('./fixture.json')
    const evidence = { revisionHash: context.plugin.revisionHash }
    evidence.priorConfig = priorConfig
    evidence.tls = await exerciseTls(context, config)
    const previous = path.join(dataRoot, 'desktop-evidence.json')
    evidence.priorSetting = context.settings.get('system.e2e.capabilities.persisted')
    context.settings.set('system.e2e.capabilities.persisted', 'survives-host-restart')
    context.settings.setAppearanceTheme('dark')

    // Actual selected directory, plus a raw SQLite transaction through the host connection.
    const selectedFile = path.join(config.selectedDirectory, 'plugin-write.txt')
    fs.writeFileSync(selectedFile, context.plugin.revisionHash)
    evidence.filesystem = {
      selectedDirectory: config.selectedDirectory,
      roundTrip: fs.readFileSync(selectedFile, 'utf8'),
      transaction: context.sqlite.transaction(() => {
        context.sqlite.exec('CREATE TABLE IF NOT EXISTS system_capability_probe (value TEXT NOT NULL)')
        context.sqlite.prepare('INSERT INTO system_capability_probe (value) VALUES (?)').run('transaction-ok')
        return context.sqlite.prepare('SELECT value FROM system_capability_probe ORDER BY rowid DESC LIMIT 1').get().value
      })()
    }

    const nativePath = context.require.resolve('./native/better_sqlite3.node')
    const addon = context.require(nativePath)
    addon.setErrorConstructor(Error)
    const dbPath = path.join(dataRoot, 'capabilities.sqlite')
    const db = new addon.Database(dbPath, dbPath, false, false, false, 5000, null, null)
    context.registerDisposable(() => db.close(), 'capability native SQLite connection')
    db.exec('CREATE TABLE IF NOT EXISTS visits (revision TEXT NOT NULL)')
    db.prepare('INSERT INTO visits VALUES (?)', {}, false).run(context.plugin.revisionHash)
    evidence.native = {
      answer: db.prepare('SELECT 42 AS answer', {}, false).get().answer,
      visits: db.prepare('SELECT revision FROM visits', {}, false).all(),
      nativePath,
      sha256: context.require('node:crypto').createHash('sha256').update(fs.readFileSync(nativePath)).digest('hex'),
      electron: process.versions.electron, modules: process.versions.modules,
      platform: process.platform, arch: process.arch, packaged: electron.app.isPackaged
    }

    // Clipboard is shared with the desktop. Restore Electron-supported formats on disposal,
    // and do not overwrite a newer clipboard value supplied by the user meanwhile.
    const originalClipboard = {
      text: electron.clipboard.readText(), html: electron.clipboard.readHTML(),
      rtf: electron.clipboard.readRTF(), image: electron.clipboard.readImage(),
      bookmark: electron.clipboard.readBookmark().title
    }
    const clipboardValue = `KnowBook capability clipboard ${config.token}`
    evidence.clipboardOriginalSha256 = context.require('node:crypto').createHash('sha256').update(originalClipboard.text).digest('hex')
    context.registerDisposable(() => {
      if (electron.clipboard.readText() !== clipboardValue) return
      electron.clipboard.write(originalClipboard)
    }, 'restore test clipboard')
    context.desktop.clipboard.writeText(clipboardValue)
    evidence.clipboard = context.desktop.clipboard.readText()

    const menu = context.desktop.createMenu([{
      id: 'capability-action', label: 'KnowBook controlled capability action',
      click: () => fs.writeFileSync(path.join(dataRoot, 'menu-click.json'), JSON.stringify({ clicked: true }))
    }])
    const tray = context.desktop.createTray(electron.nativeImage.createFromBitmap(
      Buffer.alloc(16 * 16 * 4, 255), { width: 16, height: 16 }
    ))
    tray.setToolTip('KnowBook controlled capability acceptance')
    tray.setContextMenu(menu)
    const window = context.desktop.createWindow({
      width: 460, height: 240, show: false, title: 'KnowBook capability preload',
      webPreferences: {
        contextIsolation: true, sandbox: false, nodeIntegration: false,
        preload: path.join(__dirname, 'preload.cjs')
      }
    })
    const channel = `knowbook-capability-${config.token}`
    electron.ipcMain.handle(channel, (event, value) => {
      if (event.sender !== window.webContents) throw new Error('Unexpected capability preload sender')
      return { pluginId: context.plugin.id, revisionHash: context.plugin.revisionHash, echo: value }
    })
    context.registerDisposable(() => electron.ipcMain.removeHandler(channel), 'capability preload IPC')
    await window.loadFile(path.join(__dirname, 'window.html'))
    evidence.preload = await window.webContents.executeJavaScript('window.capabilityReady')
    evidence.desktop = { windowId: window.id, trayDestroyed: tray.isDestroyed(), menuItems: menu.items.length }
    // Test inspection uses the actual Electron objects, never replacements for their APIs.
    globalThis.__knowbookCapabilityObjects = { window, tray, menu }
    globalThis.__knowbookCapabilityCreateTransientResources = () => {
      const transientWindow = context.desktop.createWindow({ show: false, title: 'Capability transient SDK window' })
      const transientTray = context.desktop.createTray(electron.nativeImage.createFromBitmap(
        Buffer.alloc(16 * 16 * 4, 255), { width: 16, height: 16 }
      ))
      const rawWindow = new electron.BrowserWindow({ show: false, title: 'Capability raw Electron window' })
      context.registerDisposable(() => { if (!rawWindow.isDestroyed()) rawWindow.destroy() }, 'raw Electron fixture window')
      globalThis.__knowbookCapabilityTransient = { window: transientWindow, tray: transientTray, rawWindow }
      return { windowId: transientWindow.id, rawWindowId: rawWindow.id }
    }
    await context.desktop.shell.openExternal(config.externalUrl)
    evidence.external = { requested: config.externalUrl }
    globalThis.__knowbookCapabilityMutate = () => exerciseData(context)
    fs.writeFileSync(previous, JSON.stringify(evidence))
  },
  healthCheck: baseline.healthCheck,
  deactivate() {
    process.stdout.write(`CONTROLLED_CAPABILITY_MAIN_DEACTIVATE ${activeRevision}\n`)
  }
}

async function exerciseTls(context, config) {
  const https = context.require('node:https')
  const ca = context.require('node:fs').readFileSync(context.require('node:path').join(__dirname, 'tls-cert.pem'))
  const get = (options) => new Promise((resolve, reject) => {
    https.get(config.tlsUrl, options, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => resolve({ status: response.statusCode, body }))
    }).once('error', reject)
  })
  const trusted = await get({ ca })
  let untrustedError = null
  try { await get({}) } catch (error) { untrustedError = error.code }
  return { trusted, untrustedError }
}

async function exerciseData(context) {
  const events = []
  const unsubscribe = context.events.subscribe((event) => { events.push(event) })
  const suffix = context.require('node:crypto').randomUUID().slice(0, 8)
  const block = (content) => ({ type: 'paragraph', content, checked: false, depth: 0 })
  try {
    const selection = await context.desktop.electron.dialog.showOpenDialog({ title: 'Choose controlled capability output', properties: ['openDirectory'] })
    if (selection.canceled || selection.filePaths.length !== 1) throw new Error('Expected one controlled output directory')
    const selectedFile = context.require('node:path').join(selection.filePaths[0], 'user-selected-dialog.txt')
    context.require('node:fs').writeFileSync(selectedFile, 'selected-directory-round-trip')
    const selectedRoundTrip = context.require('node:fs').readFileSync(selectedFile, 'utf8')
    const parent = await context.documents.create({ title: `Capability Tree ${suffix}`, blocks: [block('parent')] })
    const child = await context.documents.create({ parentId: parent.id, title: 'Capability Child', blocks: [block('child')] })
    const grandchild = await context.documents.create({ parentId: child.id, title: 'Capability Grandchild', blocks: [block('grandchild')] })
    const linkSource = await context.documents.create({ title: `Capability Links ${suffix}`, blocks: [
      block(`Old: [[${grandchild.path}]]. Moved: [[Capability Child/Capability Grandchild]].`)
    ] })
    const linksBefore = context.documents.get(linkSource.id).outgoingLinks
    const moved = await context.documents.move(child.id, null)
    const movedGrandchild = context.documents.get(grandchild.id)
    const linksAfterMove = context.documents.get(linkSource.id).outgoingLinks
    // The established single-document delete API reparents children. The acceptance
    // plugin deliberately performs subtree deletion leaf-first using that stable API.
    await context.documents.delete(grandchild.id)
    await context.documents.delete(child.id)
    await context.documents.delete(parent.id)
    const visible = await context.documents.create({ title: `Capability Visible ${suffix}`, blocks: [block('renderer-refresh-proof')] })
    const database = context.databases.create({ name: `Capability Database ${suffix}`, description: 'Live UI mutation' })
    const column = context.databases.createColumn({ databaseId: database.id, name: 'State', type: 'select', options: ['Open', 'Done'] })
    const view = context.databases.createView({ databaseId: database.id, name: 'Capability View', viewMode: 'table' })
    context.databases.updateView({ viewId: view.id, name: 'Capability View Updated' })
    const entities = [1, 2].map((number) => context.databases.createEntity({
      databaseId: database.id, title: `Capability Entity ${number}`, fieldValues: { [column.id]: 'Open' }
    }))
    context.databases.updateEntities({ updates: entities.map((entity) => ({ entityId: entity.id, fieldValues: { [column.id]: 'Done' } })) })
    const bulkUpdated = context.databases.listEntities(database.id)
    context.databases.deleteEntities({ entityIds: entities.map((entity) => entity.id) })
    const bulkDeleted = context.databases.listEntities(database.id).length === 0
    const survivor = context.databases.createEntity({ databaseId: database.id, title: 'Capability Visible Entity', fieldValues: { [column.id]: 'Done' } })
    const raw = context.sqlite.prepare('SELECT id, title FROM database_entities WHERE database_id = ? ORDER BY id').all(database.id)
    globalThis.__knowbookCapabilityCleanupData = async () => {
      context.databases.deleteView(view.id)
      context.databases.deleteEntity(survivor.id)
      context.databases.deleteColumn(column.id)
      const cleaned = {
        viewsDeleted: !context.databases.listViews(database.id).some(item => item.id === view.id),
        columnsDeleted: !context.databases.listColumns(database.id).some(item => item.id === column.id),
        entitiesDeleted: context.databases.listEntities(database.id).length === 0
      }
      context.databases.delete(database.id)
      await context.documents.delete(visible.id)
      await context.documents.delete(linkSource.id)
      return { ...cleaned, databaseDeleted: !context.databases.list().some(item => item.id === database.id),
        rawCount: context.sqlite.prepare('SELECT COUNT(*) AS count FROM database_entities WHERE database_id = ?').get(database.id).count }
    }
    context.settings.setAppearanceTheme('light')
    return {
      movedPath: moved.path, movedDescendantPath: movedGrandchild.path,
      linkedDocumentId: grandchild.id, linksBefore, linksAfterMove,
      linksAfterDelete: context.documents.get(linkSource.id).outgoingLinks,
      deleted: [parent.id, child.id, grandchild.id].every((id) => context.documents.get(id) === null),
      events, selectedRoundTrip, visible, database, column, view: context.databases.listViews(database.id).find((item) => item.id === view.id),
      bulkUpdated, bulkDeleted, survivor, raw
    }
  } finally { unsubscribe() }
}
