import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const styles = readFileSync(join(process.cwd(), 'src/renderer/src/styles.css'), 'utf8').replace(/\r\n/g, '\n')
const visualRefresh = styles.slice(styles.lastIndexOf('/* ===== 2026 visual refresh'))

function ruleFor(selector: string, source = visualRefresh): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = source.match(new RegExp(`${escapedSelector}\\s*\\{([^}]+)\\}`))
  assert.ok(match, `Missing CSS rule for ${selector}`)
  return match[1] ?? ''
}

test('documents page keeps the workspace shell from becoming a shared scroll container', () => {
  const contentRule = ruleFor('.content.page-documents')
  const workspaceRule = ruleFor('.workspace-grid')

  assert.match(contentRule, /overflow:\s*hidden/)
  assert.match(workspaceRule, /height:\s*100%/)
  assert.match(workspaceRule, /min-height:\s*0/)
  assert.match(workspaceRule, /overflow:\s*hidden/)
})

test('document canvas and auxiliary panel have independent vertical scrolling', () => {
  const previewRule = ruleFor('.preview-panel')
  const auxRule = ruleFor('.document-aux-sidebar-content,\n.document-aux-sidebar-empty')

  assert.match(previewRule, /overflow-y:\s*auto/)
  assert.match(previewRule, /overscroll-behavior:\s*contain/)
  assert.match(auxRule, /overflow-y:\s*auto/)
  assert.match(auxRule, /overscroll-behavior:\s*contain/)
})

test('document support panels share the reading-column width contract', () => {
  const supportPanelRule = ruleFor(
    '.preview-panel > .document-summary-card,\n.preview-panel > .document-outline-panel,\n.preview-panel > .document-stats-bar'
  )

  assert.match(supportPanelRule, /width:\s*min\(100%,\s*880px\)/)
  assert.match(supportPanelRule, /max-width:\s*880px/)
})

test('shared buttons expose a non-interactive disabled state', () => {
  const disabledRule = ruleFor(
    '.primary-button:disabled,\n.secondary-button:disabled,\n.danger-button:disabled',
    styles
  )

  assert.match(disabledRule, /cursor:\s*not-allowed/)
  assert.match(disabledRule, /opacity:\s*0\.48/)
  assert.doesNotMatch(styles, /\.secondary-button:hover\s*\{/)
})

test('block controls remain visible for keyboard focus and the toolbar can wrap', () => {
  const focusRule = ruleFor(
    '.block-editor-row:hover .block-hover-controls,\n.block-editor-row:focus-within .block-hover-controls',
    styles
  )
  const toolbarRule = ruleFor('.block-edit-toolbar', styles)

  assert.match(focusRule, /opacity:\s*1/)
  assert.match(toolbarRule, /flex-wrap:\s*wrap/)
  assert.match(toolbarRule, /max-width:\s*calc\(100% - 12px\)/)
  assert.match(toolbarRule, /white-space:\s*normal/)
})

test('responsive styles have one source of truth and respect reduced motion', () => {
  assert.equal((styles.match(/@media \(max-width: 1080px\)/g) ?? []).length, 1)
  assert.equal((styles.match(/@media \(max-width: 720px\)/g) ?? []).length, 1)
  assert.equal((styles.match(/@container document-canvas \(max-width: 640px\)/g) ?? []).length, 1)
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/)
})

test('active styles do not depend on removed legacy custom properties', () => {
  assert.doesNotMatch(styles, /var\(--(?:border|hover|active|text)\)/)
})
