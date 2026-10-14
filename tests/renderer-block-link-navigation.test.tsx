import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement } from 'react'
import { JSDOM } from 'jsdom'
import type { BlockReferenceResult, DocumentBlock, DocumentDetail, DocumentTreeNode, ElectronApi } from '../src/shared/contracts'
import type { AppMessageHandler } from '../src/renderer/src/notify'
import { useMarkdownNavigation } from '../src/renderer/src/hooks/useMarkdownNavigation'
import { useInlineReferenceNavigation } from '../src/renderer/src/hooks/useInlineReferenceNavigation'

type Kind = 'markdown' | 'inline'
type Navigation = { kind: 'block' | 'anchor' | 'document' | 'wiki'; documentId?: string; blockId?: string; anchor?: string; token?: string }
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
type BlockRequest = ReturnType<typeof deferred<BlockReferenceResult | null>> & { path: string; blockId: string }
type DetailRequest = ReturnType<typeof deferred<DocumentDetail | null>> & { documentId: string }
const block = (id: string, content: string, type = 'paragraph'): DocumentBlock =>
  ({ id, content, type, checked: false, depth: 0, parentBlockId: null, sortOrder: 0 })
function document(id: string, path: string, blocks: DocumentBlock[] = [block(id + '-paragraph', 'Body')]): DocumentDetail {
  return { id, path, title: path.split('/').at(-1)!, summary: '', updatedAt: '2026-10-14T00:00:00.000Z',
    blocks, children: [], outgoingLinks: [], backlinks: [] }
}
const documents = new Map([
  ['a', document('a', 'Docs/A')], ['b', document('b', 'Docs/B')],
  ['owner', document('owner', 'Archive/Actual', [block('actual-block', 'Actual owner body')])],
  ['heading', document('heading', 'Docs/Heading', [block('heading-block', 'Section title', 'heading-2'), block('caret-title', '^missing', 'heading-2')])]
])
const tree: DocumentTreeNode[] = [...documents.values()].map(detail =>
  ({ id: detail.id, title: detail.title, path: detail.path, updatedAt: detail.updatedAt, children: [] }))
