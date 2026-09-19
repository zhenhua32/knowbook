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

export async function selectSource(editor: Locator, start: number, end = start): Promise<void> {
  await editor.evaluate((element, { start, end }) => {
    const view = (element as SourceContent).cmTile.root.view
    view.dispatch({ selection: { anchor: start, head: end }, scrollIntoView: true })
  }, { start, end })
}
