import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AssistantAgentService } from '../src/main/assistant/agent-service.ts'
import { OpenAiCompatibleAssistantModelAdapter } from '../src/main/assistant/model-adapter.ts'
import { KnowbookStore } from '../src/main/database/store.ts'
import type { NoNodePluginRuntimeFactory } from '../src/main/plugin-platform/activation-coordinator.ts'
import { PluginPlatformV2Service } from '../src/main/plugin-platform/platform-service.ts'
import { QuickJsWasiPluginRealm } from '../src/main/plugin-platform/quickjs-realm.ts'

const THEME_PLUGIN_SOURCE = `import { callCapability, definePlugin } from '@knowbook/std/plugin';

export default definePlugin({
  activate() {
    return {
      contributions: [{
        descriptor: { slot: 'settings.sections', id: 'appearance-theme-toggle', order: 10 },
        value: {
          kind: 'view',
          view: {
            version: 1,
            root: {
              type: 'stack',
              gap: 8,
              children: [
                { type: 'text', text: '外观主题', size: 'large' },
                { type: 'text', text: '在深色与浅色模式之间切换。', tone: 'muted' },
                {
                  type: 'select',
                  id: 'theme',
                  label: '主题',
                  value: 'light',
                  options: [
                    { value: 'light', label: '浅色模式' },
                    { value: 'dark', label: '深色模式' }
                  ],
                  action: { handler: 'appearance.set' }
                }
              ]
            }
          }
        }
      }]
    };
  },
  handlers: {
    async 'appearance.set'(input) {
      const theme = input && input.control ? input.control.value : null;
      if (theme !== 'light' && theme !== 'dark') throw new Error('Invalid theme selection.');
      return callCapability({
        capability: 'ui.theme.write',
        version: 1,
        input: { theme }
      });
    }
  }
});
`

const THEME_PLUGIN_INPUT = {
  manifest: {
    schemaVersion: 2,
    id: 'appearance-theme-toggle',
    name: '深浅色模式切换',
    version: '1.0.0',
    apiVersion: '2',
    permissions: [{
      capability: 'ui.theme.write',
      version: 1,
      reason: 'Apply the user-selected KnowBook appearance theme.'
    }],
    standardModules: [{ id: '@knowbook/std/plugin', version: '1.0.0' }]
  },
  workerSource: THEME_PLUGIN_SOURCE,
  previousRevisionId: null
}

