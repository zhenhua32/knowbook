import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { setImmediate } from 'node:timers/promises'
import { act, createElement, useState } from 'react'
import { JSDOM, VirtualConsole } from 'jsdom'
import type { DatabaseEmbedSnapshot, DatabaseSavedView, DocumentBlockDraft } from '../src/shared/contracts'
import { createDefaultDatabaseViewConfig, DATABASE_SYSTEM_FIELD_IDS } from '../src/shared/database-workspace'
import { parseDatabaseViewPayload, serializeDatabaseViewPayload, type DatabaseViewBlockPayloadV1 } from '../src/shared/databaseViewBlock'
import type { DocumentsDomainState } from '../src/renderer/src/types/appDomains'
import { getUiText } from '../src/renderer/src/i18n'
import { waitForRenderer } from './helpers/renderer-async'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
  return nextLoad(url, context)
}`)}`, import.meta.url)

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const config = () => createDefaultDatabaseViewConfig('table', [DATABASE_SYSTEM_FIELD_IDS.title])
const payload = (databaseId = 'catalog', viewId: string | null = 'view-a'): DatabaseViewBlockPayloadV1 => ({
  version: 1, databaseId, viewId, config: config()
})
function savedView(databaseId: string, id: string): DatabaseSavedView {
  return { id, databaseId, name: id, filterQuery: '', filterScope: '', sortMode: 'updated-desc', viewMode: 'table',
    config: config(), configVersion: 1, sortOrder: 0, createdAt: '2026-10-01', updatedAt: '2026-10-01' }
}
function snapshot(databaseId: string): DatabaseEmbedSnapshot {
  return { status: 'ready', database: { id: databaseId, name: databaseId, description: '', kind: 'document-catalog',
    createdAt: '2026-10-01', updatedAt: '2026-10-01' }, columns: [], entities: [],
    savedViews: ['view-a', 'view-b'].map(id => savedView(databaseId, id)),
    catalogDocuments: [{ id: 'linked-document', title: 'Linked document', path: 'Linked document', summary: '',
      parentId: null, parentTitle: null, updatedAt: '2026-10-01', blockCount: 1, childCount: 0, linkCount: 0, fieldValues: {} }] }
}
type Creation = ReturnType<typeof deferred<{ id: string }>>
type Saving = ReturnType<typeof deferred<boolean>> & { documentId: string }
type Fixture = {
  document: Document
  creates: Creation[]
  savedDocuments: Set<string>
  saves: Saving[]
  pages: string[]
  selected: () => string | null
  host: () => HTMLElement
  clickNew: () => Promise<void>
  clickLinked: () => Promise<void>
  acknowledgeCreate: () => Promise<void>
  changeSource: () => Promise<void>
  changeView: () => Promise<void>
  removeHost: () => Promise<void>
  switchHost: (id: string) => Promise<void>
  holdNavigationSave: () => void
  acknowledgeSave: () => Promise<void>
  settle: () => Promise<void>
}

