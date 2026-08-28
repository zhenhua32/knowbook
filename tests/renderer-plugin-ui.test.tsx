import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PluginSlot } from '../src/renderer/src/components/PluginSlot.tsx'
import type { PluginUiContribution } from '../src/shared/plugin-ui.ts'

const contribution: PluginUiContribution = {
  owner: {
    pluginId: 'safe-plugin',
    revisionId: 'revision-1',
    runId: 'run-1',
    grantSetId: 'grant-1',
    scope: { kind: 'workspace', workspaceId: 'workspace-1' },
    epoch: 1
  },
  slot: 'workspace.dashboard',
  id: 'safe-view',
  order: 1,
  value: {
    kind: 'view',
    view: {
      version: 1,
      root: {
        type: 'stack',
        children: [
          { type: 'markdown', markdown: '<img src=x onerror=alert(1)>' },
          { type: 'button', label: 'Run', action: { handler: 'run' } },
          { type: 'progress', label: 'Done', value: 50 }
        ]
      }
    }
  }
}

test('PluginSlot renders ViewSpec as escaped host controls without arbitrary HTML', () => {
  const html = renderToStaticMarkup(<PluginSlot contributions={[contribution]} slot="workspace.dashboard" />)
  assert.match(html, /data-plugin-slot="workspace.dashboard"/)
  assert.match(html, /data-plugin-slot-version="1"/)
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.equal(html.includes('<img src=x'), false)
  assert.match(html, /<button[^>]*type="button"/)
  assert.match(html, /<progress[^>]*value="50"/)
})

test('sandbox frame uses only allow-scripts, one-time MessageChannel, exact identity checks, and cleanup', () => {
  const source = readFileSync(new URL('../src/renderer/src/components/PluginSlot.tsx', import.meta.url), 'utf8')
  const protocol = readFileSync(new URL('../src/shared/plugin-frame-protocol.ts', import.meta.url), 'utf8')
  assert.match(source, /sandbox="allow-scripts"/)
  assert.match(source, /src=\{contribution\.value\.src\}/)
  assert.equal(source.includes('srcDoc='), false)
  assert.equal(source.includes('allow-same-origin'), false)
  assert.match(source, /new MessageChannel\(\)/)
  assert.match(protocol, /revisionId === expected\.revisionId/)
  assert.match(protocol, /runId === expected\.runId/)
  assert.match(protocol, /candidate\.epoch === expected\.epoch/)
  assert.match(protocol, /MAX_FRAME_MESSAGE_DEPTH/)
  assert.match(protocol, /MAX_FRAME_MESSAGE_BYTES/)
  assert.match(source, /portRef\.current\?\.close\(\)/)
  assert.match(source, /reportPluginUiRuntimeFailure/)
  assert.match(source, /MAX_PENDING_IFRAME_ACTIONS/)
  assert.match(source, /ready handshake timed out after activation/)
  assert.equal(source.includes('addEventListener(\'message\''), false)
})

test('renderer mounts a hidden staging host for iframe ready handshakes', () => {
  const host = readFileSync(new URL('../src/renderer/src/components/PluginUiPreparationHost.tsx', import.meta.url), 'utf8')
  const app = readFileSync(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')
  assert.match(app, /<PluginUiPreparationHost \/>/)
  assert.match(host, /onPluginUiPreparation/)
  assert.match(host, /reportPluginUiPreparation/)
  assert.match(host, /sandbox="allow-scripts"/)
  assert.match(host, /src=\{frame\.src\}/)
  assert.equal(host.includes('srcDoc='), false)
  assert.match(host, /new MessageChannel\(\)/)
  assert.match(host, /Plugin iframe ready handshake timed out/)
})

test('all published slots are mounted in product surfaces', () => {
  const page = readFileSync(new URL('../src/renderer/src/components/AppPageContent.tsx', import.meta.url), 'utf8')
  const sidebar = readFileSync(new URL('../src/renderer/src/components/WorkspaceShellSidebar.tsx', import.meta.url), 'utf8')
  for (const slot of [
    'workspace.dashboard', 'documents.header.actions', 'documents.editor.toolbar',
    'documents.block.context-menu', 'documents.aux-panel', 'database.view.tabs',
    'database.record.actions', 'settings.sections', 'assistant.tools', 'assistant.message.cards'
  ]) assert.ok(page.includes(`slot="${slot}"`), slot)
  assert.ok(sidebar.includes('slot="navigation.primary"'))
})
