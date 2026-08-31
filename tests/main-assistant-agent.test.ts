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
import { assistantToolCallId, assistantTurnId } from '../src/shared/assistant-session.ts'

test('assistant loop exposes only closed plugin tools and persists calls/results before continuing', async () => {
  await withStore(async (store) => {
    const calls: AssistantModelCompletionInput[] = []
    const model: AssistantModelAdapter = {
      capabilities: {
        streaming: false,
        nativeToolCalling: true,
        jsonSchema: true,
        multimodal: false
      },
      complete: async (input) => {
        calls.push(input)
        if (calls.length === 1) {
          return {
            content: '',
            reasoningContent: '需要先检查平台能力。',
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
      const result = await service.sendMessage({
        sessionId: session.id,
        text: '检查插件能力。第二句话不应进入标题'
      })
      assert.equal(result.status, 'completed')
      assert.equal(calls.length, 2)
      assert.deepEqual(calls[0].tools.map((tool) => tool.eventName), [
        'knowbook.inspect_capabilities',
        'knowbook.inspect_ui_slots',
        'workspace.search',
        'documents.list',
        'documents.get',
        'documents.create',
        'documents.update',
        'plugins.inspect_capabilities',
        'plugins.inspect_standard_modules',
        'plugins.list',
        'plugins.inspect',
        'plugins.define_revision',
        'plugins.validate_revision',
        'plugins.preview_revision',
        'plugins.activate_revision',
        'plugins.stop',
        'plugins.install_workspace',
        'plugins.rollback',
        'plugins.read_diagnostics'
      ])
      assert.equal(calls[0].systemPrompt.includes('npm'), true)
      assert.equal(calls[0].systemPrompt.includes('Button actions never use handlerId'), true)
      assert.equal(calls[0].systemPrompt.includes("action: { handler, arguments? }"), true)
      assert.equal(JSON.stringify(service.getSession(session.id)?.modelConfig).includes('not-persisted'), false)
      assert.equal(service.getSession(session.id)?.title, '检查插件能力。')

      const events = service.listEvents(session.id, 0, 100)
      assert.deepEqual(events.map((event) => event.type), [
        'session.created',
        'session.title.updated',
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
      assert.equal(
        calls[1].messages.find((message) => message.tool)?.reasoningContent,
        '需要先检查平台能力。'
      )
      await service.sendMessage({ sessionId: session.id, text: '继续检查' })
      assert.equal(service.getSession(session.id)?.title, '检查插件能力。')
      assert.equal(
        service.listEvents(session.id).filter((event) => event.type === 'session.title.updated').length,
        1
      )
    } finally {
      await service.destroy()
    }
  })
})

test('assistant buffers whitespace-only streaming deltas without persisting blank chunks', async () => {
  await withStore(async (store) => {
    const model: AssistantModelAdapter = {
      capabilities: {
        streaming: true,
        nativeToolCalling: true,
        jsonSchema: true,
        multimodal: false
      },
      complete: async (input) => {
        await input.onChunk?.(' '.repeat(512))
        await input.onChunk?.('正文')
        await input.onChunk?.('\n'.repeat(512))
        return { content: '正文', toolCalls: [] }
      }
    }
    const service = new AssistantAgentService(
      store.assistantSessions,
      {} as PluginPlatformV2Service,
      {
        workspaceId: 'workspace-1',
        getAiConfig: () => ({
          enabled: true,
          apiKey: 'secret',
          baseUrl: 'https://example.invalid/v1',
          model: 'test-model'
        }),
        modelAdapter: model
      }
    )

    try {
      const session = service.createSession()
      const result = await service.sendMessage({ sessionId: session.id, text: '测试空白流式分片' })
      const events = service.listEvents(session.id, 0, 100)
      const chunks = events.filter((event) => event.type === 'assistant.chunk')

      assert.equal(result.status, 'completed')
      assert.equal(service.getSession(session.id)?.activeTurnId, null)
      assert.equal(chunks.length, 1)
      assert.equal(chunks[0]?.payload.text.trim(), '正文')
      assert.equal(chunks.every((event) => Boolean(event.payload.text.trim())), true)
    } finally {
      await service.destroy()
    }
  })
})

test('assistant plugin repair loop can continue beyond the old twelve-step limit', async () => {
  await withStore(async (store) => {
    let calls = 0
    const model: AssistantModelAdapter = {
      capabilities: {
        streaming: false,
        nativeToolCalling: true,
        jsonSchema: true,
        multimodal: false
      },
      complete: async () => {
        calls += 1
        return calls <= 13
          ? {
              content: '',
              toolCalls: [{ name: 'plugins.inspect_capabilities', arguments: {} }]
            }
          : { content: '修复完成。', toolCalls: [] }
      }
    }
    const platform = {
      authoring: { inspectCapabilities: () => [] },
      getSessionScope: (sessionId: string) => ({
        kind: 'session', workspaceId: 'workspace-1', sessionId
      })
    } as unknown as PluginPlatformV2Service
    const service = new AssistantAgentService(store.assistantSessions, platform, {
      workspaceId: 'workspace-1',
      getAiConfig: () => ({
        enabled: true,
        apiKey: 'secret',
        baseUrl: 'https://example.invalid/v1',
        model: 'test-model'
      }),
      modelAdapter: model
    })

    try {
      const session = service.createSession({ title: '长插件修复' })
      const result = await service.sendMessage({ sessionId: session.id, text: '持续修复插件直到运行' })
      assert.equal(result.status, 'completed')
      assert.equal(calls, 14)
      const events = service.listEvents(session.id, 0, 200)
      assert.equal(events.filter((event) => event.type === 'tool.result').length, 13)
      assert.equal(events.some((event) => event.type === 'session.error'), false)
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
            reasoning_content: 'inspect before acting',
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
      reasoningContent: 'provider replay context',
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
  assert.equal(result.reasoningContent, 'inspect before acting')
  assert.deepEqual(result.usage, { total_tokens: 12 })
  const messages = (requestBody as Record<string, unknown>).messages as Array<Record<string, unknown>>
  assert.equal(Object.hasOwn(requestBody as Record<string, unknown>, 'tool_choice'), false)
  assert.equal((messages[1].tool_calls as Array<{ id: string }>)[0].id, 'host-call-id')
  assert.equal(messages[1].content, '')
  assert.equal(messages[1].reasoning_content, 'provider replay context')
  assert.equal(messages[2].tool_call_id, 'host-call-id')
  assert.equal(JSON.stringify(requestBody).includes('secret'), false)
})

test('OpenAI-compatible adapter rejects invalid API keys before invoking fetch', async () => {
  let fetchCalled = false
  const adapter = new OpenAiCompatibleAssistantModelAdapter({
    fetchImplementation: async () => {
      fetchCalled = true
      return Response.json({})
    }
  })

  await assert.rejects(adapter.complete({
    apiKey: '继续使用已保存的密钥',
    baseUrl: 'https://example.invalid/v1',
    model: 'test-model',
    systemPrompt: 'system',
    messages: [],
    tools: []
  }), /AI API Key contains unsupported non-ASCII or whitespace characters/)
  assert.equal(fetchCalled, false)
})

test('OpenAI-compatible adapter accepts null tool calls and preserves reasoning content verbatim', async () => {
  const adapter = new OpenAiCompatibleAssistantModelAdapter({
    fetchImplementation: async () => Response.json({
      choices: [{
        message: {
          content: 'done',
          reasoning_content: '  provider reasoning  ',
          tool_calls: null
        }
      }]
    })
  })

  const result = await adapter.complete({
    apiKey: 'secret',
    baseUrl: 'https://example.invalid/v1',
    model: 'test-model',
    systemPrompt: 'system',
    messages: [],
    tools: []
  })

  assert.equal(result.content, 'done')
  assert.equal(result.reasoningContent, '  provider reasoning  ')
  assert.deepEqual(result.toolCalls, [])
})

test('OpenAI-compatible adapter normalizes SSE text, incremental tool arguments, and usage', async () => {
  const chunks: string[] = []
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of [
        { choices: [{ delta: { reasoning_content: '先检查', content: '你', tool_calls: null } }] },
        { choices: [{ delta: { reasoning_content: '能力', content: '好', tool_calls: [{ index: 0, function: { name: 'plugins_inspect_capabilities', arguments: '{' } }] } }] },
        { choices: [{ delta: { reasoning_content: null, tool_calls: [{ index: 0, function: { name: null, arguments: '}' } }] } }], usage: { total_tokens: 9 } },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: null, arguments: null } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: null }] } }] },
        { choices: [{ delta: { tool_calls: null } }] }
      ]) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    }
  })
  const adapter = new OpenAiCompatibleAssistantModelAdapter({
    fetchImplementation: async () => new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' }
    })
  })
  const result = await adapter.complete({
    apiKey: 'secret',
    baseUrl: 'https://example.invalid/v1',
    model: 'test-model',
    systemPrompt: 'system',
    messages: [],
    tools: [{
      name: 'plugins_inspect_capabilities',
      eventName: 'plugins.inspect_capabilities',
      description: 'Inspect',
      parameters: { type: 'object' }
    }],
    onChunk: (text) => { chunks.push(text) }
  })
  assert.equal(result.content, '你好')
  assert.equal(result.reasoningContent, '先检查能力')
  assert.deepEqual(chunks, ['你', '好'])
  assert.deepEqual(result.toolCalls, [{ name: 'plugins.inspect_capabilities', arguments: {} }])
  assert.deepEqual(result.usage, { total_tokens: 9 })
})

