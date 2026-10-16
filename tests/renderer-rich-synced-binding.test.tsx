import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { act, createElement } from 'react'
import { JSDOM } from 'jsdom'
import type { SyncedBlocksApi, SyncedCanonicalEdit, SyncedCanonicalWire, SyncedGroupSnapshot } from '../src/shared/synced-blocks'
import { SyncedValidationError } from '../src/shared/syncedBlockValidation'
import type { SyncedGroupBinding, SyncedGroupScope } from '../src/renderer/src/features/synced-blocks/types'
import { getSyncedWorkspaceController } from '../src/renderer/src/features/synced-blocks/controller'
import { syncedSnapshotGuard } from '../src/renderer/src/features/synced-blocks/types'
import { getRichTextHistoryBridge } from '../src/renderer/src/rich-text/history'
import { captureEditorHistoryBookmark, restoreEditorHistoryBookmark } from '../src/renderer/src/utils/editorHistoryFocus'
import { serializeImageFigure } from '../src/shared/markdownMedia'
import { collectMarkdownImageOccurrences } from '../src/shared/markdownMediaOccurrences'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
const { SyncedRichTextEditor } = await import('../src/renderer/src/rich-text/SyncedRichTextEditor')
const { DocumentRichTextEditor } = await import('../src/renderer/src/rich-text/DocumentRichTextEditor')
const uuid = (index: number) => `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`
const noop = () => {}
const mediaContent = (caption = 'Original caption', align: 'left' | 'center' | 'right' = 'left') => serializeImageFigure({
  src: 'https://example.test/image.png', alt: 'Original alt', caption, align
})
const mediaForest = (): SyncedCanonicalWire[] => [
  { id: 'text', type: 'paragraph', content: 'alpha', checked: false, depth: 0, parentBlockId: null, createdAt: '2026-10-15T00:00:00.000Z' },
  { id: ' 媒体:__proto__ ', type: 'paragraph', content: mediaContent(), checked: false, depth: 0, parentBlockId: null,
    tags: ['keep'], createdAt: '2026-10-15T00:00:00.000Z' }
]

async function readyMedia(roots: HTMLElement[]) {
  assert.ok(roots.length > 0, 'The media fixture has actual mounted occurrences')
  const selector = '.rich-text-source-media .image-presentation-frame'
  let disconnectMedia = noop
  try {
    const mediaReady = new Promise<void>(resolve => {
      const check = () => {
        if (roots.every(root => root.querySelector(selector))) { observer.disconnect(); resolve() }
      }
      const observer = new roots[0].ownerDocument.defaultView!.MutationObserver(check)
      disconnectMedia = () => observer.disconnect()
      for (const root of roots) observer.observe(root, { childList: true, subtree: true })
      check()
    })
    await act(async () => { await Promise.all([
      import('../src/renderer/src/components/BlockImagePresentations'),
      import('../src/renderer/src/components/ImagePresentationEditor')
    ]) })
    // React must be free to commit its private lazy resource before the DOM
    // observer resolves; awaiting this promise inside act would block that flush.
    await mediaReady
    await act(async () => {})
    for (const root of roots) assert.ok(root.querySelector(selector), 'Each real occurrence has committed its media frame before media input')
  } finally { disconnectMedia() }
}

