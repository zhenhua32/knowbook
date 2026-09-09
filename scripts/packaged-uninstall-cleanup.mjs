import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolvePackagedExecutable } from './lib/packaged-runtime-smoke.mjs'

if (process.platform !== 'win32') throw new Error('Installer maintenance acceptance requires Windows.')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const env = { ...process.env, KNOWBOOK_E2E_EXECUTABLE: resolvePackagedExecutable({ cwd: root }) }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
process.exitCode = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [join(root, 'node_modules', '@playwright', 'test', 'cli.js'),
    'test', 'system-plugins-uninstall-cleanup.spec.ts', '--reporter=list', '--output=test-results/uninstall-cleanup'
  ], { cwd: root, env, stdio: 'inherit', windowsHide: true })
  child.once('error', reject)
  child.once('close', (code) => resolve(code ?? 1))
})
