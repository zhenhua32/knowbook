import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { listWindowsRestoreProcesses, parseRestoreProcessQueryTrace, stopDatabaseRestoreProcesses, type RestoreObservedProcess } from '../src/main/database/restore-process-guard'

function identity(name: string) {
  const userDataRoot = resolve('fixture', 'restore-query-owned-exit')
  const expected = { pid: process.pid === 41076 ? 41080 : 41076, executable: resolve(name), startToken: 'windows:original',
    serviceEntry: resolve(userDataRoot, 'system-plugins', 'runtime', 'fixture', 'service.cjs') }
  const observed: RestoreObservedProcess = { pid: expected.pid, executable: expected.executable, startToken: expected.startToken,
    name, argv: [expected.executable, expected.serviceEntry] }
  return { userDataRoot, expected, observed }
}

test('owned exit waits through unreadable original-creation CIM tails until a fresh complete absence', async () => {
  const { userDataRoot, expected, observed } = identity('electron.exe')
  let queries = 0, terminated = false
  const tail: RestoreObservedProcess = { ...observed, executable: null, argv: null }
  const stopped = await stopDatabaseRestoreProcesses({ userDataRoot, identities: [expected],
    list: async () => { queries++; return !terminated ? [observed] : queries <= 4 ? [tail] : [] },
    terminate: pid => { assert.equal(pid, expected.pid); assert.equal(terminated, false); terminated = true } })
  assert.deepEqual(stopped, [expected.pid])
  assert.ok(queries >= 5, 'The unreadable tail itself must never prove the original process is gone')
})

test('owned exit still waits for the original creation when its remaining readable argv no longer identifies the service', async () => {
  const { userDataRoot, expected, observed } = identity('electron.exe')
  let queries = 0, terminated = false
  const tail: RestoreObservedProcess = { ...observed, argv: [expected.executable, 'partial-readable-tail'] }
  const stopped = await stopDatabaseRestoreProcesses({ userDataRoot, identities: [expected],
    list: async () => { queries++; return !terminated ? [observed] : queries <= 4 ? [tail] : [] },
    terminate: pid => { assert.equal(pid, expected.pid); assert.equal(terminated, false); terminated = true } })
  assert.deepEqual(stopped, [expected.pid])
  assert.ok(queries >= 5, 'Changed readable metadata cannot prove that the original creation is gone')
})

test('unreadable known Node identity blocks restore before any termination even when its name is outside the host heuristic', async () => {
  const { userDataRoot, expected, observed } = identity('node.exe')
  let queries = 0
  await assert.rejects(stopDatabaseRestoreProcesses({ userDataRoot, identities: [expected],
    list: async () => { queries++; return [{ ...observed, argv: null }] },
    terminate: () => assert.fail('An unreadable identity cannot authorize termination') }), /无法读取后台进程/)
  assert.equal(queries, 2)
})

test('unreadable reused Node PID after an owned termination cannot stand for that original creation or prove absence', async () => {
  const { userDataRoot, expected, observed } = identity('node.exe')
  let terminated = false, queries = 0
  await assert.rejects(stopDatabaseRestoreProcesses({ userDataRoot, identities: [expected],
    list: async () => { queries++; return [terminated ? { ...observed, argv: null, startToken: 'windows:reused' } : observed] },
    terminate: pid => { assert.equal(pid, expected.pid); assert.equal(terminated, false); terminated = true } }), /无法读取后台进程/)
  assert.equal(queries, 4)
})

test('a persistent owned unreadable tail still blocks replacement at the original exit deadline', async context => {
  const { userDataRoot, expected, observed } = identity('electron.exe')
  let terminated = false, clock = 0
  context.mock.method(Date, 'now', () => clock += 10_001)
  await assert.rejects(stopDatabaseRestoreProcesses({ userDataRoot, identities: [expected],
    list: async () => [{ ...observed, argv: terminated ? null : observed.argv }],
    terminate: pid => { assert.equal(pid, expected.pid); assert.equal(terminated, false); terminated = true } }), /尚未退出/)
  assert.equal(terminated, true)
})

test('process query trace exposes only fixed phase names and bounded elapsed times from private stderr', () => {
  const privateText = 'private-command-token-and-profile-path'
  const input = [privateText, 'knowbook-restore-process:started', 'knowbook-restore-timing:started:8',
    'knowbook-restore-process:argv-ready', 'knowbook-restore-timing:argv-ready:33',
    'knowbook-restore-timing:reading-processes:120001', 'knowbook-restore-timing:encoding-result:999999999999',
    'knowbook-restore-timing:complete:-1', 'knowbook-restore-timing:complete:1e3',
    'prefix knowbook-restore-process:complete', 'knowbook-restore-timing:future:7',
    'knowbook-restore-process:complete:' + privateText].join('\r\n')
  const value = parseRestoreProcessQueryTrace(input)
  assert.deepEqual(value, { phases: ['knowbook-restore-process:started', 'knowbook-restore-process:argv-ready'],
    timings: [{ phase: 'started', elapsedMs: 8 }, { phase: 'argv-ready', elapsedMs: 33 }] })
  assert.equal(JSON.stringify(value).includes(privateText), false)
  assert.deepEqual(parseRestoreProcessQueryTrace('knowbook-restore-process:signatures-ready\nknowbook-restore-timing:signatures-ready:17\nknowbook-restore-process:fixture-ready\nknowbook-restore-timing:fixture-ready:19\n' + privateText), {
    phases: ['knowbook-restore-process:signatures-ready', 'knowbook-restore-process:fixture-ready'],
    timings: [{ phase: 'signatures-ready', elapsedMs: 17 }, { phase: 'fixture-ready', elapsedMs: 19 }]
  })
  assert.deepEqual(parseRestoreProcessQueryTrace('knowbook-restore-process:encoded-result\nknowbook-restore-timing:encoded-result:44\n' + privateText), {
    phases: ['knowbook-restore-process:encoded-result'], timings: [{ phase: 'encoded-result', elapsedMs: 44 }]
  })
})

