import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const appPageContentSource = readFileSync(
  new URL('../src/renderer/src/components/AppPageContent.tsx', import.meta.url),
  'utf8'
)
const appSource = readFileSync(
  new URL('../src/renderer/src/App.tsx', import.meta.url),
  'utf8'
)
const rendererEntrySource = readFileSync(
  new URL('../src/renderer/src/main.tsx', import.meta.url),
  'utf8'
)
const blockEditorRowSource = readFileSync(
  new URL('../src/renderer/src/components/BlockEditorRow.tsx', import.meta.url),
  'utf8'
)

test('renderer page bodies stay behind lazy loading boundaries', () => {
  const lazyPageModules = [
    '../pages/DocumentsPage',
    '../pages/DatabasePage',
    '../sections/AISection',
    '../sections/DashboardSettingsSection',
    '../sections/PluginsSection',
    '../sections/WorkspaceDashboardSection'
  ]

  for (const modulePath of lazyPageModules) {
    assert.equal(
      appPageContentSource.includes(`import('${modulePath}')`),
      true,
      `${modulePath} should be loaded with a dynamic import`
    )
    assert.equal(
      appPageContentSource.includes(`from '${modulePath}'`),
      false,
      `${modulePath} should not be part of the eager renderer graph`
    )
  }

  assert.equal(appPageContentSource.includes('<Suspense'), true)
})

test('code and math theme styles load with their preview chunks', () => {
  assert.equal(rendererEntrySource.includes('katex/dist/katex.min.css'), false)
  assert.equal(rendererEntrySource.includes('highlight.js/styles/github-dark.css'), false)
  assert.equal(blockEditorRowSource.includes("import('highlight.js/styles/github-dark.css')"), true)
  assert.equal(blockEditorRowSource.includes("import('katex/dist/katex.min.css')"), true)
})

test('database domain data waits until the database page is active', () => {
  assert.equal(
    appSource.includes("useDatabaseDomainState(shell.activePage === 'database')"),
    true
  )
})
