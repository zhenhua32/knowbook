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
