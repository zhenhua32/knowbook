import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import React, { act, useState, type ReactNode } from 'react'
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
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function withRenderer(bridge: Partial<ElectronApi>, run: (context: {
  render: (node: ReactNode) => Promise<void>; document: Document; window: Window & typeof globalThis
}) => Promise<void>) {
  const dom = new JSDOM('<div id="mount"></div>', { url: 'http://localhost' }), previous = new Map<string, PropertyDescriptor | undefined>()
  Object.defineProperty(dom.window, 'knowbook', { value: bridge })
  Object.defineProperty(dom.window.document, 'hasFocus', { value: () => true })
  // JSDOM cannot compute layout; hidden details bodies and hidden ancestors have no rectangles.
  dom.window.HTMLElement.prototype.getClientRects = function () {
    if (!this.isConnected) return [] as unknown as DOMRectList
    let element: HTMLElement | null = this
    while (element) {
      const style = dom.window.getComputedStyle(element)
      if (element.hidden || element.hasAttribute('inert') || element.getAttribute('aria-hidden') === 'true'
        || style.display === 'none' || style.visibility === 'hidden'
        || (element instanceof dom.window.HTMLDetailsElement && !element.open && !element.querySelector('summary')?.contains(this))) return [] as unknown as DOMRectList
      element = element.parentElement
    }
    return [new dom.window.DOMRect(0, 0, 240, 32)] as unknown as DOMRectList
  }
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
async function activate(button: HTMLButtonElement, twice = false) {
  await act(async () => { button.focus(); button.click(); if (twice) button.click() })
  // Native Chrome blurs newly disabled controls. JSDOM's blur() skips disabled controls.
  await act(async () => {
    if (button.disabled && button.ownerDocument.activeElement === button) {
      button.disabled = false; button.blur(); button.disabled = true
    }
  })
}
function assertFocused(document: Document, expected: Element) {
  assert.ok(document.activeElement === expected, `Focused ${document.activeElement?.tagName}#${document.activeElement?.id}; expected ${expected.tagName}#${expected.id}`)
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

test('whole-document decisions report local progress and failure, prevent same-frame duplicates and restore focus on retry', async () => {
  const requests: Array<ReturnType<typeof deferred<boolean>>> = []
  const decisions: ResolveWebDavSyncConflict[] = []
  const decide = (input: ResolveWebDavSyncConflict) => {
    decisions.push(input)
    const pending = deferred<boolean>(); requests.push(pending); return pending.promise
  }
  await withRenderer({ getWebDavSyncConflictDetails: async input => details(input) }, async ({ render, document, window }) => {
    await render(<ConflictCard conflict={conflict} isZh disabled={false} onResolve={decide} />)
    await open(document, window)
    const remote = button(document, '使用远端版本')
    await activate(remote, true)
    assert.equal(decisions.length, 1, 'The synchronous lock must cover clicks before the busy commit')
    const progress = document.querySelector<HTMLElement>('.webdav-action-feedback')!
    assert.equal(progress.getAttribute('role'), 'status')
    assert.match(progress.textContent!, /正在保存/)
    assert.equal(progress.closest('[aria-busy="true"]'), null, 'Live progress must remain outside busy ancestors')
    assert.equal(progress.nextElementSibling?.className, 'settings-actions')
    assert.equal(progress.closest('.webdav-conflict-merge'), null)
    assert.equal(remote.getAttribute('aria-busy'), 'true')
    assert.equal(button(document, '使用本地版本').getAttribute('aria-busy'), 'false')
    assert.ok([...document.querySelectorAll('button')].every(item => item.disabled))
    assertFocused(document, document.body)
    await act(async () => requests[0].resolve(false))
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /无法保存处理方案/)
    assertFocused(document, remote)
    assert.equal(remote.disabled, false)
    await render(<ConflictCard conflict={conflict} isZh disabled={false} onResolve={decide} resolutionError="服务端目录只读。" />)
    assert.equal(document.querySelectorAll('.webdav-action-feedback').length, 1)
    assert.equal(document.querySelector('[role="alert"]')!.textContent, '服务端目录只读。')
    await activate(remote)
    assert.equal(document.querySelector('.webdav-action-feedback[role="alert"]'), null)
    await act(async () => requests[1].resolve(true))
    assert.equal(document.querySelector('.webdav-action-feedback[role]'), null, 'A successful retry clears even the previous parent error')
    assertFocused(document, remote)
  })
})

test('merge failures retain custom choices and preview with feedback beside merge actions, then move feedback for a whole-version attempt', async () => {
  const requests: Array<ReturnType<typeof deferred<boolean>>> = [], decisions: ResolveWebDavSyncConflict[] = []
  await withRenderer({ getWebDavSyncConflictDetails: async input => details(input) }, async ({ render, document, window }) => {
    await render(<ConflictCard conflict={conflict} isZh={false} disabled={false} resolutionError="The remote folder is read-only."
      onResolve={input => { decisions.push(input); const pending = deferred<boolean>(); requests.push(pending); return pending.promise }} />)
    await open(document, window)
    await act(async () => button(document, 'Merge changes').click())
    assert.equal(document.querySelector('.webdav-action-feedback[role]'), null, 'An unrelated parent error must not become a local failure')
    const title = document.querySelector<HTMLFieldSetElement>('[data-merge-part="title"]')!
    const body = document.querySelector<HTMLFieldSetElement>('[data-merge-part="body"]')!
    await act(async () => title.querySelectorAll<HTMLInputElement>('input[type="radio"]')[2].click())
    const input = title.querySelector<HTMLInputElement>('.editor-input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'Reviewed draft')
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
      body.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1].click()
    })
    await act(async () => button(document, 'Preview merge result').click())
    const preview = document.querySelector('.webdav-conflict-result')!.textContent
    const save = button(document, 'Save merge plan')
    await activate(save)
    const progress = document.querySelector('.webdav-action-feedback[role="status"]')!
    assert.ok(progress.closest('.webdav-conflict-merge'))
    assert.equal(progress.nextElementSibling?.className, 'settings-actions')
    assert.equal(save.getAttribute('aria-busy'), 'true')
    assert.ok([...document.querySelectorAll('fieldset')].every(field => field.disabled))
    assert.ok([...document.querySelectorAll('button')].every(item => item.disabled))
    await act(async () => requests[0].resolve(false))
    assert.deepEqual(decisions[0].mergeChoices, { title: { choice: 'custom', text: 'Reviewed draft' }, body: { choice: 'remote' } })
    assert.equal(input.value, 'Reviewed draft')
    assert.equal(body.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1].checked, true)
    assert.equal(document.querySelector('.webdav-conflict-result')!.textContent, preview)
    assert.equal(button(document, 'Merge changes').getAttribute('aria-expanded'), 'true')
    assert.equal(document.querySelectorAll('.webdav-action-feedback[role]').length, 1)
    assert.equal(document.querySelector('.webdav-conflict-merge [role="alert"]')!.textContent, 'The remote folder is read-only.')
    assertFocused(document, save)
    const local = button(document, 'Use local version')
    await activate(local)
    assert.equal(document.querySelector('.webdav-action-feedback[role="status"]')!.closest('.webdav-conflict-merge'), null)
    assert.equal(document.querySelector('.webdav-conflict-merge .webdav-action-feedback[role]'), null)
    await act(async () => requests[1].resolve(true))
    assert.equal(button(document, 'Merge changes').getAttribute('aria-expanded'), 'false')
    assert.equal(document.querySelector('.webdav-action-feedback[role]'), null)
    assertFocused(document, local)
  })
})

