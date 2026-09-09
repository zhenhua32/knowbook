import { spawn } from 'node:child_process'
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'e2e-tests/fixtures/modern-yarn-toolchain')
const target = join(root, 'release/modern-yarn-toolchain')
if (!process.env.npm_execpath) throw new Error('Run npm run prepare:modern-yarn.')
await mkdir(target, { recursive: true })
for (const file of ['package.json', 'package-lock.json']) await copyFile(join(source, file), join(target, file))
await run(process.env.npm_execpath, ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', join(target, 'npm-cache')])
const expected = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')).dependencies['@yarnpkg/cli-dist']
const installed = JSON.parse(await readFile(join(target, 'node_modules/@yarnpkg/cli-dist/package.json'), 'utf8')).version
if (expected !== installed) throw new Error(`Unexpected Yarn version: ${installed}`)
await run(join(target, 'node_modules/@yarnpkg/cli-dist/bin/yarn.js'), ['--version'])

function run(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: target, stdio: 'inherit', windowsHide: true })
    child.once('error', reject)
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`Modern Yarn preparation exited with ${code}`)))
  })
}
