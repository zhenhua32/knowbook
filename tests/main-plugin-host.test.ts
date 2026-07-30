import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

test('PluginHost persists plugin settings and exposes updated values to plugin actions', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-plugin-settings-test-'))
  const workspaceRoot = join(tempRoot, 'workspace-plugins')
  const userDataRoot = join(tempRoot, 'user-plugins')
  const pluginRoot = join(workspaceRoot, 'configurable-plugin')

  mkdirSync(pluginRoot, { recursive: true })
  mkdirSync(userDataRoot, { recursive: true })

  writeFileSync(
    join(pluginRoot, 'plugin.json'),
    JSON.stringify(
      {
        id: 'configurable-plugin',
        name: 'Configurable Plugin',
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
    join(pluginRoot, 'index.js'),
    [
      'module.exports.activate = function activate(api) {',
      '  const prefix = api.contributeSetting({',
      '    id: "summary-prefix",',
      '    label: "Summary prefix",',
      '    type: "text",',
      '    defaultValue: ""',
      '  })',
      '  api.contributeDocumentAction({ id: "prefix-summary", label: "Prefix summary" }, function runAction(context) {',
      '    const firstContentBlock = context.document.blocks.find(function findBlock(block) {',
      '      return typeof block.content === "string" && block.content.trim().length > 0',
      '    })',
      '    const nextSummary = prefix.getValue() + firstContentBlock.content.trim()',
      '    api.documents.updateSummary(context.document.id, nextSummary)',
      '    return { message: nextSummary, refreshDocument: true }',
      '  })',
      '}'
    ].join('\n'),
    'utf8'
  )

  const settings = new Map<string, string>()
  const summaryUpdates: Array<{ documentId: string; summary: string }> = []
  const mutatedDocumentIds: string[] = []
  const store = {
    getSettingPublic: (key: string) => settings.get(key) ?? null,
    saveSetting: (key: string, value: string) => {
      settings.set(key, value)
    },
    getDocumentDetail: (documentId: string) => createMockDetail(documentId),
    updateDocumentSummary: (documentId: string, summary: string) => {
      summaryUpdates.push({ documentId, summary })
    },
    recordWorkspaceEvent: () => undefined
  }

  const host = new PluginHost(store as never, [
    { path: workspaceRoot, source: 'workspace' },
    { path: userDataRoot, source: 'user-data' }
  ], '0.1.2', (documentId) => mutatedDocumentIds.push(documentId))

  try {
    await host.loadAll()

    const initialPlugin = host.getHomeDataSnapshot().plugins.find((item) => item.id === 'configurable-plugin')
    assert.ok(initialPlugin)
    assert.equal(initialPlugin?.settings.length, 1)
    assert.equal(initialPlugin?.settings[0]?.value, '')

    await host.updatePluginSetting('configurable-plugin', 'summary-prefix', 'Configured: ')

    const updatedPlugin = host.getHomeDataSnapshot().plugins.find((item) => item.id === 'configurable-plugin')
    assert.equal(updatedPlugin?.settings[0]?.value, 'Configured: ')

    const result = await host.runDocumentAction({
      pluginId: 'configurable-plugin',
      actionId: 'prefix-summary',
      documentId: 'doc-1'
    })

    assert.equal(result.refreshDocument, true)
    assert.equal(summaryUpdates[0]?.summary, 'Configured: First content block')
    assert.deepEqual(mutatedDocumentIds, ['doc-1'])
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

    const preview = await host.previewInstallFromDirectory(sourceRoot)
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
  const brokenSourceRoot = join(tempRoot, 'broken-source-plugin')

  mkdirSync(workspaceRoot, { recursive: true })
  mkdirSync(installedRoot, { recursive: true })
  mkdirSync(sourceRoot, { recursive: true })
  mkdirSync(brokenSourceRoot, { recursive: true })

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
  writeFileSync(
    join(brokenSourceRoot, 'plugin.json'),
    JSON.stringify(
      {
        id: 'quick-note',
        name: 'Quick Note',
        version: '0.3.0',
        entry: 'missing.js',
        enabledByDefault: true
      },
      null,
      2
    ),
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

    const preview = await host.previewInstallFromDirectory(sourceRoot)
    assert.equal(preview.sourceIsTarget, false)
    assert.equal(preview.canReplace, true)
    assert.equal(preview.existingPlugin?.version, '0.1.0')

    await assert.rejects(() => host.installPluginFromDirectory(sourceRoot), /already installed/)

    const updated = await host.installPluginFromDirectory(sourceRoot, { replaceExisting: true })
    assert.equal(updated.operation, 'updated')
    assert.equal(updated.previousVersion, '0.1.0')
    assert.equal(updated.plugin.version, '0.2.0')

    await assert.rejects(
      () => host.installPluginFromDirectory(brokenSourceRoot, { replaceExisting: true }),
      /entry is missing/
    )
    const preservedPlugin = host.getHomeDataSnapshot().plugins.find((plugin) => plugin.id === 'quick-note')
    assert.ok(preservedPlugin)
    assert.equal(preservedPlugin.version, '0.2.0')
    assert.equal(preservedPlugin.status, 'running')
  } finally {
    await host.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('PluginHost rejects plugin packages that exceed bounded directory limits', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-plugin-package-limits-test-'))
  const workspaceRoot = join(tempRoot, 'workspace-plugins')
  const userDataRoot = join(tempRoot, 'user-plugins')
  const sourceRoot = join(tempRoot, 'source-plugin')
  mkdirSync(workspaceRoot, { recursive: true })
  mkdirSync(userDataRoot, { recursive: true })
  mkdirSync(sourceRoot, { recursive: true })
  writeFileSync(join(sourceRoot, 'plugin.json'), JSON.stringify({
    id: 'bounded-plugin',
    name: 'Bounded Plugin',
    version: '1.0.0'
  }))
  writeFileSync(
    join(sourceRoot, 'index.js'),
    'module.exports.activate = function activate() { return undefined }\n',
    'utf8'
  )

  const host = new PluginHost(
    {} as never,
    [
      { path: workspaceRoot, source: 'workspace' },
      { path: userDataRoot, source: 'user-data' }
    ],
    '1.0.0',
    null,
    {
      packageLimits: {
        maxEntries: 1
      }
    }
  )

  try {
    await assert.rejects(
      host.previewInstallFromDirectory(sourceRoot),
      /entry limit/
    )
    await assert.rejects(
      host.installPluginFromDirectory(sourceRoot),
      /entry limit/
    )
    assert.equal(existsSync(join(userDataRoot, 'bounded-plugin')), false)
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

test('PluginHost rejects unsafe manifest paths and incompatible KnowBook versions', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-plugin-manifest-security-test-'))
  const workspaceRoot = join(tempRoot, 'workspace-plugins')
  const userDataRoot = join(tempRoot, 'user-plugins')
  const unsafeRoot = join(workspaceRoot, 'unsafe-entry')
  const incompatibleRoot = join(workspaceRoot, 'future-plugin')
  mkdirSync(unsafeRoot, { recursive: true })
  mkdirSync(incompatibleRoot, { recursive: true })
  mkdirSync(userDataRoot, { recursive: true })

  writeFileSync(join(unsafeRoot, 'plugin.json'), JSON.stringify({
    id: 'unsafe-entry',
    name: 'Unsafe Entry',
    version: '1.0.0',
    entry: '../outside.js'
  }), 'utf8')
  writeFileSync(join(incompatibleRoot, 'plugin.json'), JSON.stringify({
    id: 'future-plugin',
    name: 'Future Plugin',
    version: '1.0.0',
    entry: 'index.js',
    engines: { knowbook: '>=9.0.0' }
  }), 'utf8')
  writeFileSync(join(incompatibleRoot, 'index.js'), 'module.exports.activate = function () {}\n', 'utf8')

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
  ], '0.1.2')

  try {
    await host.loadAll()
    const plugins = host.getHomeDataSnapshot().plugins
    assert.equal(plugins.some((plugin) => plugin.id === 'unsafe-entry'), false)
    const incompatible = plugins.find((plugin) => plugin.id === 'future-plugin')
    assert.ok(incompatible)
    assert.equal(incompatible.status, 'error')
    assert.equal((incompatible.error ?? '').includes('>=9.0.0'), true)
  } finally {
    await host.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('PluginHost stops synchronous activation that exceeds the execution limit', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-plugin-timeout-test-'))
  const workspaceRoot = join(tempRoot, 'workspace-plugins')
  const pluginRoot = join(workspaceRoot, 'blocking-plugin')
  mkdirSync(pluginRoot, { recursive: true })

  writeFileSync(join(pluginRoot, 'plugin.json'), JSON.stringify({
    id: 'blocking-plugin',
    name: 'Blocking Plugin',
    version: '1.0.0',
    entry: 'index.js'
  }), 'utf8')
  writeFileSync(
    join(pluginRoot, 'index.js'),
    'module.exports.activate = function activate() { while (true) {} }\n',
    'utf8'
  )

  const store = {
    getSettingPublic: () => null,
    saveSetting: () => undefined,
    getDocumentDetail: () => createMockDetail(),
    updateDocumentSummary: () => undefined,
    recordWorkspaceEvent: () => undefined
  }
  const host = new PluginHost(store as never, [{ path: workspaceRoot, source: 'workspace' }])

  try {
    await host.loadAll()
    const plugin = host.getHomeDataSnapshot().plugins.find((item) => item.id === 'blocking-plugin')
    assert.ok(plugin)
    assert.equal(plugin.status, 'error')
    assert.equal((plugin.error ?? '').toLowerCase().includes('timed out'), true)
  } finally {
    await host.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('PluginHost rejects asynchronous callbacks before their continuation can escape the VM limit', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-plugin-async-timeout-test-'))
  const workspaceRoot = join(tempRoot, 'workspace-plugins')
  const pluginRoot = join(workspaceRoot, 'async-blocking-plugin')
  mkdirSync(pluginRoot, { recursive: true })

  writeFileSync(join(pluginRoot, 'plugin.json'), JSON.stringify({
    id: 'async-blocking-plugin',
    name: 'Async Blocking Plugin',
    version: '1.0.0',
    entry: 'index.js'
  }), 'utf8')
  writeFileSync(
    join(pluginRoot, 'index.js'),
    `module.exports.activate = async function activate() {
      await new Promise((resolve) => setTimeout(resolve, 5))
      while (true) {}
    }\n`,
    'utf8'
  )

  const store = {
    getSettingPublic: () => null,
    saveSetting: () => undefined,
    getDocumentDetail: () => createMockDetail(),
    updateDocumentSummary: () => undefined,
    recordWorkspaceEvent: () => undefined
  }
  const host = new PluginHost(store as never, [{ path: workspaceRoot, source: 'workspace' }])

  try {
    await host.loadAll()
    const plugin = host.getHomeDataSnapshot().plugins.find((item) => item.id === 'async-blocking-plugin')
    assert.ok(plugin)
    assert.equal(plugin.status, 'error')
    assert.equal((plugin.error ?? '').includes('Asynchronous plugin callbacks are not supported'), true)
  } finally {
    await host.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('PluginHost can recover an errored plugin after its entry is fixed and reloaded', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-plugin-recovery-test-'))
  const workspaceRoot = join(tempRoot, 'workspace-plugins')
  const pluginRoot = join(workspaceRoot, 'recoverable-plugin')
  mkdirSync(pluginRoot, { recursive: true })

  writeFileSync(join(pluginRoot, 'plugin.json'), JSON.stringify({
    id: 'recoverable-plugin',
    name: 'Recoverable Plugin',
    version: '1.0.0',
    entry: 'index.js'
  }), 'utf8')
  writeFileSync(
    join(pluginRoot, 'index.js'),
    'module.exports.activate = function activate() { throw new Error("broken activation") }\n',
    'utf8'
  )

  const store = {
    getSettingPublic: () => null,
    saveSetting: () => undefined,
    getDocumentDetail: () => createMockDetail(),
    updateDocumentSummary: () => undefined,
    recordWorkspaceEvent: () => undefined
  }
  const host = new PluginHost(store as never, [{ path: workspaceRoot, source: 'workspace' }])

  try {
    await host.loadAll()
    const failed = host.getHomeDataSnapshot().plugins.find((plugin) => plugin.id === 'recoverable-plugin')
    assert.ok(failed)
    assert.equal(failed.status, 'error')

    writeFileSync(
      join(pluginRoot, 'index.js'),
      `module.exports.activate = function activate(api) {
        api.contributeDashboardCard({ id: 'recovered', title: 'Recovered', body: 'running' })
      }\n`,
      'utf8'
    )
    await host.reloadPlugin('recoverable-plugin')

    const snapshot = host.getHomeDataSnapshot()
    const recovered = snapshot.plugins.find((plugin) => plugin.id === 'recoverable-plugin')
    assert.ok(recovered)
    assert.equal(recovered.status, 'running')
    assert.equal(snapshot.dashboardCards.some((card) => card.id === 'recovered'), true)
  } finally {
    await host.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('PluginHost keeps host objects out of the plugin VM and preserves safe timers', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-plugin-sandbox-test-'))
  const workspaceRoot = join(tempRoot, 'workspace-plugins')
  const pluginRoot = join(workspaceRoot, 'sandbox-probe')
  mkdirSync(pluginRoot, { recursive: true })

  writeFileSync(join(pluginRoot, 'plugin.json'), JSON.stringify({
    id: 'sandbox-probe',
    name: 'Sandbox Probe',
    version: '1.0.0',
    entry: 'index.js'
  }), 'utf8')
  writeFileSync(
    join(pluginRoot, 'index.js'),
    `module.exports.activate = function activate(api) {
      let escaped = false
      const tryEscape = (probe) => {
        try {
          probe()
          escaped = true
        } catch {}
      }

      tryEscape(() => module.constructor.constructor('return process')())
      tryEscape(() => globalThis.constructor.constructor('return process')())
      tryEscape(() => console.log.constructor('return process')())
      tryEscape(() => setTimeout.constructor('return process')())
      tryEscape(() => api.log.constructor('return process')())

      const detail = api.workspace.getDocumentDetail('doc-1')
      tryEscape(() => detail.constructor.constructor('return process')())

      try {
        api.contributeDashboardCard({ id: '', title: 'Invalid', body: 'Invalid' })
      } catch (error) {
        tryEscape(() => error.constructor.constructor('return process')())
      }

      api.contributeDocumentAction(
        { id: 'inspect-argument', label: 'Inspect argument' },
        ({ document }) => {
          try {
            document.constructor.constructor('return process')()
            return 'escaped'
          } catch {
            return 'blocked'
          }
        }
      )

      const card = api.contributeDashboardCard({
        id: 'sandbox-status',
        title: 'Sandbox status',
        body: escaped ? 'escaped' : 'blocked'
      })
      setTimeout(() => {
        card.update({ body: (escaped ? 'escaped' : 'blocked') + '-timer' })
      }, 5)
    }
    `,
    'utf8'
  )

  const store = {
    getSettingPublic: () => null,
    saveSetting: () => undefined,
    getDocumentDetail: (documentId: string) => createMockDetail(documentId),
    updateDocumentSummary: () => undefined,
    recordWorkspaceEvent: () => undefined
  }
  const host = new PluginHost(store as never, [{ path: workspaceRoot, source: 'workspace' }])

  try {
    await host.loadAll()
    await new Promise((resolve) => setTimeout(resolve, 20))
    const snapshot = host.getHomeDataSnapshot()
    const plugin = snapshot.plugins.find((item) => item.id === 'sandbox-probe')
    const card = snapshot.dashboardCards.find((item) => item.id === 'sandbox-status')
    assert.ok(plugin)
    assert.ok(card)
    assert.equal(plugin.status, 'running')
    assert.equal(card.body, 'blocked-timer')

    const result = await host.runDocumentAction({
      pluginId: 'sandbox-probe',
      actionId: 'inspect-argument',
      documentId: 'doc-1'
    })
    assert.equal(result.message, 'blocked')
  } finally {
    await host.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('PluginHost rejects oversized entries and clears partial contributions when limits are exceeded', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-plugin-resource-limit-test-'))
  const workspaceRoot = join(tempRoot, 'workspace-plugins')
  const oversizedRoot = join(workspaceRoot, 'oversized-plugin')
  const fanoutRoot = join(workspaceRoot, 'fanout-plugin')
  mkdirSync(oversizedRoot, { recursive: true })
  mkdirSync(fanoutRoot, { recursive: true })

  writeFileSync(join(oversizedRoot, 'plugin.json'), JSON.stringify({
    id: 'oversized-plugin',
    name: 'Oversized plugin',
    version: '1.0.0',
    entry: 'index.js'
  }), 'utf8')
  writeFileSync(join(oversizedRoot, 'index.js'), ' '.repeat(2_000_001), 'utf8')
  writeFileSync(join(fanoutRoot, 'plugin.json'), JSON.stringify({
    id: 'fanout-plugin',
    name: 'Fanout plugin',
    version: '1.0.0',
    entry: 'index.js'
  }), 'utf8')
  writeFileSync(
    join(fanoutRoot, 'index.js'),
    `
      module.exports.activate = function (api) {
        for (let index = 0; index < 101; index += 1) {
          api.contributeDashboardCard({
            id: 'card-' + index,
            title: 'Card ' + index,
            body: 'Body'
          })
        }
      }
    `,
    'utf8'
  )

  const store = {
    getSettingPublic: () => null,
    saveSetting: () => undefined,
    getDocumentDetail: (documentId: string) => createMockDetail(documentId),
    updateDocumentSummary: () => undefined,
    recordWorkspaceEvent: () => undefined
  }
  const host = new PluginHost(store as never, [{ path: workspaceRoot, source: 'workspace' }])

  try {
    await host.loadAll()
    const snapshot = host.getHomeDataSnapshot()
    const oversized = snapshot.plugins.find((plugin) => plugin.id === 'oversized-plugin')
    const fanout = snapshot.plugins.find((plugin) => plugin.id === 'fanout-plugin')

    assert.equal(oversized?.status, 'error')
    assert.match(oversized?.error ?? '', /source limit/)
    assert.equal(fanout?.status, 'error')
    assert.match(fanout?.error ?? '', /dashboard card limit exceeded/)
    assert.equal(snapshot.dashboardCards.some((card) => card.pluginId === 'fanout-plugin'), false)
  } finally {
    await host.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
