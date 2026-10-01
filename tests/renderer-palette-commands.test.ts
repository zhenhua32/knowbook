import assert from 'node:assert/strict'
import test from 'node:test'
import { createPaletteCommands, matchPaletteCommands } from '../src/renderer/src/utils/paletteCommands'

test('palette command aliases work across UI languages and require every query term', () => {
  for (const isZh of [true, false]) {
    const commands = createPaletteCommands({ selectedDocument: null, selectedDocumentId: null } as Parameters<typeof createPaletteCommands>[0],
      { isZh, workspaceReady: true, pageItems: [{ id: 'settings', label: isZh ? '配置中心' : 'Settings', description: '' },
        { id: 'ai', label: isZh ? 'AI 助手' : 'AI Assistant', description: '' },
        { id: 'search', label: isZh ? '搜索' : 'Search', description: '' }] } as Parameters<typeof createPaletteCommands>[1],
      {} as Parameters<typeof createPaletteCommands>[2])
    for (const [query, id] of [['> save current document', 'save-document'], ['  > COPY document markdown ', 'copy-markdown'],
      ['> 保存 当前', 'save-document'], ['> 导出 文档', 'export-markdown'], ['> ai assistant', 'page-ai'], ['> 设置', 'page-settings'], ['> import backup', 'import-backup'],
      ['> 快捷键 帮助', 'shortcut-help'], ['> keyboard shortcuts', 'shortcut-help'],
      ['> 完整搜索', 'page-search'], ['> full search', 'page-search']]) {
      assert.ok(matchPaletteCommands(commands, query).some((command) => command.id === id), `${query} (${isZh ? 'Chinese' : 'English'})`)
    }
    assert.deepEqual(matchPaletteCommands(commands, '> save impossiblecommand'), [])
    assert.equal(commands.find((command) => command.id === 'page-search')?.shortcut, 'Ctrl/Cmd+Shift+F')
    assert.equal(commands.find((command) => command.id === 'page-settings')?.shortcut, 'Ctrl/Cmd+6')
    assert.equal(commands.find((command) => command.id === 'page-ai')?.shortcut, 'Ctrl/Cmd+4')
    assert.ok(matchPaletteCommands(commands, '> save current document')[0].disabledReason)
    assert.ok(matchPaletteCommands(commands, '> save as template')[0].disabledReason)
    for (const [query, id] of [['> quick capture', 'quick-capture'], ['> 快速 记录', 'quick-capture'],
      ['> new template', 'new-from-template'], ['> 从模板新建', 'new-from-template']]) {
      const command = matchPaletteCommands(commands, query).find((item) => item.id === id)
      assert.ok(command, query)
      assert.equal(command.disabledReason, undefined)
    }
  }
})
