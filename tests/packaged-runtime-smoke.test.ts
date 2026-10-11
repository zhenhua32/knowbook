import assert from 'node:assert/strict'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { getElectronLaunchTarget } from '../e2e-tests/helpers/electron.ts'
import { collectPackagedRuntimeSmoke, resolvePackagedExecutable, runPackagedRuntimeSmoke } from '../scripts/lib/packaged-runtime-smoke.mjs'

test('packaged executable discovery supports all release layouts and explicit paths with spaces', () => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-packaged-paths-'))
  try {
    const layouts = [
      ['win32', 'x64', 'release/win-unpacked/KnowBook.exe'],
      ['linux', 'x64', 'release/linux-unpacked/knowbook'],
      ['darwin', 'x64', 'release/mac/KnowBook.app/Contents/MacOS/KnowBook'],
      ['darwin', 'arm64', 'release/mac-arm64/KnowBook.app/Contents/MacOS/KnowBook']
    ] as const
    for (const [, , relativePath] of layouts) {
      const path = resolve(root, relativePath)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, '')
    }
    for (const [platform, arch, relativePath] of layouts) {
      assert.equal(resolvePackagedExecutable({ executable: '', cwd: root, platform, arch }), resolve(root, relativePath))
    }
    const explicit = join(root, 'custom build', 'KnowBook.exe')
    mkdirSync(dirname(explicit))
    writeFileSync(explicit, '')
    assert.equal(resolvePackagedExecutable({ executable: 'custom build/KnowBook.exe', cwd: root }), explicit)
    assert.throws(() => resolvePackagedExecutable({ executable: 'missing.exe', cwd: root }), /executable is missing/)
    assert.throws(() => resolvePackagedExecutable({ executable: 'custom build', cwd: root }), /executable is missing/)

    const packaged = getElectronLaunchTarget(explicit)
    assert.equal(packaged.executablePath, explicit)
    assert.ok(packaged.args.includes('--no-sandbox'))
    assert.ok(!packaged.args.includes('.'), 'packaged launch must not load the repository app instead')
    assert.equal(getElectronLaunchTarget('').args.at(-1), '.')
    assert.throws(() => getElectronLaunchTarget(join(root, 'missing.exe')), /executable is missing/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

class ControlledSmokeProcess extends EventEmitter {
  readonly pid = 41_601
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly killSignals: string[] = []
  exitCode: number | null = null
  signalCode: string | null = null
  running: boolean | null = true
  killAccepted = true
  onKill?: () => void

  kill(signal: string): boolean {
    this.killSignals.push(signal)
    this.onKill?.()
    return this.killAccepted
  }

  exit(code: number | null, signal: string | null): void {
    this.running = false
    this.exitCode = code
    this.signalCode = signal
    this.emit('exit', code, signal)
  }
}

async function withControlledSmoke(
  callback: (child: ControlledSmokeProcess, profile: string, resultPath: string) => Promise<void>
): Promise<void> {
  const profile = mkdtempSync(join(tmpdir(), 'knowbook-controlled-smoke-'))
  const resultPath = join(profile, 'runtime-smoke-result.json')
  writeFileSync(resultPath, JSON.stringify({ status: 'passed', profile }))
  const child = new ControlledSmokeProcess()
  try {
    await callback(child, profile, resultPath)
  } finally {
    child.stdout.destroy()
    child.stderr.destroy()
    rmSync(profile, { recursive: true, force: true })
  }
}

test('runtime smoke success waits for final output and close after the host exits', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await withControlledSmoke(async (child, profile, resultPath) => {
    let settled = false
    const pending = collectPackagedRuntimeSmoke(child as unknown as ChildProcess, {
      profile, resultPath, timeoutMs: 100,
      isProcessRunning: () => child.running
    })
    void pending.then(() => { settled = true }, () => { settled = true })
    child.stdout.write('first output\n')
    child.exit(0, null)
    t.mock.timers.tick(99)
    await Promise.resolve()
    assert.equal(settled, false)
    assert.equal(existsSync(profile), true, 'result files remain until final output is collected')
    child.stdout.write('final output\n')
    child.stderr.write('last diagnostic\n')
    child.emit('close', 0, null)
    const result = await pending
    assert.equal(result.output, 'first output\nfinal output\nlast diagnostic\n')
    assert.deepEqual(child.killSignals, [])
    assert.equal(existsSync(profile), false)
  })
})

test('runtime smoke cleans an exited host when pipe close arrives after the termination deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await withControlledSmoke(async (child, profile, resultPath) => {
    let forceStops = 0
    child.onKill = () => child.exit(null, 'SIGKILL')
    const rejected = assert.rejects(collectPackagedRuntimeSmoke(child as unknown as ChildProcess, {
      profile, resultPath, timeoutMs: 4, killWaitMs: 5,
      isProcessRunning: () => child.running,
      forceStop: async () => { forceStops += 1 }
    }), (error: Error) => {
      assert.match(error.message, /timed out/)
      assert.match(error.message, /Process state at deadline: .*"running":true/)
      assert.match(error.message, /Process state at watchdog: .*"running":false/)
      assert.doesNotMatch(error.message, /did not stop|profile retained/)
      return true
    })
    t.mock.timers.tick(4)
    assert.equal(existsSync(profile), true)
    assert.equal(child.stdout.destroyed, false)
    t.mock.timers.tick(5)
    await rejected
    assert.deepEqual(child.killSignals, ['SIGKILL'])
    assert.equal(forceStops, 0)
    assert.equal(child.stdout.destroyed, true)
    assert.equal(child.stderr.destroyed, true)
    assert.equal(existsSync(profile), false)
    child.emit('close', null, 'SIGKILL')
  })
})

