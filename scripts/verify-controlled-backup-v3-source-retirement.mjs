import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import electron from 'electron'

const repo = fileURLToPath(new URL('..', import.meta.url))
const fixture = 'tests/helpers/controlled-backup-v3-source-retirement-case.ts'
process.exitCode = await new Promise((resolve, reject) => {
  const child = spawn(electron, ['--import', 'tsx', fixture], {
    cwd: repo,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit',
    windowsHide: true
  })
  child.once('error', reject)
  child.once('close', code => resolve(code ?? 1))
})
