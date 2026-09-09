import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32') throw new Error('Prepare this fixture inside the disposable Windows VM.')
const [executableInput, profileInput] = process.argv.slice(2)
if (!isAbsolute(executableInput ?? '') || !isAbsolute(profileInput ?? '')) {
  throw new Error('Usage: node scripts/prepare-windows-session-fixture.mjs <absolute-installed-exe> <absolute-isolated-profile>')
}
const executable = resolve(executableInput)
const profile = resolve(profileInput)
if (!(await stat(executable)).isFile()) throw new Error('The installed fixture executable is missing.')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
await mkdir(join(root, 'release'), { recursive: true })
const output = await mkdtemp(join(root, 'release', 'windows-session-'))
const pluginId = `system.e2e.session-${randomUUID()}`
const source = join(output, 'plugin')
await mkdir(source)
await copyFile(join(root, 'e2e-tests', 'fixtures', 'windows-startup', 'service.cjs'), join(source, 'service.cjs'))
await writeFile(join(source, 'plugin.json'), JSON.stringify({
  schemaVersion: 3, trust: 'full', id: pluginId, name: 'Windows session acceptance', version: '1.0.0', publisher: 'KnowBook E2E',
  entries: { service: 'service.cjs' }, background: { mode: 'detached', autoStart: true }, fullAccess: true,
  riskDeclarations: ['node', 'filesystem', 'background-service', 'os-persistence']
}, null, 2))
for (const mode of ['login', 'reboot']) {
  await writeFile(join(output, `${mode}-checkpoint.json`), JSON.stringify({
    kind: 'knowbook-windows-session-acceptance', executable, profile, pluginId
  }, null, 2))
}
console.log(JSON.stringify({ output, pluginSource: source, executable, profile, pluginId,
  next: 'In the VM, launch the isolated host with this absolute profile, install/review this plugin through the plugin center, separately confirm login startup, then capture the checkpoint. No host was launched and no login item was registered by preparation.'
}, null, 2))
