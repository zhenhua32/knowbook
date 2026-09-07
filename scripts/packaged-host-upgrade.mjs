import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolvePackagedExecutable } from './lib/packaged-runtime-smoke.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const baseline = resolvePackagedExecutable({ cwd: root })
const target = process.env.KNOWBOOK_E2E_UPGRADE_EXECUTABLE
  ?? JSON.parse(readFileSync(join(root, 'release', 'host-upgrade', 'fixture.json'), 'utf8')).executable
const upgraded = resolvePackagedExecutable({ cwd: root, executable: target })
const env = { ...process.env, KNOWBOOK_E2E_EXECUTABLE: baseline, KNOWBOOK_E2E_UPGRADE_EXECUTABLE: upgraded }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
console.log(`Testing host ABI upgrade and rollback: ${baseline} -> ${upgraded}`)
process.exitCode = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [
    join(root, 'node_modules', '@playwright', 'test', 'cli.js'),
    'test', 'system-plugins-host-upgrade.spec.ts', '--reporter=list', '--output=test-results/host-upgrade'
  ], { cwd: root, env, stdio: 'inherit', windowsHide: true })
  child.once('error', reject)
  child.once('close', (code) => resolve(code ?? 1))
})