function link(kind: Kind, path: string, fragment: string) {
  return kind === 'markdown' ? '/' + path.split('/').map(encodeURIComponent).join('/') + '.md#' + fragment : '[[' + path + '#' + fragment + ']]'
}
function reference(blockId = 'actual-block', documentId = 'owner'): BlockReferenceResult {
  const detail = documents.get(documentId)!
  return { documentId, documentPath: detail.path, documentTitle: detail.title, block: block(blockId, 'Actual owner body') }
}
type Context = {
  events: Navigation[]
  messages: Array<{ message: Parameters<AppMessageHandler>[0]; level: Parameters<AppMessageHandler>[1] }>
  blocks: BlockRequest[]
  details: DetailRequest[]
  select: (id: string | null) => Promise<void>
  begin: (kind: Kind, source: string) => Promise<{ completion: Promise<void> }>
  cancelDuringImport: (source: string) => Promise<void>
  resolveBlock: (index: number, result: BlockReferenceResult | null) => Promise<void>
  rejectBlock: (index: number, error: Error) => Promise<void>
  resolveDetail: (index: number, result: DocumentDetail | null) => Promise<void>
}
async function withNavigation(run: (context: Context) => Promise<void>) {
  const dom = new JSDOM('<div id="mount"></div>', { url: 'http://localhost' })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  const events: Navigation[] = [], messages: Context['messages'] = [], blocks: BlockRequest[] = [], details: DetailRequest[] = []
  const api: Partial<ElectronApi> = {
    getBlockReference: (path, blockId) => { const request = { ...deferred<BlockReferenceResult | null>(), path, blockId }; blocks.push(request); return request.promise },
    getDocumentDetail: documentId => { const request = { ...deferred<DocumentDetail | null>(), documentId }; details.push(request); return request.promise }
  }
  Object.defineProperty(dom.window, 'knowbook', { value: api })
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, value })
  }
  const { createRoot } = await import('react-dom/client')
  const { flushSync } = await import('react-dom')
  const root = createRoot(dom.window.document.getElementById('mount')!)
  let markdown!: ReturnType<typeof useMarkdownNavigation>, inline!: ReturnType<typeof useInlineReferenceNavigation>
  const onOpenDocument = (documentId: string) => { events.push({ kind: 'document', documentId }) }
  const onOpenAnchor = (documentId: string, anchor: string) => { events.push({ kind: 'anchor', documentId, anchor }) }
  const onOpenDocumentBlock = (documentId: string, blockId: string) => { events.push({ kind: 'block', documentId, blockId }) }
  const notify: AppMessageHandler = (message, level) => { messages.push({ message, level }) }
  function Harness({ id }: { id: string | null }) {
    const selected = id ? documents.get(id)! : null
    markdown = useMarkdownNavigation({ documentTree: tree, selectedDocument: selected, onOpenDocument, onOpenAnchor,
      onOpenDocumentBlock, onWikiReference: token => events.push({ kind: 'wiki', token }), onMessage: notify, isZh: true })
    inline = useInlineReferenceNavigation({ documentTree: tree, draftBlocks: selected?.blocks ?? [], onOpenDocument, onOpenDocumentBlock,
      onOpenAnchor, draftTitle: selected?.title ?? '', selectedDocumentId: id, notify, uiBlockReferenceNotFound: '找不到块引用。' })
    return null
  }
  const select = async (id: string | null) => { await act(async () => root.render(createElement(Harness, { id }))) }
  try {
    await select('a')
    await run({ events, messages, blocks, details, select,
      begin: async (kind, source) => {
        let completion!: Promise<void>
        const previousCount = blocks.length
        await act(async () => { completion = kind === 'markdown' ? markdown(source) : inline(source, Math.max(2, source.indexOf('#') + 1)) })
        const deadline = Date.now() + 1000
        while (blocks.length === previousCount && Date.now() < deadline) {
          await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
        }
        assert.equal(blocks.length, previousCount + 1, 'The actual navigation must enter its block lookup within one second')
        return { completion }
      },
      cancelDuringImport: async source => {
        let completion!: Promise<void>
        await act(async () => {
          // The first inline navigation invokes its actual module import.
          // Commit B and A before that await can resume and send any lookup.
          completion = inline(source, Math.max(2, source.indexOf('#') + 1))
          flushSync(() => root.render(createElement(Harness, { id: 'b' })))
          flushSync(() => root.render(createElement(Harness, { id: 'a' })))
          await completion
        })
      },
      resolveBlock: async (index, result) => { await act(async () => blocks[index].resolve(result)) },
      rejectBlock: async (index, error) => { await act(async () => blocks[index].reject(error)) },
      resolveDetail: async (index, result) => { await act(async () => details[index].resolve(result)) }
    })
  } finally {
    await act(async () => root.unmount())
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
    dom.window.close()
  }
}

test('the actual first inline module import cannot issue an old RPC after synchronous A to B to A commits', async () => withNavigation(async context => {
  await context.cancelDuringImport(link('inline', 'Deleted/Original', '^stale-import'))
  assert.deepEqual(context.blocks, [])
  assert.deepEqual(context.details, [])
  assert.deepEqual(context.events, [])
  assert.deepEqual(context.messages, [])
  const fresh = await context.begin('inline', link('inline', 'Deleted/Original', '^fresh'))
  await context.resolveBlock(0, reference('fresh-after-import'))
  await fresh.completion
  assert.deepEqual(context.events, [{ kind: 'block', documentId: 'owner', blockId: 'fresh-after-import' }])
}))

test('both real navigation hooks resolve an absent old route through getBlockReference and open the returned actual owner and block', async () => {
  assert.ok(!tree.some(document => document.path === 'Deleted/Original'))
  for (const kind of ['markdown', 'inline'] as const) await withNavigation(async context => {
    const request = await context.begin(kind, link(kind, 'Deleted/Original', '^moved'))
    assert.deepEqual(context.blocks.map(request => ({ path: request.path, blockId: request.blockId })), [{ path: 'Deleted/Original', blockId: '^moved' }])
    await context.resolveBlock(0, reference())
    await request.completion
    assert.deepEqual(context.events, [{ kind: 'block', documentId: 'owner', blockId: 'actual-block' }])
    assert.deepEqual(context.messages, [])
    assert.deepEqual(context.details, [])
  })
})

