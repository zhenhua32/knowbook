import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import type { SystemPluginManagedResourceSummary } from '../src/shared/contracts'
import { SystemPluginResources } from '../src/renderer/src/components/SystemPluginResources'

test('plugin resource inspector preserves resource types and distinguishes privileged popups from registered frame policies', () => {
  const revisionHash = 'sha256:fixture'
  const resources: SystemPluginManagedResourceSummary[] = [
    { id: 'sdk-window', kind: 'window', source: 'desktop-sdk', label: 'SDK window', revisionHash },
    { id: 'menu', kind: 'menu', source: 'desktop-sdk', label: 'Tools', revisionHash },
    { id: 'tray', kind: 'tray', source: 'desktop-sdk', label: 'Tray', revisionHash },
    { id: 'popup', kind: 'window', source: 'renderer-frame', label: 'Child <window>', revisionHash },
    {
      id: 'frame', kind: 'frame', source: 'renderer-frame', label: 'Frame policy', revisionHash,
      allowedOrigins: ['https://example.test'],
      framePolicy: { allowPopups: true, allowNavigation: true, allowDownloads: false, allowPermissions: false }
    }
  ]
  const dom = new JSDOM(renderToStaticMarkup(<SystemPluginResources resources={resources} isZh />))
  const { document } = dom.window
  assert.match(document.body.textContent ?? '', /已登记资源 · 5/)
  assert.match(document.body.textContent ?? '', /窗口 2 · 菜单 1 · 托盘 1 · Frame 1/)
  assert.equal(document.querySelectorAll('[data-resource-kind="window"]').length, 2)
  const popup = document.querySelector('[data-resource-kind="window"][data-resource-source="renderer-frame"]')
  assert.equal(popup?.textContent, 'Frame 特权窗口: Child <window>')
  const frame = document.querySelector('[data-resource-kind="frame"]')
  assert.match(frame?.textContent ?? '', /已登记来源: https:\/\/example\.test/)
  assert.match(frame?.textContent ?? '', /允许弹窗 · 允许导航/)
  assert.doesNotMatch(frame?.textContent ?? '', /允许下载|允许权限请求/)
  assert.match(document.body.textContent ?? '', /计数不代表当前可见数量/)
  dom.window.close()
})

test('plugin resource inspector renders an empty snapshot after resources are released', () => {
  const dom = new JSDOM(renderToStaticMarkup(<SystemPluginResources resources={[]} isZh={false} />))
  assert.match(dom.window.document.body.textContent ?? '', /Registered resources · 0/)
  assert.match(dom.window.document.body.textContent ?? '', /Windows 0 · Menus 0 · Trays 0 · Frames 0/)
  assert.equal(dom.window.document.querySelectorAll('[data-resource-kind]').length, 0)
  dom.window.close()
})
