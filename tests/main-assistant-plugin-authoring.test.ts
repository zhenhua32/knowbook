import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store.ts'
import {
  AssistantPluginAuthoringService,
  type PluginRevisionValidator
} from '../src/main/assistant/plugin-authoring-service.ts'
import {
  PluginActivationCoordinator,
  PluginCapabilityBroker,
  PluginPlatformKernel,
  PluginRevisionStore,
  type NoNodePluginRuntimeFactory
} from '../src/main/plugin-platform/index.ts'
import {
  assistantSessionId,
  assistantStepId,
  assistantToolCallId,
  assistantTurnId
} from '../src/shared/assistant-session.ts'
import type {
  PluginJsonValue,
  PluginPlatformScope,
  PluginRevisionPackageInput
} from '../src/shared/plugin-platform.ts'

test('assistant plugin tools define, diff, approve once, and atomically activate a session preview', async () => {
  await withAuthoringPlatform(async (platform) => {
    const first = await platform.service.defineRevision(platform.context, revisionInput(
      '1.0.0',
      'export const version = 1',
      [{ capability: 'documents.read', version: 1 }]
    ))

    assert.equal(first.revision.staticCheckStatus, 'passed')
    assert.equal(first.diff.previousRevisionId, null)
    assert.deepEqual(first.diff.permissionsAdded, ['documents.read@1'])
    assert.equal(platform.store.pluginPlatform.getDefinition('daily-review')?.persistenceScope, 'session-preview')
    assert.deepEqual(
      platform.service.inspectCapabilities().map((entry) => `${entry.id}@${entry.version}`),
      ['documents.read@1']
    )
    const preview = platform.service.previewRevision(platform.context, 'daily-review', first.revision.id) as Record<string, PluginJsonValue>
    assert.equal((preview.diff as Record<string, PluginJsonValue>).workerChanged, true)
    assert.match(String(((preview.code as Record<string, PluginJsonValue>).next as Record<string, PluginJsonValue>).excerpt), /version = 1/)

    const scope = platform.sessionScope
    const toolCallId = assistantToolCallId('activate-call-1')
    appendActivationToolCall(platform, toolCallId, first.revision.id, scope, '在当前会话预览每日回顾卡片')
    const approval = platform.service.requestActivation({
      ...platform.context,
      toolCallId
    }, {
      pluginId: 'daily-review',
      revisionId: first.revision.id,
      scope,
      summary: '在当前会话预览每日回顾卡片',
      runId: 'run-approved'
    })

    assert.equal(approval.status, 'awaiting-approval')
    assert.equal(approval.risk, 'low')
    assert.equal(platform.store.pluginPlatform.getRun('run-approved'), null)
    const resolved = await platform.service.resolveActivationApproval(
      platform.sessionId,
      approval.approvalId,
      'allowed-once'
    )

    assert.equal(resolved.status, 'succeeded')
    assert.equal(resolved.runId, 'run-approved')
    assert.equal(platform.store.pluginPlatform.getRun('run-approved')?.status, 'active')
    assert.equal(platform.store.pluginPlatform.getDefinition('daily-review')?.currentRevisionId, first.revision.id)
    assert.deepEqual(
      platform.kernel.listContributions<PluginJsonValue>('dashboard.card', scope).map((entry) => entry.value),
      [{ title: 'Daily Review', handlerId: 'open' }]
    )

    const events = platform.store.assistantSessions.listEvents(platform.sessionId)
    assert.deepEqual(events.filter((event) => event.type.startsWith('plugin.')).map((event) => event.type), [
      'plugin.revision.defined',
      'plugin.validation.completed',
      'plugin.run.requested',
      'plugin.run.started',
      'plugin.run.succeeded'
    ])
    const resolution = events.find((event) => event.type === 'approval.resolved')
    assert.equal(resolution?.payload.decision, 'allowed-once')
    assert.equal(typeof resolution?.payload.grantSetId, 'string')
    const approvalEvent = events.find((event) => event.type === 'approval.requested')
    assert.equal(approvalEvent?.type === 'approval.requested' && approvalEvent.payload.revisionPreview !== undefined, true)
  })
})

