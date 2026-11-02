import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { CanonicalInlineSeed, CanonicalHostBody } from './canonical-inline-seed'
import type { EditorCloseRequest, EditorCloseCancelled } from '../../src/shared/editor-close'
import { closeElectronApp, launchElectronApp, uiText, type ElectronAppContext } from './electron'
import { setRichTextDomSelection } from './rich-text-selection'

const runFile = promisify(execFile)
const helperRoot = dirname(fileURLToPath(import.meta.url)), repoRoot = join(helperRoot, '..', '..')
const electronRoot = dirname(createRequire(import.meta.url).resolve('electron/package.json'))

export async function prepareCanonicalInlineProfile(): Promise<{ profile: string; seed: CanonicalInlineSeed }> {
  // This source-backed Main preparer is intentionally paired with the local
  // built app, not an arbitrary packaged executable with another schema/ABI.
  if (process.env.KNOWBOOK_E2E_EXECUTABLE?.trim()) throw new Error('Canonical inline seed requires the current local build; unset KNOWBOOK_E2E_EXECUTABLE')
  const profile = mkdtempSync(join(tmpdir(), 'knowbook-e2e-canonical-inline-'))
  const executable = join(electronRoot, 'dist', readFileSync(join(electronRoot, 'path.txt'), 'utf8').trim())
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', KNOWBOOK_USER_DATA_DIR: profile }
  delete env.ELECTRON_RENDERER_URL
  try {
    await runFile(executable, ['--import', 'tsx', join(helperRoot, 'canonical-inline-seed.ts'), profile], {
      cwd: repoRoot, env, windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8'
    })
    const seed = JSON.parse(readFileSync(join(profile, 'canonical-inline-seed.json'), 'utf8')) as CanonicalInlineSeed
    if (seed.version !== 1 || seed.hosts.length !== 2 || seed.instanceIds.length !== 3 || !seed.primaryId.includes('\0')) throw new Error('Incomplete actual Main seed metadata')
    return { profile, seed }
  } catch (error) {
    // Keep only a failed preparation's isolated profile for diagnosis. Nothing
    // is launched and no existing/live database is copied over or rewritten.
    throw new Error('Canonical preparation failed; retained profile: ' + profile, { cause: error })
  }
}

export async function withCanonicalInlineApp(info: TestInfo, run: (fixture: {
  context: () => ElectronAppContext; seed: CanonicalInlineSeed; restart: () => Promise<void>
}) => Promise<void>): Promise<void> {
  const { profile, seed } = await prepareCanonicalInlineProfile()
  let current: ElectronAppContext | null = null, failed = true
  await info.attach('canonical-inline-seed', { body: Buffer.from(JSON.stringify({ profile, seed }, null, 2)), contentType: 'application/json' })
  try {
    current = await launchElectronApp({}, { userDataRoot: profile, editorMode: 'markdown' })
    const context = () => { if (!current) throw new Error('The real Electron app is not running'); return current }
    await run({ seed, context, restart: async () => {
      const prior = context()
      await closeElectronApp(prior, { preserveUserData: true })
      current = null
      current = await launchElectronApp({}, { userDataRoot: profile, editorMode: 'markdown' })
    } })
    failed = false
  } finally {
    // The established helper owns hidden-window launch/process/profile cleanup.
    // It is only teardown, never the oracle for a blocked X/quit assertion.
    if (current) await closeElectronApp(current, { preserveUserData: failed })
  }
}

export function inlineInstance(page: Page, instanceId: string): Locator {
  if (!/^[a-f0-9-]{36}$/i.test(instanceId)) throw new Error('A real Main-issued instance UUID is required')
  // This is the actual public DOM island and the seeded real instance UUID.
  // Canonical child IDs are opaque and are never used in a CSS selector.
  return page.locator('.synced-inline-instance[data-synced-instance-id="' + instanceId + '"]')
}

export async function openInlineHost(page: Page, host: CanonicalHostBody): Promise<void> {
  await page.locator('.tree-button', { hasText: host.title }).first().click()
  await expect(page.locator('.document-header-title')).toHaveText(host.title)
}

export async function expectCanonicalRow(instance: Locator, blockId: string, content: string): Promise<void> {
  await expect(instance).toBeVisible()
  await expect.poll(() => instance.locator('[data-block-id]').evaluateAll((elements, id) => {
    const exact = elements.filter(element => (element as HTMLElement).dataset.blockId === id)
    return exact.map(element => element.textContent?.trim() ?? '')
  }, blockId)).toEqual([content])
}

export async function appendCanonicalText(page: Page, instanceId: string, blockId: string, before: string, suffix: string): Promise<void> {
  const instance = inlineInstance(page, instanceId)
  await expectCanonicalRow(instance, blockId, before)
  const body = instance.locator('.ProseMirror[contenteditable="true"]')
  await expect(body).toBeVisible()
  await body.evaluate(setRichTextDomSelection, { from: { blockId, offset: before.length } })
  // Native selectionchange reaches the actual PM view before trusted input.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  await page.keyboard.insertText(suffix)
  await expectCanonicalRow(instance, blockId, before + suffix)
}