test('OpenAI-compatible adapter tolerates cumulative tool-argument snapshots', async () => {
  const completeArguments = JSON.stringify({
    pluginId: 'appearance-theme-toggle',
    workerSource: 'export default {}'
  })
  const response = sseResponse([
    {
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            function: {
              name: 'plugins_define_revision',
              arguments: completeArguments.slice(0, 18)
            }
          }]
        }
      }]
    },
    {
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            function: { name: null, arguments: completeArguments }
          }]
        },
        finish_reason: 'tool_calls'
      }]
    },
    {
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            function: { name: null, arguments: completeArguments }
          }]
        }
      }]
    }
  ])
  const adapter = new OpenAiCompatibleAssistantModelAdapter({
    fetchImplementation: async () => response
  })

  const result = await adapter.complete({
    apiKey: 'secret',
    baseUrl: 'https://example.invalid/v1',
    model: 'test-model',
    systemPrompt: 'system',
    messages: [],
    tools: [{
      name: 'plugins_define_revision',
      eventName: 'plugins.define_revision',
      description: 'Define',
      parameters: { type: 'object' }
    }]
  })

  assert.deepEqual(result.toolCalls, [{
    name: 'plugins.define_revision',
    arguments: JSON.parse(completeArguments)
  }])
})

test('OpenAI-compatible adapter recovers duplicated names and tagged arguments without leaking tool markup', async () => {
  const manifest = {
    schemaVersion: 2,
    id: 'theme-switcher',
    name: 'Theme Switcher',
    version: '1.0.0',
    apiVersion: '2',
    permissions: [],
    standardModules: []
  }
  const taggedCall = [
    '<tool_call>',
    '<function=plugins_define_revision>',
    `<parameter=manifest>${JSON.stringify(manifest)}</parameter>`,
    '<parameter=workerSource>export default {};\\n</parameter>',
    '<parameter=views>{}</parameter>',
    '<parameter=previousRevisionId>null</parameter>',
    '</function>',
    '</tool_call>'
  ].join('\n')
  const response = sseResponse([
    { choices: [{ delta: { content: '<tool_' } }] },
    {
      choices: [{
        delta: {
          content: taggedCall.slice('<tool_'.length),
          tool_calls: [{
            index: 0,
            function: {
              name: 'plugins_define_revision',
              arguments: '{"manifest":'
            }
          }]
        }
      }]
    },
    {
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            function: { name: 'plugins_define_revision', arguments: '' }
          }]
        },
        finish_reason: 'tool_calls'
      }]
    }
  ])
  const chunks: string[] = []
  const adapter = new OpenAiCompatibleAssistantModelAdapter({
    fetchImplementation: async () => response
  })

  const result = await adapter.complete({
    apiKey: 'secret',
    baseUrl: 'https://example.invalid/v1',
    model: 'test-model',
    systemPrompt: 'system',
    messages: [],
    tools: [{
      name: 'plugins_define_revision',
      eventName: 'plugins.define_revision',
      description: 'Define',
      parameters: {
        type: 'object',
        properties: {
          manifest: { type: 'object' },
          workerSource: { type: 'string' },
          views: {},
          previousRevisionId: { type: ['string', 'null'] }
        },
        required: ['manifest', 'workerSource']
      }
    }],
    onChunk: (text) => { chunks.push(text) }
  })

  assert.equal(result.content, '')
  assert.deepEqual(chunks, [])
  assert.deepEqual(result.toolCalls, [{
    name: 'plugins.define_revision',
    arguments: {
      manifest,
      workerSource: 'export default {};\n',
      views: {},
      previousRevisionId: null
    }
  }])
})

