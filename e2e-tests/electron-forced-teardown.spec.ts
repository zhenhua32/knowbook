import { expect, test } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { closeElectronApp, launchElectronApp } from './helpers/electron'

function isRunning(pid: number): boolean {
  if (process.platform === 'win32') {
    try { process.kill(pid, 0); return true } catch { return false }
  }
  const result = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], {
    encoding: 'utf8', windowsHide: true, timeout: 1_000, stdio: ['ignore', 'pipe', 'pipe']
  })
  if (result.error || result.status !== 0 && result.status !== 1) throw new Error(`Cannot observe fixture child: ${result.error ?? result.stderr}`)
  const state = result.stdout.trim()
  return Boolean(state && !state.startsWith('Z'))
}

test('forced Electron teardown closes the owned child and launcher pipes @electron', async ({}, info) => {
  const context = await launchElectronApp()
  const launcher = context.app.process()
  let launcherClosed = false, childPid: number | undefined, hostClosed = false
  launcher.once('close', () => { launcherClosed = true })
  try {
    const owned = await context.app.evaluate(async ({ app }) => {
      const { spawn } = process.getBuiltinModule('node:child_process')
      const child = spawn(process.execPath, ['--eval', 'setInterval(() => {}, 1000)'], {
        windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'inherit', 'inherit']
      })
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
      app.on('before-quit', event => event.preventDefault())
      return { hostPid: process.pid, childPid: child.pid }
    })
    childPid = owned.childPid
    expect(childPid).toBeGreaterThan(1)
    expect(isRunning(childPid!)).toBe(true)
    const startedAt = Date.now()
    await closeElectronApp(context)
    hostClosed = true
    await expect.poll(() => launcherClosed).toBe(true)
    await expect.poll(() => isRunning(childPid!)).toBe(false)
    expect(launcher.stdout?.readableEnded).toBe(true)
    expect(launcher.stderr?.readableEnded).toBe(true)
    await info.attach('forced-owned-teardown', { contentType: 'application/json', body: Buffer.from(JSON.stringify({
      ...owned, launcherPid: launcher.pid, platform: process.platform, elapsedMs: Date.now() - startedAt,
      launcherClosed, stdoutEnded: launcher.stdout?.readableEnded, stderrEnded: launcher.stderr?.readableEnded
    }, null, 2)) })
  } finally {
    if (!hostClosed) await closeElectronApp(context)
    // A failed assertion must not leave the continuously running fixture child.
    if (childPid && isRunning(childPid)) process.kill(childPid, 'SIGKILL')
  }
})
