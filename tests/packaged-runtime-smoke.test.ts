import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { getElectronLaunchTarget } from '../e2e-tests/helpers/electron.ts'
import { resolvePackagedExecutable, runPackagedRuntimeSmoke } from '../scripts/lib/packaged-runtime-smoke.mjs'

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
  const run = (mode: string, timeoutMs = 10_000) => runPackagedRuntimeSmoke({
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
      await assert.rejects(run('timeout', 4_000), /timed out/)
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
