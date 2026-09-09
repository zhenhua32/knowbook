'use strict'

/** @type {import('../../src/shared/system-plugin-sdk').SystemPluginServiceRpcGlobalApi} */
const api = globalThis.knowbookService
if (!api || api.protocolVersion !== 1) throw new Error('System Plugin service RPC v1 is required.')

// The supervisor owns the transport, reconnection and process identity.
// Service entries keep mutable data in the supplied data root, not the revision.
const fs = require('node:fs')
const path = require('node:path')
const timer = setInterval(() => api.heartbeat({ example: 'starter' }), 1_000)
void api.call('documents.list').then((documents) => {
  const root = process.env.KNOWBOOK_SYSTEM_PLUGIN_DATA_ROOT
  if (!root) throw new Error('Plugin data root is unavailable.')
  fs.writeFileSync(path.join(root, 'service.json'), JSON.stringify({
    protocolVersion: api.protocolVersion,
    revisionHash: api.revisionHash,
    documentCount: Array.isArray(documents) ? documents.length : 0
  }, null, 2))
  api.ready({ example: 'starter' })
}).catch((error) => {
  console.error(error)
  stop(1)
})

function stop(code = 0) {
  clearInterval(timer)
  api.dispose()
  process.exit(code)
}
process.once('SIGTERM', () => stop())
process.once('SIGINT', () => stop())
