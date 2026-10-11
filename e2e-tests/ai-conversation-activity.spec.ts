import { writeFileSync } from 'node:fs'
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { ASSISTANT_EVENT_SURFACES, type AssistantEvent, type AssistantSessionSummary } from '../src/shared/assistant-session'
import { hasBuiltElectronApp, uiText, withElectronApp, type ElectronAppContext } from './helpers/electron'

type FixtureRow = { type: AssistantEvent['type']; surface: string; turnId: string | null; stepId: string | null; payloadJson: string }
type ActionProbe = typeof globalThis & { __assistantActivityActions?: { sent: unknown[]; approvals: unknown[] } }
type SummaryReference = Window & { __assistantActivitySummary?: Element; __assistantActivityApproval?: Element }
type ScrollDiagnostics = Window & { __assistantActivityScrollSamples?: Array<Record<string, unknown>> }

const anchorText = 'Reading anchor after the first two completed action groups.'
const draft = 'Preserve this unsent extension request. 保留这份尚未发送的草稿。'
const approvalText = 'Keep this inert approval visible until the user explicitly decides.'
const oldRunError = 'An earlier distinct run failed and must remain visible.'
const validationFailure = 'The inert revision failed its static validation.'
const denseCallCount = 8

function row(type: AssistantEvent['type'], payload: Record<string, unknown>): FixtureRow {
  return { type, surface: ASSISTANT_EVENT_SURFACES[type], turnId: typeof payload.turnId === 'string' ? payload.turnId : null,
    stepId: typeof payload.stepId === 'string' ? payload.stepId : null, payloadJson: JSON.stringify(payload) }
}

