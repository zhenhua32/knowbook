import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import React, { act, type ReactNode } from 'react'
import { JSDOM } from 'jsdom'
import type { ElectronApi } from '../src/shared/contracts'
import type { ResolveWebDavSyncConflict, WebDavSyncConflict, WebDavSyncConflictDetails, WebDavSyncConflictDetailsInput, WebDavSyncStatus } from '../src/shared/webdav-sync'
import { DEFAULT_WEBDAV_SYNC_CONFIG } from '../src/shared/webdav-sync'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
const { default: ConflictCard } = await import('../src/renderer/src/sections/WebDavSyncConflictCard')
const { default: SyncSettings } = await import('../src/renderer/src/sections/WebDavSyncSettings')

const conflict: WebDavSyncConflict = { key: 'doc:document', title: 'Review', localHash: 'a'.repeat(64), remoteHash: 'b'.repeat(64),
  localPreview: 'short local', remotePreview: 'short remote', canKeepBoth: true, localDeleted: false, remoteDeleted: false,
  reason: 'overlap', canMerge: true, mergeFields: [{ id: 'title', field: 'title' }, { id: 'body', field: 'block-content', blockId: 'one' }], resolution: null }
function details(input: WebDavSyncConflictDetailsInput = conflict): WebDavSyncConflictDetails {
  const titleChoice = input.mergeChoices?.title, bodyChoice = input.mergeChoices?.body
  return { key: input.key, localHash: input.localHash, remoteHash: input.remoteHash,
    localPreview: 'complete local <script>alert(1)</script>', remotePreview: 'complete remote', basePreview: 'common version', merge: {
      document: { title: titleChoice?.choice === 'custom' ? titleChoice.text : 'Local title', summary: 'Independent summary change',
        blocks: [{ id: 'one', type: 'paragraph', content: bodyChoice?.choice === 'remote' ? 'Remote body' : 'Local body', checked: false, depth: 0 }] },
      conflicts: [{ id: 'title', field: 'title', localPreview: 'Local title', remotePreview: 'Remote title', basePreview: 'Original title', canEditText: true },
        { id: 'body', field: 'block-content', blockId: 'one', localPreview: 'Local body', remotePreview: 'Remote body', basePreview: 'Original body', canEditText: true }],
      unresolvedIds: ['title', 'body'].filter(id => !input.mergeChoices?.[id])
    } }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
async function withRenderer(bridge: Partial<ElectronApi>, run: (context: {
  render: (node: ReactNode) => Promise<void>; document: Document; window: Window & typeof globalThis
}) => Promise<void>) {
  const dom = new JSDOM('<div id="mount"></div>', { url: 'http://localhost' }), previous = new Map<string, PropertyDescriptor | undefined>()
  Object.defineProperty(dom.window, 'knowbook', { value: bridge })
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const { createRoot } = await import('react-dom/client'), root = createRoot(dom.window.document.getElementById('mount')!)
  try { await run({ render: async node => { await act(async () => root.render(node)) }, document: dom.window.document, window: dom.window as unknown as Window & typeof globalThis }) }
  finally {
    await act(async () => root.unmount())
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key) }
    dom.window.close()
  }
}
function button(document: Document, label: string): HTMLButtonElement {
  const result = [...document.querySelectorAll('button')].find(element => element.textContent === label)
  assert.ok(result, `Missing button: ${label}`); return result
}
async function open(document: Document, window: Window & typeof globalThis) {
  await act(async () => {
    const card = document.querySelector<HTMLDetailsElement>('.webdav-conflict-card')!
    card.open = true; card.dispatchEvent(new window.Event('toggle', { bubbles: true }))
  })
}

test('conflict details are loaded on demand, render full text safely and version every whole-document decision', async () => {
  const requests: WebDavSyncConflictDetailsInput[] = [], decisions: ResolveWebDavSyncConflict[] = []
  await withRenderer({ getWebDavSyncConflictDetails: async input => { requests.push(input); return details(input) } }, async ({ render, document, window }) => {
    const decide = async (input: ResolveWebDavSyncConflict) => { decisions.push(input); return true }
    await render(<ConflictCard conflict={conflict} isZh disabled={false} onResolve={decide} />)
    assert.equal(requests.length, 0)
    await open(document, window)
    assert.deepEqual(requests, [{ key: conflict.key, localHash: conflict.localHash, remoteHash: conflict.remoteHash }])
    assert.match(document.querySelector('.webdav-conflict-comparison')!.textContent!, /complete local <script>alert\(1\)<\/script>/)
    assert.equal(document.querySelectorAll('script').length, 0)
    await act(async () => button(document, '使用远端版本').click())
    assert.deepEqual(decisions[0], { key: conflict.key, localHash: conflict.localHash, remoteHash: conflict.remoteHash, choice: 'remote' })
    await render(<ConflictCard conflict={{ ...conflict, resolution: 'remote' }} isZh disabled={false} onResolve={decide} />)
    assert.match(document.querySelector('.webdav-conflict-card > summary')!.textContent!, /待同步应用 · 远端版本/)
    await act(async () => button(document, '取消处理方案').click())
    assert.equal(decisions[1].choice, 'clear')
    assert.equal(requests.length, 1, 'Polling an unchanged conflict must retain loaded details')
  })
})

