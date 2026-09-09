import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolvePackagedExecutable } from './lib/packaged-runtime-smoke.mjs'

if (process.platform !== 'win32') throw new Error('Modern Yarn acceptance currently requires Windows.')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const toolchain = join(root, 'release/modern-yarn-toolchain')
const expected = JSON.parse(readFileSync(join(root, 'e2e-tests/fixtures/modern-yarn-toolchain/package.json'), 'utf8')).dependencies['@yarnpkg/cli-dist']
const manifest = join(toolchain, 'node_modules/@yarnpkg/cli-dist/package.json')
if (!existsSync(manifest) || JSON.parse(readFileSync(manifest, 'utf8')).version !== expected) {
  throw new Error(`Run npm run prepare:modern-yarn to install Yarn ${expected}.`)
}
const env = { ...process.env, KNOWBOOK_E2E_EXECUTABLE: resolvePackagedExecutable({ cwd: root }) }
const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
env[pathKey] = [join(toolchain, 'node_modules/.bin'), dirname(process.execPath), env[pathKey] ?? ''].join(delimiter)
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
process.exitCode = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [join(root, 'node_modules/@playwright/test/cli.js'), 'test',
    'system-plugins-modern-yarn.spec.ts', '--reporter=list', '--output=test-results/modern-yarn'],
  { cwd: root, env, stdio: 'inherit', windowsHide: true })
  child.once('error', reject)
  child.once('close', (code) => resolve(code ?? 1))
})
