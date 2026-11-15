import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'

const repo = await realpath(fileURLToPath(new URL('..', import.meta.url)))
const temp = join(repo, '.tmp')
await mkdir(temp, { recursive: true })
if (await realpath(temp) !== temp) throw new Error('The exact-repeat fixture requires a local .tmp directory.')
const fixture = await mkdtemp(join(temp, 'v3r-'))
const testFile = 'tests/helpers/controlled-backup-v3-exact-repeat-case.ts'

async function run(phase) {
  await new Promise((done, reject) => {
    const child = spawn(electron, ['--import', 'tsx', '--test', '--test-timeout=120000', '--test-concurrency=1', testFile], {
      cwd: repo,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        KNOWBOOK_EXACT_V3_REPEAT_FIXTURE: fixture,
        KNOWBOOK_EXACT_V3_REPEAT_PHASE: phase
      },
      stdio: 'inherit',
      windowsHide: true
    })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) done()
      else reject(new Error(`The ${phase} exact-repeat process exited with ${code ?? signal}.`))
    })
  })
}

try {
  await run('first')
  await run('second')
  if (dirname(fixture) !== temp || await realpath(fixture) !== fixture) throw new Error('Unexpected fixture location.')
  await rm(fixture, { recursive: true })
} catch (error) {
  console.error(`The exact-repeat fixture remains at ${fixture}`)
  throw error
}
