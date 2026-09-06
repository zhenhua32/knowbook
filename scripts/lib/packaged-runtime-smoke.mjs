import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export function resolvePackagedExecutable({
  executable = process.env.KNOWBOOK_E2E_EXECUTABLE,
  cwd = process.cwd(),
  platform = process.platform,
  arch = process.arch
} = {}) {
  const macDirectories = arch === 'arm64' ? ['mac-arm64', 'mac'] : ['mac', 'mac-arm64']
  const candidates = executable?.trim()
    ? [resolve(cwd, executable.trim())]
    : platform === 'win32'
      ? [resolve(cwd, 'release', 'win-unpacked', 'KnowBook.exe')]
      : platform === 'darwin'
        ? macDirectories.map((directory) => resolve(cwd, 'release', directory, 'KnowBook.app', 'Contents', 'MacOS', 'KnowBook'))
        : [resolve(cwd, 'release', 'linux-unpacked', 'knowbook')]
  const selected = candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile())
  if (!selected) {
    throw new Error(`Packaged KnowBook executable is missing. Checked: ${candidates.join(', ')}`)
  }
  return selected
}

function readResult(resultPath) {
  try {
    return { value: JSON.parse(readFileSync(resultPath, 'utf8')) }
  } catch (error) {
    return { error: `Runtime smoke result is missing or invalid: ${error.message}` }
  }
}

/** Resolve only after process exit AND a final passed result, then remove the isolated profile. */
export async function runPackagedRuntimeSmoke({
  executable = resolvePackagedExecutable(),
  args = [],
  env = {},
  timeoutMs = 90_000,
  killWaitMs = 5_000,
  profileParent = tmpdir()
} = {}) {
  const profile = mkdtempSync(join(profileParent, 'knowbook-packaged-runtime-smoke-'))
  const resultPath = join(profile, 'runtime-smoke-result.json')
  const inheritedEnv = { ...process.env }
  delete inheritedEnv.ELECTRON_RUN_AS_NODE
  delete inheritedEnv.ELECTRON_RENDERER_URL
  let processStopped = true
  try {
    return await new Promise((resolve_, reject) => {
      const child = spawn(executable, [
        ...args,
        '--no-sandbox',
        '--disable-gpu',
        '--enable-logging=stderr',
        `--user-data-dir=${profile}`
      ], {
        env: {
          ...inheritedEnv,
          ...env,
          APPDATA: profile,
          LOCALAPPDATA: profile,
          KNOWBOOK_DISABLE_HARDWARE_ACCELERATION: '1',
          KNOWBOOK_PACKAGED_PLUGIN_RUNTIME_SMOKE: '1',
          KNOWBOOK_PACKAGED_PLUGIN_RUNTIME_SMOKE_RESULT: resultPath,
          // Isolate app.getPath('userData') and its single-instance lock too.
          KNOWBOOK_USER_DATA_DIR: profile
        },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      processStopped = false
      let output = ''
      let timedOut = false
      let spawnError
      let killTimeout
      const capture = (chunk) => { output = (output + chunk.toString()).slice(-8_000) }
      child.stdout.on('data', capture)
      child.stderr.on('data', capture)
      const timeout = setTimeout(() => {
        timedOut = true
        // Wait for close before deleting files; termination is not synchronous.
        child.kill('SIGKILL')
        killTimeout = setTimeout(() => {
          reject(new Error(`Packaged runtime smoke timed out and did not stop; profile retained at ${profile}.\n${output}`))
        }, killWaitMs)
      }, timeoutMs)
      child.once('error', (error) => {
        spawnError = error
        // Spawn failures still emit close, which owns final cleanup/settlement.
      })
      child.once('close', (code, signal) => {
        processStopped = true
        clearTimeout(timeout)
        clearTimeout(killTimeout)
        const result = readResult(resultPath)
        const diagnostic = result.error ?? JSON.stringify(result.value)
        if (spawnError || timedOut || code !== 0 || result.value?.status !== 'passed') {
          const reason = spawnError
            ? `could not start: ${spawnError.message}`
            : timedOut
              ? 'timed out'
              : `exited with code ${code}${signal ? ` (${signal})` : ''}`
          reject(new Error(`Packaged runtime smoke ${reason}. Result: ${diagnostic}.\n${output}`))
          return
        }
        resolve_({ output, result: result.value })
      })
    })
  } finally {
    // If the OS did not acknowledge termination, preserve the active profile.
    if (processStopped) {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
}
