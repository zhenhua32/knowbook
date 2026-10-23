import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import test, { type TestContext } from 'node:test'
import { forceKillOwnedPosixHost } from '../e2e-tests/helpers/posix-process-group'

function ps(pid: number, field: 'pgid' | 'stat'): string | null {
  const result = spawnSync('ps', ['-o', `${field}=`, '-p', String(pid)], {
    encoding: 'utf8', windowsHide: true, timeout: 1_000, stdio: ['ignore', 'pipe', 'pipe']
  })
  if (result.status === 1 && !result.stdout?.trim()) return null
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Owned process fixture did not complete in 10000ms')), 10_000)
    })])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function fixture(t: TestContext, detached = true) {
  const childScript = 'process.stdout.write("owned-child-ready\\n"); setInterval(() => {}, 1000)'
  const hostScript = [
    'const { spawn } = require("node:child_process")',
    `const child = spawn(process.execPath, ["--eval", ${JSON.stringify(childScript)}], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true, stdio: ["ignore", "inherit", "inherit"] })`,
    'process.stdout.write(JSON.stringify({ hostPid: process.pid, childPid: child.pid }) + "\\n")',
    'setInterval(() => {}, 1000)'
  ].join('\n')
  const launcher = spawn(process.execPath, ['--eval', hostScript], {
    detached, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe']
  })
  let closed = false, childPid: number | undefined, output = '', stderr = ''
  const exit = new Promise<void>(resolve => launcher.once('exit', () => resolve()))
  const close = new Promise<void>(resolve => launcher.once('close', () => { closed = true; resolve() }))
  launcher.stderr.on('data', chunk => { stderr += String(chunk) })
  const signal = (pid: number) => {
    try { process.kill(pid, 'SIGKILL') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  t.after(async () => {
    if (closed) return
    if (launcher.pid) {
      // Only this fixture's continuously live host/child can establish its
      // group. A non-detached control must never signal the test runner group.
      if (detached && (ps(launcher.pid, 'pgid') === String(launcher.pid)
        || childPid && ps(childPid, 'pgid') === String(launcher.pid))) signal(-launcher.pid)
      else {
        if (childPid) signal(childPid)
        if (launcher.exitCode === null && launcher.signalCode === null) signal(launcher.pid)
      }
    }
    await bounded(close)
  })
  await bounded(new Promise<void>((resolve, reject) => {
    launcher.once('error', reject)
    launcher.stdout.on('data', chunk => {
      output += String(chunk)
      const lines = output.split('\n')
      lines.pop() // Pipe chunks do not have to end at a complete JSON line.
      const metadata = lines.find(line => line.startsWith('{'))
      if (metadata) childPid = (JSON.parse(metadata) as { childPid: number }).childPid
      if (childPid && output.includes('owned-child-ready\n')) resolve()
    })
    launcher.once('exit', () => reject(new Error(`Fixture exited before its child was ready: ${stderr}`)))
  }))
  assert.ok(launcher.pid && launcher.pid > 1)
  assert.ok(childPid && childPid > 1)
  if (detached) assert.equal(ps(launcher.pid, 'pgid'), String(launcher.pid))
  assert.equal(ps(childPid, 'pgid'), ps(launcher.pid, 'pgid'))
  return { launcher, childPid, exit, close, isClosed: () => closed }
}

test('E2E POSIX cleanup rejects missing, broadcast, self and malformed host identities before signaling', () => {
  for (const pid of [undefined, 0, 1, -1, -1234, 1.5, NaN, Infinity, 2_147_483_648, process.pid]) {
    assert.throws(() => forceKillOwnedPosixHost({ pid: undefined, exitCode: null, signalCode: null }, pid),
      /Cannot identify a safe launched Electron host/)
  }
})

test('E2E POSIX control: killing only the host leaves its child and launcher stdout open', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t)
  process.kill(f.launcher.pid!, 'SIGKILL')
  await bounded(f.exit)
  assert.equal(f.launcher.signalCode, 'SIGKILL')
  assert.equal(ps(f.childPid, 'pgid'), String(f.launcher.pid))
  assert.ok(!ps(f.childPid, 'stat')?.startsWith('Z'))
  assert.equal(f.isClosed(), false)
  assert.equal(f.launcher.stdout.readableEnded, false)
})

test('E2E POSIX owned group kill closes the child-held pipes as well as the host', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t)
  const result = forceKillOwnedPosixHost(f.launcher, f.launcher.pid)
  assert.equal(result.scope, 'owned-process-group')
  assert.equal(result.processGroupId, f.launcher.pid)
  assert.equal(result.signalSent, true)
  await bounded(f.close)
  assert.equal(f.isClosed(), true)
  assert.equal(f.launcher.stdout.readableEnded, true)
  assert.equal(f.launcher.stderr.readableEnded, true)
  const childState = ps(f.childPid, 'stat')
  assert.ok(childState === null || childState.startsWith('Z'), 'The owned child must have exited; an unreaped zombie holds no pipe')
})

test('E2E POSIX intentional-child option keeps the child alive after host-only termination', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t)
  const result = forceKillOwnedPosixHost(f.launcher, f.launcher.pid, true)
  assert.equal(result.scope, 'host-only')
  await bounded(f.exit)
  assert.equal(ps(f.childPid, 'pgid'), String(f.launcher.pid))
  assert.equal(f.isClosed(), false)
})

test('E2E POSIX non-leader launch cannot terminate the parent test process group', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t, false)
  const testGroup = ps(process.pid, 'pgid')
  assert.notEqual(testGroup, String(f.launcher.pid))
  assert.equal(ps(f.launcher.pid!, 'pgid'), testGroup)
  const result = forceKillOwnedPosixHost(f.launcher, f.launcher.pid)
  assert.equal(result.scope, 'host-only')
  assert.equal(String(result.processGroupId), testGroup)
  await bounded(f.exit)
  assert.equal(ps(f.childPid, 'pgid'), testGroup)
  assert.equal(f.isClosed(), false)
})

test('E2E POSIX wrapper mismatch signals only the known host, never the launcher group', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t)
  const result = forceKillOwnedPosixHost(f.launcher, f.childPid)
  assert.equal(result.scope, 'host-only')
  assert.equal(result.processGroupId, null)
  const deadline = Date.now() + 10_000
  let childState = ps(f.childPid, 'stat')
  while (childState !== null && !childState.startsWith('Z') && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20))
    childState = ps(f.childPid, 'stat')
  }
  assert.ok(childState === null || childState.startsWith('Z'))
  assert.equal(f.launcher.exitCode, null)
  assert.equal(f.launcher.signalCode, null)
  assert.equal(f.isClosed(), false)
})

test('E2E POSIX exited launcher does not authorize a cached negative group signal', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t)
  process.kill(f.launcher.pid!, 'SIGKILL')
  await bounded(f.exit)
  const result = forceKillOwnedPosixHost(f.launcher, f.launcher.pid)
  assert.equal(result.scope, 'host-only')
  assert.equal(result.processGroupId, null)
  assert.equal(result.signalSent, false)
  assert.equal(ps(f.childPid, 'pgid'), String(f.launcher.pid))
  assert.equal(f.isClosed(), false)
})
