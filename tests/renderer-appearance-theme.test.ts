import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { applyAppearanceTheme } from '../src/renderer/src/utils/appearanceTheme.ts'

test('appearance theme application updates the host root and publishes dark surface rules', () => {
  const root = { dataset: {} as DOMStringMap }
  applyAppearanceTheme(root, 'dark')
  assert.equal(root.dataset.theme, 'dark')
  applyAppearanceTheme(root, 'light')
  assert.equal(root.dataset.theme, 'light')

  const styles = readFileSync(join(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')
  assert.match(styles, /:root\[data-theme='dark'\]/)
  assert.match(styles, /color-scheme:\s*dark/)
  assert.match(styles, /--surface:\s*#202630/)
})
