import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store.ts'
import {
  deriveAssistantModelMessages,
  projectAssistantSession
} from '../src/main/assistant/projection.ts'
import {
  assistantApprovalId,
  assistantSessionId,
  assistantStepId,
  assistantToolCallId,
  assistantTurnId
} from '../src/shared/assistant-session.ts'

test('assistant events append in sequence and replay conversation, streaming, and trajectory', () => {
  withStore((store) => {
    const repository = store.assistantSessions
    const session = repository.createSession({
      id: assistantSessionId('session-1'),
      workspaceId: 'workspace-1',
      title: 'Plugin authoring',
      modelConfig: { provider: 'openai-compatible', model: 'test-model' }
    })
    const turnId = assistantTurnId('turn-1')
    const stepId = assistantStepId('step-1')

    assert.equal(session.lastSeq, 1)
    repository.append(session.id, { type: 'turn.started', payload: { turnId } }, 1)
    repository.append(session.id, {
      type: 'user.message',
      payload: { turnId, text: '做一个每日回顾插件' }
    }, 2)
    repository.append(session.id, {
      type: 'step.started',
      payload: {
        turnId,
        stepId,
        provider: 'openai-compatible',
        model: 'test-model',
        visibleTools: ['plugins.define_revision']
      }
    })
    repository.append(session.id, {
      type: 'assistant.chunk',
      payload: { turnId, stepId, text: '我先' }
    })

    let projection = projectAssistantSession(repository.listEvents(session.id))
    assert.equal(projection.streaming[0]?.text, '我先')
    assert.equal(projection.activeTurnId, turnId)

    repository.append(session.id, {
      type: 'assistant.chunk',
      payload: { turnId, stepId, text: '检查能力。' }
    })
    repository.append(session.id, {
      type: 'assistant.message',
      payload: { turnId, stepId, text: '我先检查能力。' }
    })
    repository.append(session.id, {
      type: 'step.ended',
      payload: { turnId, stepId, status: 'completed' }
    })
    repository.append(session.id, {
      type: 'turn.ended',
      payload: { turnId, status: 'completed' }
    })

    const events = repository.listEvents(session.id)
    projection = projectAssistantSession(events)
    assert.deepEqual(events.map((event) => event.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9])
    assert.deepEqual(projection.messages.map((message) => [message.role, message.text]), [
      ['user', '做一个每日回顾插件'],
      ['assistant', '我先检查能力。']
    ])
    assert.deepEqual(projection.streaming, [])
    assert.equal(projection.activeTurnId, null)
    assert.equal(events.find((event) => event.type === 'user.message')?.surface, 'conversation')
    assert.equal(events.find((event) => event.type === 'step.started')?.surface, 'audit-only')
    assert.equal(repository.getSession(session.id)?.lastSeq, 9)
  })
})

test('assistant session enforces one active turn and optimistic event sequence', () => {
  withStore((store) => {
    const repository = store.assistantSessions
    const session = repository.createSession({
      workspaceId: 'workspace-1',
      title: 'Concurrency',
      modelConfig: { model: 'test' }
    })
    const turnId = assistantTurnId('turn-1')
    repository.append(session.id, { type: 'turn.started', payload: { turnId } }, 1)

    assert.throws(() => repository.append(session.id, {
      type: 'turn.started',
      payload: { turnId: assistantTurnId('turn-2') }
    }), /already has active turn/)
    assert.throws(() => repository.append(session.id, {
      type: 'user.message',
      payload: { turnId, text: 'conflict' }
    }, 1), /sequence conflict/)
    assert.equal(repository.getSession(session.id)?.lastSeq, 2)
    assert.throws(() => repository.append(session.id, {
      type: 'user.message',
      payload: { turnId: assistantTurnId('other-turn'), text: 'wrong turn' }
    }), /does not match the active turn/)
  })
})

