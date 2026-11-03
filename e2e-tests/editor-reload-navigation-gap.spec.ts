import { expect, test } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import type { Input, OnBeforeRequestListenerDetails, WebContents } from 'electron'
import type { DocumentDetail, UpdateDocumentInput } from '../src/shared/contracts'
import type { EditorCloseRequest } from '../src/shared/editor-close'
import { hasBuiltElectronApp, waitForBuiltinPluginReadiness } from './helpers/electron'
import { withElectronFailureTrace } from './helpers/electron-failure-trace'

type HeldResource = { id: number; url: string; resourceType: string; webContentsId: number; timestamp: number }
type Navigation = { url: string; inPlace: boolean; mainFrame: boolean; processId: number; routingId: number; sequence: number }
type OldFrameState = { captured: { processId: number; routingId: number; frameTreeNodeId: number }; destroyed: boolean;
  detached: boolean | null; current: boolean; error: string | null }
type GapSnapshot = { targetUrl: string; webContentsId: number; held: HeldResource | null; released: boolean; finished: number;
  starts: Navigation[]; observedMainResources: Array<{ url: string; webContentsId: number | null }>;
  inputs: Array<{ type: string; key: string; code: string }>;
  oldFrame: OldFrameState; oldRealmExecution: { state: 'not-started' | 'running' | 'completed' | 'failed' | 'timed-out'; error: string | null };
  gapReady: boolean; events: Array<{ kind: string; sequence: number }> }
type GapProbe = { snapshot: () => GapSnapshot; release: () => void; cleanup: () => void; executeOldRealm: (source: string) => Promise<unknown> }
type MainGlobal = typeof globalThis & { __editorReloadNavigationGap?: GapProbe }
type OldRealm = Window & { __editorReloadGapRealm?: string }
type OldRealmAttempt = { marker: string; inertBefore: boolean; inertAfter: boolean; succeeded: boolean;
  rejection: string | null; persisted: DocumentDetail | null }

async function within<T>(operation: Promise<T>, label: string, milliseconds = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(Error(`${label} exceeded its ${milliseconds}ms fixture budget`)), milliseconds)
    })])
  } finally { if (timer) clearTimeout(timer) }
}