test('assistant plugin approval is bound to persisted tool arguments and cannot promote preview to workspace', async () => {
  await withAuthoringPlatform(async (platform) => {
    const defined = await platform.service.defineRevision(
      platform.context,
      revisionInput('1.0.0', 'export const version = 1', [])
    )
    const wrongToolCallId = assistantToolCallId('wrong-call')
    appendActivationToolCall(platform, wrongToolCallId, 'sha256:wrong', platform.sessionScope, 'mismatch')
    assert.throws(() => platform.service.requestActivation({
      ...platform.context,
      toolCallId: wrongToolCallId
    }, {
      pluginId: 'daily-review',
      revisionId: defined.revision.id,
      scope: platform.sessionScope,
      summary: 'mismatch'
    }), /does not match its persisted tool arguments/)

    const workspaceScope: PluginPlatformScope = {
      kind: 'workspace',
      workspaceId: 'workspace-1'
    }
    const workspaceCallId = assistantToolCallId('workspace-call')
    appendActivationToolCall(platform, workspaceCallId, defined.revision.id, workspaceScope, 'silent promotion')
    assert.throws(() => platform.service.requestActivation({
      ...platform.context,
      toolCallId: workspaceCallId
    }, {
      pluginId: 'daily-review',
      revisionId: defined.revision.id,
      scope: workspaceScope,
      summary: 'silent promotion'
    }), /only activate inside their owning assistant session/)
  })
})

test('explicit approved workspace installation persists the preview revision and stops its session run', async () => {
  await withAuthoringPlatform(async (platform) => {
    const defined = await platform.service.defineRevision(
      platform.context,
      revisionInput('1.0.0', 'export const version = 1', [])
    )
    await approveActivation(platform, defined.revision.id, 'run-preview-before-save', 'preview first')
    const workspaceScope = { kind: 'workspace' as const, workspaceId: 'workspace-1' }
    const toolCallId = assistantToolCallId('install-workspace-call')
    appendWorkspaceInstallToolCall(
      platform,
      toolCallId,
      defined.revision.id,
      workspaceScope,
      'save daily review to workspace'
    )
    const approval = platform.service.requestWorkspaceInstallation({
      ...platform.context,
      toolCallId
    }, {
      pluginId: 'daily-review',
      revisionId: defined.revision.id,
      scope: workspaceScope,
      summary: 'save daily review to workspace',
      runId: 'run-workspace-saved'
    })
    assert.equal(approval.operation, 'install-workspace')

    const result = await platform.service.resolveActivationApproval(
      platform.sessionId,
      approval.approvalId,
      'allowed-once'
    )
    assert.equal(result.status, 'succeeded')
    assert.equal(platform.store.pluginPlatform.getDefinition('daily-review')?.persistenceScope, 'workspace')
    const installation = platform.store.pluginPlatform.getInstallationForScope('daily-review', workspaceScope)
    assert.equal(installation?.enabled, true)
    assert.equal(installation?.currentRevisionId, defined.revision.id)
    assert.equal(installation?.activeRunId, 'run-workspace-saved')
    assert.equal(platform.kernel.getActiveOwner('daily-review', platform.sessionScope), null)
    assert.equal(platform.kernel.getActiveOwner('daily-review', workspaceScope)?.runId, 'run-workspace-saved')
    assert.equal(platform.store.pluginPlatform.getRun('run-preview-before-save')?.status, 'stopped')
  })
})

