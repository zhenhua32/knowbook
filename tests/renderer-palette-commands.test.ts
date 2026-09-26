import assert from 'node:assert/strict'
import test from 'node:test'
import { createPaletteCommands, matchPaletteCommands } from '../src/renderer/src/utils/paletteCommands'

test('palette command aliases work across UI languages and require every query term', () => {
  for (const isZh of [true, false]) {
    const commands = createPaletteCommands({ selectedDocument: null, selectedDocumentId: null } as Parameters<typeof createPaletteCommands>[0],
      { isZh, workspaceReady: true, pageItems: [{ id: 'settings', label: isZh ? '配置中心' : 'Settings', description: '' },
        { id: 'ai', label: isZh ? 'AI 助手' : 'AI Assistant', description: '' }] } as Parameters<typeof createPaletteCommands>[1],
      {} as Parameters<typeof createPaletteCommands>[2])
    for (const [query, id] of [['> save current document', 'save-document'], ['  > COPY document markdown ', 'copy-markdown'],
      ['> 保存 当前', 'save-document'], ['> 导出 文档', 'export-markdown'], ['> ai assistant', 'page-ai'], ['> 设置', 'page-settings'], ['> import backup', 'import-backup']]) {
      assert.ok(matchPaletteCommands(commands, query).some((command) => command.id === id), `${query} (${isZh ? 'Chinese' : 'English'})`)
    }
    assert.deepEqual(matchPaletteCommands(commands, '> save impossiblecommand'), [])
    assert.ok(matchPaletteCommands(commands, '> save current document')[0].disabledReason)
  }
})
