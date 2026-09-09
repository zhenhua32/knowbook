import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolvePackagedExecutable } from './lib/packaged-runtime-smoke.mjs'

if (process.platform !== 'win32') throw new Error('Package-manager acceptance currently requires Windows.')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const toolchain = join(root, 'release', 'package-manager-toolchain')
const { dependencies } = JSON.parse(readFileSync(join(root, 'e2e-tests/fixtures/package-manager-toolchain/package.json'), 'utf8'))
for (const [manager, version] of Object.entries(dependencies)) {
  const manifest = join(toolchain, 'node_modules', manager, 'package.json')
  if (!existsSync(manifest) || JSON.parse(readFileSync(manifest, 'utf8')).version !== version) {
    throw new Error(`Run npm run prepare:package-managers to install ${manager}@${version}.`)
  }
}
const env = { ...process.env, KNOWBOOK_E2E_EXECUTABLE: resolvePackagedExecutable({ cwd: root }) }
// Windows treats environment names case-insensitively. Keep exactly one PATH.
const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
env[pathKey] = [join(toolchain, 'node_modules', '.bin'), dirname(process.execPath), env[pathKey] ?? ''].join(delimiter)
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
process.exitCode = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [
    join(root, 'node_modules', '@playwright', 'test', 'cli.js'), 'test',
    'system-plugins-package-managers.spec.ts', '--reporter=list', '--output=test-results/package-managers'
  ], { cwd: root, env, stdio: 'inherit', windowsHide: true })
  child.once('error', reject)
  child.once('close', (code) => resolve(code ?? 1))
})
