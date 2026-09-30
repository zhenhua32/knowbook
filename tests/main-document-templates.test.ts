import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store'
import { documentTemplateDate } from '../src/shared/documentTemplates'
import type { DocumentBlockDraft } from '../src/shared/contracts'

function fixture(run: (store: KnowbookStore, databasePath: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-templates-'))
  const databasePath = join(root, 'knowbook.db')
  const store = new KnowbookStore(databasePath)
  try { run(store, databasePath) } finally { store.destroy(); rmSync(root, { recursive: true, force: true }) }
}

const paragraph = (content: string): DocumentBlockDraft => ({ type: 'paragraph', content, checked: false, depth: 0 })

test('built-in templates are localized, expand variables and produce unique sibling titles without history', () => fixture((store) => {
  const templates = store.listDocumentTemplates()
  assert.deepEqual(templates.map((template) => template.name), ['会议纪要', '读书笔记', '项目复盘'])
  assert.ok(templates.every((template) => template.builtIn))
  assert.deepEqual(store.listDocumentTemplates('en-US').map((template) => template.name), ['Meeting notes', 'Reading notes', 'Project retrospective'])
  const first = store.createDocumentFromTemplate({ templateId: templates[0].id, parentId: null })
  const second = store.createDocumentFromTemplate({ templateId: templates[0].id, parentId: null })
  const date = documentTemplateDate()
  const firstDetail = store.getDocumentDetail(first)!
  const secondDetail = store.getDocumentDetail(second)!
  assert.equal(firstDetail.title, `会议纪要 ${date}`)
  assert.equal(secondDetail.title, firstDetail.title + ' 1')
  assert.equal(secondDetail.blocks[0].content, secondDetail.title)
  assert.ok(firstDetail.blocks.some((block) => block.content.includes(date)))
  assert.equal(store.documentRecovery.listHistory(first).length, 0)
  assert.equal(store.documentRecovery.listHistory(second).length, 0)
  assert.throws(() => store.deleteDocumentTemplate(templates[0].id), /Built-in/)
}))

test('custom templates store the current draft, clone nested block identities and rewrite only internal Markdown references', () => fixture((store) => {
  const sourceId = store.createDocument(null)
  const [parentId, childId, grandchildId] = store.getDocumentDetail(sourceId)!.blocks.map((block) => block.id).concat('grandchild')
  const blocks: DocumentBlockDraft[] = [
    { id: parentId, type: 'todo', content: 'Parent', checked: true, depth: 0, tags: ['project'], highlight: 'blue' },
    { id: childId, type: 'todo', content: 'Child', checked: false, depth: 1, parentBlockId: parentId },
    { id: grandchildId, type: 'bulleted-list', content: 'Grandchild', checked: false, depth: 2, parentBlockId: childId },
    paragraph(`[[${childId}|child]] [[#${grandchildId}]] [[Source#${parentId}]] [parent](#${parentId}) [[External]] \`[[${parentId}]]\``),
    { ...paragraph(`[[${childId}]]`), type: 'code', language: 'markdown' }
  ]
  store.updateDocument(sourceId, { title: 'Source', summary: '', blocks })
  const original = store.getDocumentDetail(sourceId)!
  const draft = { name: 'Nested draft', title: '{{title}}', summary: 'Created {{date}} for {{title}}',
    blocks: original.blocks.map((block) => ({ ...block, content: block.id === childId ? 'Unsaved child' : block.content })) }
  const expectedDraft = structuredClone(draft)
  const template = store.saveDocumentTemplate(draft)
  assert.deepEqual(draft, expectedDraft)
  const created = store.createDocumentFromTemplate({ templateId: template.id, parentId: sourceId, title: 'Copy {{date}}' })
  const detail = store.getDocumentDetail(created)!
  assert.equal(detail.title, `Copy ${documentTemplateDate()}`)
  assert.equal(detail.path, `Source/${detail.title}`)
  assert.ok(detail.summary.endsWith(detail.title))
  assert.equal(detail.blocks[1].content, 'Unsaved child')
  assert.equal(detail.blocks[1].parentBlockId, detail.blocks[0].id)
  assert.equal(detail.blocks[2].parentBlockId, detail.blocks[1].id)
  assert.deepEqual(detail.blocks.slice(0, 3).map((block) => block.depth), [0, 1, 2])
  assert.ok(detail.blocks.every((block) => !original.blocks.some((source) => source.id === block.id)))
  assert.equal(detail.blocks[0].checked, true)
  assert.deepEqual(detail.blocks[0].tags, ['project'])
  assert.equal(detail.blocks[0].highlight, 'blue')
  assert.equal(detail.blocks[3].content, `[[${detail.blocks[1].id}|child]] [[#${detail.blocks[2].id}]] [[#${detail.blocks[0].id}]] [parent](#${detail.blocks[0].id}) [[External]] \`[[${parentId}]]\``)
  assert.equal(detail.blocks[4].content, `[[${childId}]]`)
  const { children: originalChildren, ...originalContent } = original
  const { children: currentChildren, ...currentContent } = store.getDocumentDetail(sourceId)!
  assert.deepEqual(currentContent, originalContent)
  assert.equal(originalChildren.length, 0)
  assert.equal(currentChildren[0].id, created)
  const duplicate = store.createDocumentFromTemplate({ templateId: template.id, parentId: sourceId, title: detail.title })
  assert.equal(store.getDocumentDetail(duplicate)!.title, detail.title + ' 1')
  assert.equal(store.getDocumentDetail(duplicate)!.summary, `Created ${documentTemplateDate()} for ${detail.title} 1`)
}))

test('custom template snapshots and attachment URLs persist after source deletion and database reopen', () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-template-reopen-'))
  const databasePath = join(root, 'knowbook.db')
  let store = new KnowbookStore(databasePath)
  try {
    const sourceId = store.createQuickNote({ title: 'Asset source', content: '[Attachment](file:///C:/assets/reference.pdf)' })
    const snapshot = store.getDocumentDetail(sourceId)!
    const template = store.saveDocumentTemplate({ ...snapshot, name: 'Attachment template' })
    store.deleteDocument(sourceId)
    store.documentRecovery.purge(sourceId)
    store.destroy()
    store = new KnowbookStore(databasePath)
    const restored = store.listDocumentTemplates().find((candidate) => candidate.id === template.id)!
    assert.equal(restored.blocks[0].content, snapshot.blocks[0].content)
    const created = store.createDocumentFromTemplate({ templateId: restored.id, parentId: null })
    assert.equal(store.getDocumentDetail(created)!.blocks[0].content, snapshot.blocks[0].content)
    store.deleteDocumentTemplate(restored.id)
    assert.equal(store.listDocumentTemplates().some((candidate) => candidate.id === restored.id), false)
    assert.throws(() => store.createDocumentFromTemplate({ templateId: restored.id, parentId: null }), /not found/)
  } finally { store.destroy(); rmSync(root, { recursive: true, force: true }) }
})

