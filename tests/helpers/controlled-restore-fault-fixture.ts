import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const worker = fileURLToPath(new URL('./controlled-restore-fault-worker.mjs', import.meta.url))
export async function faultChild(profile: string, backup: string, mode: string, transcript: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', worker, resolve('.'), profile, backup, mode, transcript], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = '', stderr = '', failed: Error | undefined
  child.stdout?.on('data', bytes => { stdout += bytes.toString() }); child.stderr?.on('data', bytes => { stderr += bytes.toString() })
  const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(settle => {
    child.once('error', error => { failed = error; settle({ code: null, signal: null }) })
    child.once('close', (code, signal) => settle({ code, signal }))
  })
  const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }, 20000)
  try {
    const result = await ended
    writeFileSync(transcript + '.stdio.json', JSON.stringify({ ...result, error: failed?.message ?? null, stdout, stderr }, null, 2) + '\n')
    assert.equal(failed, undefined, 'The hidden fault child starts successfully')
    assert.equal(result.signal, null, 'The genuine fault child exits within the unchanged bounded cleanup deadline: ' + stderr.slice(-1500))
    const evidence = JSON.parse(readFileSync(transcript, 'utf8')) as Record<string, unknown>
    if (result.code === 2) globalThis.process.stderr.write('[controlled-restore-hook-miss] ' + JSON.stringify({ mode,
      inputProfile: evidence.inputProfile, canonicalProfile: evidence.canonicalProfile, injected: evidence.injected,
      unexpectedCompletion: evidence.unexpectedCompletion, witness: evidence.witness, stderr: stderr.slice(-1500) }) + '\n')
    return { code: result.code, evidence }
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await ended
  }
}