test('runtime smoke verifies only its launched PID when exit and close notifications are delayed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await withControlledSmoke(async (child, profile, resultPath) => {
    const probedPids: number[] = []
    let forceStops = 0
    child.onKill = () => { child.running = false }
    const rejected = assert.rejects(collectPackagedRuntimeSmoke(child as unknown as ChildProcess, {
      profile, resultPath, timeoutMs: 4, killWaitMs: 5,
      isProcessRunning: (pid) => { probedPids.push(pid); return child.running },
      forceStop: async () => { forceStops += 1 }
    }), (error: Error) => {
      assert.match(error.message, /Process state at watchdog: .*"exitObserved":null.*"running":false/)
      assert.doesNotMatch(error.message, /profile retained/)
      return true
    })
    t.mock.timers.tick(4)
    t.mock.timers.tick(5)
    await rejected
    assert.deepEqual(probedPids, [child.pid, child.pid])
    assert.equal(forceStops, 0, 'An absent process must not be targeted again')
    assert.equal(existsSync(profile), false)
  })
})

test('runtime smoke retains a live profile after real termination failure and cleans after a later exit', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await withControlledSmoke(async (child, profile, resultPath) => {
    const forcedPids: number[] = []
    child.killAccepted = false
    const rejected = assert.rejects(collectPackagedRuntimeSmoke(child as unknown as ChildProcess, {
      profile, resultPath, timeoutMs: 4, killWaitMs: 5,
      isProcessRunning: () => child.running,
      forceStop: async (ownedChild) => {
        forcedPids.push(ownedChild.pid!)
        throw new Error('Access denied while terminating the owned process')
      }
    }), (error: Error) => {
      assert.match(error.message, /timed out and did not stop; profile retained/)
      assert.match(error.message, /Process state at deadline: .*"running":true/)
      assert.match(error.message, /Process state at watchdog: .*"running":true.*"killAccepted":false/)
      assert.match(error.message, /Access denied while terminating the owned process/)
      return true
    })
    t.mock.timers.tick(4)
    t.mock.timers.tick(5)
    await rejected
    assert.deepEqual(forcedPids, [child.pid])
    assert.equal(child.stdout.destroyed, false)
    assert.equal(child.stderr.destroyed, false)
    assert.equal(existsSync(profile), true)
    child.exit(null, 'SIGKILL')
    assert.equal(existsSync(profile), false, 'late confirmed exit must release the retained profile')
    assert.equal(child.stdout.destroyed, true)
    assert.equal(child.stderr.destroyed, true)
  })
})

test('runtime smoke retries termination only for its still-live owned process and then cleans', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await withControlledSmoke(async (child, profile, resultPath) => {
    const forcedPids: number[] = []
    child.killAccepted = false
    const rejected = assert.rejects(collectPackagedRuntimeSmoke(child as unknown as ChildProcess, {
      profile, resultPath, timeoutMs: 4, killWaitMs: 5,
      isProcessRunning: () => child.running,
      forceStop: async (ownedChild, waitMs) => {
        assert.equal(waitMs, 5)
        forcedPids.push(ownedChild.pid!)
        child.running = false
      }
    }), (error: Error) => {
      assert.match(error.message, /timed out/)
      assert.match(error.message, /Process state at watchdog: .*"running":false/)
      assert.doesNotMatch(error.message, /did not stop|profile retained/)
      return true
    })
    t.mock.timers.tick(4)
    t.mock.timers.tick(5)
    await rejected
    assert.deepEqual(forcedPids, [child.pid])
    assert.equal(existsSync(profile), false)
  })
})

