import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Run from the repository root with Node. Five independent Electron Node
// processes share only the new disposable fixture; standard gates stay fixed.
const repo = fileURLToPath(new URL('../../', import.meta.url))
const scratch = join(repo, '.tmp')
mkdirSync(scratch, { recursive: true })
const profile = join(scratch, 'v3-working-many-' + randomUUID())
const electron = createRequire(import.meta.url)('electron')
const probe = fileURLToPath(new URL('./controlled-v3-working-many.ts', import.meta.url))
const sandbox = { ...process.env, ELECTRON_RUN_AS_NODE: '1', KNOWBOOK_E2E_BACKGROUND: '1' }
console.log('Isolated fixture and diagnostics:', profile)
for (const phase of ['first', 'second', 'settled', 'third', 'cold']) {
  const result = spawnSync(electron, ['--import', 'tsx', probe, phase, profile], {
    cwd: repo, env: sandbox, stdio: 'inherit', windowsHide: true
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
