import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { expect, test, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { hasBuiltElectronApp } from './helpers/electron'
import { withElectronFailureTrace } from './helpers/electron-failure-trace'

async function expectBackground(app: ElectronApplication) {
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
    .map(window => ({ visible: window.isVisible(), focused: window.isFocused(), focusable: window.isFocusable() })))
  expect(windows.length).toBeGreaterThan(0)
  expect(windows.every(window => !window.visible && !window.focused && !window.focusable)).toBe(true)
}

function expectCapturedTrace(info: TestInfo) {
  expect(info.attachments.some(attachment => attachment.name === 'electron-first-attempt-trace'
    && attachment.contentType === 'application/zip' && attachment.path)).toBe(true)
}

test('Electron locator honors the configured action deadline and captures its native failure @electron', async ({}, info) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  const timeout = info.project.use.actionTimeout
  assert.ok(typeof timeout === 'number' && timeout > 0)
  await assert.rejects(withElectronFailureTrace(info, async ({ app, page }) => {
    await expectBackground(app)
    await page.getByTestId('intentionally-missing-action-deadline-target').click()
  }), error => error instanceof Error && error.name === 'TimeoutError'
    && error.message.includes(`Timeout ${timeout}ms exceeded`)
    && error.message.includes('intentionally-missing-action-deadline-target'))
  expectCapturedTrace(info)
})

test('Electron navigation honors its separate configured deadline and closes after failure @electron', async ({}, info) => {
  test.skip(!hasBuiltElectronApp(), 'Run npm run build before Electron tests.')
  const timeout = info.project.use.navigationTimeout
  assert.ok(typeof timeout === 'number' && timeout > 0)
  let requests = 0
  const server = createServer((_request, response) => {
    requests++
    response.writeHead(200, { 'Content-Type': 'text/html' })
    // A real local response stays incomplete, so DOMContentLoaded cannot fire.
    response.write('<!doctype html><title>Pending navigation deadline</title>')
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const url = `http://127.0.0.1:${address.port}/pending-navigation`
    await assert.rejects(withElectronFailureTrace(info, async ({ app, page }) => {
      await expectBackground(app)
      await page.goto(url, { waitUntil: 'domcontentloaded' })
    }), error => error instanceof Error && error.name === 'TimeoutError'
      && error.message.includes(`Timeout ${timeout}ms exceeded`) && error.message.includes(url))
    expect(requests).toBeGreaterThan(0)
    expectCapturedTrace(info)
  } finally {
    server.closeAllConnections()
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