test('resolution completion waits for a later parent commit to enable the actual initiating button', async () => {
  for (const succeeded of [false, true]) {
    const pending = deferred<boolean>(), decide = () => pending.promise
    await withRenderer({ getWebDavSyncConflictDetails: async input => details(input) }, async ({ render, document, window }) => {
      await render(<ConflictCard conflict={conflict} isZh={false} disabled={false} onResolve={decide} />)
      await open(document, window)
      const remote = button(document, 'Use remote version')
      await activate(remote)
      await render(<ConflictCard conflict={conflict} isZh={false} disabled onResolve={decide} />)
      await act(async () => pending.resolve(succeeded))
      assert.equal(remote.disabled, true)
      assert.equal(remote.getAttribute('aria-busy'), 'false')
      assertFocused(document, document.body)
      await render(<ConflictCard conflict={conflict} isZh={false} disabled={false} onResolve={decide} />)
      assertFocused(document, remote)
    })
  }
})

test('resolution failures use readable local fallback without exposing raw thrown errors and can be retried', async () => {
  const requests: Array<ReturnType<typeof deferred<boolean>>> = []
  await withRenderer({ getWebDavSyncConflictDetails: async input => details(input) }, async ({ render, document, window }) => {
    await render(<ConflictCard conflict={conflict} isZh={false} disabled={false}
      onResolve={() => { const pending = deferred<boolean>(); requests.push(pending); return pending.promise }} />)
    await open(document, window)
    const local = button(document, 'Use local version')
    await activate(local)
    await act(async () => requests[0].reject(new Error("Error invoking remote method 'sync:resolve': Error: internal stack")))
    assert.equal(document.querySelector('[role="alert"]')!.textContent, 'Could not save the resolution. Retry.')
    assert.doesNotMatch(document.body.textContent!, /internal stack|invoking remote/)
    assert.equal(local.disabled, false)
    assertFocused(document, local)
    await activate(local)
    await act(async () => requests[1].resolve(true))
    assert.equal(document.querySelector('.webdav-action-feedback[role]'), null)
    assertFocused(document, local)
  })
})

