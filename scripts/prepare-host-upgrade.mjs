import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, Platform } from 'electron-builder'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const version = process.env.KNOWBOOK_E2E_UPGRADE_ELECTRON_VERSION ?? '36.0.0'
if (process.platform !== 'win32') throw new Error('Host upgrade acceptance currently targets Windows.')
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Expected an exact Electron release version.')
const output = join(root, 'release', 'host-upgrade')
const staging = await mkdtemp(join(tmpdir(), 'knowbook-host-upgrade-build-'))
try {
  // A failed preparation must not leave a previous success marker usable by
  // the default acceptance entry point.
  await rm(join(output, 'fixture.json'), { force: true })
  // Rebuild only the staged application's native dependencies. The repository
  // and the baseline packaged app must keep their original Electron ABI.
  await cp(join(root, 'out'), join(staging, 'out'), { recursive: true })
  await cp(join(root, 'package.json'), join(staging, 'package.json'))
  await cp(join(root, 'package-lock.json'), join(staging, 'package-lock.json'))
  await new Promise((resolve, reject) => {
    const npmCli = process.env.npm_execpath
    if (!npmCli) return reject(new Error('Run this preparation through npm run prepare:host-upgrade.'))
    const child = spawn(process.execPath, [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: staging, stdio: 'inherit', windowsHide: true
    })
    child.once('error', reject)
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`Staged npm ci failed (${code}).`)))
  })
  await build({
    projectDir: staging,
    targets: Platform.WINDOWS.createTarget('dir'),
    publish: 'never',
    config: {
      appId: 'com.zhenhua32.knowbook', productName: 'KnowBook',
      electronVersion: version,
      electronDownload: {
        isVerifyChecksum: true,
        ...(process.env.ELECTRON_MIRROR ? { mirror: process.env.ELECTRON_MIRROR } : {})
      },
      directories: { output, buildResources: join(root, 'build') },
      files: ['out/**/*', 'package.json'],
      asarUnpack: ['node_modules/better-sqlite3/**/*'],
      // An isolated unpacked test fixture; this does not alter release signing.
      win: { signAndEditExecutable: false }
    }
  })
  await mkdir(output, { recursive: true })
  const fixture = {
    electron: version,
    executable: join(output, 'win-unpacked', 'KnowBook.exe'),
    applicationVersion: JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version
  }
  await writeFile(join(output, 'fixture.json'), JSON.stringify(fixture, null, 2))
  console.log(`Prepared isolated Electron ${version} host: ${fixture.executable}`)
} finally {
  await rm(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