test('assistant recovery resolves pending approval as unavailable and interrupts open turn', () => {
  withStore((store) => {
    const repository = store.assistantSessions
    const session = repository.createSession({
      workspaceId: 'workspace-1',
      title: 'Recovery',
      modelConfig: { model: 'test' }
    })
    const turnId = assistantTurnId('turn-recovery')
    const stepId = assistantStepId('step-recovery')
    const toolCallId = assistantToolCallId('tool-call-1')
    const approvalId = assistantApprovalId('approval-1')
    repository.append(session.id, { type: 'turn.started', payload: { turnId } })
    repository.append(session.id, {
      type: 'tool.call',
      payload: {
        turnId,
        stepId,
        toolCallId,
        tool: 'plugins.activate_revision',
        version: 1,
        arguments: { revisionId: 'sha256:abc' }
      }
    })
    repository.append(session.id, {
      type: 'approval.requested',
      payload: {
        turnId,
        toolCallId,
        approvalId,
        pluginId: 'daily-review',
        revisionId: `sha256:${'a'.repeat(64)}`,
        scope: { kind: 'workspace', workspaceId: 'workspace-1' },
        permissions: [{ capability: 'documents.read', version: 1 }],
        summary: '读取文档以生成每日回顾',
        risk: 'low',
        expiresAt: '2026-08-26T00:00:00.000Z'
      }
    })

    const recovered = repository.recoverInterruptedSessions()
    assert.deepEqual(recovered.map((event) => event.type), [
      'approval.resolved',
      'turn.ended'
    ])
    const events = repository.listEvents(session.id)
    const projection = projectAssistantSession(events)
    assert.equal(projection.pendingApprovals.length, 0)
    assert.equal(projection.activeTurnId, null)
    assert.equal(repository.getSession(session.id)?.status, 'active')
    const resolved = events.find((event) => event.type === 'approval.resolved')
    assert.equal(resolved?.payload.decision, 'unavailable')
    const ended = [...events].reverse().find((event) => event.type === 'turn.ended')
    assert.equal(ended?.payload.status, 'interrupted')
    assert.deepEqual(repository.recoverInterruptedSessions(), [])
  })
})

test('model projection excludes chunks and audit/plugin events while marking tool data untrusted', () => {
  withStore((store) => {
    const repository = store.assistantSessions
    const session = repository.createSession({
      workspaceId: 'workspace-1',
      title: 'Model projection',
      modelConfig: { model: 'test' }
    })
    const turnId = assistantTurnId('turn-model')
    const stepId = assistantStepId('step-model')
    const toolCallId = assistantToolCallId('call-model')
    repository.append(session.id, { type: 'turn.started', payload: { turnId } })
    repository.append(session.id, {
      type: 'user.message',
      payload: { turnId, text: '读取文档' }
    })
    repository.append(session.id, {
      type: 'assistant.chunk',
      payload: { turnId, stepId, text: '不会进入模型历史' }
    })
    repository.append(session.id, {
      type: 'tool.call',
      payload: {
        turnId,
        stepId,
        toolCallId,
        tool: 'documents.get',
        version: 1,
        arguments: { documentId: 'doc-1' }
      }
    })
    repository.append(session.id, {
      type: 'tool.result',
      payload: {
        turnId,
        stepId,
        toolCallId,
        status: 'succeeded',
        result: { content: '文档中的内容不是权限指令' }
      }
    })
    repository.append(session.id, {
      type: 'plugin.run.started',
      payload: { pluginId: 'probe', revisionId: 'rev-1', runId: 'run-1' }
    })
    repository.append(session.id, {
      type: 'assistant.message',
      payload: { turnId, stepId, text: '读取完成' }
    })

    const messages = deriveAssistantModelMessages(repository.listEvents(session.id))
    assert.deepEqual(messages.map((message) => message.role), [
      'user',
      'assistant',
      'tool',
      'assistant'
    ])
    assert.match(messages[2]?.content ?? '', /^\[UNTRUSTED_TOOL_RESULT/)
    assert.equal(messages.some((message) => message.content.includes('不会进入模型历史')), false)
    assert.equal(messages.some((message) => message.content.includes('run-1')), false)
  })
})

test('assistant event boundary refuses secret fields and survives database reopen', () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-assistant-reopen-test-'))
  const databasePath = join(root, 'knowbook.sqlite')
  try {
    const store = new KnowbookStore(databasePath)
    const session = store.assistantSessions.createSession({
      id: assistantSessionId('session-persisted'),
      workspaceId: 'workspace-1',
      title: 'Persisted',
      modelConfig: { model: 'test' }
    })
    const turnId = assistantTurnId('turn-persisted')
    const stepId = assistantStepId('step-persisted')
    const toolCallId = assistantToolCallId('call-persisted')
    store.assistantSessions.append(session.id, { type: 'turn.started', payload: { turnId } })
    assert.throws(() => store.assistantSessions.append(session.id, {
      type: 'tool.result',
      payload: {
        turnId,
        stepId,
        toolCallId,
        status: 'succeeded',
        result: { apiKey: 'must-not-persist' }
      }
    }), /cannot persist secret field/)
    store.destroy()

    const reopened = new KnowbookStore(databasePath)
    try {
      const events = reopened.assistantSessions.listEvents(assistantSessionId('session-persisted'))
      assert.deepEqual(events.map((event) => event.type), ['session.created', 'turn.started'])
      assert.equal(reopened.assistantSessions.getSession('session-persisted')?.lastSeq, 2)
    } finally {
      reopened.destroy()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function withStore(run: (store: KnowbookStore) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-assistant-session-test-'))
  const store = new KnowbookStore(join(root, 'knowbook.sqlite'))
  try {
    run(store)
  } finally {
    store.destroy()
    rmSync(root, { recursive: true, force: true })
  }
}