async function withInlineNavigation(run: (fixture: Fixture) => Promise<void>) {
  const errors: Error[] = [], virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', error => { errors.push(error) })
  const dom = new JSDOM('<div id="mount"></div><input id="outside">', {
    url: 'http://localhost', pretendToBeVisual: true, virtualConsole
  })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement,
    Element: dom.window.Element, Node: dom.window.Node, getComputedStyle: dom.window.getComputedStyle,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const creates: Creation[] = [], saves: Saving[] = [], pages: string[] = []
  const savedDocuments = new Set<string>(), observers = new Set<() => void>()
  let holdSave = false
  Object.defineProperty(dom.window, 'knowbook', { value: {
    getSetting: async () => null,
    getDatabaseEmbedSnapshot: async (id: string) => snapshot(id),
    onWorkspaceMutated: (observer: () => void) => { observers.add(observer); return () => observers.delete(observer) },
    createDocument: () => { const request = deferred<{ id: string }>(); creates.push(request); return request.promise }
  } })

  // Install the real DOM before importing ReactDOM's input feature detection.
  const { InlineDatabaseView } = await import('../src/renderer/src/features/database/InlineDatabaseView')
  const { DatabaseEmbedProvider } = await import('../src/renderer/src/features/database/DatabaseEmbedContext')
  const { useDocumentDatabaseViewInsertion } = await import('../src/renderer/src/hooks/useDocumentDatabaseViewInsertion')
  const { useDocumentNavigationState } = await import('../src/renderer/src/hooks/useDocumentNavigationState')
  const { createRoot } = await import('react-dom/client')
  let navigation!: ReturnType<typeof useDocumentNavigationState>
  let blocks!: DocumentBlockDraft[]
  let replace!: (next: DatabaseViewBlockPayloadV1) => void
  let remove!: () => void
  function Harness() {
    const currentNavigation = useDocumentNavigationState({ onActivePageChange: page => { pages.push(page) },
      onBeforeOpenDocument: documentId => {
        const saving = { documentId, ...deferred<boolean>() }; saves.push(saving)
        if (holdSave) holdSave = false
        else saving.resolve(true)
        return saving.promise
      } })
    navigation = currentNavigation
    const [current, setCurrent] = useState<DocumentBlockDraft[]>([{ id: 'database-host', type: 'database-view',
      content: serializeDatabaseViewPayload(payload()), checked: false, depth: 0, parentBlockId: null }])
    const [visible, setVisible] = useState(true)
    blocks = current
    replace = next => setCurrent(previous => previous.map(block => ({ ...block, content: serializeDatabaseViewPayload(next) })))
    remove = () => setVisible(false)
    const documents = { selectedDocumentId: currentNavigation.selectedDocumentId,
      getRenameTarget: () => currentNavigation.selectedDocumentId ? {
        documentId: currentNavigation.selectedDocumentId, session: 1, title: currentNavigation.selectedDocumentId
      } : null,
      openDocumentInDocumentsPage: currentNavigation.openDocumentInDocumentsPage,
      notifyBlockAction: () => {}, setIsReadingMode: () => {}, isReadingMode: false, isBlockMoveBusy: false,
      getDraftBlocks: () => current, pushToHistory: () => {}, setDraftBlocks: setCurrent
    } as unknown as DocumentsDomainState
    const embed = useDocumentDatabaseViewInsertion(documents, getUiText('en-US'), false)
    return createElement(DatabaseEmbedProvider, { value: embed.context },
      createElement('div', { 'data-fixture-document': currentNavigation.selectedDocumentId ?? '' },
        visible && currentNavigation.selectedDocumentId ? createElement(InlineDatabaseView, {
          blockId: current[0].id!, content: current[0].content, mode: 'edit'
        }) : null), embed.picker)
  }
  const root = createRoot(dom.window.document.getElementById('mount')!)
  const host = () => {
    const element = dom.window.document.querySelector<HTMLElement>('[data-fixture-document]')
    assert.ok(element)
    return element
  }
  const settle = async () => { await act(async () => { await setImmediate() }) }
  const click = async (button: HTMLButtonElement | undefined) => {
    assert.ok(button)
    await act(async () => { button.click() })
  }
  try {
    await act(async () => { root.render(createElement(Harness)) })
    await act(async () => { navigation.setSelectedDocumentId('host-a') })
    await waitForRenderer(() => Boolean(host().querySelector('.dbw-record-title')), 'the real inline database must load')
    await run({ document: dom.window.document, creates, savedDocuments, saves, pages, selected: () => navigation.selectedDocumentId,
      host, settle,
      clickNew: () => click([...host().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('New document'))),
      clickLinked: () => click(host().querySelector<HTMLButtonElement>('.dbw-record-title') ?? undefined),
      acknowledgeCreate: async () => {
        assert.equal(creates.length, 1)
        await act(async () => { savedDocuments.add('created-document'); creates[0].resolve({ id: 'created-document' }) })
        await settle()
      },
      changeSource: async () => { await act(async () => { replace(payload('other-catalog')) })
        await waitForRenderer(() => Boolean(host().querySelector('[data-database-source-id="other-catalog"] .dbw-record-title')), 'the replacement source must load') },
      changeView: async () => {
        const select = host().querySelector<HTMLSelectElement>('select[aria-label="Source saved view"]')
        assert.ok(select)
        await act(async () => { select.value = 'view-b'; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })) })
        assert.equal(parseDatabaseViewPayload(blocks[0].content).viewId, 'view-b', 'the actual embedded view picker must commit through its provider')
      },
      removeHost: async () => { await act(async () => { remove() }); assert.equal(host().querySelector('.inline-database-view'), null) },
      switchHost: async id => { await act(async () => { navigation.setSelectedDocumentId(id) }) },
      holdNavigationSave: () => { holdSave = true },
      acknowledgeSave: async () => {
        assert.equal(saves.length, 1)
        await act(async () => { saves[0].resolve(true) })
        await settle()
      }
    })
  } finally {
    await act(async () => { root.unmount() })
    assert.equal(observers.size, 0, 'all shared snapshot subscriptions must be released')
    for (const request of creates) request.resolve({ id: 'created-after-unmount' })
    for (const request of saves) request.resolve(false)
    await settle()
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
    assert.deepEqual(errors, [], 'the real database UI must not throw DOM or React input errors')
  }
}

