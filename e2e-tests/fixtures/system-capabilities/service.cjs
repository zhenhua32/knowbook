'use strict'
const fs = require('node:fs')
const path = require('node:path')
const api = globalThis.knowbookService
const dataRoot = process.env.KNOWBOOK_SYSTEM_PLUGIN_DATA_ROOT
const historyPath = path.join(dataRoot, 'service-history.json')
const heartbeatPath = path.join(dataRoot, 'service-heartbeat.json')
const crashPath = path.join(dataRoot, 'crash-service.json')
const startedAt = Date.now()
let ticks = 0
function write(file, value) {
  fs.writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify(value))
  fs.renameSync(`${file}.${process.pid}.tmp`, file)
}
process.on('uncaughtException', error => {
  write(path.join(dataRoot, 'service-error.json'), { pid: process.pid, error: error.stack ?? String(error) })
  process.exit(1)
})
process.on('exit', code => {
  write(path.join(dataRoot, 'service-exit.json'), { pid: process.pid, code, ticks })
})
void Promise.all([api.call('system.ping'), api.call('paths.get')]).then(([ping, paths]) => {
  fs.mkdirSync(dataRoot, { recursive: true })
  const history = fs.existsSync(historyPath) ? JSON.parse(fs.readFileSync(historyPath, 'utf8')) : []
  history.push({ pid: process.pid, startedAt, revisionHash: ping.revisionHash })
  write(historyPath, history)
  write(path.join(dataRoot, 'service-rpc.json'), { ping, paths, protocolVersion: api.protocolVersion, pid: process.pid })
  console.log(`CONTROLLED_CAPABILITY_SERVICE_START ${ping.revisionHash}`)
  api.ready({ rpc: true })
  const heartbeat = setInterval(() => {
    ticks += 1
    write(heartbeatPath, { pid: process.pid, startedAt, ticks, elapsedMs: Date.now() - startedAt })
    try { api.heartbeat({ ticks }) } catch (error) {
      write(path.join(dataRoot, 'service-heartbeat-error.json'), { pid: process.pid, error: String(error) })
    }
    if (ticks % 4 === 0) {
      void api.call('system.ping').then(ping => write(path.join(dataRoot, 'service-reconnect.json'), {
        pid: process.pid, ticks, ping
      })).catch(() => { /* A detached service reconnects when its host returns. */ })
    }
    if (fs.existsSync(crashPath)) {
      process.stderr.write('CONTROLLED_CAPABILITY_SERVICE_CRASH\n')
      process.exit(33)
    }
  }, 250)
  const stop = () => { clearInterval(heartbeat); api.dispose(); process.exit(0) }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
}).catch((error) => { process.stderr.write(`${error.stack}\n`); process.exit(1) })
