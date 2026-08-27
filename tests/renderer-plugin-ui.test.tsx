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
  assert.match(source, /sandbox="allow-scripts"/)
  assert.equal(source.includes('allow-same-origin'), false)
  assert.match(source, /new MessageChannel\(\)/)
  assert.match(source, /revisionId === expected\.revisionId/)
  assert.match(source, /runId === expected\.runId/)
  assert.match(source, /candidate\.epoch === expected\.epoch/)
  assert.match(source, /portRef\.current\?\.close\(\)/)
  assert.equal(source.includes('addEventListener(\'message\''), false)
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
