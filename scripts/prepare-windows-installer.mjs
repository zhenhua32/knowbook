import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, Platform } from 'electron-builder'
import semver from 'semver'

if (process.platform !== 'win32') throw new Error('NSIS acceptance fixture preparation requires Windows.')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(root, 'release', 'windows-installer')
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const electronVersion = JSON.parse(await readFile(join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version
const id = randomUUID()
const token = id.replaceAll('-', '')
const productName = `KnowBook V3 Acceptance ${token}`
const executableName = `KnowBookV3Acceptance-${token}`
const packageName = `knowbook-v3-acceptance-${token}`
const appId = `com.zhenhua32.knowbook.acceptance.${token}`
const staging = await mkdtemp(join(tmpdir(), 'knowbook-nsis-build-'))
await mkdir(output, { recursive: true })
await rm(join(output, 'fixture.json'), { force: true })
try {
  await cp(join(root, 'out'), join(staging, 'out'), { recursive: true })
  await cp(join(root, 'package-lock.json'), join(staging, 'package-lock.json'))
  await writeFile(join(staging, 'package.json'), JSON.stringify(manifest, null, 2))
  const npmCli = process.env.npm_execpath
  if (!npmCli) throw new Error('Run this preparation through an npm script so npm_execpath is available.')
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: staging, stdio: 'inherit', windowsHide: true
    })
    child.once('error', reject)
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`Staged npm ci failed (${code}).`)))
  })
  const releases = []
  for (const [label, version] of [['baseline', manifest.version], ['upgrade', semver.inc(manifest.version, 'patch')]]) {
    if (!version) throw new Error('Application version must be valid semver.')
    await writeFile(join(staging, 'package.json'), JSON.stringify({ ...manifest, name: packageName, version }, null, 2))
    const paths = await build({
      projectDir: staging, targets: Platform.WINDOWS.createTarget('nsis'), publish: 'never',
      config: {
        appId, productName, electronVersion,
        directories: { output: join(output, label), buildResources: join(root, 'build') },
        files: ['out/**/*', 'package.json'], asarUnpack: ['node_modules/better-sqlite3/**/*'],
        // The localhost feed is configured by the acceptance runner. No release
        // from this identity is published and no production updater is touched.
        publish: [{ provider: 'generic', url: 'http://127.0.0.1:1/acceptance/' }],
        win: { executableName, signAndEditExecutable: false, artifactName: `${executableName}-${version}-setup.exe` },
        nsis: {
          guid: id, oneClick: false, perMachine: false, allowElevation: false,
          allowToChangeInstallationDirectory: true, runAfterFinish: false,
          include: join(root, 'build', 'installer.nsh')
        }
      }
    })
    const installer = paths.find((path) => path.endsWith('-setup.exe'))
    if (!installer) throw new Error(`NSIS did not produce the ${label} installer.`)
    const bytes = await readFile(installer)
    releases.push({ label, version, installer, sha256: createHash('sha256').update(bytes).digest('hex'), sha512: createHash('sha512').update(bytes).digest('base64'), size: bytes.length })
  }
  await writeFile(join(output, 'fixture.json'), JSON.stringify({
    schemaVersion: 1, kind: 'isolated-windows-installer-acceptance', id, appId, productName,
    executableName, packageName, electronVersion, releases, createdAt: new Date().toISOString()
  }, null, 2))
  console.log(`Prepared independent NSIS identity ${appId}; no installer has been executed.`)
} finally {
  await rm(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