test('assistant lifecycle tools inspect, roll back to a successful revision, diagnose, and stop the active run', async () => {
  await withAuthoringPlatform(async (platform) => {
    const first = await platform.service.defineRevision(
      platform.context,
      revisionInput('1.0.0', 'export const version = 1', [])
    )
    await approveActivation(platform, first.revision.id, 'run-v1', 'activate v1')

    const second = await platform.service.defineRevision(
      platform.context,
      revisionInput('2.0.0', 'export const version = 2', [])
    )
    await approveActivation(platform, second.revision.id, 'run-v2', 'activate v2')
    assert.equal(
      platform.store.pluginPlatform.getDefinition('daily-review')?.currentRevisionId,
      second.revision.id
    )

    const listed = platform.service.listPlugins(platform.context)
    assert.equal(listed.length, 1)
    assert.equal(listed[0]?.revisionCount, 2)
    assert.equal(listed[0]?.activeRun?.id, 'run-v2')
    const inspected = platform.service.inspectPlugin(platform.context, 'daily-review')
    assert.deepEqual(inspected.revisions.map((revision) => revision.id), [
      second.revision.id,
      first.revision.id
    ])
    assert.equal(
      platform.service.inspectRevision(platform.context, 'daily-review', first.revision.id).staticCheckStatus,
      'passed'
    )

    const rollbackCallId = assistantToolCallId('rollback-call')
    appendRollbackToolCall(
      platform,
      rollbackCallId,
      first.revision.id,
      platform.sessionScope,
      'restore v1'
    )
    const approval = platform.service.requestRollback({
      ...platform.context,
      toolCallId: rollbackCallId
    }, {
      pluginId: 'daily-review',
      targetRevisionId: first.revision.id,
      scope: platform.sessionScope,
      summary: 'restore v1',
      runId: 'run-rollback-v1'
    })
    assert.equal(approval.operation, 'rollback')

    const rollback = await platform.service.resolveActivationApproval(
      platform.sessionId,
      approval.approvalId,
      'allowed-once'
    )
    assert.equal(rollback.status, 'succeeded')
    assert.equal(
      platform.store.pluginPlatform.getDefinition('daily-review')?.currentRevisionId,
      first.revision.id
    )
    assert.equal(
      platform.kernel.getActiveOwner('daily-review', platform.sessionScope)?.revisionId,
      first.revision.id
    )

    platform.store.pluginPlatform.appendPluginLog({
      id: 'diagnostic-log',
      pluginId: 'daily-review',
      revisionId: first.revision.id,
      runId: 'run-rollback-v1',
      level: 'warning',
      event: 'test.diagnostic',
      message: 'diagnostic detail',
      data: { safe: true }
    })
    const diagnostics = platform.service.readDiagnostics(platform.context, 'daily-review', 20)
    assert.equal(diagnostics.logs[0]?.message, 'diagnostic detail')
    assert.deepEqual(diagnostics.logs[0]?.data, { safe: true })

    const stopped = await platform.service.stopPlugin(platform.context, {
      pluginId: 'daily-review',
      scope: platform.sessionScope
    })
    assert.equal(stopped.status, 'stopped')
    assert.equal(platform.store.pluginPlatform.getDefinition('daily-review')?.activeRunId, null)

    const lifecycleEvents = platform.store.assistantSessions.listEvents(platform.sessionId, 0, 100)
    const rollbackEvent = lifecycleEvents.find((event) => event.type === 'plugin.rollback.completed')
    assert.deepEqual(rollbackEvent?.payload, {
      pluginId: 'daily-review',
      fromRevisionId: second.revision.id,
      toRevisionId: first.revision.id,
      runId: 'run-rollback-v1'
    })
    assert.equal(lifecycleEvents.at(-1)?.type, 'plugin.run.stopped')
  })
})

test('rejected or expired approvals never create plugin runs or reusable grants', async () => {
  let now = new Date()
  await withAuthoringPlatform(async (platform) => {
    const defined = await platform.service.defineRevision(
      platform.context,
      revisionInput('1.0.0', 'export const version = 1', [])
    )
    const rejectedCall = assistantToolCallId('rejected-call')
    appendActivationToolCall(platform, rejectedCall, defined.revision.id, platform.sessionScope, 'reject this')
    const rejectedApproval = platform.service.requestActivation({
      ...platform.context,
      toolCallId: rejectedCall
    }, {
      pluginId: 'daily-review',
      revisionId: defined.revision.id,
      scope: platform.sessionScope,
      summary: 'reject this',
      runId: 'run-rejected'
    })
    const rejected = await platform.service.resolveActivationApproval(
      platform.sessionId,
      rejectedApproval.approvalId,
      'rejected'
    )
    assert.equal(rejected.status, 'rejected')
    assert.equal(platform.store.pluginPlatform.getRun('run-rejected'), null)

    const expiredCall = assistantToolCallId('expired-call')
    appendActivationToolCall(platform, expiredCall, defined.revision.id, platform.sessionScope, 'expires')
    const expiredApproval = platform.service.requestActivation({
      ...platform.context,
      toolCallId: expiredCall
    }, {
      pluginId: 'daily-review',
      revisionId: defined.revision.id,
      scope: platform.sessionScope,
      summary: 'expires',
      approvalLifetimeMs: 1_000,
      runId: 'run-expired'
    })
    now = new Date(now.getTime() + 2_000)
    platform.setNow(() => now)
    const expired = await platform.service.resolveActivationApproval(
      platform.sessionId,
      expiredApproval.approvalId,
      'allowed-once'
    )
    assert.equal(expired.status, 'unavailable')
    assert.equal(platform.store.pluginPlatform.getRun('run-expired'), null)
  }, () => now)
})

