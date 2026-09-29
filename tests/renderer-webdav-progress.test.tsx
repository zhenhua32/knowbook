import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import type { WebDavSyncProgress } from '../src/shared/webdav-sync'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
const { default: ProgressView } = await import('../src/renderer/src/sections/WebDavSyncProgress')
const now = Date.parse('2026-09-29T12:00:00Z')
const base: WebDavSyncProgress = { stage: 'uploading', completed: 12, total: 52, attachmentsCompleted: 3, attachmentsTotal: 113,
  currentItem: '项目资料', currentAttachment: '附件.pdf', startedAt: new Date(now - 80_000).toISOString(), requestsCompleted: 18, waitingUntil: null }

test('progress identifies the current stage and displays completed records, attachments and elapsed time', () => {
  const dom = new JSDOM(renderToStaticMarkup(<ProgressView progress={base} isZh now={now} />))
  try {
    const document = dom.window.document, bar = document.querySelector('progress')!
    assert.equal(document.querySelector('[role="status"]')!.textContent, '正在上传文档与附件')
    assert.equal(bar.getAttribute('aria-label'), '本阶段进度')
    assert.equal(bar.max, 165)
    assert.equal(bar.value, 15)
    assert.match(document.body.textContent!, /12 \/ 52/)
    assert.match(document.body.textContent!, /3 \/ 113/)
    assert.match(document.body.textContent!, /附件.pdf/)
    assert.match(document.body.textContent!, /1 分 20 秒/)
  } finally { dom.window.close() }
})

test('unknown connection work stays indeterminate and an expired rate-limit wait is not displayed', () => {
  const progress: WebDavSyncProgress = { ...base, stage: 'checking', total: null, completed: 0, attachmentsTotal: 0, attachmentsCompleted: 0,
    currentItem: null, currentAttachment: null, waitingUntil: new Date(now - 1).toISOString() }
  const dom = new JSDOM(renderToStaticMarkup(<ProgressView progress={progress} isZh={false} now={now} />))
  try {
    assert.equal(dom.window.document.querySelector('progress')!.hasAttribute('value'), false)
    assert.match(dom.window.document.body.textContent!, /Checking connection/)
    assert.match(dom.window.document.body.textContent!, /18 requests completed/)
    assert.doesNotMatch(dom.window.document.body.textContent!, /Waiting for the service rate limit/)
  } finally { dom.window.close() }
  assert.match(renderToStaticMarkup(<ProgressView progress={{ ...progress, waitingUntil: new Date(now + 2100).toISOString() }} isZh now={now} />), /约 3 秒后继续/)
})
