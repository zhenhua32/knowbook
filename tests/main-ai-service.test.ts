import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  DocumentDetail,
  PreviewDocumentBlockAiEditInput
} from '../src/shared/contracts.ts'
import {
  buildAiChatCompletionsEndpoint,
  getDocumentSummarySourceVersion,
  normalizeDocumentBlockAiEditResponse,
  normalizeGeneratedDocumentSummary,
  requestAiChatCompletion,
  resolveDocumentBlockAiEditInstruction,
  shouldGenerateDocumentSummary
} from '../src/main/ai-service.ts'
import {
  buildAiAuthorizationHeader,
  normalizeAiApiKey
} from '../src/main/ai-auth.ts'

const defaultRequest = {
  apiKey: 'secret',
  baseUrl: 'https://ai.example.test/v1',
  emptyResponseMessage: 'The AI response was empty.',
  failureLabel: 'AI test request',
  model: 'test-model',
  systemPrompt: 'System prompt',
  temperature: 0.2,
  userPrompt: 'User prompt'
}

function createDocumentDetail(): DocumentDetail {
  return {
    id: 'doc-1',
    title: 'Title',
    path: 'Home/Title',
    summary: 'Summary',
    updatedAt: '2026-01-01T00:00:00.000Z',
    blocks: [{
      id: 'block-1',
      type: 'paragraph',
      content: 'Content',
      checked: false,
      depth: 0,
      parentBlockId: null,
      sortOrder: 0,
      tags: ['tag']
    }],
    children: [],
    outgoingLinks: [],
    backlinks: []
  }
}

function createAiEditInput(
  mode: PreviewDocumentBlockAiEditInput['mode'],
  instruction?: string
): PreviewDocumentBlockAiEditInput {
  return {
    documentId: 'doc-1',
    documentTitle: 'Title',
    documentPath: 'Home/Title',
    documentSummary: 'Summary',
    selectedBlocks: [],
    mode,
    instruction
  }
}

test('AI endpoint builder accepts base URLs and already-complete chat endpoints', () => {
  assert.equal(
    buildAiChatCompletionsEndpoint(' https://ai.example.test/v1/?key=ignored#hash '),
    'https://ai.example.test/v1/chat/completions'
  )
  assert.equal(
    buildAiChatCompletionsEndpoint('https://ai.example.test/v1/chat/completions'),
    'https://ai.example.test/v1/chat/completions'
  )
  assert.equal(
    buildAiChatCompletionsEndpoint('http://localhost:11434/'),
    'http://localhost:11434/chat/completions'
  )
})

test('AI endpoint builder rejects missing, malformed, and non-HTTP URLs', () => {
  assert.throws(() => buildAiChatCompletionsEndpoint('  '), /Missing AI Base URL/)
  assert.throws(() => buildAiChatCompletionsEndpoint('localhost:1234'), /Invalid AI Base URL protocol/)
  assert.throws(() => buildAiChatCompletionsEndpoint('not a url'), /Invalid AI Base URL/)
  assert.throws(() => buildAiChatCompletionsEndpoint('file:///tmp/model'), /Use http:\/\/ or https:\/\//)
})

test('AI API key validation accepts raw ASCII credentials and rejects unsafe header values', () => {
  assert.equal(normalizeAiApiKey('  sk-test_123  '), 'sk-test_123')
  assert.equal(buildAiAuthorizationHeader('sk-test_123'), 'Bearer sk-test_123')
  assert.throws(
    () => normalizeAiApiKey('Bearer sk-test_123'),
    /without the "Bearer " prefix/
  )
  assert.throws(
    () => normalizeAiApiKey('继续使用已保存的密钥'),
    /unsupported non-ASCII or whitespace characters/
  )
  assert.throws(
    () => normalizeAiApiKey('sk-test key'),
    /unsupported non-ASCII or whitespace characters/
  )
})

test('AI completion rejects an invalid stored key before invoking fetch', async () => {
  let fetchCalled = false
  await assert.rejects(
    requestAiChatCompletion({
      ...defaultRequest,
      apiKey: '继续使用已保存的密钥'
    }, {
      fetchImplementation: async () => {
        fetchCalled = true
        return Response.json({})
      }
    }),
    /AI API Key contains unsupported non-ASCII or whitespace characters/
  )
  assert.equal(fetchCalled, false)
})

test('AI completion request sends the expected OpenAI-compatible payload and trims content', async () => {
  let capturedEndpoint = ''
  let capturedInit: RequestInit | undefined
  const result = await requestAiChatCompletion(defaultRequest, {
    fetchImplementation: async (input, init) => {
      capturedEndpoint = input.toString()
      capturedInit = init
      return Response.json({
        choices: [{ message: { content: '  Finished response.  ' } }]
      })
    }
  })

  assert.equal(result, 'Finished response.')
  assert.equal(capturedEndpoint, 'https://ai.example.test/v1/chat/completions')
  assert.equal(capturedInit?.method, 'POST')
  assert.deepEqual(capturedInit?.headers, {
    'Content-Type': 'application/json',
    Authorization: 'Bearer secret'
  })
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    model: 'test-model',
    messages: [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'User prompt' }
    ],
    temperature: 0.2
  })
  assert.ok(capturedInit?.signal instanceof AbortSignal)
})

