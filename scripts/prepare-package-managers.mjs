import { spawn } from 'node:child_process'
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'e2e-tests', 'fixtures', 'package-manager-toolchain')
const target = join(root, 'release', 'package-manager-toolchain')
const npmCli = process.env.npm_execpath
if (!npmCli) throw new Error('Run npm run prepare:package-managers.')
await mkdir(target, { recursive: true })
for (const file of ['package.json', 'package-lock.json']) await copyFile(join(source, file), join(target, file))
await run(npmCli, ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', join(target, 'npm-cache')])
const { dependencies } = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
for (const [manager, version] of Object.entries(dependencies)) {
  const installed = JSON.parse(await readFile(join(target, 'node_modules', manager, 'package.json'), 'utf8'))
  if (installed.version !== version) throw new Error(`Unexpected ${manager} version: ${installed.version}`)
  await run(join(target, 'node_modules', manager, manager === 'pnpm' ? 'bin/pnpm.mjs' : 'bin/yarn.js'), ['--version'])
}

function run(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: target, stdio: 'inherit', windowsHide: true })
    child.once('error', reject)
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`Toolchain command exited with ${code}`)))
  })
}
