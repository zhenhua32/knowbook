'use strict'

const fs = require('node:fs')
const path = require('node:path')

const api = globalThis.knowbookService
if (!api) throw new Error('KnowBook service RPC API was not installed before the service entry.')

void Promise.all([
  api.call('system.ping'),
  api.call('paths.get')
]).then(([ping, paths]) => {
  const dataRoot = process.env.KNOWBOOK_SYSTEM_PLUGIN_DATA_ROOT
  if (!dataRoot) throw new Error('System plugin data root is unavailable.')
  fs.mkdirSync(dataRoot, { recursive: true })
  fs.writeFileSync(path.join(dataRoot, 'service-rpc.json'), JSON.stringify({
    ping,
    paths,
    protocolVersion: api.protocolVersion
  }), 'utf8')
  api.ready({ rpc: true })
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})

const heartbeat = setInterval(() => api.heartbeat({ source: 'acceptance-fixture' }), 250)
const stop = () => {
  clearInterval(heartbeat)
  api.dispose()
  process.exit(0)
}
process.once('SIGTERM', stop)
process.once('SIGINT', stop)