function history(session: AssistantSessionSummary): FixtureRow[] {
  const turnId = `${session.id}-turn`, rows: FixtureRow[] = [row('turn.started', { turnId }),
    row('user.message', { turnId, text: 'Read the extension conversation while completed operations become compact.' })]
  const message = (stepId: string, text: string) => rows.push(row('assistant.message', { turnId, stepId, text }))
  const tool = (call: string, name: string, status?: 'succeeded' | 'failed' | 'cancelled' | 'awaiting-approval', result: Record<string, unknown> = {}) => {
    const stepId = `${call}-step`
    rows.push(row('tool.call', { turnId, stepId, toolCallId: call, tool: name, version: 1, arguments: {} }))
    if (status) rows.push(row('tool.result', { turnId, stepId, toolCallId: call, status, result }))
  }
  const run = (runId: string, outcome: 'succeeded' | 'failed' | 'stopped', operation?: 'activate' | 'rollback') => {
    const pluginId = runId === 'old-failed-run' || runId === 'new-success-run' ? 'same-inert-plugin' : `inert-${runId}`
    const revisionId = runId === 'old-failed-run' || runId === 'new-success-run' ? 'same-inert-revision' : `${runId}-revision`
    rows.push(row('plugin.run.requested', { turnId, toolCallId: `${runId}-call`, pluginId, revisionId, runId,
      ...(operation ? { operation } : {}), ...(operation === 'rollback' ? { fromRevisionId: 'previous-inert-revision' } : {}) }))
    rows.push(row('plugin.run.started', { pluginId, revisionId, runId }))
    rows.push(row(`plugin.run.${outcome}`, { pluginId, revisionId, runId,
      ...(outcome === 'succeeded' ? { epoch: 1 } : {}), ...(outcome === 'failed' ? { error: { message: oldRunError } } : {}) }))
    if (operation === 'rollback') rows.push(row('plugin.rollback.completed', { pluginId, fromRevisionId: 'previous-inert-revision', toRevisionId: revisionId, runId }))
  }
  for (let index = 0; index < 12; index++) message(`history-${index}`, `### Earlier reply ${index + 1}\n\nA persisted decision remains available while later operations finish.\n\n- Review the extension plan\n- Preserve the reading position\n- Wait for explicit approval`)
  tool('hidden-reading-0', 'documents.get')
  tool('hidden-reading-1', 'documents.list')
  tool('group-a', 'workspace.search', 'succeeded', { documents: [] })
  tool('transition-b', 'documents.get')
  tool('group-c', 'documents.list', 'succeeded', { documents: [] })
  message('reading-anchor', `${anchorText}\n\nThis paragraph should remain at the same visible position when the operation above it completes.`)
  for (let index = 0; index < denseCallCount; index++) tool(`dense-${index}`, 'workspace.search', 'succeeded', { documents: [] })
  rows.push(row('plugin.revision.defined', { turnId, pluginId: 'dense-inert-plugin', revisionId: 'dense-inert-revision', previousRevisionId: null }))
  rows.push(row('plugin.validation.completed', { turnId, pluginId: 'dense-inert-plugin', revisionId: 'dense-inert-revision', status: 'passed', diagnostics: [] }))
  tool('explicit-failure', 'documents.update', 'failed', { message: 'The fixture operation failed visibly.' })
  tool('validation-warning', 'plugins.validate_revision', 'succeeded', { pluginId: 'warning-inert-plugin', revisionId: 'warning-inert-revision', status: 'warning', diagnostics: [{ message: 'Review this inert static warning.' }] })
  tool('validation-failed', 'plugins_validate_revision', 'succeeded', { pluginId: 'failed-inert-plugin', revisionId: 'failed-inert-revision', status: 'failed', diagnostics: [{ message: validationFailure }] })
  rows.push(row('plugin.validation.completed', { turnId, pluginId: 'warning-inert-plugin', revisionId: 'warning-inert-revision', status: 'warning', diagnostics: [] }))
  run('old-failed-run', 'failed') // Older events have no operation field.
  run('new-success-run', 'succeeded', 'activate')
  run('cancelled-run', 'stopped', 'activate')
  run('rollback-run', 'succeeded', 'rollback')
  tool('cancelled-tool', 'documents.delete', 'cancelled', { status: 'cancelled' })
  rows.push(row('inbox.message', { messageId: 'queued-inert-message', text: 'This queued request remains explicit.', mode: 'next-turn' }))
  rows.push(row('plugin.run.requested', { turnId, toolCallId: 'running-run-call', pluginId: 'running-inert-plugin', revisionId: 'running-inert-revision', runId: 'running-run', operation: 'activate' }))
  rows.push(row('plugin.run.started', { pluginId: 'running-inert-plugin', revisionId: 'running-inert-revision', runId: 'running-run' }))
  tool('pending-tool', 'plugins.activate_revision', 'awaiting-approval', { status: 'awaiting-approval' })
  tool('approval-reading-0', 'documents.get')
  tool('approval-reading-1', 'documents.list')
  rows.push(row('approval.requested', { turnId, toolCallId: 'pending-tool', approvalId: 'activity-inert-approval', pluginId: 'pending-inert-plugin', revisionId: 'pending-inert-revision',
    scope: { kind: 'session', workspaceId: session.workspaceId, sessionId: session.id }, permissions: [], risk: 'low',
    summary: approvalText, expiresAt: '2099-01-01T00:00:00.000Z',
    revisionPreview: { changes: Array.from({ length: 36 }, (_, index) => `Inert review line ${index + 1}: retain the exact requested behavior and wait for the user's explicit decision.`) } }))
  message('last-reply', 'Completed operations are available on demand. Failures and pending decisions remain explicit.')
  return rows
}