test('a committed kernel activation is not revoked when its success projection cannot be appended', async () => {
  await withAuthoringPlatform(async (platform) => {
    const defined = await platform.service.defineRevision(
      platform.context,
      revisionInput('1.0.0', 'export const version = 1', [])
    )
    const toolCallId = assistantToolCallId('projection-failure-call')
    appendActivationToolCall(platform, toolCallId, defined.revision.id, platform.sessionScope, 'activate safely')
    const approval = platform.service.requestActivation({ ...platform.context, toolCallId }, {
      pluginId: 'daily-review',
      revisionId: defined.revision.id,
      scope: platform.sessionScope,
      summary: 'activate safely',
      runId: 'run-projection-failure'
    })
    const repository = platform.store.assistantSessions
    const originalAppend = repository.append.bind(repository)
    Object.defineProperty(repository, 'append', {
      configurable: true,
      value: ((sessionId: Parameters<typeof originalAppend>[0], input: Parameters<typeof originalAppend>[1]) => {
        if (input.type === 'plugin.run.succeeded') throw new Error('simulated projection write failure')
        return originalAppend(sessionId, input)
      }) as typeof repository.append
    })
    try {
      const result = await platform.service.resolveActivationApproval(
        platform.sessionId,
        approval.approvalId,
        'allowed-once'
      )
      assert.equal(result.status, 'succeeded')
      assert.equal(platform.store.pluginPlatform.getRun('run-projection-failure')?.status, 'active')
      assert.equal(platform.kernel.getActiveOwner('daily-review', platform.sessionScope)?.runId, 'run-projection-failure')
      const grant = platform.store.pluginPlatform.getGrantSet(result.grantSetId ?? '')
      assert.equal(grant?.id, result.grantSetId)
    } finally {
      Object.defineProperty(repository, 'append', { configurable: true, value: originalAppend })
    }
  })
})

test('failed validation remains inspectable but cannot request activation', async () => {
  const validator: PluginRevisionValidator = {
    validate: () => ({
      status: 'failed',
      diagnostics: [{ code: 'forbidden-api', message: 'Forbidden API reference' }]
    })
  }
  await withAuthoringPlatform(async (platform) => {
    const defined = await platform.service.defineRevision(
      platform.context,
      revisionInput('1.0.0', 'process.env.SECRET', [])
    )
    assert.equal(defined.revision.staticCheckStatus, 'failed')
    const toolCallId = assistantToolCallId('failed-validation-call')
    appendActivationToolCall(platform, toolCallId, defined.revision.id, platform.sessionScope, 'must fail')
    assert.throws(() => platform.service.requestActivation({
      ...platform.context,
      toolCallId
    }, {
      pluginId: 'daily-review',
      revisionId: defined.revision.id,
      scope: platform.sessionScope,
      summary: 'must fail'
    }), /failed validation/)
    assert.equal(platform.store.pluginPlatform.getDefinition('daily-review')?.pendingRevisionId, defined.revision.id)
  }, undefined, validator)
})

function appendActivationToolCall(
  platform: ReturnType<typeof createPlatform>,
  toolCallId: ReturnType<typeof assistantToolCallId>,
  revisionId: string,
  scope: PluginPlatformScope,
  summary: string
): void {
  platform.store.assistantSessions.append(platform.sessionId, {
    type: 'tool.call',
    payload: {
      turnId: platform.turnId,
      stepId: assistantStepId(`step-${toolCallId}`),
      toolCallId,
      tool: 'plugins.activate_revision',
      version: 1,
      arguments: { pluginId: 'daily-review', revisionId, summary, scope }
    }
  })
}

async function approveActivation(
  platform: ReturnType<typeof createPlatform>,
  revisionId: string,
  runId: string,
  summary: string
): Promise<void> {
  const toolCallId = assistantToolCallId(`activate-${runId}`)
  appendActivationToolCall(platform, toolCallId, revisionId, platform.sessionScope, summary)
  const approval = platform.service.requestActivation({
    ...platform.context,
    toolCallId
  }, {
    pluginId: 'daily-review',
    revisionId,
    scope: platform.sessionScope,
    summary,
    runId
  })
  const result = await platform.service.resolveActivationApproval(
    platform.sessionId,
    approval.approvalId,
    'allowed-once'
  )
  assert.equal(result.status, 'succeeded')
}