for (const transition of ['source', 'view', 'removed host', 'document'] as const) {
  test(`a late catalog creation ACK preserves the created document without navigating after ${transition} changes`, async () => {
    await withInlineNavigation(async fixture => {
      await fixture.clickNew()
      assert.equal(fixture.creates.length, 1, 'the actual catalog button must start one creation')
      if (transition === 'source') await fixture.changeSource()
      else if (transition === 'view') await fixture.changeView()
      else if (transition === 'removed host') await fixture.removeHost()
      else await fixture.switchHost('host-b')
      const outside = fixture.document.getElementById('outside')!
      outside.focus()
      await fixture.acknowledgeCreate()
      assert.deepEqual([...fixture.savedDocuments], ['created-document'], 'a committed source document must remain on disk')
      assert.equal(fixture.selected(), transition === 'document' ? 'host-b' : 'host-a')
      assert.deepEqual(fixture.saves, [], 'the revoked creation must not begin navigation or save a replacement host')
      assert.deepEqual(fixture.pages, [])
      assert.equal(fixture.document.activeElement, outside, 'the obsolete creator must not take focus')
    })
  })
}

for (const transition of ['view', 'document A to B to A'] as const) {
  test(`inline document navigation rechecks its lease after the actual host save waits across ${transition}`, async () => {
    await withInlineNavigation(async fixture => {
      fixture.holdNavigationSave()
      await fixture.clickLinked()
      assert.equal(fixture.saves.length, 1)
      assert.equal(fixture.saves[0].documentId, 'linked-document')
      assert.equal(fixture.selected(), 'host-a', 'navigation must still be waiting for the host save')
      if (transition === 'view') await fixture.changeView()
      else { await fixture.switchHost('host-b'); await fixture.switchHost('host-a') }
      const outside = fixture.document.getElementById('outside')!
      outside.focus()
      await fixture.acknowledgeSave()
      assert.equal(fixture.selected(), 'host-a', 'the original document ID alone must not revive an obsolete navigation lease')
      assert.deepEqual(fixture.pages, [])
      assert.equal(fixture.document.activeElement, outside)
    })
  })
}

test('a current catalog creation navigates once after its real source refresh and provider guard', async () => {
  await withInlineNavigation(async fixture => {
    await fixture.clickNew()
    await fixture.acknowledgeCreate()
    await waitForRenderer(() => fixture.selected() === 'created-document', 'a current creation must still navigate successfully')
    assert.deepEqual([...fixture.savedDocuments], ['created-document'])
    assert.deepEqual(fixture.saves.map(save => save.documentId), ['created-document'])
    assert.deepEqual(fixture.pages, ['documents'])
  })
})

test('a current inline document link completes the real pending host save and navigates once', async () => {
  await withInlineNavigation(async fixture => {
    fixture.holdNavigationSave()
    await fixture.clickLinked()
    assert.equal(fixture.selected(), 'host-a')
    await fixture.acknowledgeSave()
    assert.equal(fixture.selected(), 'linked-document')
    assert.deepEqual(fixture.pages, ['documents'])
  })
})
