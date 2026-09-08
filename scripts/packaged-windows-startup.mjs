import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolvePackagedExecutable } from './lib/packaged-runtime-smoke.mjs'

if (process.platform !== 'win32') throw new Error('Windows startup acceptance requires Windows.')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const executable = resolvePackagedExecutable({ cwd: root })
const env = { ...process.env, KNOWBOOK_E2E_EXECUTABLE: executable }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
console.log(`Testing Windows login startup and detached adoption: ${executable}`)
process.exitCode = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [
    join(root, 'node_modules', '@playwright', 'test', 'cli.js'),
    'test', 'system-plugins-windows-startup.spec.ts', '--reporter=list', '--output=test-results/windows-startup'
  ], { cwd: root, env, stdio: 'inherit', windowsHide: true })
  child.once('error', reject)
  child.once('close', (code) => resolve(code ?? 1))
})
