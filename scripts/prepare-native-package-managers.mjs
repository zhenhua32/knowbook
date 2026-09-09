import { spawn } from 'node:child_process'
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'e2e-tests/fixtures/native-rebuild-yarn-modern')
const target = join(root, 'release/native-yarn-dependencies')
const cli = join(root, 'release/modern-yarn-toolchain/node_modules/@yarnpkg/cli-dist/bin/yarn.js')
const expected = JSON.parse(await readFile(join(root, 'e2e-tests/fixtures/modern-yarn-toolchain/package.json'), 'utf8')).dependencies['@yarnpkg/cli-dist']
const actual = JSON.parse(await readFile(join(root, 'release/modern-yarn-toolchain/node_modules/@yarnpkg/cli-dist/package.json'), 'utf8')).version
if (actual !== expected) throw new Error('Run npm run prepare:modern-yarn first.')
await mkdir(target, { recursive: true })
for (const file of ['package.json', 'yarn.lock', '.yarnrc.yml']) await copyFile(join(source, file), join(target, file))
// Yarn requires native packages to declare node-gyp. Prepare its locked cache
// here; the actual reviewed plugin install later runs with networking disabled.
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [cli, 'install', '--immutable', '--mode=skip-build'], {
    cwd: target, stdio: 'inherit', windowsHide: true,
    env: { ...process.env, YARN_ENABLE_NETWORK: 'true', YARN_ENABLE_SCRIPTS: 'false' }
  })
  child.once('error', reject)
  child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`Native Yarn cache preparation failed (${code}).`)))
})
