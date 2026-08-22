import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

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
