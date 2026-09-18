import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store.ts'
import { collectDocumentMarkdownLinks } from '../src/shared/markdownLinkMaintenance.ts'
import { parseLocalMarkdownUrl, resolveMarkdownDocumentPath } from '../src/shared/markdownLinks.ts'
import { CURRENT_DATABASE_SCHEMA_VERSION } from '../src/main/database/schema-version.ts'
import { parseMarkdownBlocks } from '../src/shared/markdown.ts'
import { pathToFileURL } from 'node:url'
import { checkMarkdownAttachment } from '../src/main/markdown-attachment-check.ts'

function withStore(run: (store: KnowbookStore) => void) {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-link-maintenance-'))
  const store = new KnowbookStore(join(root, 'workspace.sqlite'))
  try { run(store) } finally { store.destroy(); rmSync(root, { recursive: true, force: true }) }
}
function create(store: KnowbookStore, title: string, source = '', parent: string | null = null) {
  const id = store.createDocument(parent)
  store.updateDocument(id, { title, summary: '', blocks: drafts(source) })
  return id
}

function drafts(source: string) {
  return parseMarkdownBlocks(source).map((block) => ({ ...block, checked: block.checked ?? false, depth: block.depth ?? 0, language: block.language ?? undefined }))
}

test('bulk restore maintains untouched inlinks once, respects authoritative imported sources and rolls back nested failures', () => {
  withStore((store) => {
    const docs = create(store, 'Docs'), archive = create(store, 'Archive')
    const target = create(store, 'Old', '## Stable', docs)
    const external = create(store, 'Outside', '[Read](Docs/Old.md#stable) [[Docs/Old]]')
    const imported = create(store, 'Imported', '[Old](Old.md#stable)', docs)
    store.runInBulkDocumentMutation(() => {
      store.moveDocument(target, archive)
      store.updateDocument(target, { ...store.getDocumentDetail(target)!, title: 'New', blocks: drafts('## Stable') })
      store.moveDocument(imported, archive)
      store.updateDocument(imported, { ...store.getDocumentDetail(imported)!, blocks: drafts('[Final](New.md#stable)') })
      assert.throws(() => store.runInBulkDocumentMutation(() => {
        store.updateDocument(target, { ...store.getDocumentDetail(target)!, title: 'Aborted' })
        throw new Error('abort nested')
      }), /abort nested/)
    })
    const outside = store.getDocumentDetail(external)!
    assert.equal(outside.blocks[0].content, '[Read](Archive/New.md#stable) [[Archive/New]]')
    assert.equal(store.getDocumentDetail(imported)!.blocks[0].content, '[Final](New.md#stable)')
    assert.equal(store.checkDocumentLinks(external, () => null).issues.length, 0)
    const before = store.getDocumentDetail(target)!
    assert.throws(() => store.runInBulkDocumentMutation(() => {
      store.updateDocument(target, { ...before, title: 'Rollback' }); throw new Error('rollback')
    }), /rollback/)
    assert.deepEqual(store.getDocumentDetail(target), before)
    store.updateDocument(target, { ...before, title: 'Final' })
    assert.ok(store.getDocumentDetail(external)!.blocks[0].content.includes('Archive/Final.md#stable'))
  })
})

test('deleting a parent rebases surviving children and their incoming links', () => {
  withStore((store) => {
    const parent = create(store, 'Folder')
    const child = create(store, 'Child', '[Neighbor](../Neighbor.md)'), neighbor = create(store, 'Neighbor')
    store.moveDocument(child, parent)
    store.updateDocument(child, { ...store.getDocumentDetail(child)!, blocks: drafts('[Neighbor](../Neighbor.md)') })
    const source = create(store, 'Source', '[Child](Folder/Child.md)')
    store.deleteDocument(parent)
    assert.equal(store.getDocumentDetail(child)!.path, 'Child')
    assert.equal(store.getDocumentDetail(child)!.blocks[0].content, '[Neighbor](Neighbor.md)')
    assert.equal(store.getDocumentDetail(source)!.blocks[0].content, '[Child](Child.md)')
    assert.equal(store.checkDocumentLinks(child, () => null).issues.length, 0)
    store.deleteDocument(neighbor)
    assert.equal(store.checkDocumentLinks(child, () => null).issues[0].reason, 'missing-document')
  })
})