test('MiMo-style streaming builds, immediately activates, and runs a workspace theme plugin', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-assistant-theme-plugin-'))
  const store = new KnowbookStore(join(root, 'knowbook.sqlite'))
  const runtimeFactory: NoNodePluginRuntimeFactory = {
    isolation: 'no-node-isolate',
    create: async (context) => await QuickJsWasiPluginRealm.create({
      identity: context.identity,
      package: context.package,
      callCapability: async (_owner, call) => await context.callCapability(call)
    })
  }
  const platform = new PluginPlatformV2Service(store, join(root, 'plugin-revisions'), {
    workspaceId: 'workspace-1',
    runtimeFactory,
    setAppearanceTheme: (theme) => {
      store.setAppearanceTheme(theme)
    }
  })
  const requests: Array<Record<string, unknown>> = []
  let completionNumber = 0
  const adapter = new OpenAiCompatibleAssistantModelAdapter({
    fetchImplementation: async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>
      requests.push(request)
      completionNumber += 1
      switch (completionNumber) {
        case 1:
          return mimoToolStream('plugins_inspect_capabilities', {}, '先检查可用权限。')
        case 2:
          return mimoToolStream('plugins_inspect_standard_modules', {}, '再检查标准模块。')
        case 3:
          return mimoToolStream('knowbook_inspect_ui_slots', {}, '检查设置页 UI 插槽。')
        case 4:
          return mimoToolStream('plugins_list', {}, '确认当前插件状态。')
        case 5:
          return mimoToolStream('plugins_define_revision', THEME_PLUGIN_INPUT, '创建不可变主题插件 revision。')
        case 6: {
          const revisionId = requireRevisionId(request)
          return mimoToolStream('plugins_validate_revision', {
            pluginId: 'appearance-theme-toggle',
            revisionId
          }, '检查静态验证结果。')
        }
        case 7: {
          const revisionId = requireRevisionId(request)
          return mimoToolStream('plugins_preview_revision', {
            pluginId: 'appearance-theme-toggle',
            revisionId
          }, '预览代码、权限和贡献。')
        }
        case 8: {
          const revisionId = requireRevisionId(request)
          return mimoToolStream('plugins_activate_revision', {
            pluginId: 'appearance-theme-toggle',
            revisionId,
            summary: '在当前会话启用深色与浅色模式切换控件。'
          }, '请求用户批准激活精确 revision。')
        }
        case 9:
          return mimoTextStream('主题切换插件已经激活，可在设置页面选择浅色或深色模式。')
        default:
          throw new Error(`Unexpected model completion ${completionNumber}.`)
      }
    }
  })
  const agent = new AssistantAgentService(store.assistantSessions, platform, {
    workspaceId: 'workspace-1',
    getAiConfig: () => ({
      enabled: true,
      apiKey: 'test-secret',
      baseUrl: 'https://example.invalid/v1',
      model: 'mimo-test'
    }),
    modelAdapter: adapter
  })

  try {
    const session = agent.createSession({ title: '主题插件完整测试' })
    const completed = await agent.sendMessage({
      sessionId: session.id,
      text: '做一个深色模式和浅色模式切换的插件'
    })
    assert.equal(completed.status, 'completed')
    assert.equal(completionNumber, 9)

    const activationEvents = agent.listEvents(session.id, 0, 200)
    assert.equal(activationEvents.some((event) => event.type === 'session.error'), false)
    assert.equal(JSON.stringify(activationEvents).includes('ui.theme.write'), true)
    assert.deepEqual(
      activationEvents.filter((event) => event.type === 'tool.call').map((event) => (
        event.type === 'tool.call' ? event.payload.tool : ''
      )),
      [
        'plugins.inspect_capabilities',
        'plugins.inspect_standard_modules',
        'knowbook.inspect_ui_slots',
        'plugins.list',
        'plugins.define_revision',
        'plugins.validate_revision',
        'plugins.preview_revision',
        'plugins.activate_revision'
      ]
    )
    assert.equal(activationEvents.some((event) => event.type === 'approval.requested'), true)
    assert.equal(activationEvents.some((event) => (
      event.type === 'approval.resolved' && event.payload.decision === 'allowed-once'
    )), true)

    const definition = store.pluginPlatform.getDefinition('appearance-theme-toggle')
    assert.ok(definition?.currentRevisionId)
    assert.equal(definition.persistenceScope, 'workspace')
    assert.equal(store.pluginPlatform.getRevision(definition.currentRevisionId)?.staticCheckStatus, 'passed')
    const contribution = platform.listUiContributions('settings.sections').find((entry) => (
      entry.id === 'appearance-theme-toggle'
    ))
    assert.ok(contribution)

    assert.deepEqual(await platform.runUiAction({
      owner: contribution.owner,
      slot: contribution.slot,
      contributionId: contribution.id,
      handler: 'appearance.set',
      control: { id: 'theme', value: 'dark' }
    }), { result: { theme: 'dark' } })
    assert.equal(store.getAppearanceTheme(), 'dark')
    assert.equal(store.getHomeDataPayload(join(root, 'backup')).appearanceTheme, 'dark')

    await platform.runUiAction({
      owner: contribution.owner,
      slot: contribution.slot,
      contributionId: contribution.id,
      handler: 'appearance.set',
      control: { id: 'theme', value: 'light' }
    })
    assert.equal(store.getAppearanceTheme(), 'light')

    const completedEvents = agent.listEvents(session.id, 0, 300)
    assert.equal(completedEvents.some((event) => (
      event.type === 'assistant.message'
      && event.payload.text.includes('主题切换插件已经激活')
    )), true)
    assert.equal(requests.every((request) => !Object.hasOwn(request, 'tool_choice')), true)
    assert.equal(requests.slice(1).every((request) => {
      const messages = request.messages as Array<Record<string, unknown>>
      return messages.filter((message) => message.tool_calls).every((message) => (
        message.content !== null
        && typeof message.reasoning_content === 'string'
      ))
    }), true)
  } finally {
    await agent.destroy()
    await platform.destroy()
    store.destroy()
    rmSync(root, { recursive: true, force: true })
  }
})

function requireRevisionId(request: Record<string, unknown>): string {
  const match = JSON.stringify(request).match(/sha256:[a-f0-9]{64}/)
  assert.ok(match, 'The previous define_revision result must be replayed to the model.')
  return match[0]
}

function mimoToolStream(name: string, args: unknown, reasoningContent: string): Response {
  const encodedArguments = JSON.stringify(args)
  const splitAt = Math.max(1, Math.floor(encodedArguments.length / 2))
  return sseResponse([
    { choices: [{ delta: { reasoning_content: reasoningContent, tool_calls: null } }] },
    {
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            function: { name, arguments: encodedArguments.slice(0, splitAt) }
          }]
        }
      }]
    },
    {
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            function: { name: null, arguments: encodedArguments.slice(splitAt) }
          }]
        },
        finish_reason: 'tool_calls'
      }],
      usage: { total_tokens: 10 }
    },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: null, arguments: null } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: null }] } }] }
  ])
}

function mimoTextStream(content: string): Response {
  return sseResponse([
    { choices: [{ delta: { reasoning_content: '确认激活结果。', tool_calls: null } }] },
    { choices: [{ delta: { content, tool_calls: null }, finish_reason: 'stop' }] }
  ])
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
