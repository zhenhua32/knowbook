import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Actual NTFS alias, never a fabricated short-name spelling. */
export function windowsShortPath(path: string): string {
  assert.equal(process.platform, 'win32')
  const result = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File',
    fileURLToPath(new URL('./windows-short-path.ps1', import.meta.url)), '-Path', path],
  { encoding: 'utf8', windowsHide: true, timeout: 20_000, maxBuffer: 128 * 1024 }).trim()
  assert.ok(result)
  assert.equal(realpathSync.native(result).toLowerCase(), realpathSync.native(path).toLowerCase())
  return result
}
