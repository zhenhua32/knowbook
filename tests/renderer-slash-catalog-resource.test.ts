import assert from 'node:assert/strict'
import test from 'node:test'
import { slashCommandCatalog, type BlockSlashCommand } from '../src/renderer/src/utils/slashCommandCatalog'

test('the real slash catalog shares concurrent requests and caches each language independently', async () => {
  assert.equal(slashCommandCatalog.cached('zh-CN'), undefined)
  assert.equal(slashCommandCatalog.cached('en-US'), undefined)

  const chineseRequest = slashCommandCatalog.load('zh-CN')
  const englishRequest = slashCommandCatalog.load('en-US')
  assert.equal(slashCommandCatalog.load('zh-CN'), chineseRequest)
  assert.equal(slashCommandCatalog.load('en-US'), englishRequest)
  assert.notEqual(chineseRequest, englishRequest)

  const [chinese, english] = await Promise.all([chineseRequest, englishRequest])
  assert.notEqual(chinese, english)
  assert.equal(slashCommandCatalog.cached('zh-CN'), chinese)
  assert.equal(slashCommandCatalog.cached('en-US'), english)
  assert.equal(await slashCommandCatalog.load('zh-CN'), chinese)
  assert.equal(await slashCommandCatalog.load('en-US'), english)
  assert.equal(chinese.find(command => command.id === 'columns')?.label, '两列分栏')
  assert.equal(english.find(command => command.id === 'columns')?.label, 'Two columns')
})

const expectedCommands = [
  ['text', 'type', 'paragraph'],
  ['h1', 'type', 'heading-1'],
  ['h2', 'type', 'heading-2'],
  ['h3', 'type', 'heading-3'],
  ['h4', 'type', 'heading-4'],
  ['h5', 'type', 'heading-5'],
  ['h6', 'type', 'heading-6'],
  ['todo', 'type', 'todo'],
  ['numbered-todo', 'type', 'numbered-todo'],
  ['code', 'type', 'code'],
  ['math', 'type', 'math'],
  ['quote', 'type', 'quote'],
  ['bullet', 'type', 'bulleted-list'],
  ['numbered', 'type', 'numbered-list'],
  ['divider', 'type', 'divider'],
  ['table', 'type', 'table'],
  ['mermaid', 'type', 'code'],
  ['callout', 'type', 'callout'],
  ['toggle', 'type', 'toggle'],
  ['columns', 'action', 'columns'],
  ['toc', 'type', 'paragraph'],
  ['above', 'action', 'insert-above'],
  ['below', 'action', 'insert-below'],
  ['child', 'action', 'insert-child'],
  ['up', 'action', 'move-up'],
  ['down', 'action', 'move-down'],
  ['indent', 'action', 'indent'],
  ['outdent', 'action', 'outdent'],
  ['duplicate', 'action', 'duplicate'],
  ['delete', 'action', 'delete']
]

test('both real catalog builders retain every conversion and action without exposing bare column conversion', async () => {
  const { buildBlockSlashCommands } = await import('../src/renderer/src/utils/blockSlashCommands')
  for (const language of ['zh-CN', 'en-US'] as const) {
    const commands = buildBlockSlashCommands(language)
    assert.deepEqual(commands.map(command => [command.id, command.kind, command.kind === 'type' ? command.type : command.action]), expectedCommands)
    assert.equal(new Set(commands.map(command => command.id)).size, commands.length)
    assert.equal(commands.some(command => command.kind === 'type' && ['column', 'columns'].includes(command.type)), false)
    assert.deepEqual(commands.find(command => command.id === 'columns')?.keywords, ['columns', 'layout', '分栏', '两列'])
    assert.notEqual(commands, slashCommandCatalog.cached(language), 'fresh builders do not replace the language resource cache')
    for (const command of commands) {
      assert.ok(command.label.trim(), `${language}: ${command.id} label`)
      assert.ok(command.description.trim(), `${language}: ${command.id} description`)
      assert.ok(command.keywords.some(keyword => /[a-z]/i.test(keyword)), `${command.id} keeps English search aliases`)
      assert.ok(command.keywords.some(keyword => /[\u4e00-\u9fff]/.test(keyword)), `${command.id} keeps Chinese search aliases`)
    }
  }
})

test('localized labels, bilingual aliases and insertion templates survive the cold catalog split', async () => {
  const { buildBlockSlashCommands } = await import('../src/renderer/src/utils/blockSlashCommands')
  const chinese = buildBlockSlashCommands('zh-CN')
  const english = buildBlockSlashCommands('en-US')
  const commandById = (commands: BlockSlashCommand[], id: string) => {
    const command = commands.find(candidate => candidate.id === id)
    assert.ok(command, id)
    return command
  }
  for (const command of chinese) {
    const translated = commandById(english, command.id)
    assert.notEqual(command.label, translated.label, `${command.id} label is localized`)
    assert.notEqual(command.description, translated.description, `${command.id} description is localized`)
    assert.deepEqual(command.keywords, translated.keywords, `${command.id} is searchable in either language`)
  }

  const expectedTemplates = [
    [chinese, '| 列 1 | 列 2 |\n| --- | --- |\n|  |  |', 'flowchart LR\n  A[开始] --> B[完成]'],
    [english, '| Column 1 | Column 2 |\n| --- | --- |\n|  |  |', 'flowchart LR\n  A[Start] --> B[Done]']
  ] as const
  for (const [commands, tableContent, diagramContent] of expectedTemplates) {
    const table = commandById(commands, 'table')
    const diagram = commandById(commands, 'mermaid')
    const toc = commandById(commands, 'toc')
    assert.equal(table.kind, 'type')
    assert.equal(diagram.kind, 'type')
    assert.equal(toc.kind, 'type')
    if (table.kind !== 'type' || diagram.kind !== 'type' || toc.kind !== 'type') assert.fail('templates must be block conversions')
    assert.equal(table.templateContent, tableContent)
    assert.equal(diagram.templateContent, diagramContent)
    assert.equal(diagram.templateLanguage, 'mermaid')
    assert.equal(toc.type, 'paragraph')
    assert.equal(toc.templateContent, '[TOC]')
    for (const id of ['callout', 'toggle']) {
      const container = commandById(commands, id)
      assert.equal(container.kind, 'type')
      assert.equal('templateContent' in container, false, `${id} creates a native container rather than inserting HTML`)
      assert.equal('templateLanguage' in container, false)
    }
  }
})
