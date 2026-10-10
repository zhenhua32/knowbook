import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import { expect, test, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { ASSISTANT_EVENT_SURFACES, type AssistantEvent, type AssistantSessionSummary } from '../src/shared/assistant-session'
import { listenOnFetchSafePort } from '../tests/helpers/http-server'
import { closeElectronApp, hasBuiltElectronApp, launchElectronApp, uiText, type ElectronAppContext } from './helpers/electron'

type Handler = (event: unknown, ...input: unknown[]) => unknown | Promise<unknown>
type ReadPage = { afterSeq: number; limit: number; count: number; firstSeq: number | null; lastSeq: number | null }
type ProbeGlobal = typeof globalThis & { __assistantPagination?: {
  reads: ReadPage[]; approvals: unknown[]; held: boolean; hold: boolean; release?: () => void
} }

const firstRequest = 'First request in the persisted long conversation.'
const firstReply = 'First completed reply retained before event 1000.'
const firstBoundaryReply = 'Final reply replaces both chunks across the first page boundary.'
const middleReply = 'Middle completed reply retained in the second event page.'
const secondBoundaryReply = 'Final reply replaces both chunks beside the second page boundary.'
const oldApprovalSummary = 'Already rejected approval before the first page boundary.'
const pendingApprovalSummary = 'Review this exact inert fixture after event 2000.'
const refreshReply = 'New persisted tail appeared after the long conversation refreshed.'
const rejectionReply = 'The requested fixture was rejected. No extension was activated.'
const initialLastSeq = 2006

function buildHistory(session: AssistantSessionSummary): AssistantEvent[] {
  const events: AssistantEvent[] = []
  const turnId = 'pagination-turn', date = '2026-10-10T02:00:00.000Z'
  const append = (type: AssistantEvent['type'], payload: Record<string, unknown>) => {
    const seq = events.length + 2
    events.push({ id: `pagination-event-${seq}`, sessionId: session.id, seq, type,
      surface: ASSISTANT_EVENT_SURFACES[type], payload, createdAt: date } as AssistantEvent)
  }
  const text = (type: 'assistant.chunk' | 'assistant.message', stepId: string, value: string) => append(type, { turnId, stepId, text: value })
  const tool = (toolCallId: string, stepId: string, name: string) => append('tool.call', {
    turnId, stepId, toolCallId, tool: name, version: 1,
    arguments: name === 'workspace.search' ? { query: 'inert pagination fixture' } : { pluginId: 'pagination-inert', revisionId: `${toolCallId}-revision` }
  })
  const run = (toolCallId: string) => append('plugin.run.requested', {
    turnId, toolCallId, pluginId: 'pagination-inert', revisionId: `${toolCallId}-revision`, runId: `${toolCallId}-run`, operation: 'activate'
  })
  const approval = (toolCallId: string, approvalId: string, summary: string) => append('approval.requested', {
    turnId, toolCallId, approvalId, pluginId: 'pagination-inert', revisionId: `${toolCallId}-revision`,
    scope: { kind: 'session', workspaceId: session.workspaceId, sessionId: session.id },
    permissions: [], summary, risk: 'low', expiresAt: '2099-01-01T00:00:00.000Z',
    revisionPreview: { changes: 'Inert fixture. Rejecting does not install or execute a plugin.' }
  })
  append('turn.started', { turnId })
  append('user.message', { turnId, text: firstRequest })
  append('step.started', { turnId, stepId: 'first-stream', provider: 'openai-compatible', model: 'pagination-fixture', visibleTools: [] })
  while (events.length + 2 < 996) text('assistant.chunk', 'first-stream', 'first provisional chunk ')
  text('assistant.message', 'first-stream', firstReply) // 996
  tool('old-activation', 'old-activation-step', 'plugins.activate_revision') // 997
  run('old-activation') // 998
  approval('old-activation', 'old-approval', oldApprovalSummary) // 999
  text('assistant.chunk', 'first-boundary', 'first boundary provisional start ') // 1000
  text('assistant.chunk', 'first-boundary', 'first boundary provisional continuation ') // 1001
  text('assistant.message', 'first-boundary', firstBoundaryReply) // 1002
  append('approval.resolved', { approvalId: 'old-approval', decision: 'rejected' }) // 1003
  append('tool.result', { turnId, stepId: 'old-activation-step', toolCallId: 'old-activation', status: 'failed', result: { status: 'rejected' } }) // 1004
  append('step.started', { turnId, stepId: 'middle-stream', provider: 'openai-compatible', model: 'pagination-fixture', visibleTools: [] }) // 1005
  while (events.length + 2 < 1997) text('assistant.chunk', 'middle-stream', 'middle provisional chunk ')
  text('assistant.message', 'middle-stream', middleReply) // 1997
  text('assistant.chunk', 'second-boundary', 'second boundary provisional start ') // 1998
  text('assistant.chunk', 'second-boundary', 'second boundary provisional continuation ') // 1999
  tool('boundary-search', 'second-boundary', 'workspace.search') // 2000
  text('assistant.message', 'second-boundary', secondBoundaryReply) // 2001
  append('tool.result', { turnId, stepId: 'second-boundary', toolCallId: 'boundary-search', status: 'succeeded', result: { documents: [] } }) // 2002
  tool('pending-activation', 'pending-activation-step', 'plugins.activate_revision') // 2003
  run('pending-activation') // 2004
  approval('pending-activation', 'pending-approval', pendingApprovalSummary) // 2005
  append('step.ended', { turnId, stepId: 'pending-activation-step', status: 'awaiting-approval' }) // 2006
  expect(events.at(-1)?.seq).toBe(initialLastSeq)
  return events
}

async function seedHistory(app: ElectronApplication, session: AssistantSessionSummary): Promise<void> {
  const rows = buildHistory(session).map(event => ({ id: event.id, seq: event.seq, type: event.type, surface: event.surface,
    turnId: 'turnId' in event.payload ? String(event.payload.turnId) : null,
    stepId: 'stepId' in event.payload ? String(event.payload.stepId) : null,
    payloadJson: JSON.stringify(event.payload), createdAt: event.createdAt }))
  await app.evaluate(({ app }, { sessionId, rows }) => {
    const { createRequire } = process.getBuiltinModule('node:module')!, { join } = process.getBuiltinModule('node:path')!
    const Database = createRequire(join(app.getAppPath(), 'package.json'))('better-sqlite3')
    const database = new Database(join(app.getPath('userData'), 'storage', 'knowbook.db'), { fileMustExist: true })
    try {
      database.transaction(() => {
        const insert = database.prepare('INSERT INTO assistant_events (id, session_id, seq, type, surface, turn_id, step_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        for (const row of rows) {
          insert.run(row.id, sessionId, row.seq, row.type, row.surface, row.turnId, row.stepId, row.payloadJson, row.createdAt)
        }
        database.prepare('UPDATE assistant_sessions SET active_turn_id = ?, next_seq = ?, updated_at = ? WHERE id = ?')
          .run('pagination-turn', rows.at(-1)!.seq + 1, rows.at(-1)!.createdAt, sessionId)
      })()
    } finally { database.close() }
  }, { sessionId: String(session.id), rows })
}

async function installReadProbe(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const probe = { reads: [] as ReadPage[], approvals: [] as unknown[], held: false, hold: true, release: undefined as (() => void) | undefined }
    ;(globalThis as ProbeGlobal).__assistantPagination = probe
    const original = handlers.get('knowbook:get-assistant-session-events')!
    ipcMain.removeHandler('knowbook:get-assistant-session-events')
    ipcMain.handle('knowbook:get-assistant-session-events', async (event, ...input: unknown[]) => {
      const records = await original(event, ...input) as AssistantEvent[]
      const afterSeq = Number(input[1] ?? 0), limit = Number(input[2] ?? 500)
      probe.reads.push({ afterSeq, limit, count: records.length, firstSeq: records[0]?.seq ?? null, lastSeq: records.at(-1)?.seq ?? null })
      if (probe.hold && afterSeq === 1000) {
        probe.hold = false; probe.held = true
        await new Promise<void>(resolve => { probe.release = resolve })
      }
      return records
    })
    const resolve = handlers.get('knowbook:resolve-assistant-approval')!
    ipcMain.removeHandler('knowbook:resolve-assistant-approval')
    ipcMain.handle('knowbook:resolve-assistant-approval', (event, ...input: unknown[]) => {
      probe.approvals.push(structuredClone(input)); return resolve(event, ...input)
    })
  })
}

