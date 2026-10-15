import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { attachmentFileName } from '../src/main/attachments'
import type { SyncedCanonicalWire, SyncedGroupWire, SyncedStableBlockDraft } from '../src/shared/synced-blocks'
import { createDefaultDatabaseViewConfig } from '../src/shared/database-workspace'
import { serializeDatabaseViewPayload } from '../src/shared/databaseViewBlock'
import { collectMarkdownDestinations } from '../src/shared/markdownLinks'
import { parseMarkdownBlocks } from '../src/shared/markdown'
import { SYNCED_GROUP_MAX_BYTES, SYNCED_MAX_BLOCKS, SyncedValidationError } from '../src/shared/syncedBlockValidation'
import {
  SYNCED_ASSET_BUDGET_HASH, buildSyncedPortableAssetUri, canonicalSyncedPortableJson, collectSyncedMarkdownAssetDestinations, measureSyncedPortableGroup,
  measureSyncedPortableHost, parseSyncedPortableAssetUri, projectSyncedGroupBudget, projectSyncedHostBudget,
  rewriteSyncedGroupAssets, syncedManagedAssetBudgetUri, syncedPortableAssetBackupPath, type SyncedPortableHostRecord
} from '../src/shared/syncedBlockPortable'

const time = '2026-10-16T00:00:00.000Z', hash = 'a'.repeat(64), otherHash = 'b'.repeat(64)
const wireBlock = (content = '', id = '  旧:正文  '): SyncedCanonicalWire => ({ id, type: 'paragraph', content,
  checked: false, depth: 0, parentBlockId: null, createdAt: time })
function group(blocks = [wireBlock()]): SyncedGroupWire {
  return { kind: 'synced-group', id: randomUUID(), creationId: randomUUID(), createdAt: time,
    origin: { version: 1, documentId: 'origin', pathAtCreation: 'Origin', firstInstanceId: randomUUID() }, bindings: [], blocks }
}
const edit = ({ createdAt: _createdAt, ...block }: SyncedCanonicalWire): SyncedStableBlockDraft => block
function host(blocks: SyncedStableBlockDraft[]): SyncedPortableHostRecord {
  return { kind: 'document', id: 'host', parentId: null, sortOrder: 0, createdAt: time, content: { title: 'Host', summary: '', blocks } }
}
const reference = (groupId: string, depth = 0, parentBlockId: string | null = null): SyncedStableBlockDraft => ({ id: randomUUID(), type: 'synced-block',
  content: JSON.stringify({ version: 1, groupId }), checked: false, depth, parentBlockId })
const local = (name: string, prefix = 'file:///C:/Profile/storage') => `${prefix}/attachments/${hash.slice(0, 2)}/${hash}/${encodeURIComponent(name)
  .replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`
const budgetError = (error: unknown) => error instanceof SyncedValidationError && error.code === 'budget'

test('portable URI canonical spelling is exactly the current encodeURIComponent builder and preserves name aliases', () => {
  const name = "中文 图 !'().png", uri = buildSyncedPortableAssetUri({ hash, name })
  assert.equal(uri, `knowbook-asset://${hash}/${encodeURIComponent(name)}`)
  assert.deepEqual(parseSyncedPortableAssetUri(uri), { hash, name, encodedName: encodeURIComponent(name) })
  assert.equal(buildSyncedPortableAssetUri(parseSyncedPortableAssetUri(uri)), uri)
  assert.equal(syncedPortableAssetBackupPath(uri), `__knowbook/assets/attachments/aa/${hash}/${name}`)
  const alias = buildSyncedPortableAssetUri({ hash, name: 'same-bytes-other-name.png' })
  assert.notEqual(syncedPortableAssetBackupPath(alias), syncedPortableAssetBackupPath(uri))
})