test('manual merge requires every overlapping field, previews the exact choices and preserves a failed draft', async () => {
  const requests: WebDavSyncConflictDetailsInput[] = [], decisions: ResolveWebDavSyncConflict[] = []
  await withRenderer({ getWebDavSyncConflictDetails: async input => { requests.push(input); return details(input) } }, async ({ render, document, window }) => {
    await render(<ConflictCard conflict={conflict} isZh disabled={false} onResolve={async input => { decisions.push(input); return false }} />)
    await open(document, window)
    await act(async () => button(document, '逐项合并').click())
    const save = button(document, '保存合并方案')
    assert.equal(save.disabled, true)
    const title = document.querySelector<HTMLFieldSetElement>('[data-merge-part="title"]')!
    const body = document.querySelector<HTMLFieldSetElement>('[data-merge-part="body"]')!
    await act(async () => title.querySelectorAll<HTMLInputElement>('input[type="radio"]')[2].click())
    const input = title.querySelector<HTMLInputElement>('.editor-input')!
    assert.equal(input.value, 'Local title')
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'Reviewed title')
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    assert.equal(input.value, 'Reviewed title')
    assert.equal(save.disabled, true)
    await act(async () => body.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1].click())
    assert.equal(save.disabled, false)
    await act(async () => button(document, '预览合并结果').click())
    assert.deepEqual(requests.at(-1)?.mergeChoices, { title: { choice: 'custom', text: 'Reviewed title' }, body: { choice: 'remote' } })
    assert.match(document.querySelector('.webdav-conflict-result')!.textContent!, /Independent summary change\n\nRemote body/)
    await act(async () => input.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true })))
    assert.equal(save.disabled, true)
    await act(async () => input.dispatchEvent(new window.CompositionEvent('compositionend', { bubbles: true })))
    await act(async () => save.click())
    assert.deepEqual(decisions[0], { key: conflict.key, localHash: conflict.localHash, remoteHash: conflict.remoteHash, choice: 'merge',
      mergeChoices: { title: { choice: 'custom', text: 'Reviewed title' }, body: { choice: 'remote' } } })
    assert.equal(input.value, 'Reviewed title')
    assert.equal(body.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1].checked, true)
  })
})

test('changing a merge choice invalidates the preview and ignores an old preview response', async () => {
  const oldPreview = deferred<WebDavSyncConflictDetails>()
  await withRenderer({ getWebDavSyncConflictDetails: async input => input.mergeChoices ? oldPreview.promise : details(input) }, async ({ render, document, window }) => {
    await render(<ConflictCard conflict={conflict} isZh={false} disabled={false} onResolve={async () => true} />)
    await open(document, window)
    await act(async () => button(document, 'Merge changes').click())
    await act(async () => {
      document.querySelector<HTMLInputElement>('[data-merge-part="title"] input')!.click()
      document.querySelector<HTMLInputElement>('[data-merge-part="body"] input')!.click()
    })
    await act(async () => button(document, 'Preview merge result').click())
    await act(async () => document.querySelector('[data-merge-part="body"]')!.querySelectorAll<HTMLInputElement>('input')[1].click())
    await act(async () => oldPreview.resolve(details({ ...conflict, mergeChoices: { title: { choice: 'local' }, body: { choice: 'local' } } })))
    assert.equal(document.querySelector('.webdav-conflict-result'), null)
    assert.equal(button(document, 'Preview merge result').disabled, false)
  })
})

