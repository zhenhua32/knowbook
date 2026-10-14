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

  const refCallback = source.slice(source.lastIndexOf('const registerTextarea', refIndex), refIndex + 260)
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
  const planGuard = adjust.indexOf('if (!plan) return')
  assert.ok(pushIndex > -1, 'adjustSelectedBlocksDepth must push history')
  assert.ok(
    planGuard !== -1 && pushIndex > planGuard && pushIndex < firstMutation,
    'history must be pushed after the no-op guards, right before the mutation'
  )

  const singleActions = readSource('src/renderer/src/hooks/useSingleBlockTreeActions.ts')
  const merge = extractUseCallback(singleActions, 'mergeWithPreviousBlock')
  const mergePush = merge.indexOf('pushToHistory(draftBlocks)')
  const mergeGuard = merge.indexOf('if (!isMergeable)')
  assert.ok(mergeGuard !== -1 && mergePush > mergeGuard, 'merge must not push history before the isMergeable guard')

  const inputActions = readSource('src/renderer/src/hooks/useBlockInputActions.ts')
  const paste = extractUseCallback(inputActions, 'handleBlockPaste')
  const containerStart = paste.indexOf('if (!activeRange && isContainerBlockType(current.type))')
  const ordinaryStart = paste.indexOf('let parsed = parsePastedMarkdown(before + text + after)')
  const singleLineGuard = paste.indexOf("if (!activeRange && !text.includes('\\n'))")
  assert.ok(containerStart > singleLineGuard && singleLineGuard !== -1 && ordinaryStart > containerStart,
    'both paste paths must follow the native single-line/no-op guard')
  const containerPaste = paste.slice(containerStart, ordinaryStart)
  const ordinaryPaste = paste.slice(ordinaryStart)
  for (const [label, path] of [['container title', containerPaste], ['ordinary block', ordinaryPaste]]) {
    const planGuard = path.indexOf('if (!plan) return false')
    const push = path.indexOf('pushToHistory(draftBlocks)')
    const mutation = path.indexOf('setDraftBlocks(')
    assert.ok(planGuard !== -1 && push > planGuard && mutation > push,
      `${label} history must follow the no-op plan guard, right before its mutation`)
    assert.equal(path.split('pushToHistory(draftBlocks)').length - 1, 1,
      `${label} paste mutation records history exactly once`)
  }
  const emptyParseGuard = ordinaryPaste.indexOf('if (!parsed.length)')
  assert.ok(emptyParseGuard !== -1 && ordinaryPaste.indexOf('pushToHistory(draftBlocks)') > emptyParseGuard,
    'ordinary paste history must follow its empty parse guard')
  assert.ok(containerPaste.indexOf('return true') > containerPaste.indexOf('setDraftBlocks('),
    'the completed container branch must return before the ordinary branch can record history')

})

test('background value refresh does not clobber an open catalog cell editor', () => {
  const source = readSource('src/renderer/src/features/database/components/DatabaseValueEditor.tsx')

  const cellIndex = source.indexOf('export function DatabaseValueEditor')
  assert.ok(cellIndex !== -1, 'the unified database value editor must exist')
  const componentSource = source.slice(cellIndex)
  const nextTopLevelFunction = componentSource.search(/\r?\n(?:export\s+)?function\s/)
  const cellSource = nextTopLevelFunction === -1 ? componentSource : componentSource.slice(0, nextTopLevelFunction)

  const effectIndex = cellSource.indexOf('useEffect(() => {')
  const effectEnd = cellSource.indexOf('})', cellSource.indexOf('}, [', effectIndex))
  const effectBody = cellSource.slice(effectIndex, effectEnd)
  assert.match(
    effectBody,
    /if \(isEditing\)/,
    'the value-sync effect must skip while the unified cell editor is open'
  )
  const dependencyMatch = effectBody.match(/},\s*\[([^\]]*)\]\)/)
  assert.ok(dependencyMatch, 'the value-sync effect must declare its dependencies')
  const dependencies = new Set(dependencyMatch[1].split(',').map(name => name.trim()))
  assert.ok(dependencies.has('isEditing') && dependencies.has('value'),
    'the effect must re-run when editing state or the persisted value changes')
})
