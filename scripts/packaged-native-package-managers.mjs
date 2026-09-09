import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolvePackagedExecutable } from './lib/packaged-runtime-smoke.mjs'

if (process.platform !== 'win32') throw new Error('Native package-manager acceptance currently requires Windows.')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const classic = join(root, 'release/package-manager-toolchain')
const modern = join(root, 'release/modern-yarn-toolchain')
for (const [fixture, directory] of [['package-manager-toolchain', classic], ['modern-yarn-toolchain', modern]]) {
  const expected = JSON.parse(readFileSync(join(root, 'e2e-tests/fixtures', fixture, 'package.json'), 'utf8')).dependencies
  for (const [name, version] of Object.entries(expected)) {
    const actual = JSON.parse(readFileSync(join(directory, 'node_modules', name, 'package.json'), 'utf8')).version
    if (actual !== version) throw new Error(`Prepare the pinned acceptance toolchain: ${name}@${version} is required.`)
  }
}
const variants = process.argv.slice(2)
if (!variants.length) variants.push('pnpm', 'yarn-classic', 'yarn-modern')
if (variants.some((value) => !['npm', 'pnpm', 'yarn-classic', 'yarn-modern'].includes(value))) throw new Error('Unsupported native acceptance variant.')
for (const variant of variants) {
  const env = { ...process.env, KNOWBOOK_E2E_EXECUTABLE: resolvePackagedExecutable({ cwd: root }), KNOWBOOK_NATIVE_PACKAGE_MANAGER: variant }
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
  env[pathKey] = [...(variant === 'yarn-modern' ? [join(modern, 'node_modules/.bin')] : []),
    join(classic, 'node_modules/.bin'), dirname(process.execPath), env[pathKey] ?? ''].join(delimiter)
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  console.log(`Running real Node-to-Electron native rebuild with ${variant}`)
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, 'node_modules/@playwright/test/cli.js'), 'test',
      'system-plugins-native-rebuild.spec.ts', '--reporter=list', `--output=test-results/native-package-managers/${variant}`
    ], { cwd: root, env, stdio: 'inherit', windowsHide: true })
    child.once('error', reject)
    child.once('close', (code) => resolve(code ?? 1))
  })
  if (code !== 0) { process.exitCode = code; break }
}