test('portable URI rejects credentials, ports, query, fragments, paths and alternate encoding spellings', () => {
  const valid = buildSyncedPortableAssetUri({ hash, name: 'asset !().png' })
  const invalid = [
    valid.replace('knowbook-', 'KNOWBOOK-'), valid.replace(hash, hash.toUpperCase()),
    valid.replace(hash, `user@${hash}`), valid.replace(hash, `${hash}:80`), `${valid}?x=1`, `${valid}#fragment`, `${valid}/`,
    valid.replace('asset', '%61sset'), valid.replace('!', '%21'), valid.replace('(', '%28'),
    `knowbook-asset://${hash}/a%2fb.png`, `knowbook-asset://${hash}/a%5Cb.png`, `knowbook-asset://${hash}/%2E%2E`,
    `knowbook-asset://${hash}/x%00.png`, `knowbook-asset://${hash}/%ZZ.png`, `knowbook-asset://${hash}/%E4%b8%AD.png`,
    `knowbook-asset://${hash}/../asset.png`, `knowbook-asset://${hash}/`, `knowbook-asset://${hash}/raw space.png`
  ]
  for (const uri of invalid) assert.throws(() => parseSyncedPortableAssetUri(uri), SyncedValidationError, uri)
})

test('portable names obey the existing managed filename closure without truncation, trimming or path repair', () => {
  for (const name of ['', '.', '..', 'x/', 'x\\y', 'trailing.', ' leading', 'trailing ', 'CON', 'com1.txt', 'bad?.png', 'a'.repeat(121), '\ud800']) {
    assert.throws(() => buildSyncedPortableAssetUri({ hash, name }), SyncedValidationError, name)
  }
  assert.equal(parseSyncedPortableAssetUri(buildSyncedPortableAssetUri({ hash, name: '_CON.txt' })).name, '_CON.txt')
  assert.equal(parseSyncedPortableAssetUri(buildSyncedPortableAssetUri({ hash, name: 'a'.repeat(120) })).name.length, 120)
})

test('portable filenames preserve the actual builder reserved-name prefix after its 120-character bound', () => {
  for (const source of [`CON.${'a'.repeat(116)}`, `com9.${'b'.repeat(115)}`, 'normal-name.png', 'x'.repeat(150)]) {
    const name = attachmentFileName(source), uri = buildSyncedPortableAssetUri({ hash, name })
    assert.equal(parseSyncedPortableAssetUri(uri).name, name)
    assert.equal(syncedPortableAssetBackupPath(uri), `__knowbook/assets/attachments/aa/${hash}/${name}`)
  }
  const reserved = attachmentFileName(`CON.${'a'.repeat(116)}`)
  assert.equal(reserved.length, 121); assert.equal(reserved, `_CON.${'a'.repeat(116)}`)
  for (const name of [`_plain${'a'.repeat(115)}`, `_CONx${'a'.repeat(116)}`, `${reserved}x`]) {
    assert.ok(name.length > 120)
    assert.throws(() => buildSyncedPortableAssetUri({ hash, name }), SyncedValidationError)
  }
})

test('managed local budget projection reads only URI syntax and uses the zero hash with the same canonical encoded name', () => {
  const name = '图 !().png', expected = buildSyncedPortableAssetUri({ hash: SYNCED_ASSET_BUDGET_HASH, name })
  assert.equal(syncedManagedAssetBudgetUri(local(name)), expected)
  assert.equal(syncedManagedAssetBudgetUri(local(name, `file:///C:/${'very-long-profile/'.repeat(40)}storage`)), expected)
  for (const uri of [local(name).replace('/aa/', '/bb/'), local(name).replace('file:///C:', 'file://remote/C:'), `${local(name)}?download=1`,
    'file:///C:/outside/image.png', local(name).replace(hash, otherHash), local(name).replace('attachments/', 'files/')]) {
    assert.throws(() => syncedManagedAssetBudgetUri(uri), SyncedValidationError)
  }
})

