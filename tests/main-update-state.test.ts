import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createInitialAppUpdateState,
  normalizeReleaseNotes,
  reduceAppUpdateState
} from '../src/main/update-state.ts'

const context = {
  checkedAt: '2026-07-29T00:00:00.000Z',
  currentVersion: '1.2.3',
  updatesEnabled: true
}

test('update state initializes supported and unsupported builds', () => {
  const supported = createInitialAppUpdateState('1.2.3', true)
  assert.equal(supported.status, 'idle')
  assert.equal(supported.updatesEnabled, true)
  assert.equal(supported.canInstall, false)

  const unsupported = createInitialAppUpdateState('1.2.3', false)
  assert.equal(unsupported.status, 'unsupported')
  assert.match(unsupported.message, /packaged builds/)
})

test('release notes normalize updater strings and structured arrays', () => {
  assert.equal(normalizeReleaseNotes('  Fixed sync.  '), 'Fixed sync.')
  assert.equal(normalizeReleaseNotes([
    { version: '1.2.4', note: '  Fixed sync. ' },
    '',
    'Improved startup.',
    { note: 42 },
    null
  ]), 'Fixed sync.\n\nImproved startup.')
  assert.equal(normalizeReleaseNotes([]), null)
  assert.equal(normalizeReleaseNotes({ note: 'ignored' }), null)
})

test('update state reducer covers check, availability, progress, and download lifecycle', () => {
  let state = createInitialAppUpdateState('1.2.3', true)

  state = reduceAppUpdateState(state, { type: 'checking' }, context)
  assert.equal(state.status, 'checking')
  assert.equal(state.checkedAt, context.checkedAt)

  state = reduceAppUpdateState(state, {
    type: 'available',
    info: {
      version: '1.3.0',
      releaseName: 'Stable',
      releaseNotes: [{ note: 'New feature' }]
    }
  }, context)
  assert.equal(state.status, 'available')
  assert.equal(state.availableVersion, '1.3.0')
  assert.equal(state.releaseName, 'Stable')
  assert.equal(state.releaseNotes, 'New feature')
  assert.equal(state.progressPercent, 0)

  state = reduceAppUpdateState(state, {
    type: 'download-progress',
    percent: 101.7
  }, context)
  assert.equal(state.status, 'downloading')
  assert.equal(state.progressPercent, 100)
  assert.match(state.message, /100%/)

  state = reduceAppUpdateState(state, {
    type: 'download-progress',
    percent: Number.NaN
  }, context)
  assert.equal(state.progressPercent, 0)
  assert.match(state.message, /0%/)

  state = reduceAppUpdateState(state, {
    type: 'downloaded',
    info: { version: '1.3.0' }
  }, context)
  assert.equal(state.status, 'downloaded')
  assert.equal(state.downloadedVersion, '1.3.0')
  assert.equal(state.releaseNotes, 'New feature')
  assert.equal(state.progressPercent, 100)
  assert.equal(state.canInstall, true)
})

test('update state reducer clears stale release data when no update exists', () => {
  const available = reduceAppUpdateState(
    createInitialAppUpdateState('1.2.3', true),
    {
      type: 'available',
      info: { version: '1.3.0', releaseName: 'Stable', releaseNotes: 'Notes' }
    },
    context
  )
  const current = reduceAppUpdateState(available, { type: 'not-available' }, context)

  assert.equal(current.status, 'not-available')
  assert.equal(current.availableVersion, null)
  assert.equal(current.downloadedVersion, null)
  assert.equal(current.releaseName, null)
  assert.equal(current.releaseNotes, null)
  assert.equal(current.canInstall, false)
})

test('update state reducer records Error and non-Error failures', () => {
  const initial = createInitialAppUpdateState('1.2.3', true)
  const errorState = reduceAppUpdateState(initial, {
    type: 'error',
    error: new Error('feed unreachable')
  }, context)
  assert.equal(errorState.status, 'error')
  assert.equal(errorState.error, 'feed unreachable')
  assert.equal(errorState.canInstall, false)

  const stringErrorState = reduceAppUpdateState(initial, {
    type: 'error',
    error: 'bad response'
  }, context)
  assert.equal(stringErrorState.error, 'bad response')
})
