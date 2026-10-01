import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import React, { act, type ComponentProps } from 'react'
import { JSDOM } from 'jsdom'
import { getUiText } from '../src/renderer/src/i18n'
import type { WorkspaceEventRecord } from '../src/shared/contracts'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
const { WorkspaceDashboardSection } = await import('../src/renderer/src/sections/WorkspaceDashboardSection')

const events: WorkspaceEventRecord[] = [
  { id: 'saved', type: 'document.updated', title: 'Document saved', description: 'Saved changes to "English technical text".',
    documentId: 'plan-document', createdAt: '2026-10-01T08:00:00.000Z',
    details: { schemaVersion: 1, documentTitle: '计划 <草稿>', path: '工作/计划 <草稿>' } },
  { id: 'deleted', type: 'document.deleted', title: 'Document deleted', description: 'Deleted old technical text.',
    documentId: null, createdAt: '2026-10-01T07:00:00.000Z', details: { schemaVersion: 1, documentTitle: '旧资料' } },
  { id: 'ai', type: 'ai.config.updated', title: 'AI settings updated', description: 'Saved AI settings for chat model local.',
    documentId: null, createdAt: 'bad date', details: { schemaVersion: 1, model: 'local', aiEnabled: false } },
  { id: 'plugin', type: 'plugin.action.executed', title: 'Custom plugin title', description: '插件自己的内容 / Custom plugin content.',
    documentId: null, createdAt: '2026-10-01T05:00:00.000Z' }
]

function props(locale: 'zh-CN' | 'en-US', onOpenDocument: (id: string) => void): ComponentProps<typeof WorkspaceDashboardSection> {
  return { isAiEnabled: false, hasAiApiKey: false, onOpenDocument, onBackupNow: () => undefined, onRestoreBackup: () => undefined,
    recentEvents: events, pluginDashboardCards: [], ui: getUiText(locale),
    summary: { databasePath: '', backupRoot: '', documents: 1, blocks: 1, links: 0, lastBackupAt: null } }
}

test('activity has readable list semantics, localized facts, and an explicit working document destination', async () => {
  const dom = new JSDOM('<div id="mount"></div>', { url: 'http://localhost', pretendToBeVisual: true })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const { createRoot } = await import('react-dom/client')
  const container = dom.window.document.getElementById('mount')!
  const root = createRoot(container)
  const opened: string[] = []
  try {
    for (const locale of ['zh-CN', 'en-US'] as const) {
      await act(async () => root.render(<WorkspaceDashboardSection {...props(locale, id => opened.push(id))} />))
      const list = container.querySelector<HTMLOListElement>('ol')!
      assert.equal(list.getAttribute('aria-label'), getUiText(locale).recentEventsTitle)
      assert.equal(list.children.length, 4)
      assert.equal(list.querySelectorAll('button').length, 1, 'non-document activity must stay readable without disabled controls')
      assert.equal(list.querySelectorAll('button:disabled').length, 0)
      assert.equal(list.querySelectorAll('time[datetime]').length, 3)
      assert.match(list.textContent!, locale === 'zh-CN' ? /已保存「计划 <草稿>」/ : /Saved “计划 <草稿>”/)
      assert.doesNotMatch(list.textContent!, /English technical text|Deleted old technical text|Saved AI settings for/)
      assert.match(list.textContent!, /Custom plugin title/)
      assert.match(list.textContent!, /插件自己的内容 \/ Custom plugin content\./)
      assert.equal(list.querySelector('草稿'), null, 'document titles must be rendered as text')
      const button = list.querySelector<HTMLButtonElement>('button')!
      assert.equal(button.getAttribute('aria-label'), `${locale === 'zh-CN' ? '打开文档：' : 'Open document: '}计划 <草稿>`)
      await act(async () => button.click())
      assert.equal(opened.at(-1), 'plan-document')
    }
  } finally {
    await act(async () => root.unmount())
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
    dom.window.close()
  }
})