test('link diagnostics distinguish local failures, accept complete-document headings, and never fetch external URLs', () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-link-check-'))
  const store = new KnowbookStore(join(root, 'store.sqlite'))
  try {
    const assets = join(root, 'assets'); mkdirSync(assets)
    writeFileSync(join(assets, 'ok.pdf'), 'attachment')
    const good = pathToFileURL(join(assets, 'ok.pdf')).href
    const missing = pathToFileURL(join(assets, 'lost.pdf')).href
    const outside = pathToFileURL(join(root, 'outside.pdf')).href
    const target = create(store, 'Target', '## Repeat\n\n## Repeat\n\n> ## Nested')
    const block = store.getDocumentDetail(target)!.blocks[0].id
    create(store, 'Shared', '', create(store, 'A')); create(store, 'Shared', '', create(store, 'B'))
    const source = create(store, 'Source', `[good](Target.md#repeat-1) [nested](Target.md#nested) [title](Target.md#target) [[Target#${block}]]\n\n`
      + `[missing](Missing.md) [heading](Target.md#absent) [[Target#missing]] [[Shared]]\n\n`
      + `[file](${good}?v=1#page=2) [lost](${missing}) [outside](${outside}) ![relative](images/test.png)\n\n`
      + '[invalid](../../escape.md) [web](https://example.com) ![web image](https://example.com/image.png)\n\n'
      + '`[code](Missing.md)` $[math](Missing.md)$\n\nNote[^a]\n\n[^a]: [footnote](Target.md#repeat)')
    const report = store.checkDocumentLinks(source, (url) => checkMarkdownAttachment(url, assets))
    assert.equal(report.checkedCount, 14)
    assert.equal(report.ignoredExternalCount, 2)
    assert.deepEqual(report.issues.map((issue) => issue.reason), ['missing-document', 'missing-heading', 'missing-block', 'ambiguous-reference', 'missing-attachment', 'unmanaged-attachment', 'unmanaged-attachment', 'invalid-path'])
    assert.ok(report.issues.every((issue) => issue.blockId && issue.offset >= 0))
    assert.equal(checkMarkdownAttachment('file://%broken', assets), 'invalid-path')
  } finally { store.destroy(); rmSync(root, { recursive: true, force: true }) }
})

test('rename and move maintain external inlinks, subtree outlinks, references and exact code content atomically', () => {
  withStore((store) => {
    const docs = create(store, 'Docs'), archive = create(store, 'Archive')
    const target = create(store, 'Next', '## Old\n\nBody', docs)
    const source = create(store, 'Start', '[Open](Next.md#old)\n\n[Shared][ref]\n\n[ref]: Next.md?x=1#old "Title"\n\n`[code](Next.md#old)`\n\n![literal](Next.md)', docs)
    const external = create(store, 'Outside', '[Go](Docs/Start.md)')
    const originalSource = store.getDocumentDetail(source)!
    const detail = store.getDocumentDetail(target)!
    const affected = store.updateDocument(target, { ...detail, title: '新 章', blocks: detail.blocks.map((block) => block.type === 'heading-2' ? { ...block, content: '新的章节' } : block) })
    assert.ok(affected.includes(source))
    const renamed = store.getDocumentDetail(source)!
    const links = collectDocumentMarkdownLinks(renamed.blocks).filter((link) => link.kind !== 'image')
    for (const link of links) assert.deepEqual(resolveMarkdownDocumentPath(renamed.path, link.url), { path: 'Docs/新 章', fragment: '新的章节' })
    assert.ok(renamed.blocks.some((block) => block.content.includes('`[code](Next.md#old)`')))
    assert.ok(renamed.blocks.some((block) => block.content.includes('![literal](Next.md)')))
    assert.ok(renamed.blocks.some((block) => block.content.includes('?x=1#') && block.content.includes('"Title"')))
    assert.deepEqual(renamed.blocks.map((block) => block.id), originalSource.blocks.map((block) => block.id))
    assert.ok(renamed.outgoingLinks.some((link) => link.id === target))
    assert.ok(store.getDocumentDetail(target)!.backlinks.some((link) => link.id === source))
    const moved = store.moveDocument(source, archive)
    assert.ok(moved.includes(external))
    const movedSource = store.getDocumentDetail(source)!
    for (const link of collectDocumentMarkdownLinks(movedSource.blocks).filter((link) => link.kind !== 'image')) {
      assert.equal(resolveMarkdownDocumentPath(movedSource.path, link.url)?.path, 'Docs/新 章')
    }
    assert.equal(collectDocumentMarkdownLinks(store.getDocumentDetail(external)!.blocks)[0].url, 'Archive/Start.md')
    const beforeFailure = store.getDocumentDetail(source)!
    assert.throws(() => store.runInTransaction(() => { store.moveDocument(source, null); throw new Error('abort') }), /abort/)
    assert.deepEqual(store.getDocumentDetail(source), beforeFailure)
    assert.equal(collectDocumentMarkdownLinks(store.getDocumentDetail(external)!.blocks)[0].url, 'Archive/Start.md')
    store.updateDocument(docs, { ...store.getDocumentDetail(docs)!, title: 'Books' })
    const finalSource = store.getDocumentDetail(source)!
    assert.equal(resolveMarkdownDocumentPath(finalSource.path, collectDocumentMarkdownLinks(finalSource.blocks)[0].url)?.path, 'Books/新 章')
  })
})

