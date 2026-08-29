import assert from 'node:assert/strict'
import test from 'node:test'
import { projectEvents } from '../src/renderer/src/components/AssistantConversation.tsx'
import type { AssistantEvent } from '../src/shared/assistant-session.ts'

test('assistant renderer rebuilds streaming, tool, approval, and plugin lifecycle cards from events alone', () => {
  const events = [
    event(1, 'assistant.chunk', { turnId: 'turn-1', stepId: 'step-1', text: '流式' }),
    event(2, 'assistant.chunk', { turnId: 'turn-1', stepId: 'step-1', text: '内容' }),
    event(3, 'assistant.message', { turnId: 'turn-1', stepId: 'step-1', text: '最终内容' }),
    event(4, 'tool.call', {
      turnId: 'turn-1', stepId: 'step-1', toolCallId: 'call-1', tool: 'documents.get', version: 1, arguments: { documentId: 'doc-1' }
    }),
    event(5, 'tool.result', {
      turnId: 'turn-1', stepId: 'step-1', toolCallId: 'call-1', status: 'failed', result: { error: { message: 'not found' } }
    }),
    event(6, 'plugin.revision.defined', {
      turnId: 'turn-1', pluginId: 'sample', revisionId: 'sha256:012345678901234567890123456789', previousRevisionId: null
    }),
    event(7, 'plugin.run.failed', {
      pluginId: 'sample', revisionId: 'sha256:012345678901234567890123456789', runId: 'run-1', error: { message: 'failed' }
    }),
    event(8, 'approval.requested', {
      turnId: 'turn-1', toolCallId: 'call-2', approvalId: 'approval-1', pluginId: 'sample',
      revisionId: 'sha256:012345678901234567890123456789', scope: { kind: 'session', workspaceId: 'workspace-1', sessionId: 'session-1' },
      permissions: [], summary: 'activate', risk: 'low', expiresAt: '2026-08-27T00:00:00.000Z'
    })
  ]
  const projection = projectEvents(events)
  const messages = projection.items.filter((item) => item.kind === 'message')
  assert.deepEqual(messages.map((item) => item.kind === 'message' ? item.text : ''), ['最终内容'])
  assert.equal(projection.items.some((item) => item.kind === 'tool' && item.status === 'failed' && item.detail === 'not found'), true)
  assert.equal(projection.items.filter((item) => item.kind === 'lifecycle').length, 2)
  assert.equal(projection.items.some((item) => item.kind === 'lifecycle' && item.detail.endsWith('· failed')), true)
  assert.equal(projection.approvals.length, 1)
  assert.deepEqual(projectEvents(structuredClone(events)), projection)
})

function event(seq: number, type: AssistantEvent['type'], payload: unknown): AssistantEvent {
  return {
    id: `event-${seq}`,
    sessionId: 'session-1',
    seq,
    type,
    surface: 'trajectory',
    payload,
    createdAt: '2026-08-27T00:00:00.000Z'
  } as AssistantEvent
}
