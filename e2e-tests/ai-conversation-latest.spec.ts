import { writeFileSync } from 'node:fs'
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { ASSISTANT_EVENT_SURFACES, type AssistantEvent, type AssistantSessionSummary } from '../src/shared/assistant-session'
import { hasBuiltElectronApp, uiText, withElectronApp, type ElectronAppContext } from './helpers/electron'

type FixtureRow = { type: AssistantEvent['type']; surface: string; turnId: string | null; stepId: string | null; payloadJson: string }
type ActionProbe = typeof globalThis & { __assistantLatestActions?: { sent: unknown[]; approvals: unknown[] } }

const longReplyCount = 28
const approvalSummary = 'This inert review must stay pending while navigating the conversation.'
const secondaryReply = 'This separate session has no unread update.'
const draft = 'Keep this unsent extension draft. 保留尚未发送的扩展需求。'

function fixtureRow(type: AssistantEvent['type'], payload: Record<string, unknown>): FixtureRow {
  return { type, surface: ASSISTANT_EVENT_SURFACES[type], turnId: typeof payload.turnId === 'string' ? payload.turnId : null,
    stepId: typeof payload.stepId === 'string' ? payload.stepId : null, payloadJson: JSON.stringify(payload) }
}

function historyRows(session: AssistantSessionSummary, long: boolean): FixtureRow[] {
  const turnId = `${session.id}-fixture-turn`
  const rows = [fixtureRow('turn.started', { turnId }), fixtureRow('user.message', { turnId, text: long
    ? 'A long persisted extension conversation, kept for reading history.' : 'A separate short conversation.' })]
  for (let index = 0; index < (long ? longReplyCount : 1); index++) {
    const stepId = `${session.id}-history-step-${index}`
    rows.push(fixtureRow('step.started', { turnId, stepId, provider: 'openai-compatible', model: 'latest-fixture', visibleTools: [] }))
    rows.push(fixtureRow('assistant.message', { turnId, stepId, text: long
      ? `### History entry ${index + 1}\n\nThe extension plan is recorded locally. Reading older decisions should stay comfortable when later updates arrive.\n\n- Review the requested behavior\n- Keep the user's reading position\n- Wait for explicit permission before activating an extension`
      : secondaryReply }))
    rows.push(fixtureRow('step.ended', { turnId, stepId, status: 'completed' }))
  }
  if (long) {
    const stepId = `${session.id}-review-step`, toolCallId = `${session.id}-inert-call`
    rows.push(fixtureRow('step.started', { turnId, stepId, provider: 'openai-compatible', model: 'latest-fixture', visibleTools: ['plugins.activate_revision'] }))
    rows.push(fixtureRow('tool.call', { turnId, stepId, toolCallId, tool: 'plugins.activate_revision', version: 1,
      arguments: { pluginId: 'latest-inert', revisionId: 'latest-inert-revision' } }))
    rows.push(fixtureRow('approval.requested', { turnId, toolCallId, approvalId: 'latest-inert-approval',
      pluginId: 'latest-inert', revisionId: 'latest-inert-revision', permissions: [], summary: approvalSummary,
      scope: { kind: 'session', workspaceId: session.workspaceId, sessionId: session.id }, risk: 'low',
      expiresAt: '2099-01-01T00:00:00.000Z' }))
    rows.push(fixtureRow('step.ended', { turnId, stepId, status: 'awaiting-approval' }))
  } else rows.push(fixtureRow('turn.ended', { turnId, status: 'completed' }))
  return rows
}

// Persist immutable events, then publish their actual committed high-water mark.
// All renderer session/event reads continue through the production preload and IPC.
async function appendEvents(app: ElectronApplication, sessionId: string, rows: FixtureRow[], activeTurnId?: string | null): Promise<number> {
  return app.evaluate(({ app, BrowserWindow }, input) => {
    const { createRequire } = process.getBuiltinModule('node:module')!, { join } = process.getBuiltinModule('node:path')!
    const Database = createRequire(join(app.getAppPath(), 'package.json'))('better-sqlite3')
    const database = new Database(join(app.getPath('userData'), 'storage', 'knowbook.db'), { fileMustExist: true })
    let lastSeq = 0
    try {
      database.transaction(() => {
        const session = database.prepare('SELECT next_seq FROM assistant_sessions WHERE id = ?').get(input.sessionId) as { next_seq: number }
        if (!session) throw new Error('Missing latest-navigation fixture session')
        let seq = session.next_seq
        const insert = database.prepare('INSERT INTO assistant_events (id, session_id, seq, type, surface, turn_id, step_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        for (const row of input.rows) {
          const createdAt = new Date(Date.UTC(2026, 9, 10, 0, 0, seq)).toISOString()
          insert.run(`${input.sessionId}-latest-event-${seq}`, input.sessionId, seq, row.type, row.surface, row.turnId, row.stepId, row.payloadJson, createdAt)
          seq++
        }
        lastSeq = seq - 1
        const updatedAt = new Date(Date.UTC(2026, 9, 10, 0, 0, lastSeq)).toISOString()
        database.prepare('UPDATE assistant_sessions SET next_seq = ?, updated_at = ? WHERE id = ?').run(seq, updatedAt, input.sessionId)
        if (input.activeTurnId !== undefined) database.prepare('UPDATE assistant_sessions SET active_turn_id = ? WHERE id = ?').run(input.activeTurnId, input.sessionId)
      })()
    } finally { database.close() }
    BrowserWindow.getAllWindows()[0].webContents.send('knowbook:assistant-session-changed', { sessionId: input.sessionId, lastSeq })
    return lastSeq
  }, { sessionId, rows, activeTurnId })
}