test('removed duplicate headings remain unresolved instead of targeting another section and undo restores them', () => {
  withStore((store) => {
    const target = create(store, 'Target', '## Repeat\n\nFirst\n\n## Repeat\n\nSecond')
    const source = create(store, 'Source', '[First](Target.md#repeat) [Second](Target.md#repeat-1)')
    const before = store.getDocumentDetail(target)!
    store.updateDocument(target, { ...before, blocks: before.blocks.slice(2) })
    const deleted = collectDocumentMarkdownLinks(store.getDocumentDetail(source)!.blocks)
    assert.match(parseLocalMarkdownUrl(deleted[0].url)!.fragment, /^knowbook-missing-heading-/)
    assert.equal(parseLocalMarkdownUrl(deleted[1].url)!.fragment, 'repeat')
    store.updateDocument(target, before)
    const restored = collectDocumentMarkdownLinks(store.getDocumentDetail(source)!.blocks)
    assert.equal(parseLocalMarkdownUrl(restored[0].url)!.fragment, 'repeat')
    assert.equal(parseLocalMarkdownUrl(restored[1].url)!.fragment, 'repeat-1')
  })
})

test('wiki document and cross-block references follow renamed targets while code, math and ambiguous names remain literal', () => {
  withStore((store) => {
    const parent = create(store, 'Parent'), target = create(store, 'Target', 'Body', parent)
    const block = store.getDocumentDetail(target)!.blocks[0]
    const source = create(store, 'Source', `[[Target]] [[Parent/Target#${block.id}]]\n\n\`[[Target]]\` $[[Target]]$`)
    store.updateDocument(target, { ...store.getDocumentDetail(target)!, title: 'New name' })
    const content = store.getDocumentDetail(source)!.blocks.map((item) => item.content).join('\n')
    assert.ok(content.includes('[[Parent/New name]]'))
    assert.ok(content.includes(`[[Parent/New name#${block.id}]]`))
    assert.ok(content.includes('`[[Target]]` $[[Target]]$'))
    assert.ok(store.getDocumentDetail(source)!.outgoingLinks.some((link) => link.id === target))
    const otherParent = create(store, 'Other'), other = create(store, 'Shared', '', otherParent)
    create(store, 'Shared', '', parent)
    const ambiguous = create(store, 'Ambiguous', '[[Shared]]')
    store.updateDocument(other, { ...store.getDocumentDetail(other)!, title: 'Unique' })
    assert.equal(store.getDocumentDetail(ambiguous)!.blocks[0].content, '[[Shared]]')
  })
})