async function typeCaption(dom: JSDOM, root: HTMLElement, text: string) {
  const input = root.querySelector<HTMLTextAreaElement>('[data-image-caption-input]')!
  await act(async () => {
    input.focus()
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  return input
}

async function withEditors(run: (api: {
  dom: JSDOM; bindings: SyncedGroupBinding[]; roots: HTMLElement[]; attempts: number[]
  clickBold: (index: number) => Promise<void>; select: (index: number, blockId?: string) => Promise<void>
  flush: () => Promise<boolean>; writes: () => number; unmount: (before?: () => void) => Promise<void>
  rebind: (index: number) => Promise<SyncedGroupBinding>
}) => Promise<void>, reject: boolean | ((blocks: SyncedCanonicalEdit[]) => boolean) = false, initial?: SyncedCanonicalWire[], save = false) {
  const dom = new JSDOM('<input id="outside"><div id="mount"></div>', { pretendToBeVisual: true })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    Element: dom.window.Element, Node: dom.window.Node, MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  Object.defineProperty(dom.window.document, 'hasFocus', { configurable: true, value: () => true })
  const rectangle = { top: 0, bottom: 20, left: 0, right: 100, x: 0, y: 0, width: 100, height: 20, toJSON: () => ({}) }
  dom.window.Range.prototype.getBoundingClientRect = () => rectangle
  dom.window.Range.prototype.getClientRects = () => [rectangle] as unknown as DOMRectList
  dom.window.scrollBy = noop
  const snapshot: SyncedGroupSnapshot = { groupId: uuid(1), creationId: uuid(2), createdAt: '2026-10-16T00:00:00.000Z',
    revision: uuid(3), topologyRevision: uuid(4), origin: { version: 1, documentId: 'origin', pathAtCreation: 'Origin', firstInstanceId: uuid(5) },
    bindings: [], blocks: initial ?? [{ id: ' __proto__:正文 ', type: 'paragraph', content: 'alpha', checked: false, depth: 0, parentBlockId: null,
      tags: ['keep'], createdAt: '2026-10-15T00:00:00.000Z' }],
    instances: [5, 6].map(index => ({ instanceId: uuid(index), hostDocumentId: 'host', bindingVersion: uuid(index + 10), depth: 0, parentBlockId: null, parentType: null })),
    history: { cursor: uuid(7), undoToken: null, redoToken: null }, maxRelativeDepth: 0 }
  snapshot.maxRelativeDepth = Math.max(...snapshot.blocks.map(block => block.depth))
  let writeCount = 0
  const unexpected = () => { throw new Error('A local PM edit must not create its own IPC writer.') }
  const api: SyncedBlocksApi = {
    getSyncedGroupSnapshots: async () => ({ workspaceScope: uuid(8), items: [{ status: 'ready', snapshot }] }),
    listSyncedGroups: unexpected, updateSyncedBlockGroup: async input => {
      writeCount++
      if (!save) return unexpected()
      return { status: 'saved', operationId: input.clientOperationId, replayed: false, snapshot: {
        ...snapshot, blocks: input.blocks.map(block => ({ ...block, createdAt: snapshot.blocks.find(previous => previous.id === block.id)?.createdAt ?? snapshot.createdAt })),
        revision: uuid(90), history: { cursor: uuid(91), undoToken: uuid(92), redoToken: null }
      } }
    }, getSyncedOperation: unexpected,
    applySyncedHostStructure: unexpected, restoreSyncedGroupOperation: unexpected, restoreSyncedHostOperation: unexpected,
    getSyncedHostHistory: unexpected, onSyncedBlocksChanged: () => noop
  }
  const workspace = getSyncedWorkspaceController(api, { validateBudget: blocks => {
    if (typeof reject === 'function' ? reject(blocks) : reject && blocks.some(block => block.content.includes('**'))) {
      throw new SyncedValidationError('budget', 'Fixture portable budget rejected the candidate.')
    }
  } })
  await workspace.load([snapshot.groupId])
  const controller = workspace.getGroup(snapshot.groupId)!, bindings: SyncedGroupBinding[] = [], attempts = [0, 0]
  let alive = true
  const bind = (scope: SyncedGroupScope, index: number) => {
    const binding = controller.bind(scope), apply = binding.apply
    binding.apply = input => {
      attempts[index]++
      const editor = scope.root()?.querySelector('.knowbook-rich-text-editor')
      assert.equal(editor?.querySelector('strong'), null, 'the candidate has not updated the PM DOM before controller acceptance')
      return apply(input)
    }
    return binding
  }
  for (const [index, instance] of snapshot.instances.entries()) {
    const scope: SyncedGroupScope = { ...instance, owner: { kind: 'synced-group', groupId: snapshot.groupId }, windowSessionId: uuid(9),
      hostSession: {}, mountEpoch: {}, bindingEpoch: {}, domNamespace: JSON.stringify(['fixture', instance.instanceId]),
      root: () => dom.window.document.querySelector(`[data-fixture-instance="${index}"]`), isCurrent: () => alive }
    bindings.push(bind(scope, index))
  }
  const { createRoot } = await import('react-dom/client'), root = createRoot(dom.window.document.getElementById('mount')!)
  let removed = false
  const unmount = async (before?: () => void) => {
    if (removed) return
    await act(async () => { before?.(); root.unmount(); alive = false; for (const binding of bindings) binding.dispose() })
    removed = true
  }
  const editors = () => createElement('main', null,
    ...bindings.map((binding, index) => createElement('section', { key: index, 'data-fixture-instance': index },
      createElement(SyncedRichTextEditor, { binding, isZh: false, onEditSource: noop, onRevealBlock: noop }))),
    createElement(DocumentRichTextEditor, { documentId: 'ordinary', blocks: [{ id: 'host-block', type: 'paragraph', content: 'Host text', checked: false, depth: 0 }],
      visibleIndices: [0], isZh: false, onChange: unexpected, checkpoint: noop, onUndo: unexpected, onRedo: unexpected, onEditSource: noop, onRevealBlock: noop }))
  try {
    if (initial) await act(async () => { await Promise.all([
      import('../src/renderer/src/components/ColumnsControls'), import('../src/renderer/src/rich-text/ColumnContentControls'),
      import('../src/renderer/src/components/NativeContainerControls'), import('../src/renderer/src/components/NativeContainerStyle')
    ]) })
    await act(async () => root.render(editors()))
    const roots = [...dom.window.document.querySelectorAll<HTMLElement>('[data-fixture-instance]')]
    const select = async (index: number, blockId = snapshot.blocks[0].id) => { await act(async () => getRichTextHistoryBridge(roots[index].querySelector<HTMLElement>('.knowbook-rich-text-editor')!)!.restore({
      blockId, index: snapshot.blocks.findIndex(block => block.id === blockId), start: 0, end: 5, direction: 'forward',
      richText: { anchor: { blockId, index: snapshot.blocks.findIndex(block => block.id === blockId), offset: 0 },
        head: { blockId, index: snapshot.blocks.findIndex(block => block.id === blockId), offset: 5 } }
    })) }
    const clickBold = async (index: number) => { await act(async () => {
      const button = roots[index].querySelector<HTMLButtonElement>('[aria-label="Bold"]')!
      button.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true })); button.click()
    }) }
    const rebind = async (index: number) => {
      const previous = bindings[index]
      await act(async () => {
        // The real controller revokes A. Deliberately retain the PM dependencies
        // so callback ownership must be checked independently of view teardown.
        bindings[index] = bind({ ...previous.scope, hostSession: {} }, index)
        previous.dispose()
        root.render(editors())
      })
      return bindings[index]
    }
    await run({ dom, bindings, roots, attempts, select, clickBold, flush: controller.flush, writes: () => writeCount, unmount, rebind })
  } finally {
    await unmount()
    workspace.dispose(); dom.window.close()
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) }
  }
}

