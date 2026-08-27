import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PLUGIN_UI_SLOT_CATALOG,
  validatePluginUiContribution,
  validateRunPluginUiActionInput
} from '../src/shared/plugin-ui.ts'
import { materializePluginUiContribution } from '../src/main/plugin-platform/ui-materializer.ts'
import type { PluginActiveOwner, PluginRevisionPackage } from '../src/shared/plugin-platform.ts'

const owner: PluginActiveOwner = {
  pluginId: 'test-plugin',
  revisionId: 'revision-1',
  runId: 'run-1',
  grantSetId: 'grant-1',
  scope: { kind: 'workspace', workspaceId: 'workspace-1' },
  epoch: 3
}

test('Plugin UI publishes the complete versioned ADR slot catalog', () => {
  assert.deepEqual(Object.keys(PLUGIN_UI_SLOT_CATALOG), [
    'navigation.primary',
    'workspace.dashboard',
    'documents.header.actions',
    'documents.editor.toolbar',
    'documents.block.context-menu',
    'documents.aux-panel',
    'database.view.tabs',
    'database.record.actions',
    'settings.sections',
    'assistant.tools',
    'assistant.message.cards'
  ])
  for (const descriptor of Object.values(PLUGIN_UI_SLOT_CATALOG)) {
    assert.equal(descriptor.version, 1)
    assert.equal(descriptor.accessibility, 'keyboard-and-labelled-controls')
    assert.equal(descriptor.theme, 'knowbook-tokens')
    assert.ok(descriptor.maxContributions > 0)
    assert.ok(descriptor.renderBudget > 0)
  }
})

test('ViewSpec rejects unknown nodes, properties, and non-JSON action values', () => {
  assert.throws(() => validatePluginUiContribution('workspace.dashboard', {
    kind: 'view', view: { version: 1, root: { type: 'raw-html', html: '<script />' } }
  }), /Unknown Plugin ViewSpec node/)
  assert.throws(() => validatePluginUiContribution('workspace.dashboard', {
    kind: 'view', view: { version: 1, root: { type: 'text', text: 'safe', onClick: 'evil()' } }
  }), /unknown field "onClick"/)
  assert.throws(() => validatePluginUiContribution('workspace.dashboard', {
    kind: 'view', view: { version: 1, root: { type: 'button', label: 'Run', action: { handler: '../escape' } } }
  }), /handler is invalid/)
})

test('iframe materialization puts CSP before untrusted bytes and only emits revision assets', () => {
  const package_: PluginRevisionPackage = {
    revisionId: owner.revisionId,
    contentHash: 'hash',
    manifest: {
      schemaVersion: 2,
      id: owner.pluginId,
      name: 'Test',
      version: '1.0.0',
      apiVersion: '2',
      worker: 'worker.js',
      permissions: [],
      standardModules: []
    },
    workerSource: '',
    views: null,
    assets: {
      'ui/index.html': new TextEncoder().encode('<script>window.ready = true</script>')
    },
    sizeBytes: 1
  }
  const result = materializePluginUiContribution({ load: (revisionId) => {
    assert.equal(revisionId, owner.revisionId)
    return package_
  } }, {
    owner,
    slot: 'workspace.dashboard',
    id: 'advanced',
    order: 1,
    value: { kind: 'iframe', asset: 'ui/index.html', title: 'Advanced', handlers: ['refresh'] }
  })
  assert.equal(result.value.kind, 'iframe')
  if (result.value.kind !== 'iframe') return
  const cspOffset = result.value.srcdoc.indexOf('Content-Security-Policy')
  const pluginScriptOffset = result.value.srcdoc.indexOf('window.ready')
  assert.ok(cspOffset >= 0 && cspOffset < pluginScriptOffset)
  assert.match(result.value.srcdoc, /default-src 'none'/)
  assert.match(result.value.srcdoc, /connect-src 'none'/)
  assert.match(result.value.srcdoc, /form-action 'none'/)
  assert.equal(result.value.srcdoc.includes('allow-same-origin'), false)
})

test('UI action requests have a closed owner, scope, control, and context shape', () => {
  assert.deepEqual(validateRunPluginUiActionInput({
    owner,
    slot: 'workspace.dashboard',
    contributionId: 'daily-review',
    handler: 'refresh',
    arguments: { period: 'today' },
    control: { id: 'query', value: 'text' },
    context: { documentId: 'doc-1' }
  }), {
    owner,
    slot: 'workspace.dashboard',
    contributionId: 'daily-review',
    handler: 'refresh',
    arguments: { period: 'today' },
    control: { id: 'query', value: 'text' },
    context: { documentId: 'doc-1' }
  })
  assert.throws(() => validateRunPluginUiActionInput({
    owner: { ...owner, epoch: 0 },
    slot: 'workspace.dashboard',
    contributionId: 'daily-review',
    handler: 'refresh'
  }), /epoch is invalid/)
  assert.throws(() => validateRunPluginUiActionInput({
    owner,
    slot: 'workspace.dashboard',
    contributionId: 'daily-review',
    handler: 'refresh',
    preload: true
  }), /unknown field "preload"/)
})