test('runtime smoke preserves its profile without a platform kill when PID liveness is unknown', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  await withControlledSmoke(async (child, profile, resultPath) => {
    child.running = null
    let forceStops = 0
    const rejected = assert.rejects(collectPackagedRuntimeSmoke(child as unknown as ChildProcess, {
      profile, resultPath, timeoutMs: 4, killWaitMs: 5,
      isProcessRunning: () => child.running,
      forceStop: async () => { forceStops += 1 }
    }), /profile retained/)
    t.mock.timers.tick(4)
    t.mock.timers.tick(5)
    await rejected
    assert.equal(forceStops, 0, 'Unknown liveness cannot authorize another platform kill')
    assert.equal(existsSync(profile), true)
    child.exit(null, 'SIGKILL')
    assert.equal(existsSync(profile), false)
  })
})

const fixtureSource = `
import { writeFileSync } from 'node:fs'
const resultPath = process.env.KNOWBOOK_PACKAGED_PLUGIN_RUNTIME_SMOKE_RESULT
const mode = process.env.SMOKE_TEST_MODE
const profile = process.env.KNOWBOOK_USER_DATA_DIR
if (process.env.APPDATA !== profile || process.env.LOCALAPPDATA !== profile) process.exit(2)
if (!process.argv.includes('--no-sandbox') || !process.argv.includes('--user-data-dir=' + profile)) process.exit(3)
if (mode === 'invalid') writeFileSync(resultPath, '{not-json')
else if (mode !== 'missing') writeFileSync(resultPath, JSON.stringify({
  status: mode === 'nonzero' || mode === 'timeout' ? 'passed' : mode,
  profile,
  error: mode === 'failed' ? 'activation failed' : undefined
}))
console.log('fixture reached final output')
if (mode === 'timeout') {
  writeFileSync(process.env.SMOKE_PID_PATH, String(process.pid))
  setInterval(() => {}, 1000)
} else {
  process.exitCode = mode === 'nonzero' ? 7 : 0
}
`

test('packaged runtime smoke requires a passed result and a successful exit and cleans every profile', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'knowbook-smoke-runner-test-'))
  const fixture = join(root, 'probe.mjs')
  const profiles = join(root, 'profiles')
  mkdirSync(profiles)
  writeFileSync(fixture, fixtureSource)
  // Result/exit-code cases use the real smoke budget. A separate hung-process
  // case below supplies a short deadline to verify timeout and termination.
  const run = (mode: string, timeoutMs?: number) => runPackagedRuntimeSmoke({
    executable: process.execPath,
    args: [fixture],
    env: { ELECTRON_RUN_AS_NODE: '1', SMOKE_TEST_MODE: mode, SMOKE_PID_PATH: join(root, 'child.pid') },
    profileParent: profiles,
    timeoutMs
  })
  try {
    await t.test('a passed result is collected after stdout drains', async () => {
      const result = await run('passed')
      assert.equal(result.result.status, 'passed')
      assert.match(result.output, /fixture reached final output/)
      assert.equal(existsSync(String(result.result.profile)), false)
    })
    for (const mode of ['missing', 'started', 'failed', 'invalid', 'nonzero']) {
      await t.test(`rejects ${mode} result`, async () => {
        await assert.rejects(run(mode), (error: Error) => {
          assert.match(error.message, mode === 'nonzero' ? /code 7/ : /code 0/)
          assert.match(error.message, /fixture reached final output/)
          if (mode === 'failed') assert.match(error.message, /activation failed/)
          if (mode === 'missing' || mode === 'invalid') assert.match(error.message, /result is missing or invalid/)
          return true
        })
        assert.deepEqual(readdirSync(profiles), [])
      })
    }
    await t.test('a hung probe is killed before its profile is deleted, even with a passed result', async () => {
      await assert.rejects(run('timeout', 4_000), (error: Error) => {
        assert.match(error.message, /timed out/)
        assert.match(error.message, /Process state at deadline/)
        return true
      })
      const pid = Number(readFileSync(join(root, 'child.pid'), 'utf8'))
      assert.throws(() => process.kill(pid, 0), /ESRCH/)
      assert.deepEqual(readdirSync(profiles), [])
    })
    await t.test('spawn failures reject and clean the profile', async () => {
      await assert.rejects(runPackagedRuntimeSmoke({
        executable: join(root, 'missing-executable'),
        profileParent: profiles
      }), /could not start/)
      assert.deepEqual(readdirSync(profiles), [])
    })
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