test('AI completion request reports HTTP, malformed JSON, empty, and network failures', async () => {
  await assert.rejects(
    requestAiChatCompletion(defaultRequest, {
      fetchImplementation: async () => new Response('service unavailable', {
        status: 503,
        statusText: 'Unavailable'
      })
    }),
    /AI test request failed \(503\): service unavailable/
  )

  await assert.rejects(
    requestAiChatCompletion(defaultRequest, {
      fetchImplementation: async () => new Response('not json', { status: 200 })
    }),
    /AI test request returned invalid JSON/
  )

  await assert.rejects(
    requestAiChatCompletion(defaultRequest, {
      fetchImplementation: async () => Response.json({
        choices: [{ message: { content: '   ' } }]
      })
    }),
    /The AI response was empty/
  )

  await assert.rejects(
    requestAiChatCompletion(defaultRequest, {
      fetchImplementation: async () => {
        throw new Error('connection refused')
      }
    }),
    /AI test request failed before the AI service responded.*connection refused/
  )
})

test('AI completion request distinguishes caller cancellation from timeout', async () => {
  const controller = new AbortController()
  const cancellation = new Error('cancelled by caller')
  controller.abort(cancellation)

  await assert.rejects(
    requestAiChatCompletion({
      ...defaultRequest,
      signal: controller.signal
    }, {
      fetchImplementation: async (_input, init) => {
        throw init?.signal?.reason
      }
    }),
    (error) => error === cancellation
  )

  await assert.rejects(
    requestAiChatCompletion(defaultRequest, {
      timeoutMilliseconds: 5,
      fetchImplementation: async (_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })
    }),
    /AI test request timed out after 5 ms/
  )
})

test('summary helpers enforce eligibility, stable source versions, and output cleanup', () => {
  const placeholder = 'New knowledge node ready for editing.'
  assert.equal(shouldGenerateDocumentSummary('', ['x'.repeat(39)], placeholder), false)
  assert.equal(shouldGenerateDocumentSummary(placeholder, ['x'.repeat(40)], placeholder), true)
  assert.equal(shouldGenerateDocumentSummary('Manual summary', ['x'.repeat(80)], placeholder), false)

  const detail = createDocumentDetail()
  const originalVersion = getDocumentSummarySourceVersion(detail)
  assert.equal(getDocumentSummarySourceVersion({
    ...detail,
    updatedAt: '2027-01-01T00:00:00.000Z'
  }), originalVersion)
  assert.notEqual(getDocumentSummarySourceVersion({
    ...detail,
    blocks: [{ ...detail.blocks[0]!, content: 'Changed' }]
  }), originalVersion)

  assert.equal(
    normalizeGeneratedDocumentSummary('  1. “A concise\n summary”  '),
    'A concise summary'
  )
  assert.equal(normalizeGeneratedDocumentSummary(' \n "` '), null)
  assert.equal(normalizeGeneratedDocumentSummary('x'.repeat(140))?.length, 120)
})

test('block AI helpers validate custom instructions and unwrap fenced tables', () => {
  assert.equal(
    resolveDocumentBlockAiEditInstruction(createAiEditInput('rewrite')),
    'Rewrite the selected content for clarity and readability while preserving meaning.'
  )
  assert.equal(
    resolveDocumentBlockAiEditInstruction(createAiEditInput('custom', '  Use a warmer tone.  ')),
    'Use a warmer tone.'
  )
  assert.throws(
    () => resolveDocumentBlockAiEditInstruction(createAiEditInput('custom', '  ')),
    /instruction is required/
  )
  assert.equal(
    normalizeDocumentBlockAiEditResponse('table', '```markdown\n| A |\n|---|\n| B |\n```'),
    '| A |\n|---|\n| B |'
  )
  assert.equal(
    normalizeDocumentBlockAiEditResponse('rewrite', '```markdown\ntext\n```'),
    '```markdown\ntext\n```'
  )
})
