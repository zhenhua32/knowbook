'use strict'

const fs = require('node:fs')
const path = require('node:path')
/** @type {import('../../src/shared/system-plugin-sdk').FullTrustPluginContext | undefined} */
let context
/** @type {string | undefined} */
let documentId

/** @type {import('../../src/shared/system-plugin-sdk').SystemPluginLifecycle<import('../../src/shared/system-plugin-sdk').FullTrustPluginContext>} */
module.exports = {
  async activate(api) {
    context = api
    const statePath = path.join(api.plugin.dataRoot, 'state.json')
    const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { activations: 0 }
    let document = state.documentId ? api.documents.get(state.documentId) : null
    if (!document) {
      document = await api.documents.create({ title: '系统插件示例', summary: '由 System Plugin v3 的 Documents API 创建。' })
    }
    documentId = document.id
    fs.writeFileSync(statePath, JSON.stringify({ schemaVersion: 1, documentId, activations: state.activations + 1 }, null, 2))
    api.settings.set(`${api.plugin.id}.documentId`, documentId)
    api.registerDisposable(api.events.subscribe((event) => {
      if ('documentId' in event && event.documentId === documentId && event.originPluginId !== api.plugin.id) {
        api.settings.set(`${api.plugin.id}.lastDocumentEvent`, event.type)
      }
    }), 'document event subscription')
  },
  healthCheck() {
    return { ok: Boolean(context && documentId && context.documents.get(documentId)), message: 'Example document is available.' }
  },
  deactivate() { context = undefined },
  // Keep migration bounded and repeatable. Data changes are not undone by a code rollback.
  migrate(api, fromVersion) {
    fs.writeFileSync(path.join(api.plugin.dataRoot, 'migration.json'), JSON.stringify({ fromVersion, toVersion: api.plugin.version }))
  }
}