async function installMainResourceHold(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    const globals = globalThis as MainGlobal
    if (globals.__editorReloadNavigationGap) throw Error('A reload gap resource hold is already installed')
    const window = BrowserWindow.getAllWindows()[0]
    if (!window || window.isDestroyed()) throw Error('The actual registered editor window is absent')
    const contents: WebContents = window.webContents, targetUrl = contents.getURL().split('#')[0]
    if (!targetUrl.startsWith('file://')) throw Error('This resource-gap fixture requires the current built file renderer')
    // Keep the actual pre-navigation WebFrameMain. Looking it up again after
    // navigation, or using Playwright page.evaluate, can wait for the next realm.
    const oldFrame = contents.mainFrame
    const captured = { processId: oldFrame.processId, routingId: oldFrame.routingId, frameTreeNodeId: oldFrame.frameTreeNodeId }
    const oldRealmExecution: GapSnapshot['oldRealmExecution'] = { state: 'not-started', error: null }
    const frameState = (): OldFrameState => {
      const state: OldFrameState = { captured, destroyed: oldFrame.isDestroyed(), detached: null, current: false, error: null }
      try {
        if (!state.destroyed) { state.detached = oldFrame.detached; state.current = contents.mainFrame === oldFrame }
      } catch (error) { state.error = String(error) }
      return state
    }
    const starts: Navigation[] = [], events: GapSnapshot['events'] = [], observedMainResources: GapSnapshot['observedMainResources'] = [], inputs: GapSnapshot['inputs'] = []
    let sequence = 0, held: HeldResource | null = null, callback: ((response: { cancel: boolean }) => void) | null = null
    let released = false, finished = 0
    const record = (kind: string) => events.push({ kind, sequence: ++sequence })
    const navigation = (_event: unknown, url: string, inPlace: boolean, mainFrame: boolean, processId: number, routingId: number) => {
      if (mainFrame && !inPlace && url.split('#')[0] === targetUrl) {
        record('real-did-start-navigation')
        starts.push({ url, inPlace, mainFrame, processId, routingId, sequence })
      }
    }
    const finish = () => { finished++; record('real-did-finish-load') }
    const input = (_event: unknown, value: Input) => { inputs.push({ type: value.type, key: value.key, code: value.code }) }
    const release = () => {
      const pending = callback
      if (!pending) return
      callback = null; released = true; record('real-resource-released')
      pending({ cancel: false })
    }
    const snapshot = (): GapSnapshot => ({ targetUrl, webContentsId: contents.id, held, released, finished,
      starts: structuredClone(starts), observedMainResources: structuredClone(observedMainResources), inputs: structuredClone(inputs), events: structuredClone(events),
      oldFrame: frameState(), oldRealmExecution: { ...oldRealmExecution },
      gapReady: held !== null && callback !== null && !released && finished === 0 && starts.length === 1 })
    const executeOldRealm = async (source: string): Promise<unknown> => {
      if (!snapshot().gapReady) throw Error('The genuine resource gap ended before the old-frame call')
      if (oldRealmExecution.state !== 'not-started') throw Error('The captured old-frame call must run exactly once')
      const state = frameState()
      if (state.destroyed || state.detached || !state.current || state.error) {
        throw Error(`The captured old frame is unavailable: ${JSON.stringify(state)}`)
      }
      let timer: ReturnType<typeof setTimeout> | undefined, timedOut = false
      oldRealmExecution.state = 'running'; record('real-old-frame-execution-started')
      try {
        const result = await Promise.race([oldFrame.executeJavaScript(source), new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            timedOut = true
            oldRealmExecution.state = 'timed-out'
            reject(Error('The captured old WebFrameMain could not execute in the genuine resource gap within 10000ms'))
          }, 10_000)
        })])
        oldRealmExecution.state = 'completed'; record('real-old-frame-execution-completed')
        return result
      } catch (error) {
        if (!timedOut) oldRealmExecution.state = 'failed'
        oldRealmExecution.error = String(error); record('real-old-frame-execution-failed')
        throw error
      } finally { if (timer) clearTimeout(timer) }
    }
    const beforeRequest = (details: OnBeforeRequestListenerDetails, next: (response: { cancel: boolean }) => void) => {
      const owner = details.webContentsId ?? details.webContents?.id ?? null
      if (details.resourceType === 'mainFrame') observedMainResources.push({ url: details.url, webContentsId: owner })
      if (held === null && details.resourceType === 'mainFrame' && owner === contents.id && details.url.split('#')[0] === targetUrl) {
        held = { id: details.id, url: details.url, resourceType: details.resourceType, webContentsId: owner, timestamp: details.timestamp }
        callback = next; record('real-main-resource-held')
        return
      }
      next({ cancel: false })
    }
    contents.on('did-start-navigation', navigation)
    contents.on('did-finish-load', finish)
    contents.on('before-input-event', input)
    // Only this isolated profile's real file main resource is delayed. Every
    // unrelated request is immediately passed to Chromium unchanged. No IPC,
    // Main business operation, preload READY, or close ACK is replaced.
    contents.session.webRequest.onBeforeRequest({ urls: ['file:///*'] }, beforeRequest)
    globals.__editorReloadNavigationGap = { snapshot, release, executeOldRealm, cleanup: () => {
      try { release() } finally {
        contents.session.webRequest.onBeforeRequest(null)
        contents.removeListener('did-start-navigation', navigation)
        contents.removeListener('did-finish-load', finish)
        contents.removeListener('before-input-event', input)
      }
    } }
  })
}

async function gapState(app: ElectronApplication): Promise<GapSnapshot> {
  return within(app.evaluate(() => {
    const probe = (globalThis as MainGlobal).__editorReloadNavigationGap
    if (!probe) throw Error('The real resource hold is absent')
    return probe.snapshot()
  }), 'Read the actual Main resource gap')
}

test.skip(!hasBuiltElectronApp(), 'Build the actual local Electron app before testing the reload navigation gap')