async function openExtension(page: Page): Promise<void> {
  await page.locator('[data-page-id="ai"]').click()
  await page.getByRole('tab', { name: uiText('App extension assistant', '应用扩展助手'), exact: true }).click()
  await expect(page.locator('.assistant-transcript')).toBeVisible()
}

async function expectCompleteHistory(page: Page, appended = false): Promise<void> {
  const messages = page.locator('.assistant-message')
  await expect(messages).toHaveCount(appended ? 6 : 5)
  await expect(messages.nth(0)).toContainText(firstRequest)
  for (const [index, value] of [firstReply, firstBoundaryReply, middleReply, secondBoundaryReply].entries()) await expect(messages.nth(index + 1)).toContainText(value)
  await expect(page.locator('.assistant-transcript')).not.toContainText('provisional')
  await expect(page.locator('.assistant-tool-event')).toHaveCount(3)
  await expect(page.locator('.assistant-tool-event').nth(0)).toContainText(/failed|失败/)
  await expect(page.locator('.assistant-tool-event').nth(1)).toContainText('workspace.search')
  await expect(page.locator('.assistant-tool-event').nth(1)).toContainText(/succeeded|已完成/)
  await expect(page.locator('.assistant-tool-event').nth(2)).toContainText('plugins.activate_revision')
  await expect(page.locator('.assistant-approval')).toHaveCount(1)
  await expect(page.locator('.assistant-approval')).toContainText(pendingApprovalSummary)
  await expect(page.locator('.assistant-transcript')).not.toContainText(oldApprovalSummary)
  if (appended) await expect(messages.last()).toContainText(refreshReply)
}

