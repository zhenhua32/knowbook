import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { computeSlashPanelPosition } from '../src/renderer/src/utils/menuPosition.ts'
import { getUiText } from '../src/renderer/src/i18n.ts'

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf8')
}

const rectLike = {
  left: 100,
  top: 200,
  width: 400,
  height: 120
} as DOMRect

test('slash panel position never produces NaN and falls back for keyword line heights', () => {
  const px = computeSlashPanelPosition(rectLike, '24px', '16px', 'hello ')
  assert.equal(px.x, 100 + 6 * 16 * 0.55)
  assert.equal(px.y, 200 + 0 + 24 + 10)

  const normal = computeSlashPanelPosition(rectLike, 'normal', '16px', 'ab')
  assert.equal(Number.isFinite(normal.x), true)
  assert.equal(Number.isFinite(normal.y), true)
  assert.equal(normal.y, 200 + 16 * 1.5 + 10)

  const missing = computeSlashPanelPosition(rectLike, '', '', 'abc')
  assert.equal(Number.isFinite(missing.x), true)
  assert.equal(Number.isFinite(missing.y), true)
})

test('slash panel position clamps inside the textarea viewport', () => {
  const longLine = 'x'.repeat(500)
  const clamped = computeSlashPanelPosition(rectLike, '20px', '16px', longLine)
  assert.ok(clamped.x <= rectLike.left + rectLike.width - 8, 'x must stay inside the textarea')
  assert.ok(clamped.x >= rectLike.left)
})

test('cjk characters count their full glyph width when estimating the caret offset', () => {
  const cjkOffset = computeSlashPanelPosition(rectLike, '20px', '16px', '数据库')
  const asciiOffset = computeSlashPanelPosition(rectLike, '20px', '16px', 'aaa')
  assert.equal(cjkOffset.x - rectLike.left, 3 * 16)
  assert.ok((asciiOffset.x - rectLike.left) < (cjkOffset.x - rectLike.left))
})

test('i18n exposes the low-severity strings in both languages', () => {
  for (const language of ['zh-CN', 'en-US'] as const) {
    const ui = getUiText(language)
    assert.match(ui.dropAfterLabel, /./)
    assert.match(ui.dropBeforeLabel, /./)
    assert.match(ui.selectionStaleGuard, /./)
    assert.match(ui.documentCreateFailed, /./)
    assert.match(ui.documentNotFoundMessage, /./)
    assert.equal(typeof ui.entityFallbackLabel('abcd1234'), 'string')
    assert.match(ui.entityFallbackLabel('abcd1234'), /abcd1234/)
  }
})

test('hardcoded english strings are replaced with localized lookups', () => {
  assert.doesNotMatch(
    readSource('src/renderer/src/utils/draftTreePlacement.ts'),
    /'(Drop after|Drop before)'/
  )
  assert.doesNotMatch(
    readSource('src/renderer/src/hooks/useBlockSelectionState.ts'),
    /The current selection no longer maps to visible rows/
  )
  assert.doesNotMatch(
    readSource('src/renderer/src/hooks/useWorkspaceDocumentManagement.ts'),
    /'Failed to create document\.'|'Document not found'/
  )
  assert.doesNotMatch(
    readSource('src/renderer/src/sections/DatabaseSection.tsx'),
    /`Entity \$\{/
  )

  const placement = readSource('src/renderer/src/utils/draftTreePlacement.ts')
  assert.match(placement, /getActiveUiText\(\)\.dropAfterLabel/)
  assert.match(placement, /getActiveUiText\(\)\.dropBeforeLabel/)
})

test('render-phase side effects move into effects', () => {
  const appSource = readSource('src/renderer/src/App.tsx')
  const assignmentIndex = appSource.indexOf('resetAiSessionRef.current = featureDomains.ai.resetAiSession')
  assert.ok(assignmentIndex !== -1, 'the ref sync must still exist')
  const effectStart = appSource.lastIndexOf('useEffect(', assignmentIndex)
  assert.ok(
    effectStart !== -1 && effectStart > appSource.indexOf('useAppKeyboardShortcuts'),
    'resetAiSessionRef sync must happen inside a useEffect'
  )

  const shellSource = readSource('src/renderer/src/hooks/useAppShellState.ts')
  const shellSync = shellSource.indexOf('setActiveUiLanguage(uiLanguage)')
  assert.ok(shellSync !== -1)
  const shellEffect = shellSource.lastIndexOf('useEffect(', shellSync)
  assert.ok(
    shellEffect !== -1 && shellEffect > shellSource.indexOf('export function useAppShellState'),
    'global ui-language sync must run inside an effect'
  )
})

test('database page effects depend on stable fields instead of the whole domain object', () => {
  const source = readSource('src/renderer/src/pages/DatabasePage.tsx')

  const entityEffectIndex = source.indexOf("database.setSelectedDatabaseEntityIds")
  assert.ok(entityEffectIndex !== -1)
  const firstDeps = source.slice(source.indexOf('}, [', entityEffectIndex))
  const firstDepsArray = firstDeps.slice(firstDeps.indexOf('['), firstDeps.indexOf(']'))
  assert.match(firstDepsArray, /filteredStandaloneDatabaseEntityIds/)
  assert.doesNotMatch(firstDepsArray, /\n\s*database,\s*\n/, 'bare `database` dependency must be removed')

  const boardEffectIndex = source.indexOf('database.setBoardGroupBy(BOARD_GROUP_BY_PARENT)')
  assert.ok(boardEffectIndex !== -1)
  const boardDepsStart = source.indexOf('}, [', boardEffectIndex)
  const boardDeps = source.slice(boardDepsStart, source.indexOf(']', boardDepsStart))
  assert.match(boardDeps, /boardGroupableColumns/)
  assert.doesNotMatch(boardDeps, /,\s*database\s*,/)
})
