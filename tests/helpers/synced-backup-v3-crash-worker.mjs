import fs from 'node:fs'
import { resolve } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import { parentPort, workerData } from 'node:worker_threads'
import { register } from 'tsx/esm/api'

// A finite test-only IO boundary. Production receives the unchanged real job.
const destination = resolve(workerData.destination), originalMkdir = fs.mkdirSync
fs.mkdirSync = function (path, ...options) {
  if (resolve(String(path)) === destination) {
    parentPort.postMessage({ kind: 'v3-before-first-external-directory', destination, snapshotId: workerData.snapshotId })
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
    throw new Error('A terminated crash-boundary worker must not resume its filesystem write')
  }
  return Reflect.apply(originalMkdir, this, [path, ...options])
}
syncBuiltinESMExports()
register()
await import('../../src/main/backup/export-worker.ts')
