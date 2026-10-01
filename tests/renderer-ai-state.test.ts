import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { act, createElement } from 'react'
import { JSDOM } from 'jsdom'
import { useAiState } from '../src/renderer/src/hooks/useAiState'
import { getUiText } from '../src/renderer/src/i18n'
import type { AskAiInput, AskAiResult, ElectronApi, SearchSemanticNotesInput, SemanticSearchResult } from '../src/shared/contracts'

const hookSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/hooks/useAiState.ts'),
  'utf8'
)

function extractFunction(name: string): string {
  const startIndex = hookSource.indexOf(`const ${name} = useCallback`)
  assert.ok(startIndex !== -1, `expected ${name} to exist in useAiState.ts`)

  const endIndex = hookSource.indexOf('\n  }, [', startIndex)
  assert.ok(endIndex !== -1, `expected ${name} to be a useCallback`)

  return hookSource.slice(startIndex, endIndex)
}

test('AI automation results are ignored when the user switches documents mid-flight', () => {
  const source = extractFunction('runEnabledAiAutomationsOnSelectedDocument')

  assert.match(
    source,
    /const requestedDocumentId = selectedDocumentId/,
    'automation must capture the requested document id before awaiting'
  )

  const refSyncIndex = hookSource.indexOf('selectedDocumentIdRef.current = selectedDocumentId')
  assert.ok(refSyncIndex !== -1, 'hook must track the current selected document id in a ref')

  const guardIndex = source.indexOf('if (selectedDocumentIdRef.current === requestedDocumentId)')
  assert.ok(guardIndex !== -1, 'automation must compare the current selection against the requested id')

  const detailApplyIndex = source.indexOf('onSelectedDocumentChange(refreshedDetail)')
  const summaryApplyIndex = source.indexOf('onDraftSummaryChange(')
  assert.ok(detailApplyIndex > guardIndex, 'document detail must be applied only after the staleness guard')
  assert.ok(summaryApplyIndex > guardIndex, 'draft summary must be applied only after the staleness guard')
})