export async function saveCanonical(page: Page, seed: CanonicalInlineSeed, instanceId: string, expected: string): Promise<void> {
  await inlineInstance(page, instanceId).getByRole('button', { name: uiText('Save / retry', '保存／重试'), exact: true }).click()
  await expect.poll(async () => {
    const actual = await page.evaluate(input => window.knowbook.resolveSyncedInlineInstance(input), {
      hostDocumentId: instanceId === seed.instanceIds[2] ? seed.hosts[1].id : seed.hosts[0].id, instanceId, groupId: seed.groupId
    })
    return actual.status === 'ready' ? actual.snapshot.blocks.find(block => block.id === seed.primaryId)?.content : null
  }).toBe(expected)
}

export async function expectHostReferencesUnchanged(page: Page, seed: CanonicalInlineSeed): Promise<void> {
  const actual = await page.evaluate(async ids => Promise.all(ids.map(async id => {
    const host = await window.knowbook.getDocumentDetail(id)
    if (!host) return null
    return { id: host.id, title: host.title, summary: host.summary, blocks: host.blocks.map(block => ({ id: block.id, type: block.type,
      content: block.content, checked: block.checked, depth: block.depth, parentBlockId: block.parentBlockId ?? null })) }
  })), seed.hosts.map(host => host.id))
  expect(actual).toEqual(seed.hosts)
  expect(actual.flatMap(host => host?.blocks ?? []).some(block => block.id === seed.primaryId || block.id === seed.secondaryId || block.content.includes(seed.query))).toBe(false)
}

export async function setInlineReading(page: Page, reading: boolean): Promise<void> {
  const toggle = page.locator('.document-navigation .document-view-toggle')
  await expect(toggle).toBeVisible()
  if (await toggle.getAttribute('aria-pressed') !== String(reading)) await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', String(reading))
}

export async function expectExactCanonicalFocus(page: Page, instanceId: string, blockId: string): Promise<void> {
  await expect.poll(() => inlineInstance(page, instanceId).evaluate((root, id) => {
    const row = [...root.querySelectorAll<HTMLElement>('[data-block-id]')].find(element => element.dataset.blockId === id)
    const active = root.ownerDocument.activeElement, selection = root.ownerDocument.getSelection()
    const node = selection?.anchorNode, element = node?.nodeType === Node.ELEMENT_NODE ? node as Element : node?.parentElement
    return Boolean(row?.classList.contains('block-editor-row-highlighted') && active && root.contains(active)
      && (row === active || row.contains(active) || element?.closest<HTMLElement>('[data-block-id]') === row))
  }, blockId)).toBe(true)
}

type CloseEvents = { requests: EditorCloseRequest[]; cancelled: EditorCloseCancelled[] }
type CloseProbeWindow = Window & { __canonicalInlineCloseProbe?: CloseEvents }
export async function observeRealEditorClose(page: Page): Promise<void> {
  await page.evaluate(() => {
    const events: CloseEvents = { requests: [], cancelled: [] }
    ;(window as CloseProbeWindow).__canonicalInlineCloseProbe = events
    // Passive observation only: no replacement bridge, forged events or ACKs.
    window.knowbook.onEditorCloseRequest(event => events.requests.push(event))
    window.knowbook.onEditorCloseCancelled(event => events.cancelled.push(event))
  })
}
export async function closeEvents(page: Page): Promise<CloseEvents> {
  return page.evaluate(() => {
    const events = (window as CloseProbeWindow).__canonicalInlineCloseProbe
    if (!events) throw new Error('The passive close probe was not installed')
    return events
  })
}

export async function assertRealCloseBlocked(context: ElectronAppContext, reason: 'window' | 'quit'): Promise<void> {
  const { page, app } = context, before = await closeEvents(page)
  await app.evaluate(({ app, BrowserWindow }, reason) => {
    if (reason === 'quit') app.quit()
    else {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win || win.isDestroyed()) throw new Error('No actual window remains for the X action')
      win.close()
    }
  }, reason)
  await expect.poll(async () => (await closeEvents(page)).cancelled.length).toBe(before.cancelled.length + 1)
  const after = await closeEvents(page), request = after.requests.at(-1)!, cancel = after.cancelled.at(-1)!
  expect(after.requests).toHaveLength(before.requests.length + 1)
  expect(request.reason).toBe(reason)
  expect(request.requestId).not.toBe(before.requests.at(-1)?.requestId)
  expect(cancel).toMatchObject({ requestId: request.requestId, reason })
  expect(cancel.message?.length).toBeGreaterThan(0)
  await expect.poll(() => page.evaluate(() => document.documentElement.inert)).toBe(false)
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(win => !win.isDestroyed()).length)).toBe(1)
}
