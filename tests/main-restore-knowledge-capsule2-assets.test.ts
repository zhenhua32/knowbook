import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import type Database from 'better-sqlite3'
import test from 'node:test'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { collectStoredMarkdownAssetDestinations, collectSyncedMarkdownAssetDestinations } from '../src/shared/syncedBlockPortable'
import { serializeMarkdownWithBlockRanges } from '../src/shared/markdown'
import { createDefaultDatabaseViewConfig } from '../src/shared/database-workspace'
import { serializeDatabaseViewPayload } from '../src/shared/databaseViewBlock'
import { readRawCapsule2AssetReferencesOwned, type RawCapsule2AssetReferences } from '../src/main/database/restore-knowledge-capsule2-assets-read'
import { readRawCapsule2ContentOwned } from '../src/main/database/restore-knowledge-capsule2-content-raw-read'
import { readRawCapsule2WorkspaceHistoryOwned } from '../src/main/database/restore-knowledge-capsule2-workspace-history-read'
import { withCapsule2RawCopy } from './helpers/capsule2-raw-fixture'
import { created, createRequest, applySyncedHostCommand, snapshot, withV3Fixture, type V3Fixture } from './helpers/synced-backup-v3-fixture'

const block = (id: string, content: string, type = 'paragraph'): DocumentBlockDraft => ({ id, type, content, checked: false, depth: 0, parentBlockId: null })
const urls = (value: RawCapsule2AssetReferences) => value.scopes.flatMap(scope => scope.destinations.map(item => item.uri))
async function observe(f: V3Fixture, check: (value: RawCapsule2AssetReferences, db: Database.Database) => void) {
  const group = snapshot(f.db, f.groupId), ack = f.db.prepare('SELECT * FROM synced_operations WHERE client_operation_id=?').get(f.created.operationId)
  await withCapsule2RawCopy(f, db => db.transaction(() => {
    const before = readRawCapsule2ContentOwned(db), history = readRawCapsule2WorkspaceHistoryOwned(db)
    const value = readRawCapsule2AssetReferencesOwned(db)
    assert.equal(value.sourceContentHash, history.sourceContentHash)
    assert.equal(value.workspaceHistoryObservationHash, history.observationHash)
    check(value, db)
    assert.deepEqual(readRawCapsule2WorkspaceHistoryOwned(db), history)
    assert.deepEqual(readRawCapsule2ContentOwned(db), before)
    assert.equal((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n, 0)
    assert.equal(value.certified, false); assert.equal(value.semanticValidationComplete, false); assert.equal(value.permit, false)
    assert.equal(value.sourceFileOwnershipVerified, false); assert.equal(value.sourceFileBytesVerified, false)
  })())
  assert.deepEqual(snapshot(f.db, f.groupId), group)
  assert.deepEqual(f.db.prepare('SELECT * FROM synced_operations WHERE client_operation_id=?').get(f.created.operationId), ack)
}

test('stored asset discovery preserves broken or future portable destinations without granting the original public portable parser validity', () => {
  for (const source of ['[future](knowbook-asset://not-valid)', '<img src="knowbook&#45;asset&colon;//not-valid">', '[future](<knowbook-asset://future/{{date}}> )']) {
    assert.throws(() => collectSyncedMarkdownAssetDestinations(source))
    const destinations = collectStoredMarkdownAssetDestinations(source)
    assert.equal(destinations.length, 1); assert.match(destinations[0].url, /^knowbook-asset:\/\//)
    assert.ok(source.slice(destinations[0].start, destinations[0].end))
  }
})

test('stored asset discovery keeps real UTF-16 spans and literal/code exclusions through HTML, cross references and footnotes', () => {
  const source = '中文 😀 [link](file:///missing/one.png)\n\n![cross][asset]\n\n[asset]: <knowbook-asset://future/image>\n\nNote[^note]\n\n[^note]: <img src="file:///missing/two.png">\n\n`[literal](file:///never/code.png)`\n\n```md\n![literal](knowbook-asset://never/code)\n```\n\nknowbook-asset://plain-word'
  const found = collectStoredMarkdownAssetDestinations(source)
  assert.deepEqual(new Set(found.map(item => item.url)), new Set(['file:///missing/one.png', 'knowbook-asset://future/image', 'file:///missing/two.png']))
  for (const item of found) assert.ok(source.slice(item.start, item.end).includes(item.url) || item.syntax === 'html')
})

test('capsule2 asset discovery reads real ordinary and canonical scopes with both actual same-hash aliases and a literal501 title', () => withV3Fixture(async f => {
  const aliases = await f.assets.import([{ name: 'first alias.png', bytes: Buffer.from('actual identical bytes') }, { name: 'second alias.png', bytes: Buffer.from('actual identical bytes') }])
  const id = f.store.createDocument(null), root = randomUUID()
  f.store.updateDocument(id, { title: '源'.repeat(501), summary: `![summary](<${aliases[0].url}>)`, blocks: [block(root, `![body](<${aliases[1].url}>)`)] })
  const command = createRequest(f.db, { documentId: id, selectedRootIds: [root] })
  created(applySyncedHostCommand(f.db, command))
  await observe(f, value => {
    assert.ok(value.scopes.find(scope => scope.source[0] === 'documents' && scope.source[1] === id)?.destinations.some(item => item.section === 'summary' && item.uri === aliases[0].url))
    assert.ok(value.scopes.find(scope => scope.source[0] === 'synced_groups' && scope.source[1] === command.action.groupId)?.destinations.some(item => item.uri === aliases[1].url))
    assert.ok(urls(value).includes(aliases[0].url)); assert.ok(urls(value).includes(aliases[1].url))
    assert.equal(value.kind, 'capsule2-known-markdown-asset-references')
    assert.equal(value.version, 2)
    assert.ok(value.unresolved.includes('remaining-policy-held-payload-asset-scopes'))
  })
}))

test('capsule2 asset discovery includes every actual checkpoint, trash, frozen move side and saved draft scope', () => withV3Fixture(async f => {
  const source = f.store.createQuickNote({ title: 'Asset move source', content: '[moving](file:///missing/moved.png)\n\nKept paragraph' })
  const target = f.store.createQuickNote({ title: 'Asset move target', content: 'Target paragraph' })
  const a = f.store.getDocumentDetail(source)!, b = f.store.getDocumentDetail(target)!
  const move = f.store.moveDocumentBlocks({ fromDocumentId: source, toDocumentId: target, blockIds: [a.blocks[0].id], expectedFromUpdatedAt: a.updatedAt, expectedToUpdatedAt: b.updatedAt })
  const trashed = f.store.createQuickNote({ title: 'Asset trash source', content: '![old](file:///missing/trash.png)' })
  f.store.deleteDocument(trashed)
  const template = f.store.saveDocumentTemplate({ name: 'Asset future draft', title: '{{title}}', summary: '[draft](knowbook-asset://future/{{date}})', blocks: [block('draft-body', '![draft](file:///missing/draft.png)')] })
  await observe(f, value => {
    const moveScopes = value.scopes.filter(scope => scope.source[0] === 'document_block_moves' && scope.source[1] === move.operationId)
    assert.equal(moveScopes.length, 4)
    assert.ok(moveScopes.filter(scope => scope.source[2] === 'before_json').flatMap(scope => scope.destinations).some(item => item.uri === 'file:///missing/moved.png'))
    assert.ok(moveScopes.filter(scope => scope.source[2] === 'after_json').flatMap(scope => scope.destinations).some(item => item.uri === 'file:///missing/moved.png'))
    assert.ok(value.scopes.filter(scope => scope.source[0] === 'document_history').some(scope => scope.destinations.some(item => item.uri === 'file:///missing/moved.png')))
    assert.ok(value.scopes.find(scope => scope.source[0] === 'document_trash' && scope.source[1] === trashed)?.destinations.some(item => item.uri === 'file:///missing/trash.png'))
    const draft = value.scopes.find(scope => scope.source[0] === 'document_templates' && scope.source[1] === template.id)!
    assert.deepEqual(new Set(draft.destinations.map(item => item.uri)), new Set(['knowbook-asset://future/%7B%7Bdate%7D%7D', 'file:///missing/draft.png']))
    assert.equal(draft.destinations.find(item => item.section === 'summary')?.raw, 'knowbook-asset://future/{{date}}')
  })
}))

test('capsule2 asset discovery preserves the complete serialized cross-block reference and named-note scope', () => withV3Fixture(async f => {
  const template = f.store.saveDocumentTemplate({ name: 'Cross block assets', title: '', summary: '', blocks: [
    block('use', '![shared][asset] Footnote[^source]'), block('definition', '[asset]: <file:///missing/cross.png>'),
    block('note', '[^source]: <img src="knowbook&#45;asset&colon;//future/note">')
  ] })
  await observe(f, value => {
    const scope = value.scopes.find(scope => scope.source[0] === 'document_templates' && scope.source[1] === template.id)!
    assert.deepEqual(new Set(scope.destinations.map(item => item.uri)), new Set(['file:///missing/cross.png', 'knowbook-asset://future/note']))
    const markdown = serializeMarkdownWithBlockRanges(template.blocks).markdown
    for (const item of scope.destinations) assert.equal(markdown.slice(item.from, item.to), item.raw)
  })
}))

test('capsule2 asset discovery never turns code, math, config, format, settings or opaque template synced drafts into destinations', () => withV3Fixture(async f => {
  const fake = 'file:///never/opaque.png', config = createDefaultDatabaseViewConfig('table', [])
  config.query = `![opaque](${fake})`
  f.store.saveSetting('custom.opaque.asset-data', `![opaque](${fake})`)
  const template = f.store.saveDocumentTemplate({ name: 'Opaque assets', title: '', summary: '', blocks: [
    { ...block('code', `![opaque](${fake})`, 'code'), language: 'markdown', markdownFormat: { codeInfo: `file:///never/header.png` } },
    block('math', `![opaque](${fake})`, 'math'), block('draft-ref', `![opaque](${fake})`, 'synced-block'),
    block('config', serializeDatabaseViewPayload({ version: 1, databaseId: f.customId, viewId: f.view.id, config }), 'database-view'),
    block('literal', `\`![opaque](${fake})\` knowbook-asset://plain-word`)
  ] })
  await observe(f, value => assert.equal(value.scopes.find(scope => scope.source[0] === 'document_templates' && scope.source[1] === template.id)?.destinations.length, 0))
}))

test('capsule2 asset discovery keeps native column and toggle content while treating nested reference drafts as opaque', () => withV3Fixture(async f => {
  const template = f.store.saveDocumentTemplate({ name: 'Structured asset source', title: '', summary: '', blocks: [
    block('layout', '', 'columns'), { ...block('column', '', 'column'), depth: 1, parentBlockId: 'layout', markdownFormat: { columnWeight: 10000 } },
    { ...block('toggle', '[nested](file:///missing/nested.png)', 'toggle'), depth: 2, parentBlockId: 'column' },
    { ...block('nested-draft', 'not group authority ![opaque](file:///never/draft.png)', 'synced-block'), depth: 3, parentBlockId: 'toggle' }
  ] })
  await observe(f, value => assert.deepEqual(value.scopes.find(scope => scope.source[0] === 'document_templates' && scope.source[1] === template.id)?.destinations.map(item => item.uri), ['file:///missing/nested.png']))
}))

test('capsule2 asset discovery does not authenticate or read asset file bytes and stays stable when the same owned SQL has different external bytes', () => withV3Fixture(async f => {
  const [attachment] = await f.assets.import([{ name: 'unverified.png', bytes: Buffer.from('original asset bytes') }])
  const id = f.store.createQuickNote({ title: 'External asset bytes', content: `![image](<${attachment.url}>) [missing](file:///never/existing/file.png)` })
  let before: RawCapsule2AssetReferences | undefined
  await observe(f, value => { before = value; assert.ok(urls(value).includes(attachment.url)); assert.ok(value.scopes.some(scope => scope.source[1] === id)) })
  writeFileSync(f.assets.resolve(attachment.url), 'changed external bytes outside the SQL original')
  await observe(f, value => assert.deepEqual(value, before))
}))

test('capsule2 asset discovery checks the complete10000 saved blocks and all129 template rows through their final source scopes', () => withV3Fixture(async f => {
  const first = f.store.saveDocumentTemplate({ name: 'Complete asset body', title: '', summary: '', blocks: Array.from({ length: 10000 }, (_, i) => block('asset-block-' + i, i === 9999 ? '[last](file:///missing/last-block.png)' : '')) })
  for (let i = 1; i < 129; i++) f.store.saveDocumentTemplate({ name: 'Template ' + i, title: '', summary: '', blocks: [block('body', `[asset](file:///missing/template-${i}.png)`)] })
  await observe(f, value => {
    const scopes = value.scopes.filter(scope => scope.source[0] === 'document_templates')
    assert.equal(scopes.length, 129)
    assert.ok(scopes.find(scope => scope.source[1] === first.id)?.destinations.some(item => item.uri === 'file:///missing/last-block.png'))
    for (let i = 1; i < 129; i++) assert.ok(urls(value).includes(`file:///missing/template-${i}.png`))
  })
}))

test('capsule2 asset discovery requires the real readonly query-only FK transaction and rejects an unknown reserved family', () => withV3Fixture(async f => {
  assert.throws(() => readRawCapsule2AssetReferencesOwned(f.db), /readonly/)
  await withCapsule2RawCopy(f, db => {
    assert.throws(() => readRawCapsule2AssetReferencesOwned(db), /readonly/)
    db.pragma('query_only=OFF')
    assert.throws(() => db.transaction(() => readRawCapsule2AssetReferencesOwned(db))(), /readonly/)
    db.pragma('query_only=ON'); db.pragma('foreign_keys=OFF')
    assert.throws(() => db.transaction(() => readRawCapsule2AssetReferencesOwned(db))(), /readonly/)
  })
  f.store.saveSetting('sync.webdav.protocol5.asset-reader.future.v99.' + randomUUID(), '{}')
  await withCapsule2RawCopy(f, db => assert.throws(() => db.transaction(() => readRawCapsule2AssetReferencesOwned(db))(), /未知|reserved/))
}))

test('capsule2 asset observation and each complete scope/destination are frozen data with no certificate or installation flag', () => withV3Fixture(async f => {
  f.store.createQuickNote({ content: '![image](file:///missing/frozen.png)' })
  await observe(f, value => {
    assert.ok(Object.isFrozen(value) && Object.isFrozen(value.scopes) && Object.isFrozen(value.unresolved))
    for (const scope of value.scopes) {
      assert.ok(Object.isFrozen(scope) && Object.isFrozen(scope.source) && Object.isFrozen(scope.destinations))
      for (const item of scope.destinations) assert.ok(Object.isFrozen(item))
    }
    assert.equal(Reflect.set(value, 'certified', true), false)
    assert.equal(Reflect.set(value, 'sourceFileBytesVerified', true), false)
  })
}))