test('the finite asset visitor rewrites actual Markdown destinations and adjusts later UTF-16 binding ranges', () => {
  const source = `😀 ![图](<${local('a(b.png')}>) and [link](Target.md)`
  const input = group([wireBlock(source)]), from = source.indexOf('[link]')
  input.bindings = [{ blockId: input.blocks[0].id, from, to: source.length, raw: source.slice(from), syntax: 'markdown',
    target: { kind: 'document', id: 'target', state: 'live' } }]
  const before = structuredClone(input), mapped = rewriteSyncedGroupAssets(input, syncedManagedAssetBudgetUri)
  const uri = buildSyncedPortableAssetUri({ hash: SYNCED_ASSET_BUDGET_HASH, name: 'a(b.png' })
  assert.equal(mapped.blocks[0].content, `😀 ![图](<${uri}>) and [link](Target.md)`)
  assert.equal(mapped.bindings[0].from, mapped.blocks[0].content.indexOf('[link]'))
  assert.equal(mapped.bindings[0].raw, '[link](Target.md)'); assert.equal(mapped.bindings[0].to, mapped.blocks[0].content.length)
  assert.deepEqual(mapped.bindings[0].target, input.bindings[0].target)
  assert.deepEqual(input, before, 'the original canonical content, identity and binding ranges stay unchanged')
  assert.equal(collectMarkdownDestinations(mapped.blocks[0].content)[0].url, uri)
})

test('asset mapping keeps unbalanced punctuation parseable and preserves HTML, definitions and repeated occurrences', () => {
  const source = `![x](${local('a(b.png')})\n\n<img src="${local("quote'.png")}" alt="x">\n\n[r]: ${local('ref.png')}\n\n![r][r]\n\n![again](${local('a(b.png')})`
  const before = collectSyncedMarkdownAssetDestinations(source)
  assert.deepEqual(before, collectMarkdownDestinations(source))
  assert.equal(before.length, 4)
  assert.deepEqual(before.map(item => source.slice(item.start, item.end)),
    [local('a(b.png'), local("quote'.png"), local('ref.png'), local('a(b.png')])
  const mapped = rewriteSyncedGroupAssets(group([wireBlock(source)]), syncedManagedAssetBudgetUri)
  const content = mapped.blocks[0].content, after = collectSyncedMarkdownAssetDestinations(content)
  const urls = after.map(item => item.url).filter(uri => uri.startsWith('knowbook-asset:'))
  assert.equal(urls.length, 4)
  assert.deepEqual(urls.map(parseSyncedPortableAssetUri).map(asset => asset.name), ['a(b.png', "quote'.png", 'ref.png', 'a(b.png'])
  assert.deepEqual(after.map(item => content.slice(item.start, item.end)),
    [urls[0], urls[1].replace("'", '&#39;'), urls[2], urls[3]])
  assert.deepEqual(after.map(item => [item.kind, item.syntax]), before.map(item => [item.kind, item.syntax]))
  assert.equal(collectMarkdownDestinations(content).length, 3, 'portable capture does not grant the public renderer a new HTML URL protocol')
  assert.ok(measureSyncedPortableGroup(mapped).bytes > 0)
  assert.ok(mapped.blocks[0].content.includes('![x](<knowbook-asset:'))
})

test('a real parsed html block visits its image destination while code with the same HTML stays literal', () => {
  const source = `<figure><img src="${local('html.png')}" alt="actual html"><figcaption>Caption</figcaption></figure>`, parsed = parseMarkdownBlocks(source)
  assert.equal(parsed.length, 1); assert.equal(parsed[0].type, 'html')
  const input = group([{ ...parsed[0], id: 'parsed-html', parentBlockId: null, createdAt: time,
    checked: parsed[0].checked ?? false, depth: parsed[0].depth ?? 0, language: parsed[0].language ?? undefined },
    { ...wireBlock(source, 'literal-code'), type: 'code' }])
  let calls = 0
  const mapped = rewriteSyncedGroupAssets(input, uri => { calls++; return syncedManagedAssetBudgetUri(uri) })
  assert.equal(calls, 1)
  const urls = collectSyncedMarkdownAssetDestinations(mapped.blocks[0].content).map(item => item.url)
  assert.deepEqual(urls, [buildSyncedPortableAssetUri({ hash: SYNCED_ASSET_BUDGET_HASH, name: 'html.png' })])
  assert.equal(mapped.blocks[1].content, source)
  assert.ok(measureSyncedPortableGroup(mapped).bytes > 0)
})

