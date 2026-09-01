import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PluginV2TechnicalDetails } from '../src/renderer/src/components/PluginV2TechnicalDetails.tsx'

test('plugin inspector renders permissions, revision status, and recent runtime logs', () => {
  const html = renderToStaticMarkup(
    <PluginV2TechnicalDetails
      details={{
        pluginId: 'detail-plugin',
        currentRevisionId: 'sha256:current',
        permissions: [{ capability: 'documents.read', version: 1 }],
        revisions: [{
          id: 'sha256:current',
          version: '2.0.0',
          previousRevisionId: 'sha256:previous',
          createdAt: '2026-09-01T00:00:00.000Z',
          staticCheckStatus: 'passed',
          permissionCount: 1,
          activated: true,
          current: true
        }],
        recentLogs: [{
          id: 'log-1',
          revisionId: 'sha256:current',
          runId: 'run-1',
          level: 'warning',
          event: 'capability.audit',
          message: 'Quota is close to the configured limit.',
          createdAt: '2026-09-01T00:01:00.000Z'
        }]
      }}
      error={null}
      isZh
      loading={false}
      onReload={() => undefined}
    />
  )

  assert.match(html, /当前权限/)
  assert.match(html, /documents\.read@1/)
  assert.match(html, /版本历史/)
  assert.match(html, /2\.0\.0/)
  assert.match(html, /最近运行日志/)
  assert.match(html, /capability\.audit/)
  assert.match(html, /Quota is close/)
})

test('plugin inspector details expose loading and retry states', () => {
  const loading = renderToStaticMarkup(
    <PluginV2TechnicalDetails details={null} error={null} isZh loading onReload={() => undefined} />
  )
  assert.match(loading, /正在读取权限/)

  const failed = renderToStaticMarkup(
    <PluginV2TechnicalDetails details={null} error="details failed" isZh={false} loading={false} onReload={() => undefined} />
  )
  assert.match(failed, /details failed/)
  assert.match(failed, /Retry/)
})