async function appendTail(app: ElectronApplication, session: AssistantSessionSummary): Promise<void> {
  await app.evaluate(({ app, BrowserWindow }, { sessionId, text }) => {
    const { createRequire } = process.getBuiltinModule('node:module')!, { join } = process.getBuiltinModule('node:path')!
    const Database = createRequire(join(app.getAppPath(), 'package.json'))('better-sqlite3')
    const database = new Database(join(app.getPath('userData'), 'storage', 'knowbook.db'), { fileMustExist: true })
    const seq = 2007, createdAt = '2026-10-10T02:01:00.000Z'
    try {
      database.transaction(() => {
        database.prepare('INSERT INTO assistant_events (id, session_id, seq, type, surface, turn_id, step_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run('pagination-tail', sessionId, seq, 'assistant.message', 'conversation', 'pagination-turn', 'tail-step',
            JSON.stringify({ turnId: 'pagination-turn', stepId: 'tail-step', text }), createdAt)
        database.prepare('UPDATE assistant_sessions SET next_seq = ?, updated_at = ? WHERE id = ?').run(seq + 1, createdAt, sessionId)
      })()
    } finally { database.close() }
    BrowserWindow.getAllWindows()[0].webContents.send('knowbook:assistant-session-changed', { sessionId, lastSeq: seq })
  }, { sessionId: String(session.id), text: refreshReply })
}

async function readStored(app: ElectronApplication, sessionId: string) {
  return app.evaluate(({ app }, sessionId) => {
    const { createRequire } = process.getBuiltinModule('node:module')!, { join } = process.getBuiltinModule('node:path')!
    const Database = createRequire(join(app.getAppPath(), 'package.json'))('better-sqlite3')
    const database = new Database(join(app.getPath('userData'), 'storage', 'knowbook.db'), { readonly: true, fileMustExist: true })
    try {
      return { session: database.prepare('SELECT * FROM assistant_sessions WHERE id = ?').get(sessionId),
        events: database.prepare('SELECT * FROM assistant_events WHERE session_id = ? ORDER BY seq').all(sessionId) as Array<{ seq: number; type: string; payload_json: string }> }
    } finally { database.close() }
  }, sessionId)
}

async function recordBackground(context: ElectronAppContext, info: TestInfo, phase: string, width: number): Promise<void> {
  const state = await context.app.evaluate(({ app, BrowserWindow }) => ({ userData: app.getPath('userData'),
    windows: BrowserWindow.getAllWindows().map(window => ({ bounds: window.getContentBounds(), visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() })) }))
  expect(state.userData).toBe(context.tempRoot)
  expect(state.windows).toHaveLength(1)
  expect(state.windows[0]).toMatchObject({ visible: false, focused: false, focusable: false, bounds: { width, height: 760 } })
  expect(await context.page.evaluate(() => ({ width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth - innerWidth })))
    .toMatchObject({ width, height: 760, overflow: 0 })
  const path = info.outputPath(`${phase}-background.json`)
  writeFileSync(path, JSON.stringify(state, null, 2)); await info.attach(`${phase}-background`, { path, contentType: 'application/json' })
  await context.page.screenshot({ path: info.outputPath(`${phase}.png`) })
}