test('portable HTML capture strictly checks logical entity-decoded URIs and leaves real file aliases and code literal', () => {
  const valid = buildSyncedPortableAssetUri({ hash, name: "quote'.png" })
  const html = (uri: string) => `<img src="${uri}" alt="x">`
  const encoded = html(valid.replace("'", '&#39;'))
  assert.equal(collectSyncedMarkdownAssetDestinations(encoded)[0].url, valid)
  assert.equal(collectSyncedMarkdownAssetDestinations(html(valid.replace('knowbook-asset:', 'knowbook&#45;asset&colon;')))[0].url, valid)
  const realFile = `file:///_______//${hash}/literal.png`
  assert.equal(collectSyncedMarkdownAssetDestinations(html(realFile))[0].url, realFile, 'a real file URI is never mistaken for a parsing alias')
  for (const uri of [valid.replace(hash, `user@${hash}`), `${valid}?x=1`, valid.replace('quote', '%71uote'),
    valid.replace('knowbook-', 'KNOWBOOK-'), valid.replace('/quote', '/dir/../quote')]) {
    const literal = html(uri)
    assert.throws(() => measureSyncedPortableGroup(group([wireBlock(literal)])), SyncedValidationError, uri)
    const entityScheme = uri.replace(/knowbook-asset:/i, scheme => scheme.replace('-', '&#45;').replace(':', '&colon;'))
    assert.throws(() => measureSyncedPortableGroup(group([wireBlock(html(entityScheme))])), SyncedValidationError, uri)
    assert.deepEqual(collectSyncedMarkdownAssetDestinations(`\`${literal}\`\n\n\`\`\`html\n${literal}\n\`\`\``), [])
    assert.doesNotThrow(() => measureSyncedPortableGroup(group([{ ...wireBlock(literal), type: 'code' }])))
  }
})

test('portable-looking bare words stay literal while real file autolinks materialize exactly once', () => {
  const valid = buildSyncedPortableAssetUri({ hash, name: 'literal.png' }), malformed = `${valid}?query=1`
  const literal = `Example ${valid} and ${malformed}`
  assert.deepEqual(collectMarkdownDestinations(literal), [])
  assert.deepEqual(collectSyncedMarkdownAssetDestinations(literal), [])
  let calls = 0
  const map = (uri: string) => { calls++; return syncedManagedAssetBudgetUri(uri) }
  assert.equal(rewriteSyncedGroupAssets(group([wireBlock(literal)]), map).blocks[0].content, literal)
  assert.equal(calls, 0)
  assert.doesNotThrow(() => measureSyncedPortableGroup(group([wireBlock(literal)])))
  assert.throws(() => measureSyncedPortableGroup(group([wireBlock(`[actual](<${malformed}>)`)])), SyncedValidationError)
  const file = local('real.png'), source = `Original ${file}`
  assert.equal(collectSyncedMarkdownAssetDestinations(source)[0].syntax, 'bare')
  const mapped = rewriteSyncedGroupAssets(group([wireBlock(source)]), map).blocks[0].content
  assert.equal(calls, 1)
  assert.equal(mapped, `Original [${file}](<${buildSyncedPortableAssetUri({ hash: SYNCED_ASSET_BUDGET_HASH, name: 'real.png' })}>)`)
  assert.equal(collectSyncedMarkdownAssetDestinations(mapped).length, 1)
})

test('HTML scheme lookalikes remain original relative destinations and never leak parsing aliases into the mapper', () => {
  const suffix = `///attachments/aa/${hash}/relative.png`
  for (const relative of [`knowbook-asset&COLON;${suffix}`, `knowbook&#x2dasset:${suffix}`]) {
    const source = `<img src="${relative}" alt="relative">`
    assert.equal(collectMarkdownDestinations(source).length, 1, 'this is an actual relative HTML image, not a portable asset')
    assert.deepEqual(collectSyncedMarkdownAssetDestinations(source), [])
    let calls = 0
    const rewritten = rewriteSyncedGroupAssets(group([wireBlock(source)]), uri => { calls++; return syncedManagedAssetBudgetUri(uri) })
    assert.equal(rewritten.blocks[0].content, source)
    assert.equal(calls, 0)
    assert.doesNotThrow(() => measureSyncedPortableGroup(rewritten))
  }
})

