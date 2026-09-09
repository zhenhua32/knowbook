import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolvePackagedExecutable } from './lib/packaged-runtime-smoke.mjs'
if (process.platform !== 'win32') throw new Error('Database restore acceptance currently requires Windows.')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const env = { ...process.env, KNOWBOOK_E2E_EXECUTABLE: resolvePackagedExecutable({ cwd: root }) }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
process.exitCode = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [join(root, 'node_modules/@playwright/test/cli.js'), 'test',
    'system-plugins-database-restore.spec.ts', '--reporter=list', '--output=test-results/database-restore'],
  { cwd: root, env, stdio: 'inherit', windowsHide: true })
  child.once('error', reject)
  child.once('close', (code) => resolve(code ?? 1))
})
const archive = join(root, 'release/acceptance/database-restore', new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-'))
mkdirSync(archive, { recursive: true })
const output = join(root, 'test-results/database-restore')
if (existsSync(output)) cpSync(output, archive, { recursive: true })
const asar = join(dirname(env.KNOWBOOK_E2E_EXECUTABLE), 'resources/app.asar')
writeFileSync(join(archive, 'runner-result.json'), JSON.stringify({
  completedAt: new Date().toISOString(), executable: env.KNOWBOOK_E2E_EXECUTABLE,
  appAsarSha256: createHash('sha256').update(readFileSync(asar)).digest('hex'), exitCode: process.exitCode
}, null, 2))
console.log(`Database restore evidence archived: ${archive}`)
