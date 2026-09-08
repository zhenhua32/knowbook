const fs = require('node:fs')
const path = require('node:path')
const api = globalThis.knowbookService
const root = process.env.KNOWBOOK_SYSTEM_PLUGIN_DATA_ROOT
const reportPath = path.join(root, 'service-state.json')
const stopPath = path.join(root, 'stop-fixture')
const deadline = Date.now() + 10 * 60_000
const state = { pid: process.pid, ticks: 0, successes: 0, failures: 0, lastRpcAt: null, paths: null }
let busy = false
let stopped = false
function save() {
  fs.writeFileSync(reportPath + '.tmp', JSON.stringify(state))
  fs.renameSync(reportPath + '.tmp', reportPath)
}
function stop() {
  stopped = true
  clearInterval(timer)
  api.dispose()
  process.exit(0)
}
const timer = setInterval(() => {
  if (fs.existsSync(stopPath) || Date.now() >= deadline) return stop()
  state.ticks += 1
  save()
  if (busy) return
  busy = true
  api.call('paths.get', null, { timeoutMs: 1_000 }).then((paths) => {
    if (stopped) return
    state.paths = paths
    state.successes += 1
    state.lastRpcAt = Date.now()
    api.ready({ rpc: true })
    api.heartbeat({ ticks: state.ticks })
  }, () => { state.failures += 1 }).finally(() => { busy = false })
}, 250)
save()
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