async function appendReply(app: ElectronApplication, sessionId: string, key: string, text: string): Promise<number> {
  return appendEvents(app, sessionId, [fixtureRow('assistant.message', { turnId: `${sessionId}-fixture-turn`, stepId: `${sessionId}-${key}`, text })])
}

async function readStored(app: ElectronApplication, sessionId: string) {
  return app.evaluate(({ app }, sessionId) => {
    const { createRequire } = process.getBuiltinModule('node:module')!, { join } = process.getBuiltinModule('node:path')!
    const Database = createRequire(join(app.getAppPath(), 'package.json'))('better-sqlite3')
    const database = new Database(join(app.getPath('userData'), 'storage', 'knowbook.db'), { readonly: true, fileMustExist: true })
    try {
      return { nextSeq: (database.prepare('SELECT next_seq FROM assistant_sessions WHERE id = ?').get(sessionId) as { next_seq: number }).next_seq,
        events: database.prepare('SELECT id, seq, type, payload_json FROM assistant_events WHERE session_id = ? ORDER BY seq').all(sessionId) as Array<{ id: string; seq: number; type: string; payload_json: string }> }
    } finally { database.close() }
  }, sessionId)
}

async function guardActions(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const actions = { sent: [] as unknown[], approvals: [] as unknown[] }
    ;(globalThis as ActionProbe).__assistantLatestActions = actions
    for (const [channel, records] of [
      ['knowbook:send-assistant-message', actions.sent], ['knowbook:resolve-assistant-approval', actions.approvals]
    ] as const) {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, (_event, input: unknown) => {
        records.push(structuredClone(input))
        throw new Error('Latest-navigation fixture must not send a message or resolve an approval')
      })
    }
  })
}

async function settleScroll(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function scrollState(transcript: Locator) {
  return transcript.evaluate(element => ({ top: element.scrollTop, height: element.clientHeight,
    bottom: element.scrollHeight - element.clientHeight - element.scrollTop, overflow: element.scrollWidth - element.clientWidth }))
}

async function readOlderMessages(page: Page, transcript: Locator): Promise<number> {
  const bounds = await transcript.boundingBox()
  expect(bounds).not.toBeNull()
  await page.mouse.move(bounds!.x + 12, bounds!.y + bounds!.height / 2)
  await page.mouse.wheel(0, -640)
  await expect.poll(async () => (await scrollState(transcript)).bottom).toBeGreaterThan(400)
  await settleScroll(page)
  const state = await scrollState(transcript)
  expect(state.top).toBeGreaterThan(0)
  return state.top
}

async function expectReadingPosition(transcript: Locator, readingTop: number): Promise<void> {
  await expect.poll(async () => Math.abs((await scrollState(transcript)).top - readingTop)).toBeLessThanOrEqual(1)
  expect((await scrollState(transcript)).bottom).toBeGreaterThan(100)
}

async function recordLayout(context: ElectronAppContext, info: TestInfo, phase: string, width: number, latest?: Locator): Promise<void> {
  const native = await context.app.evaluate(({ app, BrowserWindow }) => ({ userData: app.getPath('userData'),
    windows: BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible(), focused: window.isFocused(),
      focusable: window.isFocusable(), bounds: window.getContentBounds() })) }))
  expect(native.userData).toBe(context.tempRoot)
  expect(native.windows).toHaveLength(1)
  expect(native.windows[0]).toMatchObject({ visible: false, focused: false, focusable: false, bounds: { width, height: 760 } })
  expect(await context.page.evaluate(() => ({ width: innerWidth, height: innerHeight,
    overflow: document.documentElement.scrollWidth - innerWidth }))).toEqual({ width, height: 760, overflow: 0 })
  await expect(context.page.locator('.assistant-composer textarea')).toBeInViewport({ ratio: 1 })
  await expect(context.page.locator('.assistant-composer-hint')).toBeInViewport({ ratio: 1 })
  await expect(context.page.locator('.assistant-session-select')).toBeInViewport({ ratio: 1 })
  expect((await scrollState(context.page.locator('.assistant-transcript'))).overflow).toBeLessThanOrEqual(1)
  if (latest) {
    await expect(latest).toBeInViewport({ ratio: 1 })
    expect(await latest.evaluate(button => {
      const bounds = button.getBoundingClientRect(), target = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
      const composer = document.querySelector('.assistant-composer')!.getBoundingClientRect()
      return { reachable: target === button || button.contains(target), height: bounds.height, aboveComposer: bounds.bottom <= composer.top }
    })).toMatchObject({ reachable: true, aboveComposer: true })
    expect((await latest.boundingBox())!.height).toBeGreaterThanOrEqual(36)
  }
  const path = info.outputPath(`${phase}-background.json`)
  writeFileSync(path, JSON.stringify(native, null, 2)); await info.attach(`${phase}-background`, { path, contentType: 'application/json' })
  await context.page.screenshot({ path: info.outputPath(`${phase}.png`) })
}

