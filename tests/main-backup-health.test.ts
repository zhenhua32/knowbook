import assert from 'node:assert/strict'
import test from 'node:test'
import { BackupHealthTracker } from '../src/main/backup/health'
import type { BackupHealth } from '../src/shared/backup-health'

test('automatic backup retains early failures, deduplicates repeats and reports recovery once', () => {
  const events: BackupHealth[] = []
  const health = new BackupHealthTracker((state) => events.push(state))
  health.report(null)
  health.report('No disk space')
  health.report('No disk space')
  assert.equal(events.length, 1)
  assert.deepEqual(health.getSnapshot(), { revision: 1, error: 'No disk space' })
  health.getSnapshot().error = 'mutated copy'
  assert.equal(health.getSnapshot().error, 'No disk space')
  health.report('Directory unavailable')
  health.report(null)
  health.report(null)
  assert.deepEqual(events, [
    { revision: 1, error: 'No disk space' }, { revision: 2, error: 'Directory unavailable' }, { revision: 3, error: null }
  ])
})
