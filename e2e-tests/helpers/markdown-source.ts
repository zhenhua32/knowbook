import { expect, type Locator } from '@playwright/test'
import type { EditorView } from '@codemirror/view'

// CodeMirror renders a viewport, so DOM text is deliberately not the complete
// source. Read its document through the DOM tile used by findFromDOM, confined
// to this test adapter; all actual input still uses trusted browser events.
type SourceContent = HTMLElement & { cmTile: { root: { view: EditorView } } }

export async function sourceValue(editor: Locator): Promise<string> {
  return editor.evaluate(element => (element as SourceContent).cmTile.root.view.state.doc.toString())
}

export async function expectSource(editor: Locator, source: string): Promise<void> {
  await expect.poll(() => sourceValue(editor)).toBe(source)
}

export async function sourceSelection(editor: Locator): Promise<{ from: number; to: number }> {
  return editor.evaluate(element => {
    const { from, to } = (element as SourceContent).cmTile.root.view.state.selection.main
    return { from, to }
  })
}

export async function selectSource(editor: Locator, start: number, end = start): Promise<void> {
  await editor.evaluate((element, { start, end }) => {
    const view = (element as SourceContent).cmTile.root.view
    view.dispatch({ selection: { anchor: start, head: end }, scrollIntoView: true })
  }, { start, end })
}

// Measure inside the renderer, starting at the trusted input/click/keydown
// event. Two animation frames include a rendering opportunity, not OS display latency.
export async function measureNextFrame(target: Locator, eventName: 'input' | 'click' | 'keydown', name: string, key = 'b') {
  await target.evaluate((element, { eventName, name, key }) => {
    const listener = (event: Event) => {
      if (eventName === 'keydown' && (event as KeyboardEvent).key.toLowerCase() !== key) return
      element.removeEventListener(eventName, listener, true)
      if (!event.isTrusted) throw new Error('Expected trusted input')
      const start = performance.now()
      const frame = () => requestAnimationFrame(() => requestAnimationFrame(() => performance.measure(name, { start, end: performance.now() })))
      if (name === 'source-open-frame' && !document.querySelector('.document-markdown-source .cm-content')) {
        const observer = new MutationObserver(() => {
          if (document.querySelector('.document-markdown-source .cm-content')) { observer.disconnect(); frame() }
        })
        observer.observe(document.body, { childList: true, subtree: true })
      } else frame()
    }
    element.addEventListener(eventName, listener, { capture: true })
  }, { eventName, name, key })
}