test('caret block misses including percent encoded Markdown never fall back to headings, even with a similarly named heading document', async () => {
  for (const kind of ['markdown', 'inline'] as const) await withNavigation(async context => {
    const request = await context.begin(kind, link(kind, 'Docs/Heading', kind === 'markdown' ? '%5Emissing' : '^missing'))
    assert.equal(context.blocks[0].blockId, '^missing')
    await context.resolveBlock(0, null)
    await request.completion
    assert.deepEqual(context.events, [])
    assert.equal(context.messages.length, 1)
    assert.equal(context.messages[0].level, 'warning')
    assert.deepEqual(context.details, [], 'caret references must stop before fetching heading fallback content')
  })
})

test('ordinary Markdown and Wiki heading navigation still opens the intended document anchor after a block miss', async () => {
  for (const kind of ['markdown', 'inline'] as const) await withNavigation(async context => {
    const request = await context.begin(kind, link(kind, 'Docs/Heading', 'section-title'))
    await context.resolveBlock(0, null)
    if (kind === 'inline') {
      assert.equal(context.details[0].documentId, 'heading')
      await context.resolveDetail(0, documents.get('heading')!)
    }
    await request.completion
    assert.deepEqual(context.events, [{ kind: 'anchor', documentId: 'heading', anchor: 'section-title' }])
    assert.deepEqual(context.messages, [])
  })
})

test('both hooks reject replies after leaving the document, including A to B to A before the first reply arrives', async () => {
  for (const kind of ['markdown', 'inline'] as const) for (const returnToA of [false, true]) await withNavigation(async context => {
    const request = await context.begin(kind, link(kind, 'Deleted/Original', '^old'))
    await context.select('b')
    if (returnToA) await context.select('a')
    await context.resolveBlock(0, reference('stale-block'))
    await request.completion
    assert.deepEqual(context.events, [])
    assert.deepEqual(context.messages, [])
    const fresh = await context.begin(kind, link(kind, 'Deleted/Original', '^fresh'))
    await context.resolveBlock(1, reference('fresh-block'))
    await fresh.completion
    assert.deepEqual(context.events, [{ kind: 'block', documentId: 'owner', blockId: 'fresh-block' }])
  })
})

test('a second request in the same document wins in both hooks and late old success or failure cannot navigate or notify', async () => {
  for (const kind of ['markdown', 'inline'] as const) for (const late of ['success', 'failure'] as const) await withNavigation(async context => {
    const first = await context.begin(kind, link(kind, 'Deleted/Original', '^first'))
    const second = await context.begin(kind, link(kind, 'Deleted/Original', '^second'))
    await context.resolveBlock(1, reference('second-block'))
    await second.completion
    if (late === 'success') await context.resolveBlock(0, reference('first-block'))
    else await context.rejectBlock(0, new Error('Stale lookup failed'))
    await first.completion
    assert.deepEqual(context.events, [{ kind: 'block', documentId: 'owner', blockId: 'second-block' }])
    assert.deepEqual(context.messages, [])
  })
})

test('an inline heading detail reply also respects document generation and a newer block navigation request', async () => {
  for (const mode of ['document-switch', 'new-request'] as const) await withNavigation(async context => {
    const first = await context.begin('inline', link('inline', 'Docs/Heading', 'section-title'))
    await context.resolveBlock(0, null)
    assert.equal(context.details[0].documentId, 'heading')
    if (mode === 'document-switch') { await context.select('b'); await context.select('a') }
    else {
      const second = await context.begin('inline', link('inline', 'Deleted/Original', '^second'))
      await context.resolveBlock(1, reference('second-block'))
      await second.completion
    }
    await context.resolveDetail(0, documents.get('heading')!)
    await first.completion
    assert.deepEqual(context.events, mode === 'document-switch' ? [] : [{ kind: 'block', documentId: 'owner', blockId: 'second-block' }])
    assert.deepEqual(context.messages, [])
  })
})