test('two real rich views share the controller forest and independent history without mirroring a second write or moving focus', async () => {
  await withEditors(async api => {
    for (const root of api.roots) assert.equal(root.querySelector<HTMLElement>('[data-block-id]')?.dataset.blockId, ' __proto__:正文 ')
    await api.select(0); await api.clickBold(0)
    assert.deepEqual(api.attempts, [1, 0])
    assert.equal(api.bindings[0].getCurrent().working[0].content, '**alpha**')
    assert.equal(api.bindings[0].getCurrent().working[0].id, ' __proto__:正文 ')
    assert.equal(api.bindings[0].getCurrent().working[0].parentBlockId, null)
    for (const root of api.roots) assert.equal(root.querySelector<HTMLElement>('[data-block-id]')?.dataset.blockId, ' __proto__:正文 ')
    assert.deepEqual(api.bindings[0].getCurrent().working[0].tags, ['keep'])
    assert.equal(api.roots[1].querySelector('strong')?.textContent, 'alpha')
    const editor = api.roots[0].querySelector<HTMLElement>('.knowbook-rich-text-editor')!
    assert.equal(api.dom.window.document.activeElement, editor)
    await act(async () => editor.dispatchEvent(new api.dom.window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })))
    assert.equal(api.bindings[0].getCurrent().working[0].content, 'alpha')
    assert.equal(api.roots[0].querySelector('strong'), null); assert.equal(api.roots[1].querySelector('strong'), null)
    assert.deepEqual(api.attempts, [1, 0]); assert.equal(api.bindings[0].getCurrent().canRedo, true)
    assert.equal(api.dom.window.document.activeElement, editor)
  })
})

test('a rejected shared candidate never appears in PM and does not create an undo frame', async () => {
  await withEditors(async api => {
    await api.select(0); await api.clickBold(0)
    assert.deepEqual(api.attempts, [1, 0])
    assert.equal(api.bindings[0].getCurrent().working[0].content, 'alpha')
    assert.equal(api.roots[0].querySelector('strong'), null); assert.equal(api.roots[1].querySelector('strong'), null)
    assert.equal(api.bindings[0].getCurrent().canUndo, false)
  }, true)
})

test('a native todo checkbox rolls back a composition rejection and the next genuine click succeeds', async () => {
  const initial: SyncedCanonicalWire[] = [{ id: ' 待办:constructor ', type: 'todo', content: 'alpha', checked: false,
    depth: 0, parentBlockId: null, createdAt: '2026-10-15T00:00:00.000Z' }]
  await withEditors(async api => {
    const checkbox = () => api.roots[0].querySelector<HTMLInputElement>('input[type="checkbox"]')!
    const other = api.roots[1].querySelector<HTMLElement>('.knowbook-rich-text-editor')!
    await act(async () => other.dispatchEvent(new api.dom.window.CompositionEvent('compositionstart', { bubbles: true })))
    await act(async () => checkbox().click())
    assert.equal(checkbox().checked, false)
    assert.equal(api.bindings[0].getCurrent().working[0].checked, false)
    assert.equal(api.bindings[0].getCurrent().canUndo, false); assert.equal(api.writes(), 0)
    await act(async () => other.dispatchEvent(new api.dom.window.CompositionEvent('compositionend', { bubbles: true })))
    assert.equal(checkbox().checked, false)
    await act(async () => checkbox().click())
    assert.equal(checkbox().checked, true)
    assert.equal(api.roots[1].querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked, true)
    assert.equal(api.bindings[0].getCurrent().working[0].checked, true)
    assert.equal(api.bindings[0].getCurrent().canUndo, true)
    assert.deepEqual(api.attempts, [2, 0]); assert.equal(api.writes(), 0)
  }, false, initial)
})

