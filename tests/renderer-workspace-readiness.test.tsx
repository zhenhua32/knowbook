import assert from 'node:assert/strict'
import test from 'node:test'
import { register } from 'node:module'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { getUiText } from '../src/renderer/src/i18n'

register(`data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    return nextLoad(url, context)
  }
`)}`, import.meta.url)
const { WorkspaceDashboardSection } = await import('../src/renderer/src/sections/WorkspaceDashboardSection')

test('dashboard describes saved AI configuration without claiming an unverified connection', () => {
  for (const language of ['zh-CN', 'en-US'] as const) {
    for (const [enabled, hasApiKey, expected] of [
      [false, false, language === 'zh-CN' ? '未启用' : 'Disabled'],
      [false, true, language === 'zh-CN' ? '未启用' : 'Disabled'],
      [true, false, language === 'zh-CN' ? '待配置密钥' : 'API key needed'],
      [true, true, language === 'zh-CN' ? '已配置' : 'Configured']
    ] as const) {
      const html = renderToStaticMarkup(<WorkspaceDashboardSection
        isAiEnabled={enabled} hasAiApiKey={hasApiKey} ui={getUiText(language)}
        summary={{ databasePath: '', backupRoot: '', documents: 0, blocks: 0, links: 0, lastBackupAt: null }}
        recentEvents={[]} pluginDashboardCards={[]}
        onBackupNow={() => undefined} onRestoreBackup={() => undefined} onOpenDocument={() => undefined}
      />)
      assert.ok(html.includes(`<strong>${expected}</strong>`), `${language}: enabled=${enabled}, key=${hasApiKey}`)
      assert.doesNotMatch(html, /API ready|API 已就绪|preload bridge/)
    }
  }
})
