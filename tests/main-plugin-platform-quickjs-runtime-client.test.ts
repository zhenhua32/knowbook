import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { waitForUtilityProcessExit } from '../src/main/plugin-platform/utility-process-lifecycle'

test('utility-process exit wait does not resolve before Electron acknowledges exit', async () => {
  let acknowledgeExit: (() => void) | undefined
  const exit = new Promise<void>((resolve) => { acknowledgeExit = resolve })
  let completed = false
  const wait = waitForUtilityProcessExit(exit, 1_000).then(() => { completed = true })

  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(completed, false)
  acknowledgeExit?.()
  await wait
  assert.equal(completed, true)
})

test('utility-process exit wait has a bounded failure path', async () => {
  await assert.rejects(
    waitForUtilityProcessExit(new Promise<void>(() => {}), 5),
    /did not exit within 5ms/
  )
})

test('QuickJS runtime kills the child and awaits its exit acknowledgement during disposal', () => {
  const source = readFileSync(
    new URL('../src/main/plugin-platform/quickjs-runtime-client.ts', import.meta.url),
    'utf8'
  )
  assert.match(
    source,
    /this\.process\.kill\(\)\s+await waitForUtilityProcessExit\(this\.processExit, PROCESS_EXIT_TIMEOUT_MS\)/
  )
})