test('a native todo checkbox restores its accepted value on a byte-budget rejection and can retry successfully', async () => {
  const initial: SyncedCanonicalWire[] = [{ id: ' 待办:__proto__ ', type: 'todo', content: 'alpha', checked: true,
    depth: 0, parentBlockId: null, createdAt: '2026-10-15T00:00:00.000Z' }]
  const limit = JSON.stringify(initial.map(({ createdAt: _createdAt, ...block }) => block)).length
  let budgetBlocked = true
  await withEditors(async api => {
    const checkbox = () => api.roots[0].querySelector<HTMLInputElement>('input[type="checkbox"]')!
    await act(async () => checkbox().click())
    assert.equal(checkbox().checked, true)
    const rejected = api.bindings[0].getCurrent()
    assert.equal(rejected.working[0].checked, true); assert.equal(rejected.canUndo, false)
    assert.ok(rejected.failure?.status === 'invalid'); assert.equal(rejected.failure.code, 'budget')
    assert.equal(rejected.pending, null); assert.equal(api.writes(), 0)
    budgetBlocked = false
    await act(async () => checkbox().click())
    assert.equal(checkbox().checked, false)
    assert.equal(api.roots[1].querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked, false)
    assert.equal(api.bindings[0].getCurrent().working[0].checked, false)
    assert.equal(api.bindings[0].getCurrent().canUndo, true)
    assert.deepEqual(api.attempts, [2, 0]); assert.equal(api.writes(), 0)
  }, blocks => budgetBlocked && JSON.stringify(blocks).length > limit, initial)
})

test('real image alignment keeps the accepted preview when another occurrence composes and a genuine retry then commits', async () => {
  await withEditors(async api => {
    await readyMedia(api.roots)
    const other = api.roots[1].querySelector<HTMLElement>('.knowbook-rich-text-editor')!
    const presentation = () => api.roots[0].querySelector<HTMLElement>('[data-image-presentation]')!
    await act(async () => api.roots[0].querySelector<HTMLElement>('.image-presentation-frame')!.click())
    await act(async () => other.dispatchEvent(new api.dom.window.CompositionEvent('compositionstart', { bubbles: true })))
    await act(async () => api.roots[0].querySelector<HTMLButtonElement>('[data-image-align-button="right"]')!.click())
    const rejected = api.bindings[0].getCurrent()
    assert.equal(collectMarkdownImageOccurrences(rejected.working[1].content)[0].presentation.align, 'left')
    assert.equal(presentation().dataset.imageAlign, 'left')
    assert.equal(presentation().querySelector('[data-image-align-button="left"]')?.getAttribute('aria-pressed'), 'true')
    assert.equal(presentation().querySelector('[data-image-align-button="right"]')?.getAttribute('aria-pressed'), 'false')
    assert.ok(presentation().querySelector('[role="alert"][data-image-commit-error]'))
    assert.equal(rejected.dirty, false); assert.equal(rejected.canUndo, false)
    assert.deepEqual(api.attempts, [1, 0]); assert.equal(api.writes(), 0)
    await act(async () => other.dispatchEvent(new api.dom.window.CompositionEvent('compositionend', { bubbles: true })))
    await act(async () => presentation().querySelector<HTMLButtonElement>('[data-image-commit-retry]')!.click())
    assert.equal(collectMarkdownImageOccurrences(api.bindings[0].getCurrent().working[1].content)[0].presentation.align, 'right')
    for (const root of api.roots) assert.equal(root.querySelector<HTMLElement>('[data-image-presentation]')?.dataset.imageAlign, 'right')
    assert.equal(presentation().querySelector('[data-image-commit-error]'), null)
    assert.equal(api.bindings[0].getCurrent().canUndo, true)
    assert.deepEqual(api.attempts, [2, 0]); assert.equal(api.writes(), 0)
  }, false, mediaForest())
})

