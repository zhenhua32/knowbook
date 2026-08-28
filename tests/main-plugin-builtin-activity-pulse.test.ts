import assert from 'node:assert/strict'
import test from 'node:test'
import { ACTIVITY_PULSE_V2_PACKAGE } from '../src/main/plugin-platform/builtin-activity-pulse.ts'
import { QuickJsWasiPluginRealm } from '../src/main/plugin-platform/quickjs-realm.ts'
import { buildPluginRevisionPackage } from '../src/main/plugin-platform/revision-package.ts'
import type { PluginCapabilityCall, PluginJsonValue } from '../src/shared/plugin-platform.ts'

test('activity-pulse v2 activates and performs document/event work through capabilities only', async () => {
  const package_ = buildPluginRevisionPackage(ACTIVITY_PULSE_V2_PACKAGE).package
  const identity = {
    pluginId: package_.manifest.id,
    revisionId: package_.revisionId,
    runId: 'activity-pulse-test-run',
    grantSetId: 'activity-pulse-test-grant',
    scope: { kind: 'workspace' as const, workspaceId: 'workspace-1' }
  }
  const calls: PluginCapabilityCall[] = []
  const realm = await QuickJsWasiPluginRealm.create({
    identity,
    package: package_,
    callCapability: async (_owner, call) => {
      calls.push(call)
      if (call.capability === 'documents.read') {
        return {
          id: 'doc-1',
          title: 'Document',
          blocks: [{ id: 'block-1', type: 'text', content: '  First block content  ' }]
        }
      }
      return null
    }
  })

  try {
    const snapshot = await realm.activate()
    assert.deepEqual(snapshot.contributions.map((item) => item.descriptor.slot), [
      'dashboard.card',
      'workspace.dashboard',
      'document.action',
      'workspace.event',
      'workspace.event'
    ])
    const owner = { ...identity, epoch: 1 }
    realm.commit(owner)
    const actionResult = await realm.invokeHandler(
      owner,
      'document.summary-from-first-block',
      { documentId: 'doc-1' },
      new AbortController().signal
    )
    assert.deepEqual(actionResult, {
      message: 'Summary refreshed from the first non-empty block.',
      refreshDocument: true
    })
    assert.deepEqual(calls.map((call) => call.capability), [
      'documents.read',
      'documents.update',
      'ui.notify'
    ])
    assert.deepEqual((calls[1].input as Record<string, PluginJsonValue>).summary, 'First block content')

    await realm.invokeHandler(owner, 'workspace.remember-activity', {
      event: {
        type: 'document.updated',
        documentId: 'doc-1',
        documentTitle: 'Document',
        createdAt: '2026-08-26T00:00:00.000Z'
      }
    }, new AbortController().signal)
    assert.equal(calls.at(-1)?.capability, 'plugin.storage.write')

    await realm.invokeHandler(owner, 'ai.auto-summary-on-save', {
      event: { type: 'document.updated', documentId: 'doc-1' }
    }, new AbortController().signal)
    assert.equal(calls.at(-1)?.capability, 'ai.automation.summarize-document')
  } finally {
    await realm.dispose()
  }
})
