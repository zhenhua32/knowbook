import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf8')
}

function extractUseCallback(source: string, name: string): string {
  const startIndex = source.indexOf(`const ${name} = useCallback`)
  assert.ok(startIndex !== -1, `expected ${name} to exist`)

  const endIndex = source.indexOf('\n  }, [', startIndex)
  assert.ok(endIndex !== -1, `expected ${name} to be a useCallback`)

  return source.slice(startIndex, endIndex)
}

test('block textarea ref registry clears slots only for the detached element', () => {
  const source = readSource('src/renderer/src/components/BlockEditorRow.tsx')

  const refIndex = source.indexOf('const slots = blockTextareaRefs.current')
  assert.ok(refIndex !== -1, 'the textarea ref must keep writing into the shared slot array')

  const refCallback = source.slice(source.lastIndexOf('ref={(element)', refIndex), refIndex + 260)
  assert.match(
    refCallback,
    /const previousElement = textareaRef\.current/,
    'the ref callback must capture the previous element before overwriting textareaRef'
  )
  assert.match(
    refCallback,
    /slots\[index\] = element/,
    'attach must register the element into its slot'
  )
  assert.match(
    refCallback,
    /slots\[index\] === previousElement/,
    'detach must clear a slot only when it still holds the detached element'
  )
})

test('block reference navigation flash is wired to row rendering', () => {
  const presentation = readSource('src/renderer/src/hooks/useDocumentsBlockEditorPresentation.ts')
  const section = readSource('src/renderer/src/sections/DocumentsSection.tsx')

  assert.doesNotMatch(
    presentation,
    /isHighlighted: false/,
    'the shared row props must not hardcode isHighlighted to false'
  )
  assert.match(
    presentation,
    /highlightedBlockId/,
    'the presentation hook must consume the highlighted block id'
  )
  assert.match(
    presentation,
    /block\.id === highlightedBlockId/,
    'rows must be highlighted by comparing their block id against the highlighted block id'
  )
  assert.match(
    section,
    /isHighlighted=\{row\.isHighlighted\}/,
    'the documents section must forward the per-row highlight state'
  )
})

test('undo history is only pushed when an operation will actually mutate', () => {
  const multiActions = readSource('src/renderer/src/hooks/useMultiBlockActions.ts')
  const adjust = extractUseCallback(multiActions, 'adjustSelectedBlocksDepth')
  const firstMutation = adjust.indexOf('setDraftBlocks(')
  const pushIndex = adjust.indexOf('pushToHistory(draftBlocks)')
  assert.ok(pushIndex > -1, 'adjustSelectedBlocksDepth must push history')
  assert.ok(
    pushIndex > firstMutation - adjust.length && pushIndex > adjust.indexOf('appliedDelta === 0'),
    'history must be pushed after the no-op guards, right before the mutation'
  )

  const singleActions = readSource('src/renderer/src/hooks/useSingleBlockTreeActions.ts')
  const merge = extractUseCallback(singleActions, 'mergeWithPreviousBlock')
  const mergePush = merge.indexOf('pushToHistory(draftBlocks)')
  const mergeGuard = merge.indexOf('if (!isMergeable)')
  assert.ok(mergeGuard !== -1 && mergePush > mergeGuard, 'merge must not push history before the isMergeable guard')

  const inputActions = readSource('src/renderer/src/hooks/useBlockInputActions.ts')
  const paste = extractUseCallback(inputActions, 'handleBlockPaste')
  const firstPush = paste.indexOf('pushToHistory(draftBlocks)')
  const emptyParseGuard = paste.indexOf('nextBlocks.length === 0')
  const singleLineGuard = paste.indexOf("if (!normalizedText.includes('\\n'))")
  assert.ok(emptyParseGuard !== -1 && singleLineGuard !== -1, 'paste guards must exist')
  assert.ok(
    firstPush > emptyParseGuard,
    'the structured-paste path must push history only after its empty-parse guard'
  )
  const pushAfterSingleLineGuard = paste.indexOf('pushToHistory(draftBlocks)', singleLineGuard)
  assert.ok(
    pushAfterSingleLineGuard > singleLineGuard,
    'the plain multiline paste path must push history after the single-line guard'
  )
  assert.ok(paste.split('pushToHistory(draftBlocks)').length - 1 >= 2, 'each accepted paste mutation path must push history once')
})

test('background value refresh does not clobber an open catalog cell editor', () => {
  const source = readSource('src/renderer/src/components/database/DatabaseSectionComponents.tsx')

  const cellIndex = source.indexOf('const DocumentCatalogFieldCell = memo')
  assert.ok(cellIndex !== -1, 'the catalog field cell must exist')
  const cellSource = source.slice(cellIndex, cellIndex + 4000)

  const effectIndex = cellSource.indexOf('useEffect(() => {')
  const effectEnd = cellSource.indexOf('})', cellSource.indexOf('}, [', effectIndex))
  const effectBody = cellSource.slice(effectIndex, effectEnd)
  assert.match(
    effectBody,
    /if \(isEditing\)/,
    'the value-sync effect must skip while the cell editor is open'
  )
  assert.match(
    effectBody,
    /}, \[isEditing, value\]\)/,
    'the effect must re-run when editing state changes'
  )
})