test('code, math, YAML, DB config, format codeInfo and Origin strings are never recursively treated as assets', () => {
  const uri = local('opaque.png'), literal = `![literal](<${uri}>)`
  const config = createDefaultDatabaseViewConfig(); config.query = literal
  const db = serializeDatabaseViewPayload({ version: 1, databaseId: 'source-db', viewId: null, config })
  const input = group([
    { ...wireBlock(literal, 'code'), type: 'code', markdownFormat: { codeInfo: uri } },
    { ...wireBlock(literal, 'math'), type: 'math' }, { ...wireBlock(`---\nx: '${literal}'\n---`, 'yaml'), type: 'frontmatter' },
    { ...wireBlock(db, 'db'), type: 'database-view' }, wireBlock(`\`${literal}\`\n\n\`\`\`md\n${literal}\n\`\`\``, 'examples')
  ])
  input.origin.pathAtCreation = uri
  let calls = 0
  const mapped = rewriteSyncedGroupAssets(input, value => { calls++; return syncedManagedAssetBudgetUri(value) })
  assert.equal(calls, 0); assert.deepEqual(mapped, input)
})

test('a binding crossed by an asset edit fails closed instead of guessing its new target range', () => {
  const source = `![x](<${local('image.png')}>)`, input = group([wireBlock(source)])
  const from = source.indexOf('file:') + 5
  input.bindings = [{ blockId: input.blocks[0].id, from, to: source.length, raw: source.slice(from), syntax: 'markdown',
    target: { kind: 'unresolved-url', path: 'relative.md', fragment: null } }]
  assert.throws(() => rewriteSyncedGroupAssets(input, syncedManagedAssetBudgetUri), SyncedValidationError)
})

test('group budget is the complete canonical UTF-8 wire JSON with an inclusive five MiB limit', () => {
  const input = group(), base = measureSyncedPortableGroup(input)
  input.blocks[0].content = 'x'.repeat(SYNCED_GROUP_MAX_BYTES - base.bytes)
  assert.equal(measureSyncedPortableGroup(input).bytes, SYNCED_GROUP_MAX_BYTES)
  input.blocks[0].content += 'x'
  assert.throws(() => measureSyncedPortableGroup(input), budgetError)
  const unicode = group([wireBlock('界'.repeat(1_800_000))])
  assert.ok(unicode.blocks[0].content.length < SYNCED_GROUP_MAX_BYTES)
  assert.throws(() => measureSyncedPortableGroup(unicode), budgetError)
})

test('budget projection removes local profile length without mutating canonical source or publishing fabricated hashes', () => {
  const short = group([wireBlock(`![x](<${local('image.png')}>)`)]), long = structuredClone(short)
  long.blocks[0].content = `![x](<${local('image.png', `file:///C:/${'long-profile/'.repeat(1000)}storage`)}>)`
  assert.deepEqual(projectSyncedGroupBudget(short), projectSyncedGroupBudget(long))
  assert.throws(() => measureSyncedPortableGroup(long), SyncedValidationError, 'local file URLs are not portable wire')
  const measured = projectSyncedGroupBudget(long)
  assert.deepEqual(Object.keys(measured).sort(), ['blocks', 'bytes'], 'no record containing zero-hash placeholders escapes the budget API')
  assert.ok(long.blocks[0].content.includes('long-profile'))
})

test('host occurrence measurement exactly includes the document envelope and counts every repeated group', () => {
  const shared = group([wireBlock('body', '__proto__')]), ordinary = edit(wireBlock('before', 'ordinary'))
  const input = host([ordinary, reference(shared.id), reference(shared.id)])
  input.content.summary = 'Summary'; input.content.title = '完整标题'
  const result = measureSyncedPortableHost(input, new Map([[shared.id, shared]]))
  const equivalent = { ...input, content: { ...input.content, blocks: [ordinary, edit(shared.blocks[0]), edit(shared.blocks[0])] } }
  assert.equal(result.blocks, 3)
  assert.equal(result.bytes, new TextEncoder().encode(canonicalSyncedPortableJson(equivalent)).byteLength)
  assert.equal(input.content.blocks[1].type, 'synced-block', 'measurement never detaches the real host')
})

