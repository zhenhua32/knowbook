'use strict'
module.exports = async function (api) {
  const catalog = await window.knowbook.getDocumentCatalog()
  const root = document.createElement('section')
  root.dataset.testid = 'system-capability-dom'
  root.dataset.preloadRead = String(catalog.length)
  root.textContent = 'Real renderer preload API answered'
  document.body.append(root)
  api.registerDisposable(() => root.remove(), 'capability DOM')
  api.injectCss('[data-testid="system-capability-dom"] { color: rgb(17, 34, 51); }', { id: 'capability-style' })
  api.registerSlotContribution({
    id: 'capability-dashboard', slot: 'workspace.dashboard',
    component: () => React.createElement('p', {
      'data-testid': 'system-capability-react', 'data-revision': api.plugin.revisionHash
    }, `Twelve capability acceptance: ${api.plugin.id}`)
  })
  api.registerCommand({
    id: 'capability-command', title: 'Controlled capability command',
    shortcut: { key: 'k', ctrlKey: true, altKey: true },
    execute: ({ source }) => { root.dataset.commandSource = source; return 'command-ok' }
  })
  root.dataset.commandResult = await api.executeCommand('capability-command')
  const data = document.createElement('pre')
  data.dataset.testid = 'capability-live-data'
  root.append(data)
  const refresh = async () => {
    const home = await window.knowbook.getHomeData()
    const databases = await window.knowbook.getDatabases()
    const entities = (await Promise.all(databases.map(database => window.knowbook.getDatabaseEntities(database.id)))).flat()
    data.textContent = JSON.stringify({ documents: home.documentCatalog.map(item => item.title), entities: entities.map(item => item.title), theme: home.appearanceTheme, aiModel: home.aiConfig.model })
  }
  api.registerDisposable(window.knowbook.onWorkspaceMutated(() => { void refresh() }), 'live capability data subscription')
  await refresh()
  const target = window.__knowbookFullTrustAcceptanceFrameTarget
  const handle = await api.createUnsandboxedFrame({
    src: target, allowedOrigins: [target], allowPopups: true, allowNavigation: true,
    allowDownloads: true, allowPermissions: true, container: root, title: 'Capability remote frame'
  })
  handle.frame.dataset.testid = 'system-capability-frame'
  const url = new URL(target)
  url.searchParams.set('popupName', handle.popupName)
  handle.frame.src = url.href
}
