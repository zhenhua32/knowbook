import { spawn } from 'node:child_process'
import { availableParallelism } from 'node:os'
import electron from 'electron'

// Restore tests start additional Electron processes and scan SQLite and files.
// On high-core Windows hosts, limit simultaneous test files so those child
// processes can finish within the same per-file and operation deadlines.
const windowsWorkers = process.platform === 'win32'
  ? [`--test-concurrency=${Math.min(8, Math.max(1, availableParallelism() - 1))}`] : []

process.exitCode = await new Promise((resolve, reject) => {
  const child = spawn(electron, [
    '--import', 'tsx', '--test', '--test-timeout=120000', ...windowsWorkers, ...process.argv.slice(2),
    'tests/**/*.test.ts', 'tests/**/*.test.tsx'
  ], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit', windowsHide: true })
  child.once('error', reject)
  child.once('close', code => resolve(code ?? 1))
})