test('OpenAI-compatible adapter treats a repeated complete tool name as a snapshot', async () => {
  const response = sseResponse([
    {
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            function: { name: 'plugins_define_revision', arguments: '{"worker' }
          }]
        }
      }]
    },
    {
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            function: { name: 'plugins_define_revision', arguments: 'Source":"ok"}' }
          }]
        },
        finish_reason: 'tool_calls'
      }]
    }
  ])
  const adapter = new OpenAiCompatibleAssistantModelAdapter({
    fetchImplementation: async () => response
  })

  const result = await adapter.complete({
    apiKey: 'secret',
    baseUrl: 'https://example.invalid/v1',
    model: 'test-model',
    systemPrompt: 'system',
    messages: [],
    tools: [{
      name: 'plugins_define_revision',
      eventName: 'plugins.define_revision',
      description: 'Define',
      parameters: { type: 'object' }
    }]
  })

  assert.deepEqual(result.toolCalls, [{
    name: 'plugins.define_revision',
    arguments: { workerSource: 'ok' }
  }])
})

test('malformed streamed tool arguments become a failed, non-executing tool result that the model can repair', async () => {
  const malformedResponse = sseResponse([
    {
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            function: {
              name: 'plugins_define_revision',
              arguments: '{"manifest":{"id":"broken"}'
            }
          }]
        },
        finish_reason: 'length'
      }]
    }
  ])
  const model = new OpenAiCompatibleAssistantModelAdapter({
    fetchImplementation: async () => malformedResponse
  })
  const firstCompletion = await model.complete({
    apiKey: 'secret',
    baseUrl: 'https://example.invalid/v1',
    model: 'test-model',
    systemPrompt: 'system',
    messages: [],
    tools: [{
      name: 'plugins_define_revision',
      eventName: 'plugins.define_revision',
      description: 'Define',
      parameters: { type: 'object' }
    }]
  })

  assert.equal(firstCompletion.toolCalls[0]?.name, 'plugins.define_revision')
  assert.deepEqual(firstCompletion.toolCalls[0]?.arguments, {})
  assert.match(firstCompletion.toolCalls[0]?.argumentsError ?? '', /invalid streaming arguments/)

  await withStore(async (store) => {
    const calls: AssistantModelCompletionInput[] = []
    const recoveringModel: AssistantModelAdapter = {
      capabilities: {
        streaming: false,
        nativeToolCalling: true,
        jsonSchema: true,
        multimodal: false
      },
      complete: async (input) => {
        calls.push(input)
        if (calls.length === 1) {
          return {
            content: '',
            toolCalls: [{
              name: 'plugins.define_revision',
              arguments: {},
              argumentsError: 'Assistant tool "plugins_define_revision" returned invalid streaming arguments.'
            }]
          }
        }
        return { content: '参数已重新生成。', toolCalls: [] }
      }
    }
    const service = new AssistantAgentService(store.assistantSessions, {} as PluginPlatformV2Service, {
      workspaceId: 'workspace-1',
      getAiConfig: () => ({
        enabled: true,
        apiKey: 'secret',
        baseUrl: 'https://example.invalid/v1',
        model: 'test-model'
      }),
      modelAdapter: recoveringModel
    })

    try {
      const session = service.createSession()
      const result = await service.sendMessage({ sessionId: session.id, text: '定义主题插件' })
      assert.equal(result.status, 'completed')
      assert.equal(calls.length, 2)
      assert.equal(calls[1]?.messages.some((message) => (
        message.role === 'tool'
        && message.content.includes('No operation was executed')
      )), true)
      const events = service.listEvents(session.id, 0, 100)
      assert.equal(events.some((event) => event.type === 'session.error'), false)
      assert.equal(events.find((event) => event.type === 'tool.result')?.payload.status, 'failed')
    } finally {
      await service.destroy()
    }
  })
})

