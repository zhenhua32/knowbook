import { spawnSync, type ChildProcess } from 'node:child_process'

type Launcher = Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode'>

/** Force only a verified, still-owned POSIX group; wrappers fall back to the exact host. */
export function forceKillOwnedPosixHost(launcher: Launcher, hostPid: number | undefined, preserveDetachedChildren = false) {
  const pid = hostPid ?? launcher.pid
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 1 || pid > 2_147_483_647 || pid === process.pid) {
    throw new Error('Cannot identify a safe launched Electron host for POSIX cleanup; keeping its profile.')
  }
  if (process.platform === 'win32') throw new Error('POSIX process cleanup cannot run on Windows.')

  let processGroupId: number | null = null
  let observation = preserveDetachedChildren ? 'intentional children preserved' : 'launcher is not the live host'
  if (!preserveDetachedChildren && launcher.pid === pid && launcher.exitCode === null && launcher.signalCode === null) {
    // Playwright currently spawns a detached group on POSIX. Verify that fact
    // for this live launcher instead of assuming a PID is a group ID. No shell,
    // executable-name match, parent group, or negative unverified PID is used.
    const result = spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], {
      encoding: 'utf8', windowsHide: true, timeout: 1_000, stdio: ['ignore', 'pipe', 'pipe']
    })
    const raw = result.stdout?.trim() ?? ''
    if (result.status === 0 && /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw))) {
      processGroupId = Number(raw)
      observation = processGroupId === pid ? 'live launcher is its group leader' : 'launcher shares another process group'
    } else {
      observation = `process group unavailable (${result.error?.message ?? result.status ?? result.signal ?? 'unknown'})`
    }
  }

  const scope = processGroupId === pid ? 'owned-process-group' : 'host-only'
  let signalSent = false
  try {
    process.kill(scope === 'owned-process-group' ? -pid : pid, 'SIGKILL')
    signalSent = true
  } catch (error) {
    // A host can exit between the observation and the signal. Other failures
    // remain errors, so cleanup cannot silently delete a still-live profile.
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
  return { scope, hostPid: pid, launcherPid: launcher.pid, processGroupId, observation, signalSent }
}
