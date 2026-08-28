import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isBoundedPluginFrameJson,
  readPluginFrameAction,
  readPluginFrameReadiness
} from '../src/shared/plugin-frame-protocol.ts'
import type { PluginActiveOwner } from '../src/shared/plugin-platform.ts'

const owner: PluginActiveOwner = {
  pluginId: 'safe-plugin',
  revisionId: 'revision-1',
  runId: 'run-1',
  grantSetId: 'grant-1',
  scope: { kind: 'workspace', workspaceId: 'workspace-1' },
  epoch: 7
}
const address = {
  owner,
  contributionId: 'frame-1',
  slot: 'workspace.dashboard' as const
}

test('plugin frame protocol accepts only the exact active owner, slot, and closed message shape', () => {
  const action = {
    type: 'knowbook:action',
    owner,
    contributionId: address.contributionId,
    slot: address.slot,
    requestId: 'request-1',
    handler: 'refresh',
    arguments: { documentId: 'doc-1' }
  }
  assert.deepEqual(readPluginFrameAction(action, address), {
    requestId: 'request-1',
    handler: 'refresh',
    arguments: { documentId: 'doc-1' }
  })
  assert.equal(readPluginFrameAction({ ...action, slot: 'settings.sections' }, address), null)
  assert.equal(readPluginFrameAction({ ...action, owner: { ...owner, epoch: 6 } }, address), null)
  assert.equal(readPluginFrameAction({ ...action, unexpected: true }, address), null)

  assert.deepEqual(readPluginFrameReadiness({
    type: 'knowbook:ready',
    owner,
    contributionId: address.contributionId,
    slot: address.slot
  }, address), { status: 'ready' })
  assert.equal(readPluginFrameReadiness({
    type: 'knowbook:ready',
    owner,
    contributionId: address.contributionId,
    slot: address.slot,
    unexpected: true
  }, address), null)
})

test('plugin frame protocol rejects cycles, excessive depth, and oversized payloads without throwing', () => {
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  assert.equal(isBoundedPluginFrameJson(cyclic), false)
  assert.doesNotThrow(() => readPluginFrameReadiness({
    type: 'knowbook:ready',
    owner: { ...owner, scope: cyclic },
    contributionId: address.contributionId,
    slot: address.slot
  }, address))

  let deep: Record<string, unknown> = { value: 'end' }
  for (let index = 0; index < 20; index += 1) deep = { child: deep }
  assert.equal(readPluginFrameAction({
    type: 'knowbook:action',
    owner,
    contributionId: address.contributionId,
    slot: address.slot,
    requestId: 'deep',
    handler: 'refresh',
    arguments: deep
  }, address), null)

  assert.equal(readPluginFrameAction({
    type: 'knowbook:action',
    owner,
    contributionId: address.contributionId,
    slot: address.slot,
    requestId: 'large',
    handler: 'refresh',
    arguments: 'x'.repeat(256 * 1024 + 1)
  }, address), null)
})