test('assistant explicitly disables all tools for adapters without native tool calling', async () => {
  await withStore(async (store) => {
    const observed: AssistantModelCompletionInput[] = []
    const model: AssistantModelAdapter = {
      capabilities: { streaming: false, nativeToolCalling: false, jsonSchema: false, multimodal: false },
      complete: async (input) => {
        observed.push(input)
        return { content: '普通问答可用。', toolCalls: [] }
      }
    }
    const service = new AssistantAgentService(store.assistantSessions, {} as PluginPlatformV2Service, {
      workspaceId: 'workspace-1',
      getAiConfig: () => ({ enabled: true, apiKey: 'secret', baseUrl: 'https://example.invalid/v1', model: 'test' }),
      modelAdapter: model
    })
    try {
      const session = service.createSession()
      assert.equal((await service.sendMessage({ sessionId: session.id, text: '你好' })).status, 'completed')
      assert.deepEqual(observed[0]?.tools, [])
      assert.match(observed[0]?.systemPrompt ?? '', /tools are disabled/i)
      const step = service.listEvents(session.id).find((event) => event.type === 'step.started')
      assert.deepEqual(step?.type === 'step.started' ? step.payload.visibleTools : null, [])
    } finally {
      await service.destroy()
    }
  })
})

test('a running turn can be steered by an inbox message without creating a second turn', async () => {
  await withStore(async (store) => {
    let calls = 0
    let signalStarted!: () => void
    const started = new Promise<void>((resolve) => { signalStarted = resolve })
    const model: AssistantModelAdapter = {
      capabilities: { streaming: false, nativeToolCalling: true, jsonSchema: true, multimodal: false },
      complete: async (input) => {
        calls += 1
        if (calls === 1) {
          signalStarted()
          return await new Promise((_resolve, reject) => {
            input.signal?.addEventListener('abort', () => reject(input.signal?.reason), { once: true })
          })
        }
        return { content: '已按新要求处理。', toolCalls: [] }
      }
    }
    const service = new AssistantAgentService(store.assistantSessions, {} as PluginPlatformV2Service, {
      workspaceId: 'workspace-1',
      getAiConfig: () => ({ enabled: true, apiKey: 'secret', baseUrl: 'https://example.invalid/v1', model: 'test' }),
      modelAdapter: model
    })
    try {
      const session = service.createSession()
      const first = service.sendMessage({ sessionId: session.id, text: '先做 A' })
      await started
      const steered = service.sendMessage({ sessionId: session.id, text: '改为做 B' })
      assert.equal((await first).status, 'cancelled')
      assert.equal((await steered).status, 'completed')
      const events = service.listEvents(session.id, 0, 100)
      assert.equal(events.filter((event) => event.type === 'turn.started').length, 1)
      assert.deepEqual(events.filter((event) => event.type === 'user.message').map((event) => (
        event.type === 'user.message' ? event.payload.text : ''
      )), ['先做 A', '改为做 B'])
      assert.equal(events.some((event) => event.type === 'inbox.message.consumed'), true)
    } finally {
      await service.destroy()
    }
  })
})