// The fixture writes facts only. Production preload/IPC still reads and projects
// the actual database, and notifications carry its committed sequence number.
async function append(app: ElectronApplication, sessionId: string, rows: FixtureRow[], activeTurnId?: string | null): Promise<number> {
  return app.evaluate(({ app, BrowserWindow }, input) => {
    const { createRequire } = process.getBuiltinModule('node:module')!, { join } = process.getBuiltinModule('node:path')!
    const Database = createRequire(join(app.getAppPath(), 'package.json'))('better-sqlite3')
    const database = new Database(join(app.getPath('userData'), 'storage', 'knowbook.db'), { fileMustExist: true })
    let lastSeq = 0
    try {
      database.transaction(() => {
        const session = database.prepare('SELECT next_seq FROM assistant_sessions WHERE id = ?').get(input.sessionId) as { next_seq: number }
        if (!session) throw new Error('Missing activity fixture session')
        let seq = session.next_seq
        const insert = database.prepare('INSERT INTO assistant_events (id, session_id, seq, type, surface, turn_id, step_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        for (const event of input.rows) {
          insert.run(`${input.sessionId}-activity-${seq}`, input.sessionId, seq, event.type, event.surface, event.turnId, event.stepId, event.payloadJson,
            new Date(Date.UTC(2026, 9, 10, 0, 0, seq)).toISOString())
          seq++
        }
        lastSeq = seq - 1
        database.prepare('UPDATE assistant_sessions SET next_seq = ?, updated_at = ? WHERE id = ?')
          .run(seq, new Date(Date.UTC(2026, 9, 10, 0, 0, lastSeq)).toISOString(), input.sessionId)
        if (input.activeTurnId !== undefined) database.prepare('UPDATE assistant_sessions SET active_turn_id = ? WHERE id = ?').run(input.activeTurnId, input.sessionId)
      })()
    } finally { database.close() }
    BrowserWindow.getAllWindows()[0].webContents.send('knowbook:assistant-session-changed', { sessionId: input.sessionId, lastSeq })
    return lastSeq
  }, { sessionId, rows, activeTurnId })
}

async function stored(app: ElectronApplication, sessionId: string) {
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
    ;(globalThis as ActionProbe).__assistantActivityActions = actions
    for (const [channel, records] of [['knowbook:send-assistant-message', actions.sent], ['knowbook:resolve-assistant-approval', actions.approvals]] as const) {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, (_event, input: unknown) => {
        records.push(structuredClone(input)); throw new Error('Activity navigation must not send or approve anything')
      })
    }
  })
}