test('AI automations still refresh home data and report results when the selection changed', () => {
  const source = extractFunction('runEnabledAiAutomationsOnSelectedDocument')

  const homeDataIndex = source.indexOf('onHomeDataChange(refreshedHome)')
  const messageIndex = source.indexOf('onMessage(ui.aiAutomationResult(result))')
  assert.ok(homeDataIndex !== -1, 'home data is global and should stay fresh')
  assert.ok(messageIndex !== -1, 'the automation result message should still be surfaced')
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function relatedNote(documentId: string): SemanticSearchResult {
  return { documentId, title: documentId, path: documentId, summary: '', snippet: documentId, score: 1 }
}

async function withAiState(run: (context: {
  state: () => ReturnType<typeof useAiState>
  selectDocument: (id: string | null) => Promise<void>
  answers: Array<ReturnType<typeof deferred<AskAiResult>> & { input: AskAiInput }>
  searches: Array<ReturnType<typeof deferred<SemanticSearchResult[]>> & { input: SearchSemanticNotesInput }>
}) => Promise<void>, availability = { enabled: true, hasApiKey: true }) {
  const dom = new JSDOM('<div id="mount"></div>')
  const originals = new Map<string, PropertyDescriptor | undefined>()
  const answers: Array<ReturnType<typeof deferred<AskAiResult>> & { input: AskAiInput }> = []
  const searches: Array<ReturnType<typeof deferred<SemanticSearchResult[]>> & { input: SearchSemanticNotesInput }> = []
  const api: Partial<ElectronApi> = {
    askAiAboutDocument: (input) => {
      const request = { ...deferred<AskAiResult>(), input }
      answers.push(request)
      return request.promise
    },
    searchSemanticNotes: (input) => {
      const request = { ...deferred<SemanticSearchResult[]>(), input }
      searches.push(request)
      return request.promise
    }
  }
  Object.defineProperty(dom.window, 'knowbook', { value: api })
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  let state!: ReturnType<typeof useAiState>
  const noop = () => undefined
  const aiConfig = { ...availability, baseUrl: '', model: '', autoSummaryOnSave: false, relatedNotesEnabled: true }
  function Harness({ id }: { id: string | null }) {
    state = useAiState({ aiConfig, selectedDocumentId: id, ui: getUiText('zh-CN'),
      onHomeDataChange: noop, onSelectedDocumentChange: noop, onDraftSummaryChange: noop, onMessage: noop })
    return null
  }
  const selectDocument = async (id: string | null) => {
    await act(async () => root.render(createElement(Harness, { id })))
  }
  try {
    await selectDocument('a')
    await act(async () => state.setAiPromptDraft('  查找资料  '))
    await run({ state: () => state, selectDocument, answers, searches })
  } finally {
    await act(async () => root.unmount())
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
}

function assertEmptySession(state: ReturnType<typeof useAiState>) {
  assert.equal(state.aiAnswer, '')
  assert.equal(state.aiAnsweredPrompt, '')
  assert.equal(state.aiAnswerError, '')
  assert.equal(state.aiFailedPrompt, '')
  assert.deepEqual(state.aiContextResults, [])
  assert.equal(state.aiContextError, '')
  assert.equal(state.aiAsking, false)
  assert.equal(state.aiContextSearching, false)
  assert.equal(state.aiContextHasSearched, false)
}

for (const outcome of ['success', 'failure'] as const) {
  for (const selection of [['b'], [null], ['b', 'a']]) {
    test(`AI session ignores late ${outcome} after selecting ${selection.join(' then ') || 'no document'}`, async () => {
      await withAiState(async ({ state, selectDocument, answers, searches }) => {
        let answerPending!: Promise<void>
        let searchPending!: Promise<void>
        await act(async () => {
          answerPending = state().askAiOnSelectedDocument()
          searchPending = state().findRelatedNotesForPrompt()
        })
        assert.equal(state().aiAsking, true)
        assert.equal(state().aiContextSearching, true)
        assert.deepEqual(answers[0].input, { documentId: 'a', prompt: '查找资料' })
        assert.deepEqual(searches[0].input, { query: '查找资料', excludeDocumentId: 'a', limit: 4 })
        for (const id of selection) await selectDocument(id)
        assertEmptySession(state())
        await act(async () => {
          if (outcome === 'success') {
            answers[0].resolve({ answer: '旧文档回答', references: [] })
            searches[0].resolve([relatedNote('旧文档资料')])
          } else {
            answers[0].reject(new Error('旧文档提问失败'))
            searches[0].reject(new Error('旧文档检索失败'))
          }
          await Promise.all([answerPending, searchPending])
        })
        assertEmptySession(state())
      })
    })
  }

  test(`AI session reset discards old ${outcome} without finishing the new requests`, async () => {
    await withAiState(async ({ state, answers, searches }) => {
      let oldAnswer!: Promise<void>
      let oldSearch!: Promise<void>
      let newAnswer!: Promise<void>
      let newSearch!: Promise<void>
      await act(async () => {
        oldAnswer = state().askAiOnSelectedDocument()
        oldSearch = state().findRelatedNotesForPrompt()
      })
      await act(async () => state().resetAiSession())
      assertEmptySession(state())
      await act(async () => {
        newAnswer = state().askAiOnSelectedDocument()
        newSearch = state().findRelatedNotesForPrompt()
      })
      await act(async () => {
        if (outcome === 'success') {
          answers[0].resolve({ answer: '清空前的回答', references: [] })
          searches[0].resolve([relatedNote('清空前的资料')])
        } else {
          answers[0].reject(new Error('清空前的提问失败'))
          searches[0].reject(new Error('清空前的检索失败'))
        }
        await Promise.all([oldAnswer, oldSearch])
      })
      assert.equal(state().aiAsking, true)
      assert.equal(state().aiContextSearching, true)
      assert.equal(state().aiAnswer, '')
      assert.deepEqual(state().aiContextResults, [])
      assert.equal(state().aiContextError, '')
      await act(async () => {
        answers[1].resolve({ answer: '清空后的回答', references: [] })
        searches[1].resolve([relatedNote('清空后的资料')])
        await Promise.all([newAnswer, newSearch])
      })
      assert.equal(state().aiAnswer, '清空后的回答')
      assert.deepEqual(state().aiContextResults, [relatedNote('清空后的资料')])
      assert.equal(state().aiAsking, false)
      assert.equal(state().aiContextSearching, false)
    })
  })

  test(`AI requests keep the latest answer and notes when older requests finish with ${outcome}`, async () => {
    await withAiState(async ({ state, answers, searches }) => {
      let oldAnswer!: Promise<void>
      let oldSearch!: Promise<void>
      let newAnswer!: Promise<void>
      let newSearch!: Promise<void>
      await act(async () => {
        oldAnswer = state().askAiOnSelectedDocument()
        oldSearch = state().findRelatedNotesForPrompt()
        newAnswer = state().askAiOnSelectedDocument()
        newSearch = state().findRelatedNotesForPrompt()
      })
      await act(async () => {
        answers[1].resolve({ answer: '新回答', references: [] })
        searches[1].resolve([relatedNote('新资料')])
        await Promise.all([newAnswer, newSearch])
      })
      await act(async () => {
        if (outcome === 'success') {
          answers[0].resolve({ answer: '旧回答', references: [] })
          searches[0].resolve([relatedNote('旧资料')])
        } else {
          answers[0].reject(new Error('旧提问失败'))
          searches[0].reject(new Error('旧检索失败'))
        }
        await Promise.all([oldAnswer, oldSearch])
      })
      assert.equal(state().aiAnswer, '新回答')
      assert.deepEqual(state().aiContextResults, [relatedNote('新资料')])
      assert.equal(state().aiContextError, '')
      assert.equal(state().aiAsking, false)
      assert.equal(state().aiContextSearching, false)
    })
  })
}

test('current AI errors still appear and finish their own loading states', async () => {
  await withAiState(async ({ state, answers, searches }) => {
    let answerPending!: Promise<void>
    let searchPending!: Promise<void>
    await act(async () => {
      answerPending = state().askAiOnSelectedDocument()
      searchPending = state().findRelatedNotesForPrompt()
    })
    await act(async () => {
      answers[0].reject(new Error('当前提问失败'))
      searches[0].reject(new Error('当前检索失败'))
      await Promise.all([answerPending, searchPending])
    })
    assert.equal(state().aiAnswer, '')
    assert.equal(state().aiAnswerError, '当前提问失败')
    assert.equal(state().aiFailedPrompt, '查找资料')
    assert.equal(state().aiContextError, '当前检索失败')
    assert.deepEqual(state().aiContextResults, [])
    assert.equal(state().aiAsking, false)
    assert.equal(state().aiContextSearching, false)
  })
})

test('a failed AI answer preserves related notes found while it was running', async () => {
  await withAiState(async ({ state, answers, searches }) => {
    let answerPending!: Promise<void>
    let searchPending!: Promise<void>
    await act(async () => {
      answerPending = state().askAiOnSelectedDocument()
      searchPending = state().findRelatedNotesForPrompt()
    })
    await act(async () => {
      searches[0].resolve([relatedNote('已找到的资料')])
      await searchPending
    })
    await act(async () => {
      answers[0].reject(new Error('提问失败'))
      await answerPending
    })
    assert.equal(state().aiAnswer, '')
    assert.equal(state().aiAnswerError, '提问失败')
    assert.deepEqual(state().aiContextResults, [relatedNote('已找到的资料')])
  })
})

test('related note search distinguishes an unsearched prompt from a completed empty search', async () => {
  await withAiState(async ({ state, searches, selectDocument }) => {
    assert.equal(state().aiContextHasSearched, false)
    let search!: Promise<void>
    await act(async () => { search = state().findRelatedNotesForPrompt() })
    assert.equal(state().aiContextSearching, true)
    await act(async () => { searches[0].resolve([]); await search })
    assert.equal(state().aiContextHasSearched, true)
    assert.deepEqual(state().aiContextResults, [])
    await selectDocument('b')
    assert.equal(state().aiContextHasSearched, false)
  })
})

test('retry uses the failed document and question without replacing a newer draft', async () => {
  await withAiState(async ({ state, answers, selectDocument }) => {
    let request!: Promise<void>
    await act(async () => { request = state().askAiOnSelectedDocument() })
    await act(async () => state().setAiPromptDraft('正在准备的下一条问题'))
    await act(async () => { answers[0].reject(new Error('连接失败')); await request })
    assert.equal(state().aiFailedPrompt, '查找资料')
    assert.equal(state().aiPromptDraft, '正在准备的下一条问题')
    assert.equal(state().aiAnswer, '')
    await act(async () => { request = state().retryFailedAiRequest() })
    assert.deepEqual(answers[1].input, { documentId: 'a', prompt: '查找资料' })
    assert.equal(state().aiAnswerError, '')
    assert.equal(state().aiAsking, true)
    await act(async () => { answers[1].resolve({ answer: '**重新回答**', references: [] }); await request })
    assert.equal(state().aiAnswer, '**重新回答**')
    assert.equal(state().aiAnsweredPrompt, '查找资料')
    assert.equal(state().aiAnswerError, '')
    assert.equal(state().aiFailedPrompt, '')
    assert.equal(state().aiPromptDraft, '正在准备的下一条问题')
    await selectDocument('b')
    await act(async () => { await state().retryFailedAiRequest() })
    assert.equal(answers.length, 2)
  })
})

test('starting another question clears the previous answer and failure state', async () => {
  await withAiState(async ({ state, answers }) => {
    let request!: Promise<void>
    await act(async () => { request = state().askAiOnSelectedDocument() })
    await act(async () => { answers[0].resolve({ answer: '上一条回答', references: [] }); await request })
    await act(async () => { state().setAiPromptDraft('新的问题') })
    await act(async () => { request = state().askAiOnSelectedDocument() })
    assert.equal(state().aiAnswer, '')
    assert.equal(state().aiAnswerError, '')
    assert.equal(state().aiFailedPrompt, '')
    assert.equal(state().aiAnsweredPrompt, '')
    await act(async () => { answers[1].reject(new Error('新的提问失败')); await request })
    assert.equal(state().aiAnswer, '')
    assert.equal(state().aiAnswerError, '新的提问失败')
    assert.equal(state().aiFailedPrompt, '新的问题')
  })
})

for (const availability of [{ enabled: false, hasApiKey: true }, { enabled: true, hasApiKey: false }]) {
  test(`AI questions require ready configuration while local note search remains available ${JSON.stringify(availability)}`, async () => {
    await withAiState(async ({ state, answers, searches }) => {
      await act(async () => { await state().askAiOnSelectedDocument() })
      assert.equal(answers.length, 0)
      assert.equal(state().aiAsking, false)
      let search!: Promise<void>
      await act(async () => { search = state().findRelatedNotesForPrompt() })
      assert.equal(searches.length, 1)
      await act(async () => { searches[0].resolve([]); await search })
      assert.equal(state().aiContextHasSearched, true)
    }, availability)
  })
}