test('a real F5 keeps ordinary writes frozen from did-start-navigation through the held main resource until the new preload and DOM land @electron', async ({}, info) => {
  // Keep the original 60s/default retries/workers and hidden independent-profile
  // helper. If this Electron/file loader cannot hold the real resource after
  // navigation start, fail with its actual event evidence; never synthesize it.
  await withElectronFailureTrace(info, async context => {
    const { app, page } = context
    const initial = await page.evaluate(async () => {
      // Use the genuine ordinary capture producer, whose Main completion also
      // publishes the catalog refresh consumed by the actual document tree.
      const created = await window.knowbook.createQuickNote({ parentId: null, title: 'Reload gap ordinary document', content: 'Ordinary reload gap seed' })
      const blockId = crypto.randomUUID()
      await window.knowbook.updateDocument(created.id, { title: 'Reload gap ordinary document', summary: 'Original ordinary summary 中文🙂', blocks: [
        { id: blockId, type: 'paragraph', content: 'Original ordinary body remains until new READY', checked: false, depth: 0, parentBlockId: null }
      ] })
      const document = await window.knowbook.getDocumentDetail(created.id)
      if (!document) throw Error('The real ordinary fixture document is missing')
      return { document, blockId }
    })
    expect(initial.document.blocks.every(block => block.type !== 'synced-block')).toBe(true)
    // Enter the real Documents page and select the catalog-backed tree row.
    // No synthetic workspace event, forced navigation or private React state.
    const documentsPage = page.locator('[data-page-id="documents"]')
    await documentsPage.click()
    await expect(documentsPage).toHaveAttribute('aria-current', 'page')
    await page.locator('.tree-button', { hasText: initial.document.title }).first().click()
    await expect(page.locator('.document-header-title')).toHaveText(initial.document.title)
    const before = await page.evaluate(id => window.knowbook.getDocumentDetail(id), initial.document.id)
    expect(before).toEqual(initial.document)
    const marker = 'old-realm-' + initial.blockId, requests: EditorCloseRequest[] = [], prefix = '[reload-navigation-gap-request]'
    page.on('console', message => {
      if (message.text().startsWith(prefix)) requests.push(JSON.parse(message.text().slice(prefix.length)) as EditorCloseRequest)
    })
    await page.evaluate(({ marker, prefix }) => {
      ;(window as OldRealm).__editorReloadGapRealm = marker
      // Passive observation of the genuine old-realm drain request only.
      window.knowbook.onEditorCloseRequest(request => console.info(prefix + JSON.stringify(request)))
    }, { marker, prefix })
    const pid = await app.evaluate(() => process.pid)
    const intended: UpdateDocumentInput = { expectedUpdatedAt: initial.document.updatedAt, title: initial.document.title,
      summary: 'The same ordinary write succeeds only after new preload READY', blocks: initial.document.blocks.map(({ sortOrder: _sortOrder, ...block }) => ({
        ...block, content: block.id === initial.blockId ? 'The same ordinary body write after admitted reload 中文🙂' : block.content
      })) }
    let failure: unknown, trigger: Promise<void> | null = null, loaded: Promise<unknown> | null = null
    let blocked: unknown, after: DocumentDetail | null = null
    await installMainResourceHold(app)
    try {
      // Send through Electron's actual keyboard input API. CDP page.keyboard
      // does not necessarily reach Main before-input-event in a hidden window.
      // No focus/show, synthetic emitter, direct reload call or forged ACK.
      trigger = app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]
        if (!window || window.isDestroyed()) throw Error('The real editor window is absent for F5 input')
        window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F5' })
        window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F5' })
      })
      trigger.catch(() => undefined)
      await expect.poll(async () => (await gapState(app)).gapReady, {
        message: 'The real file main resource must be held after one actual main-frame did-start-navigation, before load commit'
      }).toBe(true)
      const held = await gapState(app)
      expect(held.held).toMatchObject({ resourceType: 'mainFrame', webContentsId: held.webContentsId })
      expect(held.starts).toHaveLength(1)
      expect(held.starts[0]).toMatchObject({ mainFrame: true, inPlace: false })
      expect(held.finished).toBe(0)
      expect(held.released).toBe(false)
      expect(held.oldFrame).toMatchObject({ destroyed: false, detached: false, current: true, error: null })
      await expect.poll(() => requests.length).toBe(1)
      expect(requests[0].reason).toBe('reload')
      // Register the real landing event before any release. If the old-frame
      // RPC fails, finally still releases and awaits this same event promise.
      loaded = page.waitForEvent('domcontentloaded', { timeout: 20_000 })
      loaded.catch(() => undefined)
      const source = `(async ({ id, input, marker }) => {
        if (window.__editorReloadGapRealm !== marker) throw Error('The old JavaScript realm is no longer alive in the resource gap')
        const inertBefore = document.documentElement.inert
        let succeeded = false, rejection = null
        try { await window.knowbook.updateDocument(id, input); succeeded = true }
        catch (error) { rejection = error instanceof Error ? error.message : String(error) }
        return { marker: window.__editorReloadGapRealm, inertBefore, inertAfter: document.documentElement.inert,
          succeeded, rejection, persisted: await window.knowbook.getDocumentDetail(id) }
      })(${JSON.stringify({ id: initial.document.id, input: intended, marker })})`
      const attempt = await test.step('Call the real old-frame bridge while the actual main resource is held', () => within(
        app.evaluate((_electron, source) => {
          const probe = (globalThis as MainGlobal).__editorReloadNavigationGap
          if (!probe) throw Error('The real resource hold disappeared before the old-frame bridge call')
          return probe.executeOldRealm(source)
        }, source), 'The native captured old-frame RPC', 20_000
      )) as OldRealmAttempt
      blocked = attempt
      expect(attempt.marker).toBe(marker)
      expect(attempt.inertBefore).toBe(true); expect(attempt.inertAfter).toBe(true)
      expect(attempt.succeeded).toBe(false)
      expect(attempt.rejection).toMatch(/Editor writes are frozen after close acknowledgement/)
      expect(attempt.persisted).toEqual(before)
      expect((await gapState(app)).gapReady).toBe(true)

      await within(app.evaluate(() => (globalThis as MainGlobal).__editorReloadNavigationGap!.release()), 'Release the actual main resource')
      const landing = loaded; loaded = null
      await within(landing, 'The real DOM landing', 20_000)
      await within(trigger, 'The actual F5 input')
      await expect(page.getByTestId('shell')).toBeVisible()
      await waitForBuiltinPluginReadiness(context, { freshProfile: false })
      expect(await page.evaluate(() => (window as OldRealm).__editorReloadGapRealm ?? null)).toBeNull()
      // Preload sends its actual READY before exposing this new realm's API.
      // With no fixture READY or handler replacement, the original gate can
      // admit this identical write only after its real landing fence clears.
      after = await page.evaluate(async ({ id, input }) => {
        await window.knowbook.updateDocument(id, input)
        return window.knowbook.getDocumentDetail(id)
      }, { id: initial.document.id, input: intended })
      expect(after?.summary).toBe(intended.summary)
      expect(after?.blocks.find(block => block.id === initial.blockId)?.content).toBe(intended.blocks[0].content)
      expect(after?.blocks.map(block => block.id)).toEqual(initial.document.blocks.map(block => block.id))
      expect(after?.title).toBe(initial.document.title)
      expect(await app.evaluate(() => process.pid)).toBe(pid)
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
      const landed = await gapState(app)
      expect(landed.released).toBe(true)
      expect(landed.finished).toBeGreaterThanOrEqual(1)
      expect(landed.starts).toHaveLength(1)
    } catch (error) { failure = error; throw error }
    finally {
      let cleanupFailure: unknown
      try {
        // Release and remove the hook before awaiting diagnostics or landing.
        // In particular, a bounded old-frame RPC failure must not strand the
        // real navigation and make tracing or profile teardown wait forever.
        const cleanup = await within(app.evaluate(() => {
          const globals = globalThis as MainGlobal, probe = globals.__editorReloadNavigationGap
          if (!probe) return null
          let gap: GapSnapshot
          try { gap = probe.snapshot() }
          finally {
            try { probe.cleanup() } finally { delete globals.__editorReloadNavigationGap }
          }
          return { gap, afterCleanup: probe.snapshot() }
        }), 'Release and remove the actual resource interception')
        await info.attach('real-reload-navigation-gap', { body: Buffer.from(JSON.stringify({ before, intended, blocked, after,
          requests, gap: cleanup?.gap, afterCleanup: cleanup?.afterCleanup }, null, 2)), contentType: 'application/json' })
      } catch (cleanupError) {
        cleanupFailure = cleanupError
        await info.attach('reload-gap-cleanup-error', { body: String(cleanupError), contentType: 'text/plain' }).catch(() => undefined)
      } finally {
        try {
          if (loaded) {
            const landing = loaded; loaded = null
            await within(landing, 'The real DOM landing after resource cleanup', 20_000)
          }
          if (trigger) await within(trigger, 'The actual F5 input during cleanup')
        } catch (landingError) {
          cleanupFailure ??= landingError
          await info.attach('reload-gap-landing-error', { body: String(landingError), contentType: 'text/plain' }).catch(() => undefined)
        }
      }
      if (!failure && cleanupFailure) throw cleanupFailure
    }
  }, {}, { editorMode: 'markdown' })
})