test('successfully clearing a resolution restores the remaining whole action after the removed trigger and parent busy state clear', async () => {
  const pending = deferred<boolean>(), decide = () => pending.promise
  const saved = { ...conflict, resolution: 'local' as const }
  await withRenderer({ getWebDavSyncConflictDetails: async input => details(input) }, async ({ render, document, window }) => {
    await render(<ConflictCard conflict={saved} isZh disabled={false} onResolve={decide} />)
    await open(document, window)
    const clear = button(document, '取消处理方案')
    await activate(clear)
    await render(<ConflictCard conflict={conflict} isZh disabled onResolve={decide} />)
    const fallback = button(document, '逐项合并')
    assert.equal(clear.isConnected, false)
    assert.equal(fallback.disabled, true)
    await act(async () => pending.resolve(true))
    assertFocused(document, document.body)
    await render(<ConflictCard conflict={conflict} isZh disabled={false} onResolve={decide} />)
    assertFocused(document, fallback)
    assert.equal(document.querySelector('.webdav-action-feedback[role]'), null)
    assert.doesNotMatch(document.querySelector('.webdav-conflict-card > summary')!.textContent!, /待同步应用/)
  })
})

test('resolution completion never takes focus back after an outside interaction or a new modal', async () => {
  for (const interruption of ['input', 'pointer', 'modal'] as const) {
    const pending = deferred<boolean>()
    await withRenderer({ getWebDavSyncConflictDetails: async input => details(input) }, async ({ render, document, window }) => {
      await render(<ConflictCard conflict={conflict} isZh disabled={false} onResolve={() => pending.promise} />)
      await open(document, window)
      await activate(button(document, '使用本地版本'))
      const outside = document.createElement('input'); outside.id = 'other-setting'; document.body.append(outside)
      await act(async () => {
        if (interruption === 'input') outside.focus()
        else if (interruption === 'pointer') outside.dispatchEvent(new window.Event('pointerdown', { bubbles: true }))
        else {
          const modal = document.createElement('div'); modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true')
          document.body.append(modal)
        }
      })
      await act(async () => pending.resolve(false))
      assertFocused(document, interruption === 'input' ? outside : document.body)
      assert.equal(document.querySelector('.webdav-action-feedback')!.getAttribute('role'), 'alert')
    })
  }
})

