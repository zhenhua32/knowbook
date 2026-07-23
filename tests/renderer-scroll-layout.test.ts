import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const styles = readFileSync(join(process.cwd(), 'src/renderer/src/styles.css'), 'utf8').replace(/\r\n/g, '\n')
const visualRefresh = styles.slice(styles.lastIndexOf('/* ===== 2026 visual refresh'))

function ruleFor(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = visualRefresh.match(new RegExp(`${escapedSelector}\\s*\\{([^}]+)\\}`))
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
