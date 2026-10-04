import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { act } from 'react'

/** Flush external async work and React commits without advancing mocked animation frames. */
export async function waitForRenderer(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5000
  do {
    await act(async () => { await setImmediate() })
    if (condition()) return
  } while (Date.now() < deadline)
  assert.fail(message)
}