test('a small unique group cannot bypass the host byte cap by appearing many times', () => {
  const shared = group([wireBlock('x'.repeat(2 * 1024 * 1024))])
  assert.ok(measureSyncedPortableGroup(shared).bytes < SYNCED_GROUP_MAX_BYTES)
  assert.equal(measureSyncedPortableHost(host(Array.from({ length: 5 }, () => reference(shared.id))), new Map([[shared.id, shared]])).blocks, 5)
  assert.throws(() => measureSyncedPortableHost(host(Array.from({ length: 9 }, () => reference(shared.id))), new Map([[shared.id, shared]])), budgetError)
})

test('the one hundred thousand expanded node boundary counts repeated occurrences, not unique canonical nodes', () => {
  const shared = group(Array.from({ length: 20_000 }, (_, index) => wireBlock('', `b${index}`)))
  const groups = new Map([[shared.id, shared]])
  assert.equal(measureSyncedPortableHost(host(Array.from({ length: 5 }, () => reference(shared.id))), groups).blocks, SYNCED_MAX_BLOCKS)
  assert.throws(() => measureSyncedPortableHost(host(Array.from({ length: 6 }, () => reference(shared.id))), groups), budgetError)
  assert.throws(() => measureSyncedPortableGroup(group(Array.from({ length: SYNCED_MAX_BLOCKS + 1 }, (_, index) => wireBlock('', `b${index}`)))), budgetError)
})

test('host budget validates missing snapshots, actual projected depth and does not impose the group five MiB cap on ordinary text', () => {
  const shared = group([{ ...wireBlock('toggle', 'owner'), type: 'toggle' },
    { ...wireBlock('child', 'child'), parentBlockId: 'owner', depth: 1 }])
  assert.throws(() => measureSyncedPortableHost(host([reference(shared.id)]), new Map()), SyncedValidationError)
  const owners = Array.from({ length: 6 }, (_, index) => ({ ...edit(wireBlock('owner', `o${index}`)), type: 'toggle', depth: index,
    parentBlockId: index ? `o${index - 1}` : null }))
  assert.throws(() => measureSyncedPortableHost(host([...owners, reference(shared.id, 6, 'o5')]), new Map([[shared.id, shared]])),
    error => error instanceof SyncedValidationError && error.code === 'depth')
  assert.ok(measureSyncedPortableHost(host([edit(wireBlock('x'.repeat(6 * 1024 * 1024)))]), new Map()).bytes > SYNCED_GROUP_MAX_BYTES)
})

test('transparent host expansion preserves the actual list-parent role instead of validating depth alone', () => {
  const listGroup = group([{ ...wireBlock('Nested task', 'canonical-task'), type: 'todo' }])
  const owner: SyncedStableBlockDraft = { ...edit(wireBlock('Owner task', 'host-task')), type: 'todo' }
  const input = host([owner, reference(listGroup.id, 1, owner.id)])
  assert.equal(measureSyncedPortableHost(input, new Map([[listGroup.id, listGroup]])).blocks, 2)
  const paragraphGroup = { ...listGroup, blocks: [wireBlock('Not a list item', 'canonical-paragraph')] }
  assert.throws(() => measureSyncedPortableHost(input, new Map([[paragraphGroup.id, paragraphGroup]])),
    (error: unknown) => error instanceof SyncedValidationError && error.code === 'forest')
})

test('host placeholder budgets share the same typed mapping and skip unreferenced groups', () => {
  const shared = group([wireBlock(`![x](<${local('a.png')}>)`)]), original = host([reference(shared.id)])
  original.content.summary = `[summary](<${local('b.png')}>)`
  const before = structuredClone(original), unreferenced = group([wireBlock('x'.repeat(6 * 1024 * 1024))])
  const measured = projectSyncedHostBudget(original, new Map([[shared.id, shared], [unreferenced.id, unreferenced]]))
  assert.equal(measured.blocks, 1); assert.ok(measured.bytes > 0)
  assert.deepEqual(original, before)
})