async function frame(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

async function observeNativeScroll(page: Page): Promise<void> {
  await page.evaluate(() => {
    const transcript = document.querySelector('.assistant-transcript')!
    const samples: Array<Record<string, unknown>> = []
    ;(window as ScrollDiagnostics).__assistantActivityScrollSamples = samples
    const observe = (event: Event) => {
      const viewport = transcript.getBoundingClientRect()
      const anchor = [...transcript.querySelectorAll('.assistant-message')].find(element => element.textContent?.includes('Reading anchor after the first two completed action groups.'))
      samples.push({ time: performance.now(), kind: event.type, trusted: event.isTrusted,
        scrollTop: transcript.scrollTop, scrollHeight: transcript.scrollHeight, clientHeight: transcript.clientHeight,
        viewportTop: viewport.top, anchorTop: anchor?.getBoundingClientRect().top,
        approvalTop: transcript.querySelector('.assistant-approval')?.getBoundingClientRect().top,
        ...(event instanceof WheelEvent ? { deltaX: event.deltaX, deltaY: event.deltaY } : {}) })
      if (samples.length > 256) samples.shift()
    }
    transcript.addEventListener('scroll', observe, { passive: true })
    transcript.addEventListener('wheel', observe, { passive: true })
  })
}

async function recordReadingGeometry(page: Page, info: TestInfo, phase: string, expectedY: number): Promise<void> {
  let snapshot: unknown
  try {
    snapshot = await page.evaluate(expectedY => {
      const transcript = document.querySelector('.assistant-transcript')!
      const viewport = transcript.getBoundingClientRect(), center = (viewport.top + viewport.bottom) / 2
      const describe = (element: Element) => {
        const bounds = element.getBoundingClientRect(), details = element.closest('details.assistant-activity-group')
        return { tag: element.tagName, className: element.className, text: element.textContent?.trim().slice(0, 140),
          toolCallId: element.getAttribute('data-tool-call-id'), runId: element.getAttribute('data-run-id'),
          groupToolCallIds: [...(details?.querySelectorAll('[data-tool-call-id]') ?? [])].map(tool => tool.getAttribute('data-tool-call-id')),
          groupOpen: details?.hasAttribute('open') ?? null, connected: element.isConnected,
          rect: { top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right, height: bounds.height, width: bounds.width },
          offsetFromViewportTop: bounds.top - viewport.top, distanceFromViewportCenter: Math.abs((bounds.top + bounds.bottom) / 2 - center),
          intersectsViewport: bounds.height > 0 && bounds.bottom > viewport.top && bounds.top < viewport.bottom }
      }
      const cards = [...transcript.querySelectorAll('.assistant-message, .assistant-activity-group > summary, .assistant-tool-event, .assistant-lifecycle-event, .assistant-approval')].map(describe)
      return { time: performance.now(), expectedY, viewport: { top: viewport.top, bottom: viewport.bottom, height: viewport.height, center },
        scrollTop: transcript.scrollTop, scrollHeight: transcript.scrollHeight, clientHeight: transcript.clientHeight,
        overflowAnchor: getComputedStyle(transcript).overflowAnchor, scrollBehavior: getComputedStyle(transcript).scrollBehavior,
        activeElement: document.activeElement ? describe(document.activeElement) : null,
        cards, visibleCards: cards.filter(card => card.intersectsViewport),
        scrollSamples: (window as ScrollDiagnostics).__assistantActivityScrollSamples ?? [] }
    }, expectedY)
  } catch (error) { snapshot = { expectedY, diagnosticError: String(error) } }
  const path = info.outputPath(`${phase}-reading-geometry.json`)
  writeFileSync(path, JSON.stringify(snapshot, null, 2))
  await info.attach(`${phase}-reading-geometry`, { path, contentType: 'application/json' })
}

async function focusWithTab(page: Page, target: Locator): Promise<void> {
  await page.getByRole('tab', { name: uiText('App extension assistant', '应用扩展助手'), exact: true }).click()
  for (let index = 0; index < 40 && !await target.evaluate(element => element === document.activeElement); index++) await page.keyboard.press('Tab')
  await expect(target).toBeFocused()
}

async function revealAnchor(page: Page, transcript: Locator, anchor: Locator): Promise<number> {
  const bounds = (await transcript.boundingBox())!
  await page.mouse.move(bounds.x + 12, bounds.y + bounds.height / 2)
  for (let index = 0; index < 16; index++) {
    const target = (await anchor.boundingBox())!
    const center = bounds.y + bounds.height / 2
    const targetCenter = target.y + target.height / 2
    // Establish which paragraph the user is reading. Merely revealing its
    // first line can leave another reply closer to the enlarged viewport's
    // center, where preserving that reply is the correct behavior.
    if (target.y >= bounds.y + 8 && target.y + target.height <= bounds.y + bounds.height - 8
      && Math.abs(targetCenter - center) <= 16) {
      await frame(page); return (await anchor.boundingBox())!.y
    }
    await page.mouse.wheel(0, Math.max(-360, Math.min(360, targetCenter - center)))
    await frame(page)
  }
  throw new Error('The historical reading anchor must be reachable with the native scroll wheel')
}

async function expectOutsideGroup(item: Locator): Promise<void> {
  await expect(item).toBeVisible()
  expect(await item.evaluate(element => element.closest('details.assistant-activity-group') === null)).toBe(true)
}

async function readInsideApproval(page: Page, transcript: Locator, approval: Locator): Promise<number> {
  const bounds = (await transcript.boundingBox())!
  const approvalBounds = (await approval.boundingBox())!
  expect(approvalBounds.height).toBeGreaterThan(bounds.height + 50)
  // Use the card's left padding so the native wheel scrolls the transcript,
  // rather than the preview's independently scrollable pre element.
  await page.mouse.move(bounds.x + 12, bounds.y + bounds.height / 2)
  for (let index = 0; index < 16; index++) {
    const card = (await approval.boundingBox())!
    const distance = card.y - (bounds.y - 8)
    if (Math.abs(distance) <= 1) {
      await frame(page)
      const geometry = await approval.evaluate(element => {
        const card = element.getBoundingClientRect(), transcript = element.closest('.assistant-transcript')!
        const viewport = transcript.getBoundingClientRect()
        return { top: card.top, coversViewport: card.top <= viewport.top && card.bottom >= viewport.bottom,
          bottomDistance: transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop }
      })
      expect(geometry.coversViewport).toBe(true)
      expect(geometry.bottomDistance).toBeGreaterThan(48)
      return geometry.top
    }
    await page.mouse.wheel(0, Math.max(-240, Math.min(240, distance)))
    await frame(page)
  }
  throw new Error('The expanded approval must cover the native transcript viewport while reading history')
}

async function record(context: ElectronAppContext, info: TestInfo, phase: string, width: number): Promise<void> {
  const native = await context.app.evaluate(({ app, BrowserWindow }) => ({ userData: app.getPath('userData'),
    windows: BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable(), bounds: window.getContentBounds() })) }))
  expect(native.userData).toBe(context.tempRoot)
  expect(native.windows).toHaveLength(1)
  expect(native.windows[0]).toMatchObject({ visible: false, focused: false, focusable: false, bounds: { width, height: 760 } })
  expect(await context.page.evaluate(() => ({ width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth - innerWidth })))
    .toEqual({ width, height: 760, overflow: 0 })
  await expect(context.page.locator('.assistant-composer textarea')).toBeInViewport({ ratio: 1 })
  await expect(context.page.locator('.assistant-composer-hint')).toBeInViewport({ ratio: 1 })
  expect(await context.page.locator('.assistant-transcript').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
  const path = info.outputPath(`${phase}-background.json`)
  writeFileSync(path, JSON.stringify(native, null, 2)); await info.attach(`${phase}-background`, { path, contentType: 'application/json' })
  await context.page.screenshot({ path: info.outputPath(`${phase}.png`) })
}

