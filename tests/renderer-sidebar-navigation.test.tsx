import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import { JSDOM } from 'jsdom'
import React, { act, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { PageNavWithWorkspaceTree } from '../src/renderer/src/components/PageNavWithWorkspaceTree.tsx'
import { useWorkspaceDocumentManagement } from '../src/renderer/src/hooks/useWorkspaceDocumentManagement.ts'
import { getUiText, type UiLanguage } from '../src/renderer/src/i18n.ts'

// Browser styles are bundled by Vite; DOM interaction tests only load their JS modules.
register(`data:text/javascript,${encodeURIComponent('export async function load(url, context, nextLoad) { if (url.endsWith(".css")) return { format: "module", source: "", shortCircuit: true }; return nextLoad(url, context) }')}`, import.meta.url)
await Promise.all([
  import('../src/renderer/src/components/SidebarCaptureActions.tsx'),
  import('../src/renderer/src/components/DocumentTreeContextMenu.tsx')
])

type SidebarProps = ComponentProps<typeof PageNavWithWorkspaceTree>
const nodes = ['a', 'b'].map((id) => ({ id, title: `Document ${id}`, path: `Document ${id}`, updatedAt: '2026-10-01T00:00:00Z', children: [] }))
const noop = () => undefined

function sidebarProps(language: UiLanguage = 'en-US'): SidebarProps {
  const ui = getUiText(language)
  const labels = language === 'zh-CN'
    ? ['文档', '总览', '数据库', 'AI 助手', '插件中心', '配置中心', '搜索']
    : ['Documents', 'Dashboard', 'Database', 'AI Assistant', 'Plugins', 'Settings', 'Search']
  return {
    activePage: 'documents', pageItems: ['documents', 'dashboard', 'database', 'ai', 'plugins', 'settings', 'search'].map((id, index) => ({ id, label: labels[index], description: '' })),
    onSelectPage: noop, pageTitle: labels[0], pageDescription: '', brandEyebrow: '', navLabel: language === 'zh-CN' ? '页面导航' : 'Navigation',
    currentPageLabel: '', currentPageHint: '', backTitle: ui.back, forwardTitle: ui.forward, rootsCountLabel: '',
    onOpenGlobalSearch: noop, globalSearchTitle: ui.globalSearch, onCreateRoot: noop, newRootLabel: ui.newRoot, dropToRootLabel: ui.dropToRoot,
    dragOverRoot: false, onRootDragOver: noop, onRootDragLeave: noop, onDropToRoot: noop, pinnedSectionLabel: ui.pinnedSectionLabel,
    pinnedDocuments: [], pinnedDocumentIds: new Set(), activeDocumentReadyId: 'a', selectedDocumentId: 'a', detailLoading: false, isSaving: false,
    onSelectDocument: noop, onTogglePinDocument: noop, onCopyDocumentMarkdown: noop, onExportDocumentMarkdown: noop, onCreateChildDocument: noop,
    onDeleteDocument: noop, onSaveDocument: noop, documentTreeNodes: nodes, navCanGoBack: false, navCanGoForward: false, onNavBack: noop, onNavForward: noop,
    onDragStart: noop, onDragEnd: noop, onDragOverNode: noop, onDropOnNode: async () => undefined, uiLanguage: language,
    onToggleNavCollapse: noop, totalDocumentsCount: nodes.length
  }
}

async function withDom(run: (dom: JSDOM, root: ReturnType<typeof createRoot>, mount: HTMLElement) => Promise<void>) {
  const dom = new JSDOM('<!doctype html><html><body><div id="mount"></div></body></html>', { pretendToBeVisual: true })
  const keys = ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'IS_REACT_ACT_ENVIRONMENT'] as const
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const key of keys) Object.defineProperty(globalThis, key, {
    configurable: true, writable: true, value: key === 'IS_REACT_ACT_ENVIRONMENT' ? true : dom.window[key]
  })
  const mount = dom.window.document.querySelector<HTMLElement>('#mount')!
  const root = createRoot(mount)
  try { await run(dom, root, mount) }
  finally {
    await act(async () => root.unmount())
    dom.window.close()
    for (const key of keys) {
      const descriptor = previous.get(key)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

async function settleLazyViews() {
  await new Promise((resolve) => setTimeout(resolve, 30))
}

test('sidebar keeps every destination accessible in both languages and collapsed mode', async () => {
  await withDom(async (_dom, root, mount) => {
    const selected: string[] = []
    let toggles = 0
    for (const language of ['en-US', 'zh-CN'] as const) {
      const props = { ...sidebarProps(language), onSelectPage: (id: string) => selected.push(id), onToggleNavCollapse: () => { toggles++ } }
      for (const collapsed of [false, true]) {
        await act(async () => { root.render(<PageNavWithWorkspaceTree {...props} isNavCollapsed={collapsed} />); await settleLazyViews() })
        const primary = mount.querySelector('.sidebar-primary-navigation')!
        const secondary = mount.querySelector('.sidebar-secondary-navigation')!
        const management = mount.querySelector('.sidebar-management-footer')!
        assert.deepEqual([...primary.querySelectorAll('[data-page-id]')].map((button) => button.getAttribute('data-page-id')), ['documents', 'search', 'database'])
        assert.deepEqual([...secondary.querySelectorAll('[data-page-id]')].map((button) => button.getAttribute('data-page-id')), ['dashboard', 'ai'])
        for (const item of props.pageItems) {
          const button = mount.querySelector<HTMLButtonElement>(`[data-page-id="${item.id}"]`)!
          assert.equal(button.getAttribute('aria-label'), item.label)
          assert.equal(button.getAttribute('aria-current'), item.id === 'documents' ? 'page' : null)
          assert.equal(management.contains(button), ['plugins', 'settings'].includes(item.id))
          await act(async () => button.click())
          assert.equal(selected.at(-1), item.id)
        }
        await act(async () => mount.querySelector<HTMLButtonElement>('.rail-toggle-btn')!.click())
      }
    }
    assert.equal(toggles, 4)
  })
})

test('sidebar right click operates on its target without switching the open document', async () => {
  await withDom(async (dom, root, mount) => {
    const opened: string[] = [], copied: string[] = []
    await act(async () => { root.render(<PageNavWithWorkspaceTree {...sidebarProps()} onSelectDocument={(id) => opened.push(id)} onCopyDocumentMarkdown={(id) => copied.push(id)} />); await settleLazyViews() })
    const target = [...mount.querySelectorAll<HTMLButtonElement>('.tree-button')].find((button) => button.textContent?.includes('Document b'))!
    await act(async () => { target.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })); await settleLazyViews() })
    assert.deepEqual(opened, [])
    assert.match(mount.querySelector('.tree-button-active')!.textContent!, /Document a/)
    const menu = dom.window.document.querySelector('.document-tree-context-menu')!
    assert.ok(menu)
    const copy = [...menu.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === getUiText('en-US').copyMarkdown)!
    await act(async () => copy.click())
    assert.deepEqual(copied, ['b'])
    assert.deepEqual(opened, [])
  })
})

