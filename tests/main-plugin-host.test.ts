import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { PluginHost } from '../src/main/plugin-host.ts'
import type { DocumentDetail } from '../src/shared/contracts.ts'

function createMockDetail(documentId = 'doc-1'): DocumentDetail {
  return {
    id: documentId,
    title: 'Doc 1',
    path: 'Doc 1',
    summary: '',
    updatedAt: '2026-05-02T00:00:00.000Z',
    blocks: [
      {
        id: 'b1',
        type: 'paragraph',
        content: 'First content block',
        checked: false,
        depth: 0,
        parentBlockId: null,
        sortOrder: 0
      }
    ],
    children: [],
    outgoingLinks: [],
    backlinks: []
  }
}

test('PluginHost loads workspace plugin, reacts to events, and runs document actions', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-plugin-host-test-'))
  const workspaceRoot = join(tempRoot, 'workspace-plugins')
  const userDataRoot = join(tempRoot, 'user-plugins')
  mkdirSync(workspaceRoot, { recursive: true })
  mkdirSync(userDataRoot, { recursive: true })

  const sourcePluginDir = join(process.cwd(), 'plugins', 'activity-pulse')
  cpSync(sourcePluginDir, join(workspaceRoot, 'activity-pulse'), { recursive: true })

  const events: Array<{ type: string; title: string; description: string; documentId?: string | null }> = []
  const summaryUpdates: Array<{ documentId: string; summary: string }> = []

  const store = {
    getSettingPublic: () => null,
    saveSetting: () => undefined,
    getDocumentDetail: (documentId: string) => createMockDetail(documentId),
    updateDocumentSummary: (documentId: string, summary: string) => {
      summaryUpdates.push({ documentId, summary })
    },
    recordWorkspaceEvent: (input: { type: string; title: string; description: string; documentId?: string | null }) => {
      events.push(input)
    }
  }

  const host = new PluginHost(store as never, [
    { path: workspaceRoot, source: 'workspace' },
    { path: userDataRoot, source: 'user-data' }
  ])

  try {
    await host.loadAll()

    const snapshot = host.getHomeDataSnapshot()
    const plugin = snapshot.plugins.find((item) => item.id === 'activity-pulse')
    const action = snapshot.documentActions.find((item) => item.pluginId === 'activity-pulse' && item.id === 'summary-from-first-block')

    assert.ok(plugin)
    assert.equal(plugin.status, 'running')
    assert.ok(action)

    await host.handleWorkspaceEvent({
      type: 'document.updated',
      createdAt: '2026-05-02T00:00:00.000Z',
      documentId: 'doc-1',
      documentTitle: 'Doc 1',
      path: 'Doc 1',
      affectedDocumentIds: ['doc-1'],
      pathChanged: false
    })

    const updatedSnapshot = host.getHomeDataSnapshot()
    const card = updatedSnapshot.dashboardCards.find((item) => item.pluginId === 'activity-pulse' && item.id === 'activity-pulse-card')
    assert.ok(card)
    assert.equal(card.title, 'Latest plugin-observed activity')
    assert.equal(card.body.includes('document.updated'), true)

    const result = await host.runDocumentAction({
      pluginId: 'activity-pulse',
      actionId: 'summary-from-first-block',
      documentId: 'doc-1'
    })

    assert.equal(result.refreshDocument, true)
    assert.equal(summaryUpdates.length, 1)
    assert.equal(summaryUpdates[0]?.summary, 'First content block')
    assert.equal(events.some((event) => event.type === 'plugin.action.executed'), true)

    await host.setPluginEnabled('activity-pulse', false)
    const disabled = host.getHomeDataSnapshot().plugins.find((item) => item.id === 'activity-pulse')
    assert.equal(disabled?.status, 'disabled')
  } finally {
    await host.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('PluginHost installs and removes user-data plugins', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-plugin-install-test-'))
  const workspaceRoot = join(tempRoot, 'workspace-plugins')
  const userDataRoot = join(tempRoot, 'user-plugins')
  const sourceRoot = join(tempRoot, 'source-plugin')

  mkdirSync(workspaceRoot, { recursive: true })
  mkdirSync(userDataRoot, { recursive: true })
  mkdirSync(sourceRoot, { recursive: true })

  writeFileSync(
    join(sourceRoot, 'plugin.json'),
    JSON.stringify(
      {
        id: 'quick-note',
        name: 'Quick Note',
        version: '0.1.0',
        entry: 'index.js',
        enabledByDefault: true
      },
      null,
      2
    ),
    'utf8'
  )
  writeFileSync(
    join(sourceRoot, 'index.js'),
    'module.exports.activate = function activate() { return undefined }\n',
    'utf8'
  )

  const events: Array<{ type: string; title: string; description: string; documentId?: string | null }> = []
  const store = {
    getSettingPublic: () => null,
    saveSetting: () => undefined,
    getDocumentDetail: () => createMockDetail(),
    updateDocumentSummary: () => undefined,
    recordWorkspaceEvent: (input: { type: string; title: string; description: string; documentId?: string | null }) => {
      events.push(input)
    }
  }

  const host = new PluginHost(store as never, [
    { path: workspaceRoot, source: 'workspace' },
    { path: userDataRoot, source: 'user-data' }
  ])

  try {
    await host.loadAll()

    const preview = host.previewInstallFromDirectory(sourceRoot)
    assert.equal(preview.manifest.id, 'quick-note')
    assert.equal(preview.existingPlugin, null)

    const installResult = await host.installPluginFromDirectory(sourceRoot)
    assert.equal(installResult.operation, 'installed')
    assert.equal(installResult.plugin.id, 'quick-note')

    const installed = host.getHomeDataSnapshot().plugins.find((item) => item.id === 'quick-note')
    assert.ok(installed)
    assert.equal(installed?.source, 'user-data')

    await host.removePlugin('quick-note')
    const removed = host.getHomeDataSnapshot().plugins.find((item) => item.id === 'quick-note')
    assert.equal(removed, undefined)
    assert.equal(events.some((event) => event.type === 'plugin.installed'), true)
    assert.equal(events.some((event) => event.type === 'plugin.removed'), true)

    const expectedInstallPath = join(userDataRoot, 'quick-note', 'plugin.json')
    const parent = dirname(expectedInstallPath)
    assert.equal(parent.includes('user-plugins'), true)
  } finally {
    await host.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('PluginHost marks invalid plugin entry as error', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-plugin-invalid-test-'))
  const workspaceRoot = join(tempRoot, 'workspace-plugins')
  const userDataRoot = join(tempRoot, 'user-plugins')
  const badPluginRoot = join(workspaceRoot, 'broken-plugin')

  mkdirSync(badPluginRoot, { recursive: true })
  mkdirSync(userDataRoot, { recursive: true })

  writeFileSync(
    join(badPluginRoot, 'plugin.json'),
    JSON.stringify(
      {
        id: 'broken-plugin',
        name: 'Broken Plugin',
        version: '0.1.0',
        entry: 'index.js',
        enabledByDefault: true
      },
      null,
      2
    ),
    'utf8'
  )
  writeFileSync(join(badPluginRoot, 'index.js'), 'module.exports = {}\n', 'utf8')

  const store = {
    getSettingPublic: () => null,
    saveSetting: () => undefined,
    getDocumentDetail: () => createMockDetail(),
    updateDocumentSummary: () => undefined,
    recordWorkspaceEvent: () => undefined
  }

  const host = new PluginHost(store as never, [
    { path: workspaceRoot, source: 'workspace' },
    { path: userDataRoot, source: 'user-data' }
  ])

  try {
    await host.loadAll()
    const plugin = host.getHomeDataSnapshot().plugins.find((item) => item.id === 'broken-plugin')
    assert.ok(plugin)
    assert.equal(plugin.status, 'error')
    assert.equal((plugin.error ?? '').includes('activate(api)'), true)
  } finally {
    await host.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('PluginHost rejects install when plugin id conflicts with workspace plugin', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-plugin-conflict-test-'))
  const workspaceRoot = join(tempRoot, 'workspace-plugins')
  const userDataRoot = join(tempRoot, 'user-plugins')
  const sourceRoot = join(tempRoot, 'source-plugin')

  mkdirSync(workspaceRoot, { recursive: true })
  mkdirSync(userDataRoot, { recursive: true })
  mkdirSync(sourceRoot, { recursive: true })

  const activitySource = join(process.cwd(), 'plugins', 'activity-pulse')
  cpSync(activitySource, join(workspaceRoot, 'activity-pulse'), { recursive: true })

  writeFileSync(
    join(sourceRoot, 'plugin.json'),
    JSON.stringify(
      {
        id: 'activity-pulse',
        name: 'Activity Pulse Local',
        version: '0.1.1',
        entry: 'index.js',
        enabledByDefault: true
      },
      null,
      2
    ),
    'utf8'
  )
  writeFileSync(
    join(sourceRoot, 'index.js'),
    'module.exports.activate = function activate() { return undefined }\n',
    'utf8'
  )

  const store = {
    getSettingPublic: () => null,
    saveSetting: () => undefined,
    getDocumentDetail: () => createMockDetail(),
    updateDocumentSummary: () => undefined,
    recordWorkspaceEvent: () => undefined
  }

  const host = new PluginHost(store as never, [
    { path: workspaceRoot, source: 'workspace' },
    { path: userDataRoot, source: 'user-data' }
  ])

  try {
    await host.loadAll()
    await assert.rejects(
      () => host.installPluginFromDirectory(sourceRoot),
      /already provided by the workspace plugin/
    )
  } finally {
    await host.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('PluginHost records failed document action when plugin handler throws', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-plugin-action-fail-test-'))
  const workspaceRoot = join(tempRoot, 'workspace-plugins')
  const userDataRoot = join(tempRoot, 'user-plugins')
  const failingPluginRoot = join(workspaceRoot, 'failing-plugin')

  mkdirSync(failingPluginRoot, { recursive: true })
  mkdirSync(userDataRoot, { recursive: true })

  writeFileSync(
    join(failingPluginRoot, 'plugin.json'),
    JSON.stringify(
      {
        id: 'failing-plugin',
        name: 'Failing Plugin',
        version: '0.1.0',
        entry: 'index.js',
        enabledByDefault: true
      },
      null,
      2
    ),
    'utf8'
  )
  writeFileSync(
    join(failingPluginRoot, 'index.js'),
    [
      'module.exports.activate = function activate(api) {',
      '  api.contributeDocumentAction({ id: "explode", label: "Explode" }, function runAction() {',
      '    throw new Error("boom-action")',
      '  })',
      '}'
    ].join('\n'),
    'utf8'
  )

  const events: Array<{ type: string; title: string; description: string; documentId?: string | null }> = []
  const store = {
    getSettingPublic: () => null,
    saveSetting: () => undefined,
    getDocumentDetail: () => createMockDetail(),
    updateDocumentSummary: () => undefined,
    recordWorkspaceEvent: (input: { type: string; title: string; description: string; documentId?: string | null }) => {
      events.push(input)
    }
  }

  const host = new PluginHost(store as never, [
    { path: workspaceRoot, source: 'workspace' },
    { path: userDataRoot, source: 'user-data' }
  ])

  try {
    await host.loadAll()
    await assert.rejects(
      () => host.runDocumentAction({ pluginId: 'failing-plugin', actionId: 'explode', documentId: 'doc-1' }),
      /boom-action/
    )

    assert.equal(events.some((event) => event.type === 'plugin.action.failed' && event.title.includes('Explode')), true)
  } finally {
    await host.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('PluginHost refuses removing workspace-scoped plugins', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-plugin-remove-workspace-test-'))
  const workspaceRoot = join(tempRoot, 'workspace-plugins')
  const userDataRoot = join(tempRoot, 'user-plugins')
  mkdirSync(workspaceRoot, { recursive: true })
  mkdirSync(userDataRoot, { recursive: true })

  const sourcePluginDir = join(process.cwd(), 'plugins', 'activity-pulse')
  cpSync(sourcePluginDir, join(workspaceRoot, 'activity-pulse'), { recursive: true })

  const store = {
    getSettingPublic: () => null,
    saveSetting: () => undefined,
    getDocumentDetail: () => createMockDetail(),
    updateDocumentSummary: () => undefined,
    recordWorkspaceEvent: () => undefined
  }

  const host = new PluginHost(store as never, [
    { path: workspaceRoot, source: 'workspace' },
    { path: userDataRoot, source: 'user-data' }
  ])

  try {
    await host.loadAll()
    await assert.rejects(() => host.removePlugin('activity-pulse'), /Only plugins installed into the user-data root/)
  } finally {
    await host.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('PluginHost install from target directory triggers reload operation', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-plugin-reload-op-test-'))
  const workspaceRoot = join(tempRoot, 'workspace-plugins')
  const userDataRoot = join(tempRoot, 'user-plugins')
  const installedRoot = join(userDataRoot, 'quick-note')

  mkdirSync(workspaceRoot, { recursive: true })
  mkdirSync(installedRoot, { recursive: true })

  writeFileSync(
    join(installedRoot, 'plugin.json'),
    JSON.stringify(
      {
        id: 'quick-note',
        name: 'Quick Note',
        version: '0.1.0',
        entry: 'index.js',
        enabledByDefault: true
      },
      null,
      2
    ),
    'utf8'
  )
  writeFileSync(
    join(installedRoot, 'index.js'),
    'module.exports.activate = function activate() { return undefined }\n',
    'utf8'
  )

  const store = {
    getSettingPublic: () => null,
    saveSetting: () => undefined,
    getDocumentDetail: () => createMockDetail(),
    updateDocumentSummary: () => undefined,
    recordWorkspaceEvent: () => undefined
  }

  const host = new PluginHost(store as never, [
    { path: workspaceRoot, source: 'workspace' },
    { path: userDataRoot, source: 'user-data' }
  ])

  try {
    await host.loadAll()
    const result = await host.installPluginFromDirectory(installedRoot)
    assert.equal(result.operation, 'reloaded')
    assert.equal(result.plugin.id, 'quick-note')
    assert.equal(result.previousVersion, '0.1.0')
  } finally {
    await host.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('PluginHost supports replacing existing user-data plugin when replaceExisting is true', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-plugin-replace-test-'))
  const workspaceRoot = join(tempRoot, 'workspace-plugins')
  const userDataRoot = join(tempRoot, 'user-plugins')
  const installedRoot = join(userDataRoot, 'quick-note')
  const sourceRoot = join(tempRoot, 'source-plugin')

  mkdirSync(workspaceRoot, { recursive: true })
  mkdirSync(installedRoot, { recursive: true })
  mkdirSync(sourceRoot, { recursive: true })

  writeFileSync(
    join(installedRoot, 'plugin.json'),
    JSON.stringify(
      {
        id: 'quick-note',
        name: 'Quick Note',
        version: '0.1.0',
        entry: 'index.js',
        enabledByDefault: true
      },
      null,
      2
    ),
    'utf8'
  )
  writeFileSync(
    join(installedRoot, 'index.js'),
    'module.exports.activate = function activate() { return undefined }\n',
    'utf8'
  )

  writeFileSync(
    join(sourceRoot, 'plugin.json'),
    JSON.stringify(
      {
        id: 'quick-note',
        name: 'Quick Note',
        version: '0.2.0',
        entry: 'index.js',
        enabledByDefault: true
      },
      null,
      2
    ),
    'utf8'
  )
  writeFileSync(
    join(sourceRoot, 'index.js'),
    'module.exports.activate = function activate() { return undefined }\n',
    'utf8'
  )

  const store = {
    getSettingPublic: () => null,
    saveSetting: () => undefined,
    getDocumentDetail: () => createMockDetail(),
    updateDocumentSummary: () => undefined,
    recordWorkspaceEvent: () => undefined
  }

  const host = new PluginHost(store as never, [
    { path: workspaceRoot, source: 'workspace' },
    { path: userDataRoot, source: 'user-data' }
  ])

  try {
    await host.loadAll()

    const preview = host.previewInstallFromDirectory(sourceRoot)
    assert.equal(preview.sourceIsTarget, false)
    assert.equal(preview.canReplace, true)
    assert.equal(preview.existingPlugin?.version, '0.1.0')

    await assert.rejects(() => host.installPluginFromDirectory(sourceRoot), /already installed/)

    const updated = await host.installPluginFromDirectory(sourceRoot, { replaceExisting: true })
    assert.equal(updated.operation, 'updated')
    assert.equal(updated.previousVersion, '0.1.0')
    assert.equal(updated.plugin.version, '0.2.0')
  } finally {
    await host.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('PluginHost reloadPlugin reports error when manifest is missing', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-plugin-reload-missing-manifest-test-'))
  const workspaceRoot = join(tempRoot, 'workspace-plugins')
  const userDataRoot = join(tempRoot, 'user-plugins')
  const pluginRoot = join(workspaceRoot, 'broken-reload')

  mkdirSync(pluginRoot, { recursive: true })
  mkdirSync(userDataRoot, { recursive: true })

  writeFileSync(
    join(pluginRoot, 'plugin.json'),
    JSON.stringify(
      {
        id: 'broken-reload',
        name: 'Broken Reload',
        version: '0.1.0',
        entry: 'index.js',
        enabledByDefault: true
      },
      null,
      2
    ),
    'utf8'
  )
  writeFileSync(join(pluginRoot, 'index.js'), 'module.exports.activate = function activate() { return undefined }\n', 'utf8')

  const events: Array<{ type: string; title: string; description: string }> = []
  const store = {
    getSettingPublic: () => null,
    saveSetting: () => undefined,
    getDocumentDetail: () => createMockDetail(),
    updateDocumentSummary: () => undefined,
    recordWorkspaceEvent: (input: { type: string; title: string; description: string }) => {
      events.push(input)
    }
  }

  const host = new PluginHost(store as never, [
    { path: workspaceRoot, source: 'workspace' },
    { path: userDataRoot, source: 'user-data' }
  ])

  try {
    await host.loadAll()
    rmSync(join(pluginRoot, 'plugin.json'), { force: true })

    await host.reloadPlugin('broken-reload')

    const plugin = host.getHomeDataSnapshot().plugins.find((item) => item.id === 'broken-reload')
    assert.ok(plugin)
    assert.equal(plugin.status, 'error')
    assert.equal((plugin.error ?? '').includes('Missing manifest file'), true)
    assert.equal(events.some((event) => event.type === 'plugin.reloaded' && event.title.includes('reload failed')), true)
  } finally {
    await host.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('PluginHost setPluginEnabled persists setting and can re-enable plugin', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-plugin-enable-toggle-test-'))
  const workspaceRoot = join(tempRoot, 'workspace-plugins')
  const userDataRoot = join(tempRoot, 'user-plugins')
  mkdirSync(workspaceRoot, { recursive: true })
  mkdirSync(userDataRoot, { recursive: true })

  const sourcePluginDir = join(process.cwd(), 'plugins', 'activity-pulse')
  cpSync(sourcePluginDir, join(workspaceRoot, 'activity-pulse'), { recursive: true })

  const settings: Array<{ key: string; value: string }> = []
  const store = {
    getSettingPublic: () => null,
    saveSetting: (key: string, value: string) => {
      settings.push({ key, value })
    },
    getDocumentDetail: () => createMockDetail(),
    updateDocumentSummary: () => undefined,
    recordWorkspaceEvent: () => undefined
  }

  const host = new PluginHost(store as never, [
    { path: workspaceRoot, source: 'workspace' },
    { path: userDataRoot, source: 'user-data' }
  ])

  try {
    await host.loadAll()
    await host.setPluginEnabled('activity-pulse', false)
    await host.setPluginEnabled('activity-pulse', true)

    assert.equal(settings.some((item) => item.key === 'plugin.enabled.activity-pulse' && item.value === 'false'), true)
    assert.equal(settings.some((item) => item.key === 'plugin.enabled.activity-pulse' && item.value === 'true'), true)

    const plugin = host.getHomeDataSnapshot().plugins.find((item) => item.id === 'activity-pulse')
    assert.equal(plugin?.status, 'running')
  } finally {
    await host.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('PluginHost reloadPlugin reports error when manifest id changes', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-plugin-reload-id-change-test-'))
  const workspaceRoot = join(tempRoot, 'workspace-plugins')
  const userDataRoot = join(tempRoot, 'user-plugins')
  const pluginRoot = join(workspaceRoot, 'id-change')
  mkdirSync(pluginRoot, { recursive: true })
  mkdirSync(userDataRoot, { recursive: true })

  writeFileSync(
    join(pluginRoot, 'plugin.json'),
    JSON.stringify({ id: 'id-change', name: 'ID Change', version: '0.1.0', entry: 'index.js', enabledByDefault: true }, null, 2),
    'utf8'
  )
  writeFileSync(join(pluginRoot, 'index.js'), 'module.exports.activate = function activate() { return undefined }\n', 'utf8')

  const store = {
    getSettingPublic: () => null,
    saveSetting: () => undefined,
    getDocumentDetail: () => createMockDetail(),
    updateDocumentSummary: () => undefined,
    recordWorkspaceEvent: () => undefined
  }

  const host = new PluginHost(store as never, [
    { path: workspaceRoot, source: 'workspace' },
    { path: userDataRoot, source: 'user-data' }
  ])

  try {
    await host.loadAll()
    writeFileSync(
      join(pluginRoot, 'plugin.json'),
      JSON.stringify({ id: 'id-change-new', name: 'ID Change', version: '0.2.0', entry: 'index.js', enabledByDefault: true }, null, 2),
      'utf8'
    )

    await host.reloadPlugin('id-change')
    const plugin = host.getHomeDataSnapshot().plugins.find((item) => item.id === 'id-change')
    assert.ok(plugin)
    assert.equal(plugin.status, 'error')
    assert.equal((plugin.error ?? '').includes('manifest id changed'), true)
  } finally {
    await host.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('PluginHost normalizes document action return values', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-plugin-action-normalize-test-'))
  const workspaceRoot = join(tempRoot, 'workspace-plugins')
  const userDataRoot = join(tempRoot, 'user-plugins')
  const pluginRoot = join(workspaceRoot, 'normalize-action')
  mkdirSync(pluginRoot, { recursive: true })
  mkdirSync(userDataRoot, { recursive: true })

  writeFileSync(
    join(pluginRoot, 'plugin.json'),
    JSON.stringify({ id: 'normalize-action', name: 'Normalize Action', version: '0.1.0', entry: 'index.js', enabledByDefault: true }, null, 2),
    'utf8'
  )
  writeFileSync(
    join(pluginRoot, 'index.js'),
    [
      'module.exports.activate = function activate(api) {',
      '  api.contributeDocumentAction({ id: "void-action", label: "Void Action" }, function runVoid() {})',
      '  api.contributeDocumentAction({ id: "string-action", label: "String Action" }, function runString() { return "done" })',
      '}'
    ].join('\n'),
    'utf8'
  )

  const store = {
    getSettingPublic: () => null,
    saveSetting: () => undefined,
    getDocumentDetail: () => createMockDetail(),
    updateDocumentSummary: () => undefined,
    recordWorkspaceEvent: () => undefined
  }

  const host = new PluginHost(store as never, [
    { path: workspaceRoot, source: 'workspace' },
    { path: userDataRoot, source: 'user-data' }
  ])

  try {
    await host.loadAll()
    const voidResult = await host.runDocumentAction({ pluginId: 'normalize-action', actionId: 'void-action', documentId: 'doc-1' })
    const stringResult = await host.runDocumentAction({ pluginId: 'normalize-action', actionId: 'string-action', documentId: 'doc-1' })

    assert.equal(voidResult.message, 'Void Action completed.')
    assert.equal(voidResult.refreshDocument, false)
    assert.equal(stringResult.message, 'done')
    assert.equal(stringResult.refreshDocument, false)
  } finally {
    await host.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('PluginHost marks plugin as error when workspace event handler throws', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-plugin-event-error-test-'))
  const workspaceRoot = join(tempRoot, 'workspace-plugins')
  const userDataRoot = join(tempRoot, 'user-plugins')
  const pluginRoot = join(workspaceRoot, 'event-error')
  mkdirSync(pluginRoot, { recursive: true })
  mkdirSync(userDataRoot, { recursive: true })

  writeFileSync(
    join(pluginRoot, 'plugin.json'),
    JSON.stringify({ id: 'event-error', name: 'Event Error', version: '0.1.0', entry: 'index.js', enabledByDefault: true }, null, 2),
    'utf8'
  )
  writeFileSync(
    join(pluginRoot, 'index.js'),
    [
      'module.exports.activate = function activate(api) {',
      '  api.onWorkspaceEvent("document.updated", function onEvent() {',
      '    throw new Error("event-boom")',
      '  })',
      '}'
    ].join('\n'),
    'utf8'
  )

  const store = {
    getSettingPublic: () => null,
    saveSetting: () => undefined,
    getDocumentDetail: () => createMockDetail(),
    updateDocumentSummary: () => undefined,
    recordWorkspaceEvent: () => undefined
  }

  const host = new PluginHost(store as never, [
    { path: workspaceRoot, source: 'workspace' },
    { path: userDataRoot, source: 'user-data' }
  ])

  try {
    await host.loadAll()
    await host.handleWorkspaceEvent({
      type: 'document.updated',
      createdAt: '2026-05-02T00:00:00.000Z',
      documentId: 'doc-1',
      documentTitle: 'Doc 1',
      path: 'Doc 1',
      affectedDocumentIds: ['doc-1'],
      pathChanged: false
    })

    const plugin = host.getHomeDataSnapshot().plugins.find((item) => item.id === 'event-error')
    assert.ok(plugin)
    assert.equal(plugin.status, 'error')
    assert.equal((plugin.error ?? '').length > 0, true)
  } finally {
    await host.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