for (const scenario of [{ language: 'en-US', theme: 'light', width: 1280 }, { language: 'zh-CN', theme: 'dark', width: 760 }] as const) {
  test(`assistant restores and refreshes all persisted event pages without reviving resolved approvals (${scenario.language}) @electron`, async ({}, info) => {
    test.setTimeout(120_000)
    test.skip(!hasBuiltElectronApp(), 'Requires a built Electron app')
    const requests: Array<{ model?: string; messages?: unknown[] }> = []
    const server = createServer((request, response) => {
      let body = ''; request.setEncoding('utf8'); request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
          response.writeHead(404); response.end('Unsupported fixture route'); return
        }
        requests.push(JSON.parse(body)); response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: rejectionReply }, finish_reason: 'stop' }] }))
      })
    })
    const port = await listenOnFetchSafePort(server)
    let context: ElectronAppContext | null = null
    try {
      context = await launchElectronApp({ PLAYWRIGHT_ELECTRON_LOCALE: scenario.language, KNOWBOOK_SYSTEM_PLUGIN_SAFE_MODE: '1' })
      let { app, page } = context
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 760), scenario.width)
      await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([scenario.width, 760])
      const session = await page.evaluate(async ({ language, theme, baseUrl }) => {
        await window.knowbook.saveSetting('ui.language', language); await window.knowbook.saveSetting('appearance.theme', theme)
        await window.knowbook.updateAiConfig({ enabled: true, apiKey: 'pagination-inert-key', baseUrl, model: 'pagination-fixture', autoSummaryOnSave: false, relatedNotesEnabled: false })
        return window.knowbook.createAssistantSession({ title: 'Persisted pagination fixture' })
      }, { ...scenario, baseUrl: `http://127.0.0.1:${port}/v1` })
      await seedHistory(app, session); await installReadProbe(app)
      const seeded = await readStored(app, session.id)
      expect(seeded.events).toHaveLength(initialLastSeq)
      await page.reload(); await openExtension(page)
      await expect(page.locator('html')).toHaveAttribute('data-theme', scenario.theme)
      await expect(page.locator('.assistant-session-select')).toHaveAttribute('aria-label', scenario.language === 'zh-CN' ? '助手对话' : 'Assistant session')
      await expect.poll(() => app.evaluate(() => (globalThis as ProbeGlobal).__assistantPagination!.held)).toBe(true)
      // A complete projection must wait for subsequent pages. In particular,
      // page 1 contains an approval whose rejection is persisted in page 2.
      await expect(page.locator('.assistant-message, .assistant-tool-event, .assistant-approval')).toHaveCount(0)
      await app.evaluate(() => (globalThis as ProbeGlobal).__assistantPagination!.release!())
      await expectCompleteHistory(page)
      expect(await app.evaluate(() => (globalThis as ProbeGlobal).__assistantPagination!.reads.slice(0, 3))).toEqual([
        { afterSeq: 0, limit: 1000, count: 1000, firstSeq: 1, lastSeq: 1000 },
        { afterSeq: 1000, limit: 1000, count: 1000, firstSeq: 1001, lastSeq: 2000 },
        { afterSeq: 2000, limit: 1000, count: 6, firstSeq: 2001, lastSeq: initialLastSeq }
      ])
      expect(await readStored(app, session.id)).toEqual(seeded)
      await expect(page.locator('.assistant-approval')).toBeInViewport({ ratio: 1 })
      await recordBackground(context, info, 'complete-persisted-history', scenario.width)

      await appendTail(app, session); await expectCompleteHistory(page, true)
      const afterRefresh = await readStored(app, session.id)
      expect(afterRefresh.events.slice(0, initialLastSeq)).toEqual(seeded.events)
      expect(afterRefresh.events.at(-1)).toMatchObject({ seq: 2007, type: 'assistant.message' })
      expect(await app.evaluate(() => (globalThis as ProbeGlobal).__assistantPagination!.reads.slice(3))).toEqual([
        { afterSeq: 2006, limit: 1000, count: 1, firstSeq: 2007, lastSeq: 2007 }
      ])
      const reject = page.locator('.assistant-approval').getByRole('button', { name: uiText('Reject', '拒绝'), exact: true })
      await page.getByRole('tab', { name: uiText('App extension assistant', '应用扩展助手'), exact: true }).click()
      for (let index = 0; index < 20 && !await reject.evaluate(element => element === document.activeElement); index++) await page.keyboard.press('Tab')
      await expect(reject).toBeFocused(); await expect(reject).toBeInViewport({ ratio: 1 }); await page.keyboard.press('Enter')
      await expect.poll(async () => {
        try { return await app.evaluate(() => (globalThis as ProbeGlobal).__assistantPagination!.approvals) }
        catch (error) {
          // Retry only this read-only inspector observation. The keyboard
          // action and real approval IPC must still occur exactly once.
          if (!(error instanceof Error)
            || error.message !== 'electronApplication.evaluate: Execution context was destroyed, most likely because of a navigation.') throw error
          return null
        }
      }).toEqual([
        [{ sessionId: session.id, approvalId: 'pending-approval', decision: 'rejected' }]
      ])
      await expect(page.locator('.assistant-approval')).toHaveCount(0)
      await expect(page.locator('.assistant-message').last()).toContainText(rejectionReply)
      await expect(page.getByRole('button', { name: uiText('Cancel turn', '取消当前任务'), exact: true })).toHaveCount(0)
      await expect(page.locator('.assistant-tool-event').last()).toContainText(/failed|失败/)
      expect(requests).toHaveLength(1); expect(requests[0].model).toBe('pagination-fixture')
      const providerHistory = JSON.stringify(requests[0].messages)
      for (const value of [firstRequest, firstReply, firstBoundaryReply, middleReply, secondBoundaryReply, refreshReply, 'pending-activation', 'rejected']) expect(providerHistory).toContain(value)
      const completed = await readStored(app, session.id)
      expect(completed.events.slice(0, 2007)).toEqual(afterRefresh.events)
      expect(completed.events.filter(event => event.type === 'approval.resolved').map(event => JSON.parse(event.payload_json)))
        .toEqual([{ approvalId: 'old-approval', decision: 'rejected' }, { approvalId: 'pending-approval', decision: 'rejected' }])
      expect(completed.events.filter(event => event.type === 'plugin.run.started')).toEqual([])
      expect(completed.events.at(-1)?.type).toBe('turn.ended')
      await recordBackground(context, info, 'native-keyboard-rejection', scenario.width)

      const tempRoot = context.tempRoot
      await closeElectronApp(context, { preserveUserData: true }); context = null
      context = await launchElectronApp({ PLAYWRIGHT_ELECTRON_LOCALE: scenario.language, KNOWBOOK_SYSTEM_PLUGIN_SAFE_MODE: '1' }, { userDataRoot: tempRoot })
      ;({ app, page } = context)
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 760), scenario.width)
      await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([scenario.width, 760])
      await openExtension(page)
      await expect(page.locator('html')).toHaveAttribute('data-theme', scenario.theme)
      await expect(page.locator('.assistant-session-select')).toHaveAttribute('aria-label', scenario.language === 'zh-CN' ? '助手对话' : 'Assistant session')
      await expect(page.locator('.assistant-message')).toHaveCount(7)
      await expect(page.locator('.assistant-message').first()).toContainText(firstRequest)
      await expect(page.locator('.assistant-message').nth(1)).toContainText(firstReply)
      await expect(page.locator('.assistant-message').nth(2)).toContainText(firstBoundaryReply)
      await expect(page.locator('.assistant-message').nth(4)).toContainText(secondBoundaryReply)
      await expect(page.locator('.assistant-message').nth(5)).toContainText(refreshReply)
      await expect(page.locator('.assistant-message').last()).toContainText(rejectionReply)
      await expect(page.locator('.assistant-approval')).toHaveCount(0)
      await expect(page.locator('.assistant-tool-event')).toHaveCount(3)
      await expect(page.locator('.assistant-tool-event').nth(1)).toContainText(/succeeded|已完成/)
      await expect(page.locator('.assistant-tool-event').last()).toContainText(/failed|失败/)
      expect(await readStored(app, session.id)).toEqual(completed)
      expect(requests).toHaveLength(1)
      await recordBackground(context, info, 'reopened-complete-history', scenario.width)
    } finally {
      await closeElectronApp(context)
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })
}