test('document drag reveals the root destination, follows hovered targets and clears after moving', async () => {
  await withDom(async (dom, root, mount) => {
    const moves: Array<[string, string | null]> = []
    Object.defineProperty(dom.window, 'knowbook', { configurable: true, value: {
      moveDocument: async (id: string, parent: string | null) => { moves.push([id, parent]) },
      getHomeData: async () => ({ documentTree: nodes })
    } })
    function Harness() {
      const workspace = useWorkspaceDocumentManagement({
        catalogColumns: [], catalogDocuments: [], documentIndex: [], moveTargetId: '', selectedDocument: null, selectedDocumentId: null,
        ui: getUiText('en-US'), onCancelPendingAutoSave: noop, onFlushPendingDocumentChanges: async () => true,
        getDraftMarkdownExport: () => null, onClearEditorSession: noop, onDetailLoadingChange: noop, onHomeDataChange: noop,
        onMessage: noop, onMoveTargetIdChange: noop, onSelectedDocumentChange: noop, onSelectedDocumentIdChange: noop, onUpdateDocumentDatabaseValue: async () => undefined
      })
      return <PageNavWithWorkspaceTree {...sidebarProps()} draggingDocumentId={workspace.draggingDocumentId} dragOverDocumentId={workspace.dragOverDocumentId}
        dragOverRoot={workspace.dragOverRoot} onDragStart={workspace.beginDrag} onDragEnd={workspace.endDrag} onDragOverNode={workspace.handleTreeNodeDragOver}
        onDragLeaveNode={workspace.handleTreeNodeDragLeave} onRootDragOver={workspace.handleRootDragOver} onRootDragLeave={workspace.handleRootDragLeave}
        onDropToRoot={() => { void workspace.dropToRoot() }} onDropOnNode={workspace.dropOnDocument} />
    }
    await act(async () => { root.render(<Harness />); await settleLazyViews() })
    const buttons = [...mount.querySelectorAll<HTMLButtonElement>('.tree-button')]
    const [source, target] = buttons
    const dispatchDrag = (element: HTMLElement, type: string) => {
      const event = new dom.window.Event(type, { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'dataTransfer', { value: { setData: noop, effectAllowed: '' } })
      element.dispatchEvent(event)
    }
    assert.equal(mount.querySelector('.root-drop-zone-compact'), null)
    await act(async () => dispatchDrag(source, 'dragstart'))
    assert.ok(mount.querySelector('.root-drop-zone-compact'))
    assert.ok(source.classList.contains('tree-button-dragging'))
    await act(async () => dispatchDrag(target, 'dragover'))
    assert.ok(target.classList.contains('tree-button-drag-over'))
    await act(async () => dispatchDrag(target, 'dragleave'))
    assert.equal(target.classList.contains('tree-button-drag-over'), false)
    await act(async () => dispatchDrag(target, 'dragover'))
    const rootDestination = mount.querySelector<HTMLElement>('.root-drop-zone-compact')!
    await act(async () => dispatchDrag(rootDestination, 'dragover'))
    assert.equal(target.classList.contains('tree-button-drag-over'), false)
    assert.ok(rootDestination.classList.contains('root-drop-zone-active'))
    await act(async () => { dispatchDrag(rootDestination, 'drop'); await settleLazyViews() })
    assert.deepEqual(moves, [['a', null]])
    assert.equal(mount.querySelector('.root-drop-zone-compact'), null)
    assert.equal(mount.querySelector('.tree-button-dragging'), null)
    assert.equal(mount.querySelector('.tree-button-drag-over'), null)
  })
})