test('a maintained Wiki heading also updates incoming Markdown anchors without touching unrelated sources', () => {
  withStore((store) => {
    const target = create(store, 'Target')
    const heading = create(store, 'Sections', '## [[Target]]\n\n[Self](#target)')
    const source = create(store, 'Source', '[Section](Sections.md#target)')
    const affected = store.updateDocument(target, { ...store.getDocumentDetail(target)!, title: 'New Target' })
    assert.ok(affected.includes(heading)); assert.ok(affected.includes(source))
    assert.equal(store.getDocumentDetail(source)!.blocks[0].content, '[Section](Sections.md#new-target)')
    assert.equal(store.getDocumentDetail(heading)!.blocks[1].content, '[Self](#new-target)')
    assert.equal(store.checkDocumentLinks(source, () => null).issues.length, 0)
  })
})

test('link index migration backfills the index and preserves a backup before rewriting existing links', () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-link-migration-')), path = join(root, 'workspace.sqlite')
  let store = new KnowbookStore(path)
  try {
    const target = create(store, 'Target', '## Old'), source = create(store, 'Source', '[Go](Target.md#old)')
    store.getUnsafeDatabaseHandle().exec('DROP TABLE markdown_link_sources; PRAGMA user_version = 14;')
    store.destroy(); store = new KnowbookStore(path)
    assert.equal(store.getUnsafeDatabaseHandle().pragma('user_version', { simple: true }), CURRENT_DATABASE_SCHEMA_VERSION)
    assert.ok(readdirSync(root).some((name) => name.includes(`pre-migration-v14-to-v${CURRENT_DATABASE_SCHEMA_VERSION}-`)))
    store.updateDocument(target, { ...store.getDocumentDetail(target)!, title: 'Renamed' })
    assert.equal(collectDocumentMarkdownLinks(store.getDocumentDetail(source)!.blocks)[0].url, 'Renamed.md#old')
  } finally { store.destroy(); rmSync(root, { recursive: true, force: true }) }
})

test('schema 16 rebuilds stale table link positions before a target is renamed', () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-link-position-migration-')), path = join(root, 'workspace.sqlite')
  let store = new KnowbookStore(path)
  try {
    const target = create(store, 'Target')
    const source = create(store, 'Source', '| A | B |\n| - | - |\n| $unfinished | [real](Target.md)$ |\n| literal | ` [code](Target.md) ` |')
    // Simulate v15's missed entry; migration must not depend on editing Source.
    store.getUnsafeDatabaseHandle().exec('DELETE FROM markdown_link_sources; DELETE FROM links; PRAGMA user_version = 15;')
    store.destroy(); store = new KnowbookStore(path)
    assert.ok(readdirSync(root).some((name) => name.includes(`pre-migration-v15-to-v${CURRENT_DATABASE_SCHEMA_VERSION}-`)))
    const detail = store.getDocumentDetail(source)!
    assert.equal(detail.outgoingLinks.length, 1)
    store.updateDocument(target, { ...store.getDocumentDetail(target)!, title: 'Moved' })
    const content = store.getDocumentDetail(source)!.blocks[0].content
    assert.ok(content.includes('[real](Moved.md)'))
    assert.ok(content.includes('[code](Target.md)'))
  } finally { store.destroy(); rmSync(root, { recursive: true, force: true }) }
})

test('popular heading edits maintain only relevant fragments and keep index resolution correct across undo and rename', () => {
  withStore((store) => {
    const target = create(store, 'Target', '## Old\n\n## Stable')
    const original = store.getDocumentDetail(target)!
    const stable: string[] = [], changing: string[] = []
    store.runInBulkDocumentMutation(() => {
      for (let index = 0; index < 40; index++) {
        if (index % 4) stable.push(create(store, `Stable ${index}`, `[Top](Target.md#) [Same](Target.md#stable) [[Target#${original.blocks[0].id}]]`))
        else changing.push(create(store, `Changing ${index}`, '[Inline](Target.md?query=1#old)\n\n[Defined][d]\n\n[d]: Target.md#old\n\n| Link |\n| - |\n| [Cell](Target.md#old) |'))
      }
    })
    const stableBefore = stable.map((id) => store.getDocumentDetail(id))
    const changed = store.updateDocument(target, { ...original, blocks: original.blocks.map((block, index) => index === 0 ? { ...block, content: 'New' } : block) })
    assert.deepEqual(new Set(changed), new Set([target, ...changing]))
    assert.deepEqual(stable.map((id) => store.getDocumentDetail(id)), stableBefore)
    for (const id of changing) {
      assert.ok(collectDocumentMarkdownLinks(store.getDocumentDetail(id)!.blocks).every((link) => link.url.endsWith('#new')))
      assert.deepEqual(store.checkDocumentLinks(id, () => null).issues, [])
    }
    store.updateDocument(target, original)
    store.updateDocument(target, { ...original, title: 'Renamed' })
    for (const id of [...stable, ...changing]) {
      const detail = store.getDocumentDetail(id)!
      assert.ok(collectDocumentMarkdownLinks(detail.blocks).every((link) => link.url.startsWith('Renamed')))
      assert.ok(detail.outgoingLinks.every((link) => link.id === target))
      assert.deepEqual(store.checkDocumentLinks(id, () => null).issues, [])
    }
  })
})

