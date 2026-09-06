import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolvePackagedExecutable } from './lib/packaged-runtime-smoke.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const executable = resolvePackagedExecutable({ cwd: root })
const env = { ...process.env, KNOWBOOK_E2E_EXECUTABLE: executable }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL

console.log(`Running native System Plugin acceptance against ${executable}`)
process.exitCode = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [
    join(root, 'node_modules', '@playwright', 'test', 'cli.js'),
    'test', 'system-plugins-native.spec.ts', 'system-plugins-native-rebuild.spec.ts', '--reporter=list'
  ], { cwd: root, env, stdio: 'inherit', windowsHide: true })
  child.once('error', reject)
  child.once('close', (code) => resolve(code ?? 1))
})