test('real caption rejection retains editable input but keeps the accepted preview and history until a successful retry', async () => {
  await withEditors(async api => {
    await readyMedia(api.roots)
    const other = api.roots[1].querySelector<HTMLElement>('.knowbook-rich-text-editor')!
    await act(async () => api.roots[0].querySelector<HTMLElement>('.image-presentation-frame')!.click())
    await act(async () => other.dispatchEvent(new api.dom.window.CompositionEvent('compositionstart', { bubbles: true })))
    const input = await typeCaption(api.dom, api.roots[0], 'Retained caption draft')
    await act(async () => input.dispatchEvent(new api.dom.window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true })))
    assert.equal(input.value, 'Retained caption draft')
    for (const root of api.roots) assert.equal(root.querySelector('[data-image-caption]')?.textContent, 'Original caption')
    assert.equal(collectMarkdownImageOccurrences(api.bindings[0].getCurrent().working[1].content)[0].presentation.caption, 'Original caption')
    assert.ok(api.roots[0].querySelector('[role="alert"][data-image-commit-error]'))
    assert.equal(api.bindings[0].getCurrent().dirty, false); assert.equal(api.bindings[0].getCurrent().canUndo, false)
    assert.deepEqual(api.attempts, [1, 0]); assert.equal(api.writes(), 0)
    await act(async () => other.dispatchEvent(new api.dom.window.CompositionEvent('compositionend', { bubbles: true })))
    await act(async () => api.roots[0].querySelector<HTMLButtonElement>('[data-image-commit-retry]')!.click())
    assert.equal(input.value, 'Retained caption draft')
    for (const root of api.roots) assert.equal(root.querySelector('[data-image-caption]')?.textContent, 'Retained caption draft')
    const accepted = api.bindings[0].getCurrent()
    assert.equal(collectMarkdownImageOccurrences(accepted.working[1].content)[0].presentation.caption, 'Retained caption draft')
    assert.equal(accepted.working[1].id, ' 媒体:__proto__ '); assert.deepEqual(accepted.working[1].tags, ['keep'])
    assert.equal(accepted.canUndo, true); assert.equal(api.roots[0].querySelector('[data-image-commit-error]'), null)
    assert.deepEqual(api.attempts, [2, 0]); assert.equal(api.writes(), 0)
  }, false, mediaForest())
})

test('a retained media draft cannot borrow a new content lease after another occurrence replaces its source', async () => {
  await withEditors(async api => {
    await readyMedia(api.roots)
    const other = api.roots[1].querySelector<HTMLElement>('.knowbook-rich-text-editor')!
    await act(async () => api.roots[0].querySelector<HTMLElement>('.image-presentation-frame')!.click())
    await act(async () => other.dispatchEvent(new api.dom.window.CompositionEvent('compositionstart', { bubbles: true })))
    const input = await typeCaption(api.dom, api.roots[0], 'Do not overwrite the replacement')
    await act(async () => input.dispatchEvent(new api.dom.window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true })))
    await act(async () => other.dispatchEvent(new api.dom.window.CompositionEvent('compositionend', { bubbles: true })))
    await act(async () => {
      const binding = api.bindings[1], state = binding.getCurrent()
      assert.equal(binding.apply({ expectedEditSequence: state.editSequence, guards: syncedSnapshotGuard(state.snapshot),
        blocks: state.working.map(block => block.id === ' 媒体:__proto__ ' ? { ...block, content: mediaContent('New source caption', 'center') } : block),
        bookmark: null, transactionId: uuid(81) }), true)
    })
    assert.equal(input.value, 'Do not overwrite the replacement')
    assert.equal(api.roots[0].querySelector('[data-image-caption]')?.textContent, 'New source caption')
    await act(async () => api.roots[0].querySelector<HTMLButtonElement>('[data-image-commit-retry]')!.click())
    assert.deepEqual(api.attempts, [1, 1])
    assert.equal(collectMarkdownImageOccurrences(api.bindings[0].getCurrent().working[1].content)[0].presentation.caption, 'New source caption')
    assert.equal(input.value, 'Do not overwrite the replacement')
    assert.ok(api.roots[0].querySelector('[data-image-commit-error]'))
    await act(async () => api.roots[0].querySelector<HTMLButtonElement>('[data-image-commit-discard]')!.click())
    assert.equal(input.value, 'New source caption')
    assert.equal(api.roots[0].querySelector('[data-image-commit-error]'), null)
    assert.deepEqual(api.attempts, [1, 1]); assert.equal(api.writes(), 0)
  }, false, mediaForest())
})

