import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store.ts'
import { MarkdownBackupService } from '../src/main/backup/exporter.ts'
import { MarkdownRestoreService } from '../src/main/backup/importer.ts'
import { PluginHost } from '../src/main/plugin-host.ts'
import { WebClipBridgeService } from '../src/main/web-clip-bridge.ts'
import { isPublicIpAddress } from '../src/main/web-clipper.ts'
import { parseMarkdownBackupDocument } from '../src/shared/markdown.ts'

test('store enables a busy timeout so concurrent access waits instead of failing', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-busy-timeout-test-'))
  const store = new KnowbookStore(join(tempRoot, 't.sqlite'))
  try {
    type PragmaFn = (statement: string, options?: { simple?: boolean }) => unknown
    const db = (store as unknown as { db: { pragma: PragmaFn } }).db
    assert.equal(Number(db.pragma('busy_timeout', { simple: true })) > 0, true)
  } finally {
    store.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('document detail heals orphaned child blocks whose parent row disappeared', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-orphan-heal-test-'))
  const store = new KnowbookStore(join(tempRoot, 't.sqlite'))
  try {
    const home = store.getHomeData('').documentCatalog.find((entry) => entry.path === 'Home')
    assert.ok(home)
    const documentId = store.createDocument(home.id)
    store.updateDocument(documentId, {
      title: 'Orphan heal',
      summary: '',
      blocks: [
        { id: 'parent-block', type: 'bulleted-list', content: 'parent', checked: false, depth: 0 },
        { id: 'child-block', type: 'bulleted-list', content: 'child', checked: false, depth: 1, parentBlockId: 'parent-block' },
        { id: 'grandchild-block', type: 'todo', content: 'grandchild', checked: false, depth: 2, parentBlockId: 'child-block' }
      ]
    })

    const db = (store as unknown as { db: { prepare: (sql: string) => { run: (...args: never[]) => unknown } } }).db
    db.prepare('DELETE FROM blocks WHERE id = ?').run('parent-block' as never)

    const detail = store.getDocumentDetail(documentId)
    assert.ok(detail)
    const child = detail!.blocks.find((block) => block.id === 'child-block')
    const grandchild = detail!.blocks.find((block) => block.id === 'grandchild-block')

    assert.ok(child)
    assert.ok(grandchild)
    assert.equal(child.depth, 0, 'the orphaned child must be presented at root depth')
    assert.equal(child.parentBlockId, null)
    assert.equal(grandchild.depth, 1, 'the grandchild must stay nested under the healed child')
    assert.equal(grandchild.parentBlockId, 'child-block')
  } finally {
    store.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('wiki-link resolution accepts case-insensitive paths like the rest of the system', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-link-nocase-test-'))
  const store = new KnowbookStore(join(tempRoot, 't.sqlite'))
  try {
    const catalog = store.getHomeData('').documentCatalog
    const product = catalog.find((entry) => entry.path === 'Home/Product')
    assert.ok(product)
    const referencingId = store.createDocument(product.parentId ?? null)
    store.updateDocument(referencingId, {
      title: 'Referencing note',
      summary: '',
      blocks: [{ type: 'paragraph', content: 'See [[home/product]] for details.', checked: false, depth: 0 }]
    })

    const detail = store.getDocumentDetail(referencingId)
    assert.ok(detail)
    assert.equal(
      detail!.outgoingLinks.some((link) => link.path === 'Home/Product'),
      true,
      'a case-variant wiki link must resolve to the canonical document'
    )
  } finally {
    store.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('public ip gate rejects IPv4-bearing IPv6 forms used for SSRF bypasses', () => {
  assert.equal(isPublicIpAddress('::ffff:127.0.0.1'), false, 'IPv4-mapped loopback stays blocked')
  assert.equal(isPublicIpAddress('::127.0.0.1'), false, 'dotted-quad IPv4-compatible form must be blocked')
  assert.equal(isPublicIpAddress('::7f00:1'), false, 'hex-encoded IPv4-compatible form must be blocked')
  assert.equal(isPublicIpAddress('64:ff9b::127.0.0.1'), false, 'NAT64 loopback must be blocked')
  assert.equal(isPublicIpAddress('64:ff9b::7f00:1'), false, 'NAT64 hex form must be blocked')
  assert.equal(isPublicIpAddress('2002:7f00:1::'), false, '6to4-wrapped loopback must be blocked')

  assert.equal(isPublicIpAddress('2606:4700::1111'), true, 'regular public IPv6 stays allowed')
  assert.equal(isPublicIpAddress('8.8.8.8'), true, 'public IPv4 stays allowed')
  assert.equal(isPublicIpAddress('fe80::1'), false, 'link-local stays blocked')
  assert.equal(isPublicIpAddress('fd12::1'), false, 'ULA stays blocked')
})

test('bridge responses restrict CORS to browser-extension origins', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-bridge-cors-test-'))
  const store = new KnowbookStore(join(tempRoot, 'store.sqlite'))
  const bridge = new WebClipBridgeService({
    onImport: async () => ({
      documentId: 'doc',
      title: 't',
      created: true,
      warnings: [],
      sourceUrl: 'https://example.com/a',
      duplicateOfDocumentId: null
    })
  })

  try {
    const status = await bridge.applyConfig({ enabled: true, port: 0, token: 'cors-token' })
    assert.ok(status.endpoint)
    const endpoint = new URL(status.endpoint!)
    const base = `http://127.0.0.1:${endpoint.port}`

    const malicious = await fetch(`${base}/health`, {
      headers: { Origin: 'https://evil.example' }
    })
    assert.equal(malicious.headers.get('access-control-allow-origin'), null, 'web origins must not receive CORS grants')

    const extension = await fetch(`${base}/health`, {
      headers: { Origin: 'chrome-extension://abcdefg' }
    })
    assert.equal(extension.headers.get('access-control-allow-origin'), 'chrome-extension://abcdefg')

    const preflight = await fetch(`${base}/clip`, {
      method: 'OPTIONS',
      headers: { Origin: 'chrome-extension://abcdefg' }
    })
    assert.equal(preflight.status, 204)
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'chrome-extension://abcdefg')

    const noOrigin = await fetch(`${base}/health`)
    assert.equal(noOrigin.status, 200)
    assert.equal(noOrigin.headers.get('access-control-allow-origin'), null)
  } finally {
    await bridge.destroy()
    store.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('restore rejects markdown files that are not valid UTF-8', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-restore-utf8-test-'))
  const backupRoot = join(tempRoot, 'backup')
  const store = new KnowbookStore(join(tempRoot, 't.sqlite'))

  try {
    await new MarkdownBackupService(store, backupRoot).exportAll()
    const roadmapFile = join(backupRoot, 'Home', 'Product', 'Roadmap.md')
    const bytes = readFileSync(roadmapFile)
    writeFileSync(roadmapFile, Buffer.concat([bytes.subarray(0, 10), Buffer.from([0xff, 0xfe, 0xdd]), bytes.subarray(13)]))

    await assert.rejects(
      new MarkdownRestoreService(store).restoreFromDirectory(backupRoot),
      /UTF-8/
    )
  } finally {
    store.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('markdown parsing normalizes lone CR line endings', () => {
  const parsed = parseMarkdownBackupDocument('---\rkind: document\rid: doc-cr\r---\r\rFirst line\rSecond line')
  assert.equal(parsed.frontmatter.id, 'doc-cr')
  const bodyText = parsed.blocks.map((block) => block.content).join('\n')
  assert.equal(bodyText.includes('\r'), false, 'lone carriage returns must be normalized')
})

test('isolated plugin action results are normalized like in-process results', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-isolated-result-normalize-test-'))
  const workspaceRoot = join(tempRoot, 'plugins')
  const pluginRoot = join(workspaceRoot, 'isolated-probe')
  mkdirSync(pluginRoot, { recursive: true })
  writeFileSync(join(pluginRoot, 'plugin.json'), JSON.stringify({
    id: 'isolated-probe',
    name: 'Isolated Probe',
    version: '1.0.0'
  }))
  writeFileSync(join(pluginRoot, 'index.js'), '')

  const document = {
    id: 'doc-1',
    title: 'Document',
    path: 'Document',
    summary: '',
    updatedAt: '2026-07-30T00:00:00.000Z',
    blocks: [],
    children: [],
    outgoingLinks: [],
    backlinks: []
  }
  const runtime = {
    initialize: async () => ({
      state: { status: 'running', dashboardCards: [], documentActions: [{
        pluginId: 'isolated-probe', id: 'act', label: 'Act'
      }], settings: [] },
      effects: []
    }),
    handleWorkspaceEvent: async () => ({ state: { status: 'running', dashboardCards: [], documentActions: [], settings: [] }, effects: [] }),
    runDocumentAction: async () => ({
      state: { status: 'running', dashboardCards: [], documentActions: [], settings: [] },
      effects: [],
      result: 'done string'
    }),
    updateSetting: async () => ({ state: { status: 'running', dashboardCards: [], documentActions: [], settings: [] }, effects: [] }),
    dispose: async () => undefined,
    onStateChanged: () => () => undefined,
    onFailure: () => () => undefined
  }
  const store = {
    getSettingPublic: () => null,
    getSettingsByPrefix: () => ({}),
    getPluginWorkspaceDocuments: () => [document],
    saveSetting: () => undefined,
    getDocumentDetail: () => document,
    updateDocumentSummary: () => undefined,
    recordWorkspaceEvent: () => undefined
  }
  const host = new PluginHost(
    store as never,
    [{ path: workspaceRoot, source: 'workspace' }],
    '1.0.0',
    null,
    { runtimeFactory: () => runtime as never }
  )

  try {
    await host.loadAll()
    const result = await host.runDocumentAction({
      pluginId: 'isolated-probe',
      actionId: 'act',
      documentId: document.id
    })
    assert.deepEqual(result, { message: 'done string', refreshDocument: false })
  } finally {
    await host.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('removing a workspace-shadowed plugin clears its dormant user-data copy', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-plugin-shadow-test-'))
  const workspaceRoot = join(tempRoot, 'workspace-plugins')
  const userDataRoot = join(tempRoot, 'user-plugins')
  const shadowedId = 'shadow-probe'
  for (const root of [join(workspaceRoot, shadowedId), join(userDataRoot, shadowedId)]) {
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'plugin.json'), JSON.stringify({ id: shadowedId, name: 'Shadow', version: '1.0.0' }))
    writeFileSync(join(root, 'index.js'), '')
  }

  const store = {
    getSettingPublic: () => null,
    getSettingsByPrefix: () => ({}),
    getPluginWorkspaceDocuments: () => [],
    saveSetting: () => undefined,
    getDocumentDetail: () => null,
    updateDocumentSummary: () => undefined,
    recordWorkspaceEvent: () => undefined
  }
  const host = new PluginHost(
    store as never,
    [
      { path: workspaceRoot, source: 'workspace' },
      { path: userDataRoot, source: 'user-data' }
    ],
    '1.0.0',
    null
  )

  try {
    await host.loadAll()

    await host.removePlugin(shadowedId)

    assert.equal(existsSync(join(userDataRoot, shadowedId)), false, 'the dormant copy must be deleted')
    assert.equal(existsSync(join(workspaceRoot, shadowedId)), true, 'the workspace original must remain untouched')
    assert.ok(host.getHomeDataSnapshot().plugins.some((plugin) => plugin.id === shadowedId))
  } finally {
    await host.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('plugin operations sweep abandoned staging directories older than a day', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-plugin-sweep-test-'))
  const workspaceRoot = join(tempRoot, 'workspace-plugins')
  const userDataRoot = join(tempRoot, 'user-plugins')
  mkdirSync(join(workspaceRoot, 'probe'), { recursive: true })
  writeFileSync(join(workspaceRoot, 'probe', 'plugin.json'), JSON.stringify({ id: 'probe', name: 'Probe', version: '1.0.0' }))
  writeFileSync(join(workspaceRoot, 'probe', 'index.js'), '')

  const operationRoot = join(userDataRoot, '.knowbook-operations')
  const stalePrevious = join(operationRoot, 'previous-stale-1234')
  const freshStaging = join(operationRoot, 'install-fresh-5678')
  mkdirSync(stalePrevious, { recursive: true })
  mkdirSync(freshStaging, { recursive: true })
  const old = new Date(Date.now() - 48 * 3600_000)
  utimesSync(stalePrevious, old, old)

  const store = {
    getSettingPublic: () => null,
    getSettingsByPrefix: () => ({}),
    getPluginWorkspaceDocuments: () => [],
    saveSetting: () => undefined,
    getDocumentDetail: () => null,
    updateDocumentSummary: () => undefined,
    recordWorkspaceEvent: () => undefined
  }
  const host = new PluginHost(
    store as never,
    [
      { path: workspaceRoot, source: 'workspace' },
      { path: userDataRoot, source: 'user-data' }
    ],
    '1.0.0',
    null
  )

  try {
    await host.loadAll()
    assert.equal(existsSync(stalePrevious), false, 'abandoned previous-* directories must be swept')
    assert.equal(existsSync(freshStaging), true, 'recent staging directories must survive')
  } finally {
    await host.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