function appendRollbackToolCall(
  platform: ReturnType<typeof createPlatform>,
  toolCallId: ReturnType<typeof assistantToolCallId>,
  targetRevisionId: string,
  scope: PluginPlatformScope,
  summary: string
): void {
  platform.store.assistantSessions.append(platform.sessionId, {
    type: 'tool.call',
    payload: {
      turnId: platform.turnId,
      stepId: assistantStepId(`step-${toolCallId}`),
      toolCallId,
      tool: 'plugins.rollback',
      version: 1,
      arguments: { pluginId: 'daily-review', targetRevisionId, summary, scope }
    }
  })
}

function appendWorkspaceInstallToolCall(
  platform: ReturnType<typeof createPlatform>,
  toolCallId: ReturnType<typeof assistantToolCallId>,
  revisionId: string,
  scope: Extract<PluginPlatformScope, { kind: 'workspace' }>,
  summary: string
): void {
  platform.store.assistantSessions.append(platform.sessionId, {
    type: 'tool.call',
    payload: {
      turnId: platform.turnId,
      stepId: assistantStepId(`step-${toolCallId}`),
      toolCallId,
      tool: 'plugins.install_workspace',
      version: 1,
      arguments: { pluginId: 'daily-review', revisionId, summary, scope }
    }
  })
}

function revisionInput(
  version: string,
  workerSource: string,
  permissions: Array<{ capability: string; version: number }>
): PluginRevisionPackageInput {
  return {
    manifest: {
      schemaVersion: 2,
      id: 'daily-review',
      name: 'Daily Review',
      version,
      apiVersion: '2',
      permissions,
      standardModules: []
    },
    workerSource,
    views: { cards: [{ id: 'daily-review' }] }
  }
}

async function withAuthoringPlatform(
  run: (platform: ReturnType<typeof createPlatform>) => Promise<void>,
  now?: () => Date,
  validator?: PluginRevisionValidator
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-assistant-authoring-test-'))
  const platform = createPlatform(root, now, validator)
  try {
    await run(platform)
  } finally {
    await platform.kernel.destroy()
    platform.store.destroy()
    rmSync(root, { recursive: true, force: true })
  }
}

function createPlatform(
  root: string,
  initialNow?: () => Date,
  validator: PluginRevisionValidator = {
    validate: () => ({ status: 'passed', diagnostics: [] })
  }
) {
  let now = initialNow ?? (() => new Date())
  const store = new KnowbookStore(join(root, 'knowbook.sqlite'))
  const revisions = new PluginRevisionStore(join(root, 'plugins-v2'))
  const kernel = new PluginPlatformKernel()
  const broker = new PluginCapabilityBroker(kernel)
  broker.register({
    id: 'documents.read',
    version: 1,
    scopes: ['session', 'workspace'],
    parseInput: (input) => input,
    execute: () => ({ ok: true })
  })
  const runtimeFactory: NoNodePluginRuntimeFactory = {
    isolation: 'no-node-isolate',
    create: async () => ({
      activate: async () => ({
        contributions: [{
          descriptor: { slot: 'dashboard.card', id: 'daily-review' },
          value: { title: 'Daily Review', handlerId: 'open' }
        }]
      }),
      commit: () => undefined,
      invokeHandler: async () => ({}),
      dispose: () => undefined
    })
  }
  const coordinator = new PluginActivationCoordinator(
    kernel,
    broker,
    store.pluginPlatform,
    revisions,
    runtimeFactory
  )
  const service = new AssistantPluginAuthoringService(
    store.assistantSessions,
    store.pluginPlatform,
    revisions,
    broker,
    coordinator,
    validator,
    { now: () => now() }
  )
  const sessionId = assistantSessionId('session-authoring')
  const turnId = assistantTurnId('turn-authoring')
  store.assistantSessions.createSession({
    id: sessionId,
    workspaceId: 'workspace-1',
    title: 'Authoring',
    modelConfig: { model: 'test' }
  })
  store.assistantSessions.append(sessionId, { type: 'turn.started', payload: { turnId } })

  return {
    store,
    revisions,
    kernel,
    broker,
    coordinator,
    service,
    sessionId,
    turnId,
    context: { sessionId, turnId },
    sessionScope: {
      kind: 'session',
      workspaceId: 'workspace-1',
      sessionId
    } as PluginPlatformScope,
    setNow: (next: () => Date) => {
      now = next
    }
  }
}