test('quick notes parse ordinary Markdown, infer or accept titles and preserve literal template tokens', () => fixture((store) => {
  const id = store.createQuickNote({ content: '# Quick capture\n\n- [ ] Parent\n  - [x] Child\n\nLiteral {{date}} and {{title}}.' })
  const detail = store.getDocumentDetail(id)!
  assert.equal(detail.title, 'Quick capture')
  assert.deepEqual(detail.blocks.slice(1, 3).map((block) => [block.type, block.checked, block.depth]), [['todo', false, 0], ['todo', true, 1]])
  assert.equal(detail.blocks[2].parentBlockId, detail.blocks[1].id)
  assert.equal(detail.blocks[3].content, 'Literal {{date}} and {{title}}.')
  const child = store.createQuickNote({ parentId: id, title: 'Custom title', content: 'A quick thought.' })
  assert.equal(store.getDocumentDetail(child)!.path, 'Quick capture/Custom title')
  assert.equal(store.documentRecovery.listHistory(child).length, 0)
  const pathNote = store.createQuickNote({ content: '修复 /src/main/index.ts 与 a\\b 的处理。' })
  assert.equal(store.getDocumentDetail(pathNote)!.title, '修复 src main index.ts 与 a b 的处理。')
  assert.equal(store.getDocumentDetail(pathNote)!.blocks[0].content, '修复 /src/main/index.ts 与 a\\b 的处理。')
  for (const content of ['.', '..']) {
    const dotNote = store.getDocumentDetail(store.createQuickNote({ content }))!
    assert.match(dotNote.title, /^快速记录(?: \d+)?$/)
    assert.equal(dotNote.blocks[0].content, content)
  }
  assert.throws(() => store.createQuickNote({ content: '  ' }), /required/)
}))

test('template requests validate snapshots and roll back every inserted row on transaction failure', () => fixture((store, databasePath) => {
  const baseline = store.getAllDocumentSnapshots().length
  assert.throws(() => store.saveDocumentTemplate({ name: ' ', title: '', summary: '', blocks: [] }), /required/)
  assert.throws(() => store.saveDocumentTemplate({ name: 'Broken', title: '', summary: '', blocks: [
    { ...paragraph('one'), id: 'same' }, { ...paragraph('two'), id: 'same' }
  ] }), /unique/)
  assert.throws(() => store.saveDocumentTemplate({ name: 'Broken', title: '', summary: '', blocks: [
    { ...paragraph('orphan'), parentBlockId: 'missing' }
  ] }), /precede/)
  const template = store.saveDocumentTemplate({ name: 'Valid', title: 'Valid', summary: '', blocks: [paragraph('content')] })
  assert.throws(() => store.createDocumentFromTemplate({ templateId: template.id, parentId: 'missing' }), /Parent document/)
  assert.equal(store.getAllDocumentSnapshots().length, baseline)
  const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
  const db = new Database(databasePath)
  try {
    db.exec(`CREATE TRIGGER reject_template_block BEFORE INSERT ON blocks
      WHEN (SELECT title FROM documents WHERE id = new.document_id) = 'Rollback'
      BEGIN SELECT RAISE(ABORT, 'Forced template failure'); END`)
    assert.throws(() => store.createDocumentFromTemplate({ templateId: template.id, parentId: null, title: 'Rollback' }), /Forced template failure/)
    assert.equal(store.getAllDocumentSnapshots().length, baseline)
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM documents WHERE title = 'Rollback'").get() as { count: number }).count, 0)
  } finally { db.close() }
}))
