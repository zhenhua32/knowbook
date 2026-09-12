'use strict'

/** @typedef {import('../../src/shared/system-plugin-sdk').SystemPluginServiceRpcJson} Json */
/** @typedef {import('../../src/shared/system-plugin-sdk').FullTrustPluginContext} Context */

const PREFIX_KEY = 'activity-pulse.summary-prefix'
const ACTIVITY_KEY = 'activity-pulse.latest-activity'

/** @param {Context} api */
function readState(api) {
  const storedActivity = api.settings.get(ACTIVITY_KEY)
  /** @type {Json} */
  let activity = null
  if (storedActivity) {
    try { activity = JSON.parse(storedActivity) } catch { /* Older invalid state is ignored. */ }
  }
  return { summaryPrefix: api.settings.get(PREFIX_KEY) ?? '', activity }
}

/** @param {Json | undefined} input @param {string} key */
function requireString(input, key) {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input[key] : undefined
  if (typeof value !== 'string') throw new Error(`Activity Pulse: ${key} must be a string.`)
  return value
}

/** @type {import('../../src/shared/system-plugin-sdk').SystemPluginLifecycle<Context>} */
module.exports = {
  activate(api) {
    // This executes only after the user confirms this v3 artifact and restarts.
    // Migrate the previous text value once; existing v3 settings always win.
    if (api.settings.get(PREFIX_KEY) === null) {
      api.settings.set(PREFIX_KEY, api.settings.get('plugin.setting.activity-pulse.summary-prefix') ?? '')
    }
    api.renderer.handle('get-state', () => readState(api))
    api.renderer.handle('set-summary-prefix', (input) => {
      const prefix = requireString(input, 'prefix')
      if (prefix.length > 1_000) throw new Error('摘要前缀不能超过 1000 个字符。')
      api.settings.set(PREFIX_KEY, prefix)
      return readState(api)
    })
    api.renderer.handle('summary-from-first-block', async (input) => {
      const documentId = requireString(input, 'documentId')
      const document = api.documents.get(documentId)
      if (!document) throw new Error('文档不存在或已被删除。')
      const first = document.blocks.find((block) => typeof block.content === 'string' && block.content.trim())
      if (!first) return { message: '没有找到非空内容块，原摘要已保留。', refreshDocument: false }
      const prefix = api.settings.get(PREFIX_KEY) ?? ''
      const body = first.content.trim().replace(/\s+/g, ' ').slice(0, 80)
      const summary = prefix.trim() ? `${prefix}${body}` : body
      await api.documents.update(documentId, {
        title: document.title, blocks: document.blocks, summary
      })
      console.info(`Activity Pulse: 已从首个内容块更新“${document.title}”的摘要。`)
      return { message: '已从首个非空内容块更新摘要。', refreshDocument: true }
    })
    api.registerDisposable(api.events.subscribe((event) => {
      if (event.type !== 'document.created' && event.type !== 'document.updated') return
      api.settings.set(ACTIVITY_KEY, JSON.stringify({
        type: event.type,
        documentId: event.documentId,
        documentTitle: event.documentTitle || '未命名文档',
        createdAt: event.createdAt
      }))
    }), 'Activity Pulse document events')
  }
}