test('a retained media retry cannot borrow a rebound scope even when its epochs and PM view are reused', async () => {
  await withEditors(async api => {
    await readyMedia(api.roots)
    const editor = api.roots[0].querySelector<HTMLElement>('.knowbook-rich-text-editor')!
    const other = api.roots[1].querySelector<HTMLElement>('.knowbook-rich-text-editor')!
    await act(async () => api.roots[0].querySelector<HTMLElement>('.image-presentation-frame')!.click())
    await act(async () => other.dispatchEvent(new api.dom.window.CompositionEvent('compositionstart', { bubbles: true })))
    const input = await typeCaption(api.dom, api.roots[0], 'Old scope caption draft')
    await act(async () => input.dispatchEvent(new api.dom.window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true })))
    const oldBinding = api.bindings[0], before = oldBinding.getCurrent(), rebound = await api.rebind(0)
    assert.equal(oldBinding.isCurrent(), false); assert.equal(rebound.isCurrent(), true)
    assert.notEqual(rebound.scope, oldBinding.scope); assert.notEqual(rebound.scope.hostSession, oldBinding.scope.hostSession)
    assert.equal(rebound.scope.mountEpoch, oldBinding.scope.mountEpoch); assert.equal(rebound.scope.bindingEpoch, oldBinding.scope.bindingEpoch)
    assert.equal(rebound.scope.domNamespace, oldBinding.scope.domNamespace)
    assert.equal(rebound.scope.instanceId, oldBinding.scope.instanceId); assert.equal(rebound.scope.bindingVersion, oldBinding.scope.bindingVersion)
    assert.equal(api.roots[0].querySelector('.knowbook-rich-text-editor'), editor)
    assert.equal(api.roots[0].querySelector('[data-image-caption-input]'), input)
    await act(async () => other.dispatchEvent(new api.dom.window.CompositionEvent('compositionend', { bubbles: true })))
    await act(async () => api.roots[0].querySelector<HTMLButtonElement>('[data-image-commit-retry]')!.click())
    assert.deepEqual(api.attempts, [1, 0]); assert.equal(api.writes(), 0)
    assert.deepEqual(rebound.getCurrent().working, before.working)
    assert.equal(rebound.getCurrent().editSequence, before.editSequence)
    assert.equal(rebound.getCurrent().canUndo, false); assert.equal(rebound.getCurrent().dirty, false)
    assert.equal(input.value, 'Old scope caption draft')
    assert.equal(api.roots[0].querySelector('[data-image-caption]')?.textContent, 'Original caption')
    assert.ok(api.roots[0].querySelector('[data-image-commit-error]'))
    await act(async () => api.roots[0].querySelector<HTMLButtonElement>('[data-image-commit-discard]')!.click())
    assert.equal(input.value, 'Original caption')
    assert.equal(api.roots[0].querySelector('[data-image-commit-error]'), null)
    await typeCaption(api.dom, api.roots[0], 'Fresh scope caption')
    await act(async () => input.dispatchEvent(new api.dom.window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true })))
    assert.equal(collectMarkdownImageOccurrences(rebound.getCurrent().working[1].content)[0].presentation.caption, 'Fresh scope caption')
    for (const root of api.roots) assert.equal(root.querySelector('[data-image-caption]')?.textContent, 'Fresh scope caption')
    assert.equal(rebound.getCurrent().canUndo, true); assert.equal(api.roots[0].querySelector('[data-image-commit-error]'), null)
    assert.deepEqual(api.attempts, [2, 0]); assert.equal(api.writes(), 0)
  }, false, mediaForest())
})

test('host history capture skips group editors while an explicit root restores only that occurrence', async () => {
  await withEditors(async api => {
    await api.select(0)
    const blocks = api.bindings[0].getCurrent().working, editor = api.roots[0].querySelector<HTMLElement>('.knowbook-rich-text-editor')!
    assert.equal(captureEditorHistoryBookmark(blocks, editor), null)
    const bookmark = captureEditorHistoryBookmark(blocks, editor, api.roots[0])!
    assert.ok(bookmark)
    let restored = false
    await act(async () => { restored = restoreEditorHistoryBookmark(bookmark, blocks, api.roots[1]) })
    assert.equal(restored, true)
    assert.equal(api.dom.window.document.activeElement, api.roots[1].querySelector('.knowbook-rich-text-editor'))
    const ordinary = { ...bookmark, blockId: 'host-block', richText: { anchor: { blockId: 'host-block', index: 0, offset: 0 }, head: { blockId: 'host-block', index: 0, offset: 2 } } }
    await act(async () => { restored = restoreEditorHistoryBookmark(ordinary, [{ id: 'host-block', type: 'paragraph', content: 'Host text', checked: false, depth: 0 }]) })
    assert.equal(restored, true)
    assert.equal(api.dom.window.document.activeElement?.closest('[data-forest-owner]')?.getAttribute('data-forest-owner'), 'document')
  })
})