test('settings keep saved resolutions across remounts and discard details from superseded conflict versions', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let current: WebDavSyncStatus = { config: { ...DEFAULT_WEBDAV_SYNC_CONFIG }, hasPassword: true, phase: 'idle', lastSyncAt: null,
    message: 'Ready', uploaded: 0, downloaded: 0, merged: 0, progress: null, conflicts: [{ ...conflict, resolution: 'local' }] }
  const oldDetails = deferred<WebDavSyncConflictDetails>(), requests: WebDavSyncConflictDetailsInput[] = []
  await withRenderer({ getWebDavSyncStatus: async () => current,
    getWebDavSyncConflictDetails: input => { requests.push(input); return requests.length === 1 ? oldDetails.promise : Promise.resolve(details(input)) } }, async ({ render, document, window }) => {
    await render(<SyncSettings isZh />)
    assert.match(document.querySelector('.webdav-conflict-card > summary')!.textContent!, /待同步应用/)
    await open(document, window)
    current = { ...current, conflicts: [{ ...conflict, localHash: 'c'.repeat(64), resolution: null }] }
    await act(async () => t.mock.timers.tick(1000))
    await act(async () => oldDetails.resolve(details()))
    assert.equal(document.querySelector<HTMLDetailsElement>('.webdav-conflict-card')!.open, false)
    assert.doesNotMatch(document.querySelector('.webdav-conflict-card')!.textContent!, /complete local/)
    await open(document, window)
    assert.equal(requests[1].localHash, 'c'.repeat(64))
    await render(null)
    current = { ...current, conflicts: [{ ...conflict, resolution: 'merge' }] }
    await render(<SyncSettings isZh />)
    assert.match(document.querySelector('.webdav-conflict-card > summary')!.textContent!, /待同步应用 · 逐项合并/)
  })
})

test('delete versus edit conflicts explain which version becomes the conflict copy', async () => {
  await withRenderer({}, async ({ render, document }) => {
    await render(<ConflictCard conflict={{ ...conflict, reason: 'delete-edit', localDeleted: true, canMerge: false }} isZh disabled onResolve={async () => true} />)
    assert.match(document.body.textContent!, /本地版本 · 已删除/)
    assert.match(document.body.textContent!, /保留原文档的本地删除状态/)
    assert.match(document.body.textContent!, /远端冲突副本/)
    assert.equal([...document.querySelectorAll('button')].every(element => element.disabled), true)
  })
})

test('block property conflicts identify task completion, tags and formatting independently', async () => {
  const value = details()
  value.merge!.conflicts = ['checked', 'tags', 'language', 'listStart', 'markdownFormat', 'highlight'].map(property => ({
    id: property, field: 'block-property', blockId: 'one', property, basePreview: 'original', localPreview: 'local', remotePreview: 'remote', canEditText: false
  }))
  await withRenderer({ getWebDavSyncConflictDetails: async () => value }, async ({ render, document, window }) => {
    await render(<ConflictCard conflict={conflict} isZh disabled={false} onResolve={async () => true} />)
    await open(document, window)
    await act(async () => button(document, '逐项合并').click())
    assert.deepEqual([...document.querySelectorAll('legend')].map(element => element.textContent),
      ['正文块 1 · 任务完成状态', '正文块 1 · 标签', '正文块 1 · 代码语言', '正文块 1 · 编号起点', '正文块 1 · 格式', '正文块 1 · 高亮'])
    assert.equal(document.querySelectorAll('.webdav-conflict-merge input[type="radio"]').length, 12)
  })
})

test('reopening a saved merge restores its exact choices, custom text and final preview', async () => {
  const savedChoices = { title: { choice: 'custom' as const, text: 'Saved reviewed title' }, body: { choice: 'remote' as const } }
  await withRenderer({ getWebDavSyncConflictDetails: async input => ({ ...details({ ...input, mergeChoices: savedChoices }), savedChoices }) }, async ({ render, document, window }) => {
    await render(<ConflictCard conflict={{ ...conflict, resolution: 'merge' }} isZh={false} disabled={false} onResolve={async () => true} />)
    await open(document, window)
    await act(async () => button(document, 'Merge changes').click())
    assert.equal(document.querySelector<HTMLInputElement>('[data-merge-part="title"] .editor-input')!.value, 'Saved reviewed title')
    assert.equal(document.querySelector('[data-merge-part="body"]')!.querySelectorAll<HTMLInputElement>('input')[1].checked, true)
    assert.match(document.querySelector('.webdav-conflict-result')!.textContent!, /Saved reviewed title\n\nIndependent summary change\n\nRemote body/)
    assert.equal(button(document, 'Save merge plan').disabled, false)
  })
})