for (const scenario of [{ language: 'en-US', theme: 'light', width: 1280 }, { language: 'zh-CN', theme: 'dark', width: 760 }] as const) {
  test(`assistant groups completed activity while preserving warnings, approvals, keyboard focus and reading (${scenario.language}) @electron`, async ({}, info) => {
    test.setTimeout(120_000)
    test.skip(!hasBuiltElectronApp(), 'Requires a built Electron app')
    await withElectronApp(async context => {
      const { app, page } = context
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 760), scenario.width)
      await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([scenario.width, 760])
      const sessions = await page.evaluate(async ({ language, theme }) => {
        await window.knowbook.saveSetting('ui.language', language); await window.knowbook.saveSetting('appearance.theme', theme)
        await window.knowbook.updateAiConfig({ enabled: true, apiKey: 'activity-inert-key', baseUrl: 'https://example.invalid/v1', model: 'activity-fixture', autoSummaryOnSave: false, relatedNotesEnabled: false })
        return { primary: await window.knowbook.createAssistantSession({ title: 'Completed activity fixture' }),
          secondary: await window.knowbook.createAssistantSession({ title: 'Separate activity session' }) }
      }, scenario)
      await append(app, sessions.primary.id, history(sessions.primary), `${sessions.primary.id}-turn`)
      const original = await stored(app, sessions.primary.id)
      await guardActions(app); await page.reload()
      await page.locator('[data-page-id="ai"]').click()
      const extension = page.getByRole('tab', { name: uiText('App extension assistant', '应用扩展助手'), exact: true })
      const document = page.getByRole('tab', { name: uiText('Document AI assistant', '文档智能助手'), exact: true })
      await extension.click()
      const selector = page.locator('.assistant-session-select'), transcript = page.locator('.assistant-transcript'), composer = page.locator('.assistant-composer textarea')
      await selector.selectOption(sessions.primary.id)
      await expect(page.locator('html')).toHaveAttribute('data-theme', scenario.theme)
      await expect(page.locator('.assistant-message')).toHaveCount(15)
      await composer.fill(draft)
      // First establish the persisted facts and the visible native disclosure.
      // This regression must also fail on old builds without the new ID attributes.
      await expect(transcript.locator('.assistant-tool-event > code').filter({ hasText: /^workspace\.search$/ })).toHaveCount(denseCallCount + 1)
      await expect(transcript.locator('details.assistant-activity-group').first()).toBeVisible()
      const tool = (id: string) => page.locator(`.assistant-tool-event[data-tool-call-id="${id}"]`)
      const run = (id: string) => page.locator(`.assistant-lifecycle-event[data-run-id="${id}"]`)
      const group = (call: string) => page.locator('details.assistant-activity-group').filter({ has: tool(call) })
      const groupA = group('group-a'), groupC = group('group-c'), dense = group('dense-0')
      const summaryC = groupC.locator('summary').first()
      for (const item of [groupA, groupC, dense]) { await expect(item).toHaveCount(1); await expect(item).not.toHaveAttribute('open') }
      await expect(summaryC).toHaveAccessibleName(scenario.language === 'zh-CN' ? '已完成 1 项操作' : '1 completed action')
      await expect(tool('group-a')).not.toBeVisible(); await expect(tool('group-c')).not.toBeVisible()
      for (const id of ['hidden-reading-0', 'hidden-reading-1', 'transition-b', 'explicit-failure', 'validation-warning', 'validation-failed', 'cancelled-tool', 'pending-tool', 'approval-reading-0', 'approval-reading-1']) await expectOutsideGroup(tool(id))
      await expect(tool('validation-warning')).toContainText(/warning|有警告/)
      await expect(tool('validation-failed')).toContainText(/failed|失败/)
      await expect(tool('validation-failed')).toContainText(validationFailure)
      for (const id of ['old-failed-run', 'new-success-run', 'cancelled-run', 'rollback-run', 'running-run']) await expect(run(id)).toHaveCount(1)
      await expectOutsideGroup(run('old-failed-run')); await expect(run('old-failed-run')).toContainText(oldRunError)
      await expect(run('old-failed-run').locator('.assistant-run-history')).toContainText(/request|请求/)
      await expect(run('old-failed-run').locator('.assistant-run-history')).toContainText(/start|启动/)
      await expect(run('old-failed-run').locator('.assistant-run-history')).toContainText(/fail|失败/)
      await expect(run('new-success-run')).not.toBeVisible()
      await expect(run('rollback-run').locator('.assistant-run-history')).toContainText(/rollback|回滚/)
      await expectOutsideGroup(run('cancelled-run')); await expectOutsideGroup(run('running-run'))
      await expectOutsideGroup(page.locator('.assistant-lifecycle-warning').filter({ hasText: 'warning-inert-plugin' }))
      await expectOutsideGroup(page.locator('.assistant-lifecycle-queued'))
      await expectOutsideGroup(page.locator('.assistant-approval'))
      await expect(page.locator('.assistant-approval')).toContainText(approvalText)
      await expect(page.locator('.assistant-approval')).toBeInViewport({ ratio: 1 })
      await record(context, info, 'compact-completed-with-visible-decisions', scenario.width)

      const denseClosedHeight = (await dense.boundingBox())!.height
      await focusWithTab(page, dense.locator('summary').first()); await page.keyboard.press('Enter')
      await expect(dense).toHaveAttribute('open', '')
      await expect(tool('dense-0')).toBeVisible(); await expect(tool(`dense-${denseCallCount - 1}`)).toBeVisible()
      expect((await dense.boundingBox())!.height).toBeGreaterThan(denseClosedHeight * 3)
      expect((await dense.boundingBox())!.height - denseClosedHeight).toBeGreaterThan(200)
      await record(context, info, 'native-expanded-completed-details', scenario.width)
      await page.keyboard.press('Enter'); await expect(dense).not.toHaveAttribute('open')

      await focusWithTab(page, summaryC); await page.keyboard.press('Enter')
      await expect(groupC).toHaveAttribute('open', ''); await expect(summaryC).toBeFocused()
      await summaryC.evaluate(element => { (window as SummaryReference).__assistantActivitySummary = element })
      const anchor = page.locator('.assistant-message').filter({ hasText: anchorText })
      await observeNativeScroll(page)
      const readingY = await revealAnchor(page, transcript, anchor)
      await expect(anchor).toBeInViewport(); await expect(summaryC).toBeFocused()
      const readingBounds = (await anchor.boundingBox())!, viewportBounds = (await transcript.boundingBox())!
      expect(readingBounds.y).toBeGreaterThanOrEqual(viewportBounds.y + 8)
      expect(readingBounds.y + readingBounds.height).toBeLessThanOrEqual(viewportBounds.y + viewportBounds.height - 8)
      expect(Math.abs(readingBounds.y + readingBounds.height / 2 - viewportBounds.y - viewportBounds.height / 2)).toBeLessThanOrEqual(16)
      await recordReadingGeometry(page, info, 'message-before-completion', readingY)
      const completedSeq = await append(app, sessions.primary.id, [row('tool.result', { turnId: `${sessions.primary.id}-turn`,
        stepId: 'transition-b-step', toolCallId: 'transition-b', status: 'succeeded', result: { document: null } })])
      await expect(groupA).toContainText('documents.get')
      await expect(groupA.locator('summary').first()).toHaveAccessibleName(scenario.language === 'zh-CN' ? '已完成 2 项操作' : '2 completed actions')
      await expect(tool('transition-b')).not.toBeVisible()
      await expect(groupC).toHaveAttribute('open', ''); await expect(summaryC).toBeFocused()
      expect(await summaryC.evaluate(element => element === (window as SummaryReference).__assistantActivitySummary)).toBe(true)
      await recordReadingGeometry(page, info, 'message-after-completion', readingY)
      try {
        await expect.poll(async () => Math.abs((await anchor.boundingBox())!.y - readingY)).toBeLessThanOrEqual(1)
      } finally { await recordReadingGeometry(page, info, 'message-after-anchor-check', readingY) }
      await expect(composer).toHaveValue(draft)
      await record(context, info, 'completed-transition-keeps-reading-and-focus', scenario.width)

      await recordReadingGeometry(page, info, 'message-before-hidden-completion', readingY)
      await document.click(); await expect(transcript).not.toBeVisible()
      const hiddenCompletedSeq = await append(app, sessions.primary.id, [0, 1].map(index => row('tool.result', {
        turnId: `${sessions.primary.id}-turn`, stepId: `hidden-reading-${index}-step`, toolCallId: `hidden-reading-${index}`,
        status: 'succeeded', result: { documents: [] }
      })))
      expect(hiddenCompletedSeq).toBe(completedSeq + 2)
      const hiddenCompletedGroup = group('hidden-reading-0')
      await expect(hiddenCompletedGroup).toHaveCount(1)
      await expect(hiddenCompletedGroup).not.toHaveAttribute('open')
      await expect(hiddenCompletedGroup.locator('[data-tool-call-id="hidden-reading-1"]')).toHaveCount(1)
      await expect(transcript).not.toBeVisible()
      await recordReadingGeometry(page, info, 'message-completion-while-hidden', readingY)
      await extension.click(); await expect(groupC).toHaveAttribute('open', '')
      expect(await summaryC.evaluate(element => element === (window as SummaryReference).__assistantActivitySummary)).toBe(true)
      await recordReadingGeometry(page, info, 'message-after-hidden-completion-return', readingY)
      try {
        await expect.poll(async () => Math.abs((await anchor.boundingBox())!.y - readingY)).toBeLessThanOrEqual(1)
      } finally { await recordReadingGeometry(page, info, 'message-after-hidden-anchor-check', readingY) }
      await expect(composer).toHaveValue(draft)
      await record(context, info, 'hidden-completion-keeps-reading-and-open-details', scenario.width)

      const approval = page.locator('.assistant-approval'), preview = approval.locator('details.assistant-revision-preview')
      await focusWithTab(page, preview.locator('summary')); await page.keyboard.press('Enter')
      await expect(preview).toHaveAttribute('open', '')
      await expect(preview.locator('pre')).toContainText('Inert review line 36')
      const approvalReadingY = await readInsideApproval(page, transcript, approval)
      await approval.evaluate(element => { (window as SummaryReference).__assistantActivityApproval = element })
      await expect(page.locator('.assistant-latest-button')).toBeVisible()
      await recordReadingGeometry(page, info, 'approval-before-completion', approvalReadingY)
      const approvalCompletedSeq = await append(app, sessions.primary.id, [0, 1].map(index => row('tool.result', {
        turnId: `${sessions.primary.id}-turn`, stepId: `approval-reading-${index}-step`, toolCallId: `approval-reading-${index}`,
        status: 'succeeded', result: { documents: [] }
      })))
      expect(approvalCompletedSeq).toBe(hiddenCompletedSeq + 2)
      const approvalCompletedGroup = group('approval-reading-0')
      await expect(approvalCompletedGroup).not.toHaveAttribute('open')
      await expect(approvalCompletedGroup.locator('summary')).toHaveAccessibleName(scenario.language === 'zh-CN' ? '已完成 2 项操作' : '2 completed actions')
      await expect(approvalCompletedGroup.locator('[data-tool-call-id="approval-reading-1"]')).toHaveCount(1)
      await expect(tool('approval-reading-0')).not.toBeVisible(); await expect(tool('approval-reading-1')).not.toBeVisible()
      await recordReadingGeometry(page, info, 'approval-after-completion', approvalReadingY)
      try {
        await expect.poll(async () => Math.abs((await approval.boundingBox())!.y - approvalReadingY)).toBeLessThanOrEqual(1)
      } finally { await recordReadingGeometry(page, info, 'approval-after-anchor-check', approvalReadingY) }
      expect(await approval.evaluate(element => element === (window as SummaryReference).__assistantActivityApproval)).toBe(true)
      expect(await approval.evaluate(element => {
        const card = element.getBoundingClientRect(), viewport = element.closest('.assistant-transcript')!.getBoundingClientRect()
        return card.top <= viewport.top && card.bottom >= viewport.bottom
      })).toBe(true)
      await expect(preview).toHaveAttribute('open', '')
      await expectOutsideGroup(tool('pending-tool'))
      await expect(composer).toHaveValue(draft)
      await record(context, info, 'approval-reading-anchor-after-completed-tools', scenario.width)
      const reject = approval.getByRole('button', { name: uiText('Reject', '拒绝'), exact: true })
      await focusWithTab(page, reject)
      await expect(reject).toBeInViewport({ ratio: 1 }); await expect(reject).toBeEnabled()
      await expect(approval.getByRole('button', { name: uiText('Allow once', '仅本次允许'), exact: true })).toBeEnabled()
      await expect(preview).toHaveAttribute('open', '')
      await expect(composer).toHaveValue(draft)
      await record(context, info, 'pending-decision-keyboard-reachable', scenario.width)

      await selector.selectOption(sessions.secondary.id)
      await expect(page.locator('details.assistant-activity-group')).toHaveCount(0)
      await selector.selectOption(sessions.primary.id)
      await expect(groupC).not.toHaveAttribute('open'); await expect(dense).not.toHaveAttribute('open')
      await expect(preview).not.toHaveAttribute('open')
      await expect(tool('group-c')).not.toBeVisible()
      await expect(page.locator('.assistant-approval')).toBeInViewport({ ratio: 1 })
      await expect(composer).toHaveValue(draft)
      await record(context, info, 'session-switch-resets-completed-details', scenario.width)

      const final = await stored(app, sessions.primary.id)
      expect(final.events.slice(0, original.events.length)).toEqual(original.events)
      expect(final.events.slice(original.events.length)).toHaveLength(5)
      expect(final.events.slice(original.events.length).map(event => event.type)).toEqual(Array(5).fill('tool.result'))
      expect(final.events.at(-1)?.type).toBe('tool.result'); expect(final.nextSeq - 1).toBe(approvalCompletedSeq)
      const actual = await page.evaluate(sessionId => window.knowbook.getAssistantSessionEvents(sessionId, 0, 1_000), sessions.primary.id)
      expect(actual.map(event => event.seq)).toEqual(final.events.map(event => event.seq))
      expect(actual.filter(event => event.type === 'plugin.run.started')).toHaveLength(5)
      expect(actual.filter(event => event.type === 'approval.resolved')).toHaveLength(0)
      expect(await app.evaluate(() => (globalThis as ActionProbe).__assistantActivityActions)).toEqual({ sent: [], approvals: [] })
      await expect(page.getByRole('alert')).toHaveCount(0)
    }, { PLAYWRIGHT_ELECTRON_LOCALE: scenario.language, KNOWBOOK_SYSTEM_PLUGIN_SAFE_MODE: '1' })
  })
}