test('next-turn inbox messages run in order after the active turn commits', async () => {
  await withStore(async (store) => {
    let calls = 0
    let signalStarted!: () => void
    let finishFirst!: (value: { content: string; toolCalls: [] }) => void
    const started = new Promise<void>((resolve) => { signalStarted = resolve })
    const model: AssistantModelAdapter = {
      capabilities: { streaming: false, nativeToolCalling: true, jsonSchema: true, multimodal: false },
      complete: async () => {
        calls += 1
        if (calls === 1) {
          signalStarted()
          return await new Promise((resolve) => { finishFirst = resolve })
        }
        return { content: '第二轮完成。', toolCalls: [] }
      }
    }
    const service = new AssistantAgentService(store.assistantSessions, {} as PluginPlatformV2Service, {
      workspaceId: 'workspace-1',
      getAiConfig: () => ({ enabled: true, apiKey: 'secret', baseUrl: 'https://example.invalid/v1', model: 'test' }),
      modelAdapter: model
    })
    try {
      const session = service.createSession()
      const first = service.sendMessage({ sessionId: session.id, text: '第一轮' })
      await started
      const queued = await service.sendMessage({ sessionId: session.id, text: '第二轮', mode: 'next-turn' })
      assert.equal(queued.status, 'queued')
      finishFirst({ content: '第一轮完成。', toolCalls: [] })
      assert.equal((await first).status, 'completed')
      await waitUntil(() => service.listEvents(session.id, 0, 100).filter((event) => event.type === 'turn.ended').length === 2)
      const events = service.listEvents(session.id, 0, 100)
      assert.equal(events.filter((event) => event.type === 'turn.started').length, 2)
      assert.deepEqual(events.filter((event) => event.type === 'user.message').map((event) => (
        event.type === 'user.message' ? event.payload.text : ''
      )), ['第一轮', '第二轮'])
    } finally {
      await service.destroy()
    }
  })
})

