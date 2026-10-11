import { execFile, spawn } from 'node:child_process'
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

function processIsRunning(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // Permission failures do not prove that the launched process has stopped.
    return error.code === 'ESRCH' ? false : null
  }
}

async function forceStopProcess(child, killWaitMs) {
  if (process.platform === 'win32') {
    await new Promise((resolve_, reject) => {
      execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true, timeout: killWaitMs
      }, (error) => error ? reject(error) : resolve_())
    })
  } else if (!child.kill('SIGKILL')) {
    throw new Error('The launched process did not accept SIGKILL')
  }
}

/** Keep process termination separate from final stdout/stderr delivery. */
export function collectPackagedRuntimeSmoke(child, {
  profile, resultPath, timeoutMs = 90_000, killWaitMs = 5_000,
  isProcessRunning = processIsRunning, forceStop = forceStopProcess
}) {
  let stopped = false
  let finished = false
  let profileRemoved = false
  const removeProfile = () => {
    if (profileRemoved) return
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    profileRemoved = true
  }
  return new Promise((resolve_, reject) => {
    let output = ''
    let timedOut = false
    let settled = false
    let closeObserved = false
    let spawnError
    let killError = null
    let killAccepted = null
    let killTimeout
    let exitObserved = null
    let deadlineState = null
    let watchdogState = null
    const markStopped = () => {
      if (stopped) return
      stopped = true
      if (finished) {
        // A host may exit after a genuine termination failure was reported.
        // Its formerly active profile can then be released safely.
        try { removeProfile() } catch (error) {
          console.error(`Could not remove stopped runtime smoke profile ${profile}: ${error.message}`)
        }
      }
    }
    const snapshot = () => ({
      pid: child.pid ?? null, exitObserved, closeObserved,
      running: stopped || exitObserved || closeObserved || (spawnError && !child.pid)
        ? false : child.pid ? isProcessRunning(child.pid) : null,
      stdoutEnded: child.stdout.readableEnded, stderrEnded: child.stderr.readableEnded,
      stdoutDestroyed: child.stdout.destroyed, stderrDestroyed: child.stderr.destroyed,
      killAccepted, killError
    })
    const finish = (error, result) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      clearTimeout(killTimeout)
      if (error) reject(error)
      else resolve_(result)
    }
    const failure = (reason) => {
      const result = readResult(resultPath)
      const diagnostic = result.error ?? JSON.stringify(result.value)
      const lifecycle = deadlineState
        ? ` Process state at deadline: ${JSON.stringify(deadlineState)}. Process state at watchdog: ${JSON.stringify(watchdogState)}.`
        : ''
      return new Error(`Packaged runtime smoke ${reason}.${lifecycle} Result: ${diagnostic}.\n${output}`)
    }
    const finishStoppedTimeout = () => {
      markStopped()
      // A stopped host can leave its pipe close notifications pending. Timeout
      // already means failure, so release these pipes without awaiting more output.
      child.stdout.destroy()
      child.stderr.destroy()
      finish(failure('timed out'))
    }
    const capture = (chunk) => { output = (output + chunk.toString()).slice(-8_000) }
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)
    child.once('exit', (code, signal) => {
      exitObserved = { code, signal }
      markStopped()
      if (settled) {
        child.stdout.destroy()
        child.stderr.destroy()
      }
    })
    child.on('error', (error) => {
      if (!child.pid) {
        spawnError = error
        markStopped()
      } else {
        killError = error.message
      }
    })
    child.once('close', (code, signal) => {
      closeObserved = true
      markStopped()
      if (settled) return
      if (spawnError || timedOut || code !== 0) {
        const reason = spawnError ? `could not start: ${spawnError.message}`
          : timedOut ? 'timed out' : `exited with code ${code}${signal ? ` (${signal})` : ''}`
        finish(failure(reason))
        return
      }
      const result = readResult(resultPath)
      if (result.value?.status !== 'passed') {
        finish(failure('exited with code 0'))
      } else {
        finish(null, { output, result: result.value })
      }
    })
    const timeout = setTimeout(() => {
      deadlineState = snapshot()
      timedOut = true
      if (deadlineState.running !== false) {
        try { killAccepted = child.kill('SIGKILL') } catch (error) { killError = error.message }
      }
      if (settled) return
      killTimeout = setTimeout(async () => {
        watchdogState = snapshot()
        if (watchdogState.running === false) {
          finishStoppedTimeout()
          return
        }
        // Only target the exact still-live PID owned by this spawn. Unknown
        // liveness is insufficient evidence to invoke a platform kill command.
        if (watchdogState.running === true && child.pid) {
          try { await forceStop(child, killWaitMs) } catch (error) { killError = error.message }
          if (settled) return
          watchdogState = snapshot()
          if (watchdogState.running === false) {
            finishStoppedTimeout()
            return
          }
        }
        finish(failure(`timed out and did not stop; profile retained at ${profile}`))
      }, killWaitMs)
    }, timeoutMs)
  }).finally(() => {
    finished = true
    // Pipe drainage is not a liveness test. Only an observed exit/close, a
    // failed spawn, or ESRCH for the launched PID permits profile removal.
    if (stopped) removeProfile()
  })
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
  let child
  try {
    child = spawn(executable, [
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
  } catch (error) {
    // A synchronous spawn error never created a process owning this profile.
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    throw error
  }
  return await collectPackagedRuntimeSmoke(child, { profile, resultPath, timeoutMs, killWaitMs })
}