test('a rich edit racing an unmirrored shared update cannot overwrite that newer forest', async () => {
  await withEditors(async api => {
    await api.select(0)
    await act(async () => {
      const binding = api.bindings[1], state = binding.getCurrent()
      assert.equal(binding.apply({ expectedEditSequence: state.editSequence, guards: syncedSnapshotGuard(state.snapshot),
        blocks: state.working.map(block => ({ ...block, content: 'newer shared body' })), bookmark: null, transactionId: uuid(80) }), true)
      api.roots[0].querySelector<HTMLButtonElement>('[aria-label="Bold"]')!.click()
    })
    assert.equal(api.bindings[0].getCurrent().working[0].content, 'newer shared body')
    assert.deepEqual(api.attempts, [0, 1])
    assert.match(api.roots[0].querySelector('.knowbook-rich-text-editor')!.textContent!, /newer shared body/)
    assert.equal(api.roots[0].querySelector('strong'), null)
  })
})

test('native composition owns its occurrence until PM completes compositionend', async () => {
  await withEditors(async api => {
    await api.select(0)
    const editor = api.roots[1].querySelector<HTMLElement>('.knowbook-rich-text-editor')!
    await act(async () => editor.dispatchEvent(new api.dom.window.CompositionEvent('compositionstart', { bubbles: true })))
    assert.deepEqual(api.bindings[0].getCurrent().composingInstanceIds, [uuid(6)])
    await api.clickBold(0)
    assert.equal(api.bindings[0].getCurrent().working[0].content, 'alpha')
    assert.equal(api.roots[0].querySelector('strong'), null)
    await act(async () => editor.dispatchEvent(new api.dom.window.CompositionEvent('compositionend', { bubbles: true })))
    assert.deepEqual(api.bindings[0].getCurrent().composingInstanceIds, [])
    await api.clickBold(0)
    assert.equal(api.bindings[0].getCurrent().working[0].content, '**alpha**')
  })
})

test('unmounting a composing PM view preserves its dirty controller and cannot impersonate compositionend to save', async () => {
  await withEditors(async api => {
    await api.select(0); await api.clickBold(0)
    const editor = api.roots[0].querySelector<HTMLElement>('.knowbook-rich-text-editor')!
    await act(async () => editor.dispatchEvent(new api.dom.window.CompositionEvent('compositionstart', { bubbles: true })))
    const before = api.bindings[0].getCurrent()
    assert.equal(before.dirty, true); assert.deepEqual(before.composingInstanceIds, [uuid(5)])
    await api.unmount()
    const retained = api.bindings[0].getCurrent()
    assert.deepEqual(retained.working, before.working); assert.equal(retained.dirty, true)
    assert.deepEqual(retained.composingInstanceIds, [uuid(5)])
    let saved = true
    await act(async () => { saved = await api.flush() })
    assert.equal(saved, false); assert.equal(api.writes(), 0)
    assert.deepEqual(api.bindings[0].getCurrent().working, before.working)
    assert.equal(api.bindings[0].getCurrent().pending, null)
  }, false, undefined, true)
})

test('a genuine compositionend permits explicit saving without inventing a candidate edit', async () => {
  await withEditors(async api => {
    await api.select(0); await api.clickBold(0)
    const editor = api.roots[0].querySelector<HTMLElement>('.knowbook-rich-text-editor')!, before = api.bindings[0].getCurrent()
    await act(async () => editor.dispatchEvent(new api.dom.window.CompositionEvent('compositionstart', { bubbles: true })))
    let saved = true
    await act(async () => { saved = await api.flush() })
    assert.equal(saved, false); assert.equal(api.writes(), 0)
    await act(async () => editor.dispatchEvent(new api.dom.window.CompositionEvent('compositionend', { bubbles: true })))
    assert.deepEqual(api.bindings[0].getCurrent().composingInstanceIds, [])
    assert.equal(api.bindings[0].getCurrent().editSequence, before.editSequence)
    assert.deepEqual(api.bindings[0].getCurrent().working, before.working)
    assert.deepEqual(api.attempts, [1, 0]); assert.equal(api.writes(), 0)
    await act(async () => { saved = await api.flush() })
    assert.equal(saved, true); assert.equal(api.writes(), 1)
    assert.equal(api.bindings[0].getCurrent().dirty, false)
    assert.deepEqual(api.bindings[0].getCurrent().working, before.working)
    assert.equal(api.bindings[0].getCurrent().editSequence, before.editSequence)
  }, false, undefined, true)
})

test('a genuine compositionend can settle its original lease after the PM view is synchronously unmounted', async () => {
  await withEditors(async api => {
    await api.select(0); await api.clickBold(0)
    const editor = api.roots[0].querySelector<HTMLElement>('.knowbook-rich-text-editor')!, before = api.bindings[0].getCurrent()
    await act(async () => editor.dispatchEvent(new api.dom.window.CompositionEvent('compositionstart', { bubbles: true })))
    await api.unmount(() => editor.dispatchEvent(new api.dom.window.CompositionEvent('compositionend', { bubbles: true })))
    assert.deepEqual(api.bindings[0].getCurrent().composingInstanceIds, [])
    assert.equal(api.bindings[0].getCurrent().editSequence, before.editSequence)
    let saved = false
    await act(async () => { saved = await api.flush() })
    assert.equal(saved, true); assert.equal(api.writes(), 1)
    assert.deepEqual(api.bindings[0].getCurrent().working, before.working)
  }, false, undefined, true)
})

