import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants, copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

export const hash = bytes => createHash('sha256').update(bytes).digest('hex')
export const hashFile = file => hash(readFileSync(file))
export function writeFresh(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
}
export function inventory(folder, skip = new Set()) {
  const rows = []
  function walk(directory, prefix) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const path = prefix + entry.name
      if (skip.has(path)) continue
      const file = join(directory, entry.name), stat = lstatSync(file)
      assert.equal(stat.isSymbolicLink(), false, 'Evidence traversal never follows a symlink: ' + file)
      if (stat.isDirectory()) walk(file, path + '/')
      else {
        assert.equal(stat.isFile(), true, 'Evidence contains only real files: ' + file)
        const bytes = readFileSync(file)
        rows.push({ path, bytes: bytes.length, sha256: hash(bytes) })
      }
    }
  }
  walk(folder, '')
  return rows
}
export function copyTreeFresh(source, target) {
  mkdirSync(target, { recursive: false })
  const rows = inventory(source)
  for (const row of rows) {
    const destination = join(target, ...row.path.split('/'))
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(join(source, ...row.path.split('/')), destination, constants.COPYFILE_EXCL)
  }
  assert.deepEqual(inventory(target), rows, 'The independent raw copy is read back without normalization')
  return rows
}
export function assertWithin(parent, file) {
  const part = relative(resolve(parent), resolve(file))
  assert.ok(part !== '' && part !== '..' && !part.startsWith('..' + sep) && !part.startsWith(sep), 'The verifier owns only its fresh child directory')
}
export function causeMessages(error) {
  const messages = [], visited = new Set()
  function visit(value) {
    if (!value || typeof value !== 'object' || visited.has(value)) return
    visited.add(value)
    if (value instanceof Error) { messages.push(value.name + ': ' + value.message); visit(value.cause) }
    else for (const key of ['cause', 'queryFailure', 'recording', 'cleanup']) visit(value[key])
  }
  visit(error)
  return messages
}
export function dumpRemote(server, directory) {
  mkdirSync(directory, { recursive: false })
  const rows = [...server.files.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, bytes]) => {
    const file = hash(Buffer.from(path)) + '.bin'
    writeFresh(join(directory, file), Buffer.from(bytes))
    return { path, file, bytes: bytes.length, sha256: hash(bytes) }
  })
  writeFresh(join(directory, 'inventory.json'), rows)
  return rows
}
export function dumpRequests(requests, file) {
  writeFresh(file, requests.map((request, index) => ({ index, method: request.method, path: request.path,
    ifMatch: request.ifMatch ?? null, ifNoneMatch: request.ifNoneMatch ?? null,
    overwrite: request.overwrite ?? null, destination: request.destination ?? null,
    bytes: request.bytes.length, sha256: hash(request.bytes), bodyBase64: request.bytes.toString('base64') })))
}
// Synchronous spawn here would block the legacy process's actual HTTP server.
export async function runChild({ name, script, args, cwd, loader, tsconfig, evidence, timeoutMs = 120_000 }) {
  mkdirSync(evidence, { recursive: true })
  const stdoutPath = join(evidence, name + '-stdout.log'), stderrPath = join(evidence, name + '-stderr.log')
  writeFresh(stdoutPath, ''); writeFresh(stderrPath, '')
  const { createWriteStream } = await import('node:fs')
  const stdout = createWriteStream(stdoutPath, { flags: 'a' }), stderr = createWriteStream(stderrPath, { flags: 'a' })
  const stdoutFinished = new Promise((resolve, reject) => { stdout.once('finish', resolve); stdout.once('error', reject) })
  const stderrFinished = new Promise((resolve, reject) => { stderr.once('finish', resolve); stderr.once('error', reject) })
  const startedAt = new Date().toISOString(), started = performance.now()
  const environment = { ...process.env, ELECTRON_RUN_AS_NODE: '1', TSX_TSCONFIG_PATH: tsconfig }
  let launchError = null, timedOut = false
  const child = spawn(process.execPath, ['--import', loader, script, ...args], {
    cwd, windowsHide: true, env: environment, stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.pipe(stdout); child.stderr.pipe(stderr)
  child.on('error', error => { launchError = { name: error.name, message: error.message } })
  const timer = setTimeout(() => { timedOut = true; child.kill() }, timeoutMs)
  const terminal = await new Promise(resolve => child.once('close', (exitCode, signal) => resolve({ exitCode, signal })))
  clearTimeout(timer)
  await Promise.all([stdoutFinished, stderrFinished])
  const report = { name, pid: child.pid ?? null, executable: process.execPath, script, scriptSha256: hashFile(script),
    args, cwd, environment: { ELECTRON_RUN_AS_NODE: '1', TSX_TSCONFIG_PATH: tsconfig },
    startedAt, completedAt: new Date().toISOString(), wallMs: performance.now() - started,
    ...terminal, launchError, timedOut,
    stdout: { path: stdoutPath, bytes: lstatSync(stdoutPath).size, sha256: hashFile(stdoutPath) },
    stderr: { path: stderrPath, bytes: lstatSync(stderrPath).size, sha256: hashFile(stderrPath) } }
  writeFresh(join(evidence, name + '-process.json'), report)
  assert.equal(launchError, null, name + ' must start successfully')
  assert.equal(timedOut, false, name + ' must finish within the existing 120 second child bound')
  assert.equal(terminal.signal, null, name + ' must report a normal process exit')
  assert.equal(terminal.exitCode, 0, name + ' failed; original stdout/stderr and process record are preserved')
  return report
}