for (const scenario of [{ language: 'en-US', theme: 'light', width: 1280 }, { language: 'zh-CN', theme: 'dark', width: 760 }] as const) {
  test(`assistant latest navigation preserves historical reading and drafts across updates and sessions (${scenario.language}) @electron`, async ({}, info) => {
    test.setTimeout(120_000)
    test.skip(!hasBuiltElectronApp(), 'Requires a built Electron app')
    await withElectronApp(async context => {
      const { app, page } = context
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 760), scenario.width)
      await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([scenario.width, 760])
      const sessions = await page.evaluate(async ({ language, theme }) => {
        await window.knowbook.saveSetting('ui.language', language); await window.knowbook.saveSetting('appearance.theme', theme)
        await window.knowbook.updateAiConfig({ enabled: true, apiKey: 'latest-inert-key', baseUrl: 'https://example.invalid/v1',
          model: 'latest-fixture', autoSummaryOnSave: false, relatedNotesEnabled: false })
        return { primary: await window.knowbook.createAssistantSession({ title: 'Read this long history' }),
          secondary: await window.knowbook.createAssistantSession({ title: 'Separate short session' }) }
      }, scenario)
      await appendEvents(app, sessions.primary.id, historyRows(sessions.primary, true), `${sessions.primary.id}-fixture-turn`)
      await appendEvents(app, sessions.secondary.id, historyRows(sessions.secondary, false), null)
      const original = await readStored(app, sessions.primary.id)
      await guardActions(app)
      await page.reload()
      await page.locator('[data-page-id="ai"]').click()
      const extension = page.getByRole('tab', { name: uiText('App extension assistant', '应用扩展助手'), exact: true })
      const document = page.getByRole('tab', { name: uiText('Document AI assistant', '文档智能助手'), exact: true })
      await extension.click()
      const selector = page.locator('.assistant-session-select'), transcript = page.locator('.assistant-transcript')
      const composer = page.locator('.assistant-composer textarea')
      const jump = page.getByRole('button', { name: uiText('Jump to latest', '回到最新'), exact: true })
      const unread = page.getByRole('button', { name: uiText('New content · Jump to latest', '有新内容 · 回到最新'), exact: true })
      const latestStatus = page.locator('.assistant-latest-status')
      await selector.selectOption(sessions.primary.id)
      await expect(page.locator('html')).toHaveAttribute('data-theme', scenario.theme)
      await expect(selector).toHaveAttribute('aria-label', scenario.language === 'zh-CN' ? '助手对话' : 'Assistant session')
      await expect(page.locator('.assistant-message')).toHaveCount(longReplyCount + 1)
      await expect(page.locator('.assistant-approval')).toContainText(approvalSummary)
      await expect.poll(async () => (await scrollState(transcript)).bottom).toBeLessThanOrEqual(1)
      await expect(jump).not.toBeVisible(); await expect(unread).not.toBeVisible()
      await composer.fill(draft)
      await recordLayout(context, info, 'initial-pinned', scenario.width)

      const readingTop = await readOlderMessages(page, transcript)
      await expect(jump).toBeVisible(); await expect(unread).not.toBeVisible()
      await recordLayout(context, info, 'reading-history', scenario.width, jump)
      const firstUpdate = 'Visible update stays below the historical reading position.'
      await appendReply(app, sessions.primary.id, 'visible-update', firstUpdate)
      await expect(page.locator('.assistant-message').last()).toContainText(firstUpdate)
      await expectReadingPosition(transcript, readingTop)
      await expect(unread).toBeVisible(); await expect(jump).not.toBeVisible()
      await expect(latestStatus).toHaveAttribute('role', 'status')
      await expect(latestStatus).toHaveText(scenario.language === 'zh-CN' ? '有新内容' : 'New content')
      await expect(composer).toHaveValue(draft)
      await recordLayout(context, info, 'new-content-while-reading', scenario.width, unread)

      // Return through native keyboard navigation from the historical transcript.
      // Enter must activate this button without submitting that draft or an approval.
      const transcriptBounds = await transcript.boundingBox()
      await transcript.click({ position: { x: 12, y: transcriptBounds!.height / 2 } })
      await expect(transcript).toBeFocused()
      await page.keyboard.press('Shift+Tab')
      await expect(unread).toBeFocused(); await page.keyboard.press('Enter')
      await expect.poll(async () => (await scrollState(transcript)).bottom).toBeLessThanOrEqual(1)
      await expect(unread).not.toBeVisible(); await expect(jump).not.toBeVisible()
      await expect(latestStatus).toHaveText('')
      await expect(transcript).toBeFocused()
      await expect(composer).toHaveValue(draft)
      const followingUpdate = 'Following resumes after the user returns to the latest content.'
      await appendReply(app, sessions.primary.id, 'following-update', followingUpdate)
      await expect(page.locator('.assistant-message').last()).toContainText(followingUpdate)
      await expect.poll(async () => (await scrollState(transcript)).bottom).toBeLessThanOrEqual(1)
      await expect(unread).not.toBeVisible()

      const hiddenReadingTop = await readOlderMessages(page, transcript)
      await expect(jump).toBeVisible()
      await document.click()
      await expect(transcript).not.toBeVisible()
      const hiddenUpdate = 'A hidden-panel update must preserve the previous reading position.'
      await appendReply(app, sessions.primary.id, 'hidden-update', hiddenUpdate)
      await expect(page.locator('.assistant-message').last()).toContainText(hiddenUpdate)
      await extension.click()
      await expectReadingPosition(transcript, hiddenReadingTop)
      await expect(unread).toBeVisible()
      await expect(latestStatus).toHaveText(scenario.language === 'zh-CN' ? '有新内容' : 'New content')
      await expect(composer).toHaveValue(draft)
      await recordLayout(context, info, 'hidden-update-restored', scenario.width, unread)

      await selector.selectOption(sessions.secondary.id)
      await expect(page.locator('.assistant-message')).toHaveCount(2)
      await expect(transcript).toContainText(secondaryReply)
      await expect(unread).not.toBeVisible(); await expect(jump).not.toBeVisible()
      await expect(latestStatus).toHaveText('')
      const otherSessionUpdate = 'An update in another session must not mark this short session unread.'
      const lastSeq = await appendReply(app, sessions.primary.id, 'other-session-update', otherSessionUpdate)
      await expect.poll(async () => (await page.evaluate(() => window.knowbook.listAssistantSessions()))
        .find(session => session.id === sessions.primary.id)?.lastSeq).toBe(lastSeq)
      await settleScroll(page)
      await expect(transcript).not.toContainText(otherSessionUpdate)
      await expect(unread).not.toBeVisible(); await expect(jump).not.toBeVisible()
      await expect(latestStatus).toHaveText('')
      await expect(composer).toHaveValue(draft)
      await selector.selectOption(sessions.primary.id)
      await expect(page.locator('.assistant-message').last()).toContainText(otherSessionUpdate)
      await expect.poll(async () => (await scrollState(transcript)).bottom).toBeLessThanOrEqual(1)
      await expect(unread).not.toBeVisible(); await expect(jump).not.toBeVisible()
      await expect(page.locator('.assistant-approval')).toContainText(approvalSummary)
      await expect(composer).toHaveValue(draft)
      await recordLayout(context, info, 'session-return-pinned', scenario.width)

      const final = await readStored(app, sessions.primary.id)
      expect(final.events.slice(0, original.events.length)).toEqual(original.events)
      expect(final.events.slice(original.events.length).map(event => event.type)).toEqual(Array(4).fill('assistant.message'))
      expect(final.nextSeq - 1).toBe(lastSeq)
      const ipcEvents = await page.evaluate(sessionId => window.knowbook.getAssistantSessionEvents(sessionId, 0, 1_000), sessions.primary.id)
      expect(ipcEvents.map(event => event.seq)).toEqual(final.events.map(event => event.seq))
      expect(ipcEvents.at(-1)?.seq).toBe(lastSeq)
      expect(await app.evaluate(() => (globalThis as ActionProbe).__assistantLatestActions)).toEqual({ sent: [], approvals: [] })
      await expect(page.getByRole('alert')).toHaveCount(0)
    }, { PLAYWRIGHT_ELECTRON_LOCALE: scenario.language, KNOWBOOK_SYSTEM_PLUGIN_SAFE_MODE: '1' })
  })
}
