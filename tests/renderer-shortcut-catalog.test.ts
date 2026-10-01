import assert from 'node:assert/strict'
import test from 'node:test'
import { filterShortcuts, shortcutKeyLabel, shortcuts } from '../src/renderer/src/utils/shortcutCatalog'
import { PAGE_ORDER } from '../src/renderer/src/hooks/useAppShellState'
import { markdownFormatShortcut } from '../src/renderer/src/utils/markdownFormatting'

test('shortcut search accepts Chinese, English and exact platform key aliases', () => {
  for (const query of ['加粗', 'bold', 'Ctrl+B', 'Control + B', '⌘B', 'Cmd+B', 'Command B']) {
    assert.deepEqual(filterShortcuts(query).map((item) => item.id), ['format-bold'], query)
  }
  assert.deepEqual(filterShortcuts('ctrl+k').map((item) => item.id), ['search'])
  assert.deepEqual(filterShortcuts('Cmd Shift K').map((item) => item.id), ['format-link'])
  assert.deepEqual(filterShortcuts('复制块').map((item) => item.id), ['block-duplicate'])
  assert.deepEqual(filterShortcuts('F1').map((item) => item.id), ['help'])
  assert.equal(filterShortcuts('Ctrl+Enter', 'search')[0].id, 'search-document')
  assert.equal(filterShortcuts('Ctrl+Enter', 'block')[0].id, 'block-insert')
  assert.deepEqual(filterShortcuts('Ctrl+Enter', 'assistant').map(item => item.id), ['assistant-document-send'])
  assert.deepEqual(filterShortcuts('Ctrl+Enter').map(item => item.id), ['quick-capture-save', 'search-document', 'block-insert', 'assistant-document-send'])
  assert.deepEqual(filterShortcuts('Shift+F10').map(item => item.id), ['tree-context-menu'])
  assert.deepEqual(filterShortcuts('Home', 'tree').map(item => item.id), ['tree-boundary'])
  assert.deepEqual(filterShortcuts('ArrowRight', 'tree').map(item => item.id), ['tree-expand'])
  assert.deepEqual(filterShortcuts('unavailable-shortcut'), [])
  assert.deepEqual(filterShortcuts('', 'source').map((item) => item.id), ['source-apply', 'source-undo', 'source-redo'])
  assert.equal(shortcutKeyLabel('Mod', true), '⌘')
  assert.equal(shortcutKeyLabel('Mod', false), 'Ctrl')
  assert.equal(shortcutKeyLabel('Alt', true), '⌥')
})

test('help agrees with page navigation and the actual Markdown formatting bindings', () => {
  const pages = shortcuts.filter((item) => item.id.startsWith('page-'))
  assert.deepEqual(pages.map((item) => item.id), PAGE_ORDER.map((page) => `page-${page}`))
  assert.deepEqual(pages.map((item) => item.keys[0]), PAGE_ORDER.map((_, index) => ['Mod', String(index + 1)]))
  for (const item of shortcuts.filter((entry) => entry.group === 'format' && entry.id !== 'format-toolbar')) {
    const keys = item.keys[0]
    for (const mac of [false, true]) assert.equal(markdownFormatShortcut({
      key: keys.at(-1)!, ctrlKey: !mac, metaKey: mac, altKey: false, shiftKey: keys.includes('Shift')
    }), item.id.replace('format-', ''))
  }
  assert.deepEqual(filterShortcuts('Ctrl+S').map((item) => item.id), ['document-save', 'source-apply'])
  assert.equal(new Set(shortcuts.map((item) => item.id)).size, shortcuts.length)
})

test('help describes the implemented tree navigation and separates document questions from extension messages', () => {
  const tree = shortcuts.filter(item => item.group === 'tree')
  assert.equal(tree.length, 6)
  assert.deepEqual(tree.flatMap(item => item.keys), [['↑'], ['↓'], ['Home'], ['End'], ['→'], ['←'], ['Enter'], ['Space'], ['Shift', 'F10']])
  const documentSend = shortcuts.find(item => item.id === 'assistant-document-send')!
  assert.match(documentSend.note![0], /文档智能助手和文档辅助区/)
  assert.match(documentSend.note![1], /Enter inserts a line break/)
  assert.match(shortcuts.find(item => item.id === 'assistant-send')!.note![0], /应用扩展助手和插件定制对话/)
})
