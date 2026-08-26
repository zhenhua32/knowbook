import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AssistantAgentService } from '../src/main/assistant/agent-service.ts'
import {
  OpenAiCompatibleAssistantModelAdapter,
  type AssistantModelAdapter,
  type AssistantModelCompletionInput
} from '../src/main/assistant/model-adapter.ts'
import { KnowbookStore } from '../src/main/database/store.ts'
import type { PluginPlatformV2Service } from '../src/main/plugin-platform/platform-service.ts'
import { assistantToolCallId } from '../src/shared/assistant-session.ts'

test('assistant loop exposes only closed plugin tools and persists calls/results before continuing', async () => {
  await withStore(async (store) => {
    const calls: AssistantModelCompletionInput[] = []
    const model: AssistantModelAdapter = {
      complete: async (input) => {
        calls.push(input)
        if (calls.length === 1) {
          return {
            content: '',
            toolCalls: [{ name: 'plugins.inspect_capabilities', arguments: {} }]
          }
        }
        return { content: '平台能力已检查。', toolCalls: [] }
      }
    }
    const platform = {
      authoring: {
        inspectCapabilities: () => [{
          id: 'documents.read',
          version: 1,
          scopes: ['workspace', 'session'],
          timeoutMs: 10_000,
          maxResultBytes: 1_000_000
        }]
      },
      getSessionScope: (sessionId: string) => ({
        kind: 'session', workspaceId: 'workspace-1', sessionId
      })
    } as unknown as PluginPlatformV2Service
    const service = new AssistantAgentService(store.assistantSessions, platform, {
      workspaceId: 'workspace-1',
      getAiConfig: () => ({
        enabled: true,
        apiKey: 'not-persisted',
        baseUrl: 'https://example.invalid/v1',
        model: 'test-model'
      }),
      modelAdapter: model
    })

    try {
      const session = service.createSession({ title: '插件会话' })
      const result = await service.sendMessage({ sessionId: session.id, text: '检查插件能力' })
      assert.equal(result.status, 'completed')
      assert.equal(calls.length, 2)
      assert.deepEqual(calls[0].tools.map((tool) => tool.eventName), [
        'plugins.inspect_capabilities',
        'plugins.inspect_standard_modules',
        'plugins.define_revision',
        'plugins.activate_revision'
      ])
      assert.equal(calls[0].systemPrompt.includes('npm'), true)
      assert.equal(JSON.stringify(service.getSession(session.id)?.modelConfig).includes('not-persisted'), false)

      const events = service.listEvents(session.id, 0, 100)
      assert.deepEqual(events.map((event) => event.type), [
        'session.created',
        'turn.started',
        'user.message',
        'step.started',
        'tool.call',
        'tool.result',
        'step.ended',
        'step.started',
        'assistant.message',
        'step.ended',
        'turn.ended'
      ])
      const toolResult = events.find((event) => event.type === 'tool.result')
      assert.equal(toolResult?.payload.status, 'succeeded')
      assert.equal(calls[1].messages.some((message) => message.role === 'tool'), true)
    } finally {
      await service.destroy()
    }
  })
})

test('OpenAI-compatible adapter maps canonical tool facts without trusting provider call ids', async () => {
  let requestBody: unknown = null
  const adapter = new OpenAiCompatibleAssistantModelAdapter({
    fetchImplementation: async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: 'provider-controlled-id',
              type: 'function',
              function: { name: 'plugins_inspect_capabilities', arguments: '{}' }
            }]
          }
        }],
        usage: { total_tokens: 12 }
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
  })
  const tool = {
    name: 'plugins_inspect_capabilities',
    eventName: 'plugins.inspect_capabilities',
    description: 'Inspect',
    parameters: { type: 'object' } as const
  }
  const result = await adapter.complete({
    apiKey: 'secret',
    baseUrl: 'https://example.invalid/v1',
    model: 'test-model',
    systemPrompt: 'system',
    messages: [{
      role: 'assistant',
      content: '',
      tool: {
        id: assistantToolCallId('host-call-id'),
        name: tool.eventName,
        version: 1,
        arguments: {}
      }
    }, {
      role: 'tool',
      toolCallId: assistantToolCallId('host-call-id'),
      content: '{}'
    }],
    tools: [tool]
  })

  assert.deepEqual(result.toolCalls, [{ name: 'plugins.inspect_capabilities', arguments: {} }])
  assert.deepEqual(result.usage, { total_tokens: 12 })
  const messages = (requestBody as Record<string, unknown>).messages as Array<Record<string, unknown>>
  assert.equal((messages[1].tool_calls as Array<{ id: string }>)[0].id, 'host-call-id')
  assert.equal(messages[2].tool_call_id, 'host-call-id')
  assert.equal(JSON.stringify(requestBody).includes('secret'), false)
})

async function withStore(run: (store: KnowbookStore) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-assistant-agent-test-'))
  const store = new KnowbookStore(join(root, 'knowbook.db'))
  try {
    await run(store)
  } finally {
    store.destroy()
    rmSync(root, { recursive: true, force: true })
  }
}
