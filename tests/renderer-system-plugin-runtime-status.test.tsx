import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import type { SystemPluginRunRecord } from '../src/shared/system-plugin-state'
import { SystemPluginRuntimeStatus } from '../src/renderer/src/components/SystemPluginRuntimeStatus'

test('runtime inspector keeps Main and Renderer status, actual PID, revision and nested failure stages distinct', () => {
  const run = (component: 'main' | 'renderer', status: 'ready' | 'failed', pid: number): SystemPluginRunRecord => ({
    id: component, pluginId: 'plugin', installationId: 'install', packageId: `${component}-package`,
    component, status, pid, exitCode: null, exitSignal: null, restartCount: 0, health: null,
    error: component === 'main' ? null : { name: 'AggregateError', errors: [{ stage: 'activate', message: 'failed' }] },
    logPath: null, startedAt: '2026-09-09T00:00:00Z', readyAt: null, lastHeartbeatAt: null, stoppedAt: null,
    updatedAt: '2026-09-09T00:00:00Z'
  })
  const dom = new JSDOM(renderToStaticMarkup(<SystemPluginRuntimeStatus isZh plugin={{
    recentRuns: [run('renderer', 'failed', 22), run('main', 'ready', 11)],
    availablePackages: ['main', 'renderer'].map((component) => ({
      packageId: `${component}-package`, artifactSha256: `${component}-hash`, version: '1.0.0', status: 'ready', createdAt: ''
    }))
  }} />))
  const main = dom.window.document.querySelector('[data-component="main"]')!
  const renderer = dom.window.document.querySelector('[data-component="renderer"]')!
  assert.equal(main.getAttribute('data-run-status'), 'ready')
  assert.match(main.textContent!, /Main · ready.*sha256:main-hash.*PID 11/)
  assert.doesNotMatch(main.textContent!, /失败阶段|renderer-hash/)
  assert.equal(renderer.getAttribute('data-run-status'), 'failed')
  assert.match(renderer.textContent!, /Renderer · failed.*sha256:renderer-hash.*PID 22.*失败阶段: activate/)
  dom.window.close()
})

test('an active last-known-good run stays ready while the failed candidate remains independently diagnosable', () => {
  const current: SystemPluginRunRecord = {
    id: 'current', pluginId: 'plugin', installationId: 'install', packageId: 'lkg', component: 'main',
    status: 'ready', pid: 11, exitCode: null, exitSignal: null, restartCount: 0, health: null, error: null,
    logPath: null, startedAt: '2026-09-09T01:00:01Z', readyAt: '2026-09-09T01:00:02Z',
    lastHeartbeatAt: null, stoppedAt: null, updatedAt: '2026-09-09T01:00:02Z'
  }
  const candidate: SystemPluginRunRecord = {
    ...current, id: 'candidate-run', packageId: 'candidate', status: 'failed', pid: null,
    error: { stage: 'migrate', message: '候选迁移失败 token=[REDACTED]' },
    startedAt: '2026-09-09T01:00:00Z', stoppedAt: '2026-09-09T01:00:01Z', readyAt: null
  }
  const older: SystemPluginRunRecord = {
    ...candidate, id: 'older', packageId: 'older-package', stoppedAt: '2026-09-08T00:00:00Z',
    error: { stage: 'activate', message: 'older failure' }
  }
  const dom = new JSDOM(renderToStaticMarkup(<SystemPluginRuntimeStatus isZh plugin={{
    recentRuns: [current, older, candidate],
    availablePackages: ['lkg', 'candidate'].map((id) => ({
      packageId: id, artifactSha256: `${id}-hash`, version: id === 'lkg' ? '1.0.0' : '2.0.0',
      status: id === 'lkg' ? 'ready' : 'failed', createdAt: ''
    }))
  }} />))
  const active = dom.window.document.querySelector('[data-testid="system-plugin-runtime-component"]')!
  const failed = dom.window.document.querySelector('[data-testid="system-plugin-last-failure"]')!
  assert.equal(active.getAttribute('data-run-status'), 'ready')
  assert.match(active.textContent!, /Main · ready.*sha256:lkg-hash/)
  assert.doesNotMatch(active.textContent!, /候选迁移失败/)
  assert.match(failed.textContent!, /最近失败 · main.*sha256:candidate-hash.*失败阶段: migrate.*候选迁移失败/)
  assert.doesNotMatch(failed.textContent!, /older failure|lkg-hash/)
  dom.window.close()
})
