import assert from 'node:assert/strict'
import test from 'node:test'
import { CoalescedNotifier } from '../src/main/coalesced-notifier.ts'

test('CoalescedNotifier merges pending notifications and supports flush and dispose', () => {
  let notifications = 0
  const notifier = new CoalescedNotifier(() => {
    notifications += 1
  }, 60_000)

  notifier.notify()
  notifier.notify()
  notifier.notify()
  assert.equal(notifications, 0)

  notifier.flush()
  assert.equal(notifications, 1)
  notifier.flush()
  assert.equal(notifications, 1)

  notifier.notify()
  notifier.dispose()
  notifier.flush()
  notifier.notify()
  assert.equal(notifications, 1)
})