test('outgoing relations follow parsed Wiki links and block structure instead of literal text', () => {
  withStore((store) => {
    const target = create(store, 'Target', 'Body')
    const source = create(store, 'Source', '[[target]] [Ordinary](Target.md)')
    const original = store.getDocumentDetail(source)!
    assert.equal(original.outgoingLinks.length, 2)
    for (const type of ['code', 'math']) {
      store.updateDocument(source, { ...original, blocks: original.blocks.map((block) => ({ ...block, type })) })
      assert.deepEqual(store.getDocumentDetail(source)!.outgoingLinks, [])
      assert.ok(!store.getDocumentDetail(target)!.backlinks.some((link) => link.id === source))
    }
    store.updateDocument(source, original)
    assert.equal(store.getDocumentDetail(source)!.outgoingLinks.length, 2)
    store.updateDocument(source, { ...original, blocks: drafts('`[[Target]]` $[[Target]]$ ![ [[Target]] ](https://example.com/image.png)') })
    assert.deepEqual(store.getDocumentDetail(source)!.outgoingLinks, [])
  })
})

test('case-variant Wiki links resolve when a target is created and follow its canonical path on rename', () => {
  withStore((store) => {
    const source = create(store, 'Source', '[[future]] [[FUTURE#body]]')
    assert.equal(store.checkDocumentLinks(source, () => null).issues.length, 2)
    const target = create(store, 'Future')
    store.updateDocument(target, { ...store.getDocumentDetail(target)!, blocks: [{ id: 'body', type: 'paragraph', content: 'Body', checked: false, depth: 0 }] })
    assert.equal(store.getDocumentDetail(source)!.outgoingLinks.length, 2)
    assert.deepEqual(store.checkDocumentLinks(source, () => null).issues, [])
    store.updateDocument(target, { ...store.getDocumentDetail(target)!, title: 'Final' })
    assert.equal(store.getDocumentDetail(source)!.blocks[0].content, '[[Final]] [[Final#body]]')
    assert.deepEqual(store.checkDocumentLinks(source, () => null).issues, [])
  })
})

test('schema 17 refreshes old Wiki relations and case-variant bindings with a migration backup', () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-link-relations-migration-')), path = join(root, 'workspace.sqlite')
  let store = new KnowbookStore(path)
  try {
    const target = create(store, 'Target'), source = create(store, 'Source', '[[target]]')
    const literal = create(store, 'Literal', '`[[Target]]`')
    store.getUnsafeDatabaseHandle().prepare('INSERT INTO links (id, source_document_id, target_document_id, label, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('stale', literal, target, 'Target', new Date().toISOString())
    store.getUnsafeDatabaseHandle().exec("UPDATE markdown_link_sources SET target_path = NULL WHERE kind = 'wiki'; PRAGMA user_version = 16;")
    store.destroy(); store = new KnowbookStore(path)
    assert.ok(readdirSync(root).some((name) => name.includes(`pre-migration-v16-to-v${CURRENT_DATABASE_SCHEMA_VERSION}-`)))
    assert.deepEqual(store.getDocumentDetail(literal)!.outgoingLinks, [])
    store.updateDocument(target, { ...store.getDocumentDetail(target)!, title: 'Renamed' })
    assert.equal(store.getDocumentDetail(source)!.blocks[0].content, '[[Renamed]]')
    assert.equal(store.getDocumentDetail(literal)!.blocks[0].content, '`[[Target]]`')
  } finally { store.destroy(); rmSync(root, { recursive: true, force: true }) }
})