test('process query trace keeps only its final five bounded observations and ignores non-text data', () => {
  const input = Array.from({ length: 10 }, (_, index) => 'knowbook-restore-process:started\nknowbook-restore-timing:started:' + index).join('\n')
  const value = parseRestoreProcessQueryTrace(input)
  assert.equal(value.phases.length, 5)
  assert.deepEqual(value.timings.map(item => item.elapsedMs), [5, 6, 7, 8, 9])
  for (const data of [undefined, null, 99, {}, ['knowbook-restore-process:complete']]) assert.deepEqual(parseRestoreProcessQueryTrace(data), { phases: [], timings: [] })
})

async function withChild(kind: 'node' | 'powershell', run: (child: ChildProcess, args: string[]) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'knowbook query interop 中文 '))
  const entry = join(root, 'system-plugins', 'runtime', 'fixture', 'service.' + (kind === 'node' ? 'cjs' : 'ps1'))
  mkdirSync(join(entry, '..'), { recursive: true })
  writeFileSync(entry, kind === 'node' ? 'setInterval(() => {}, 1000)' : 'param([string]$Marker)\nwhile ($true) { Start-Sleep -Milliseconds 500 }')
  const args = kind === 'node' ? [entry, '', 'two words', '汉字😀', 'literal"quote', 'before\\\"after', '\\server\\share\\', '\t',
    '$(not a command); & literal', 'line one\r\nline two\b\f', '\u2028\u2029', '--knowbookService=fixture'] : ['-NoProfile', '-NonInteractive', '-File', entry, 'kNoWbOoKsErViCe']
  const child = spawn(kind === 'node' ? process.execPath : 'powershell.exe', args,
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: 'ignore' })
  const ended = once(child, 'exit')
  try { await once(child, 'spawn'); await run(child, args) }
  catch (error) {
    const cause = error instanceof Error ? error.cause : undefined
    if (cause instanceof Error) {
      const failed = cause as Error & { code?: unknown; signal?: unknown; killed?: unknown; stdout?: unknown; stderr?: unknown }
      // The execFile cause retains private command lines. Keep only fixed
      // phase/timing tokens and bounded exit metadata when a real query fails.
      console.error(JSON.stringify({ kind: 'restore-process-query-failure',
        code: typeof failed.code === 'number' && Number.isSafeInteger(failed.code) ? failed.code
          : typeof failed.code === 'string' && /^E[A-Z0-9_]{1,63}$/.test(failed.code) ? failed.code : null,
        signal: failed.signal === 'SIGTERM' || failed.signal === 'SIGKILL' ? failed.signal : null,
        killed: failed.killed === true,
        stdoutBytes: typeof failed.stdout === 'string' ? Buffer.byteLength(failed.stdout) : Buffer.isBuffer(failed.stdout) ? failed.stdout.byteLength : null,
        stderrBytes: typeof failed.stderr === 'string' ? Buffer.byteLength(failed.stderr) : Buffer.isBuffer(failed.stderr) ? failed.stderr.byteLength : null,
        ...parseRestoreProcessQueryTrace(failed.stderr) }))
    }
    throw error
  }
  finally {
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await ended
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
}

test('real Windows query preserves native empty quoted Unicode and shell-looking argv plus stable creation identity', { skip: process.platform !== 'win32' }, () => withChild('node', async (child, args) => {
  const observed = (await listWindowsRestoreProcesses()).find(row => row.pid === child.pid)
  assert.ok(observed?.argv); assert.ok(observed.executable)
  assert.deepEqual(observed.argv.slice(1), args)
  assert.match(observed.startToken, /^windows:[0-9]+$/)
  const fresh = (await listWindowsRestoreProcesses()).find(row => row.pid === child.pid)
  assert.equal(fresh?.startToken, observed.startToken)
  assert.equal(fresh?.executable, observed.executable)
  assert.deepEqual(fresh?.argv, observed.argv)
}))

test('real Windows query keeps the original case-insensitive service marker for a non-Node PowerShell process', { skip: process.platform !== 'win32' }, () => withChild('powershell', async (child, args) => {
  const observed = (await listWindowsRestoreProcesses()).find(row => row.pid === child.pid)
  assert.ok(observed?.argv); assert.ok(observed.executable)
  assert.equal(observed.name?.toLowerCase(), 'powershell.exe')
  assert.deepEqual(observed.argv.slice(1), args)
  assert.match(observed.startToken, /^windows:[0-9]+$/)
}))