test('assistant event reads reconcile a committed plugin run from kernel authority', async () => {
  await withStore(async (store) => {
    const session = store.assistantSessions.createSession({
      workspaceId: 'workspace-1',
      title: 'Recovery',
      modelConfig: { model: 'test' }
    })
    const turnId = assistantTurnId('recovery-turn')
    store.assistantSessions.append(session.id, { type: 'turn.started', payload: { turnId } })
    store.assistantSessions.append(session.id, {
      type: 'plugin.run.requested',
      payload: {
        turnId,
        toolCallId: assistantToolCallId('recovery-call'),
        pluginId: 'recovered-plugin',
        revisionId: 'sha256:recovered',
        runId: 'recovered-run'
      }
    })
    const platform = {
      getPluginRunReconciliationState: () => ({
        pluginId: 'recovered-plugin',
        revisionId: 'sha256:recovered',
        runId: 'recovered-run',
        status: 'active',
        epoch: 7,
        error: null
      })
    } as unknown as PluginPlatformV2Service
    const service = new AssistantAgentService(store.assistantSessions, platform, {
      workspaceId: 'workspace-1',
      getAiConfig: () => ({ enabled: false, apiKey: null, baseUrl: '', model: '' }),
      modelAdapter: {
        capabilities: { streaming: false, nativeToolCalling: false, jsonSchema: false, multimodal: false },
        complete: async () => ({ content: 'unused', toolCalls: [] })
      }
    })
    try {
      const reconciled = service.listEvents(session.id, 0, 100).find((event) => event.type === 'plugin.run.succeeded')
      assert.equal(reconciled?.type === 'plugin.run.succeeded' ? reconciled.payload.epoch : null, 7)
    } finally {
      await service.destroy()
    }
  })
})

async function waitUntil(predicate: () => boolean, attempts = 100): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error('Timed out waiting for assistant state.')
}

function sseResponse(events: unknown[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    }
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' }
  })
}

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
