import assert from 'node:assert/strict'
import test from 'node:test'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { VIEWPORT_MENU_MARGIN } from '../src/renderer/src/utils/menuPosition.ts'

type GlobalOverrideKey = 'window' | 'document' | 'navigator' | 'HTMLElement' | 'ResizeObserver'

test('FloatingSlashCommandPanel keeps the slash menu inside the viewport near the bottom edge', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
  const previousGlobals = new Map<GlobalOverrideKey, PropertyDescriptor | undefined>()
  const targetViewport = { width: 800, height: 600 }
  const panelSize = { width: 280, height: 220 }
  const panelAnchor = { x: 760, y: 560 }

  const overrideGlobal = (key: GlobalOverrideKey, value: unknown) => {
    previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value
    })
  }

  const restoreGlobal = (key: GlobalOverrideKey) => {
    const previous = previousGlobals.get(key)
    if (previous) {
      Object.defineProperty(globalThis, key, previous)
      return
    }

    Reflect.deleteProperty(globalThis, key)
  }

  const originalOffsetWidth = Object.getOwnPropertyDescriptor(dom.window.HTMLElement.prototype, 'offsetWidth')
  const originalOffsetHeight = Object.getOwnPropertyDescriptor(dom.window.HTMLElement.prototype, 'offsetHeight')

  Object.defineProperty(dom.window, 'innerWidth', {
    configurable: true,
    value: targetViewport.width
  })
  Object.defineProperty(dom.window, 'innerHeight', {
    configurable: true,
    value: targetViewport.height
  })

  Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get() {
      return this.classList.contains('floating-slash-command-panel') ? panelSize.width : 0
    }
  })
  Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() {
      return this.classList.contains('floating-slash-command-panel') ? panelSize.height : 0
    }
  })

  let root: ReturnType<typeof createRoot> | null = null

  try {
    overrideGlobal('window', dom.window)
    overrideGlobal('document', dom.window.document)
    overrideGlobal('navigator', dom.window.navigator)
    overrideGlobal('HTMLElement', dom.window.HTMLElement)
    overrideGlobal('ResizeObserver', undefined)
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      configurable: true,
      writable: true,
      value: true
    })

    const { FloatingSlashCommandPanel } = await import('../src/renderer/src/components/FloatingSlashCommandPanel.tsx')
    const container = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(createElement(FloatingSlashCommandPanel, {
        x: panelAnchor.x,
        y: panelAnchor.y,
        query: '',
        commands: [
          {
            id: 'text',
            label: '文本段落',
            description: '把当前块转换为普通段落。'
          }
        ],
        activeCommandId: 'text',
        noMatchingLabel: '没有匹配的命令',
        onHoverCommand: () => undefined,
        onSelectCommand: () => undefined
      }))
    })

    const panel = container.querySelector('.floating-slash-command-panel') as HTMLDivElement | null
    assert.ok(panel)
    assert.equal(panel.style.left, `${targetViewport.width - panelSize.width - VIEWPORT_MENU_MARGIN}px`)
    assert.equal(panel.style.top, `${targetViewport.height - panelSize.height - VIEWPORT_MENU_MARGIN}px`)
  } finally {
    if (root) {
      await act(async () => {
        root?.unmount()
      })
    }

    if (originalOffsetWidth) {
      Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetWidth', originalOffsetWidth)
    }
    if (originalOffsetHeight) {
      Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetHeight', originalOffsetHeight)
    }

    restoreGlobal('ResizeObserver')
    restoreGlobal('HTMLElement')
    restoreGlobal('navigator')
    restoreGlobal('document')
    restoreGlobal('window')
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
    dom.window.close()
  }
})