test('deleting the final canonical block produces one explicit fresh empty paragraph', async () => {
  await withEditors(async api => {
    const editor = api.roots[0].querySelector<HTMLElement>('.knowbook-rich-text-editor')!, bridge = getRichTextHistoryBridge(editor)!
    const before = api.bindings[0].getCurrent().working[0]
    await act(async () => bridge.restore({ blockId: before.id, index: 0, start: 0, end: 5, direction: 'forward',
      richText: { kind: 'all', anchor: { blockId: before.id, index: 0, offset: 0 }, head: { blockId: before.id, index: 0, offset: 5 } } }))
    await act(async () => editor.dispatchEvent(new api.dom.window.KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })))
    const after = api.bindings[0].getCurrent().working
    assert.equal(after.length, 1); assert.equal(after[0].type, 'paragraph'); assert.equal(after[0].content, '')
    assert.ok(after[0].id); assert.notEqual(after[0].id, before.id)
    assert.equal(after[0].depth, 0); assert.equal(after[0].parentBlockId, null)
    assert.deepEqual(api.attempts, [1, 0])
    assert.equal(api.roots[1].querySelectorAll('.block-editor-row').length, 1)
  })
})

test('both rich occurrences preserve opaque column and nested parent identities through edits, mirrors and undo', async () => {
  const createdAt = '2026-10-15T00:00:00.000Z'
  const initial: SyncedCanonicalWire[] = [
    { id: ' __proto__ ', type: 'columns', content: '', checked: false, depth: 0, parentBlockId: null, createdAt },
    { id: ' constructor ', type: 'column', content: '', checked: false, depth: 1, parentBlockId: ' __proto__ ', markdownFormat: { columnWeight: 5000 }, createdAt },
    { id: '树:父/中文 ', type: 'callout', content: 'alpha', checked: false, depth: 2, parentBlockId: ' constructor ', tags: ['keep'], createdAt },
    { id: ' value:__proto__ ', type: 'bulleted-list', content: 'nested', checked: false, depth: 3, parentBlockId: '树:父/中文 ', createdAt },
    { id: '\t右:constructor\t', type: 'column', content: '', checked: false, depth: 1, parentBlockId: ' __proto__ ', markdownFormat: { columnWeight: 5000 }, createdAt },
    { id: ' 空格id ', type: 'paragraph', content: 'alpha', checked: false, depth: 2, parentBlockId: '\t右:constructor\t', createdAt },
    { id: '__proto__', type: 'paragraph', content: 'different exact ID', checked: false, depth: 2, parentBlockId: '\t右:constructor\t', createdAt }
  ]
  const graph = initial.map(block => ({ id: block.id, parentBlockId: block.parentBlockId, depth: block.depth, markdownFormat: block.markdownFormat }))
  await withEditors(async api => {
    const check = () => {
      for (const binding of api.bindings) assert.deepEqual(binding.getCurrent().working.map(block => ({
        id: block.id, parentBlockId: block.parentBlockId, depth: block.depth, markdownFormat: block.markdownFormat
      })), graph)
      for (const root of api.roots) {
        const rows = [...root.querySelectorAll<HTMLElement>('.knowbook-rich-text-editor .block-editor-row[data-block-id]')]
        assert.deepEqual(rows.map(row => row.dataset.blockId), initial.map(block => block.id))
        assert.deepEqual(rows.map(row => Number(row.dataset.blockDepth)), initial.map(block => block.depth))
        assert.equal(root.querySelectorAll('.document-columns-grid > .document-column').length, 2)
      }
    }
    check()
    await api.select(0, '树:父/中文 '); await api.clickBold(0)
    assert.equal(api.bindings[0].getCurrent().working[2].content, '**alpha**')
    assert.equal(api.roots[1].querySelector('strong')?.textContent, 'alpha')
    check()
    const editor = api.roots[0].querySelector<HTMLElement>('.knowbook-rich-text-editor')!
    await act(async () => editor.dispatchEvent(new api.dom.window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })))
    assert.equal(api.bindings[0].getCurrent().working[2].content, 'alpha')
    check()
    await api.select(1, ' 空格id '); await api.clickBold(1)
    assert.equal(api.bindings[1].getCurrent().working[5].content, '**alpha**')
    assert.equal(api.roots[0].querySelector('strong')?.textContent, 'alpha')
    assert.deepEqual(api.attempts, [1, 1])
    check()
  }, false, initial)
})
