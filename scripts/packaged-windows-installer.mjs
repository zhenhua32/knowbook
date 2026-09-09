import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32') throw new Error('NSIS acceptance requires Windows.')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const env = { ...process.env, KNOWBOOK_E2E_INSTALLER_FIXTURE: join(root, 'release', 'windows-installer', 'fixture.json') }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
process.exitCode = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [join(root, 'node_modules', '@playwright', 'test', 'cli.js'),
    'test', 'system-plugins-windows-installer.spec.ts', '--reporter=list', '--output=release/acceptance/windows-installer-live'
  ], { cwd: root, env, stdio: 'inherit', windowsHide: true })
  child.once('error', reject)
  child.once('close', (code) => resolve(code ?? 1))
})