test('an unmounted conflict cannot publish late failures or restore focus into its replacement version', async () => {
  for (const outcome of ['success', 'false', 'reject'] as const) {
    const old = deferred<boolean>()
    await withRenderer({ getWebDavSyncConflictDetails: async input => details(input) }, async ({ render, document, window }) => {
      await render(<ConflictCard key="old" conflict={conflict} isZh disabled={false} onResolve={() => old.promise} />)
      await open(document, window)
      await activate(button(document, '使用本地版本'))
      await render(<ConflictCard key="new" conflict={{ ...conflict, localHash: 'c'.repeat(64) }} isZh disabled={false}
        resolutionError="旧版本保存失败" onResolve={async () => true} />)
      const editor = document.createElement('input'); editor.id = 'current-editor'; document.body.append(editor); editor.focus()
      await act(async () => outcome === 'reject' ? old.reject(new Error('Old conflict failed')) : old.resolve(outcome === 'success'))
      assertFocused(document, editor)
      assert.equal(document.querySelector('.webdav-action-feedback[role]'), null)
      assert.equal(document.querySelector<HTMLDetailsElement>('.webdav-conflict-card')!.open, false)
      await open(document, window)
      assert.equal(button(document, '使用本地版本').disabled, false)
    })
  }
})

test('parent feedback ownership hides an old failure and allows a current failure before its detailed reason commits', async () => {
  const requests: Array<ReturnType<typeof deferred<boolean>>> = []
  const decide = () => { const pending = deferred<boolean>(); requests.push(pending); return pending.promise }
  await withRenderer({ getWebDavSyncConflictDetails: async input => details(input) }, async ({ render, document, window }) => {
    await render(<ConflictCard conflict={conflict} isZh disabled={false} resolutionFeedbackActive onResolve={decide} />)
    await open(document, window)
    const local = button(document, '使用本地版本')
    await activate(local)
    await act(async () => requests[0].resolve(false))
    assert.match(document.querySelector('.webdav-action-feedback[role="alert"]')!.textContent!, /无法保存处理方案/)
    await render(<ConflictCard conflict={conflict} isZh disabled={false} resolutionFeedbackActive onResolve={decide} resolutionError="当前目录只读。" />)
    assert.equal(document.querySelector('.webdav-action-feedback[role="alert"]')!.textContent, '当前目录只读。')
    await render(<ConflictCard conflict={conflict} isZh disabled={false} resolutionFeedbackActive={false} onResolve={decide} resolutionError="当前目录只读。" />)
    assert.equal(document.querySelector('.webdav-action-feedback[role]'), null, 'A different parent action must hide the old card failure')
    await activate(local)
    assert.equal(document.querySelector('.webdav-action-feedback[role="status"]')!.textContent, '正在保存处理方案…', 'The local pending operation reports progress before parent ownership commits')
    await render(<ConflictCard conflict={conflict} isZh disabled={false} resolutionFeedbackActive onResolve={decide} />)
    await act(async () => requests[1].resolve(false))
    assert.match(document.querySelector('.webdav-action-feedback[role="alert"]')!.textContent!, /无法保存处理方案/)
    await render(<ConflictCard conflict={conflict} isZh disabled={false} resolutionFeedbackActive onResolve={decide} resolutionError="稍后到达的失败原因。" />)
    assert.equal(document.querySelector('.webdav-action-feedback[role="alert"]')!.textContent, '稍后到达的失败原因。')
  })
})

test('same-frame failed resolution and parent ownership update retain the new local failure', async () => {
  let attempts = 0
  function Parent() {
    const [owned, setOwned] = useState(false)
    return <ConflictCard conflict={conflict} isZh={false} disabled={false} resolutionFeedbackActive={owned}
      onResolve={() => { attempts++; setOwned(true); return Promise.resolve(false) }} />
  }
  await withRenderer({ getWebDavSyncConflictDetails: async input => details(input) }, async ({ render, document, window }) => {
    await render(<Parent />)
    await open(document, window)
    assert.equal(document.querySelector('.webdav-action-feedback[role]'), null)
    await activate(button(document, 'Use local version'))
    assert.equal(attempts, 1)
    assert.equal(document.querySelector('.webdav-action-feedback[role="alert"]')!.textContent, 'Could not save the resolution. Retry.')
    assert.equal(document.querySelectorAll('.webdav-action-feedback[role]').length, 1)
    assertFocused(document, button(document, 'Use local version'))
  })
})
