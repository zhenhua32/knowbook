import { writeFileSync } from 'node:fs'
import electron from 'electron'

const smokeEnabled = process.env['KNOWBOOK_PACKAGED_PLUGIN_RUNTIME_SMOKE'] === '1'
const smokeResultPath = process.env['KNOWBOOK_PACKAGED_PLUGIN_RUNTIME_SMOKE_RESULT']?.trim()

function recordBootstrapStatus(status: 'started' | 'failed', error?: unknown): void {
  if (!smokeEnabled || !smokeResultPath) return
  try {
    writeFileSync(smokeResultPath, JSON.stringify({
      status,
      phase: 'bootstrap',
      ...(error === undefined ? {} : {
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      })
    }), 'utf8')
  } catch {
    // The result file is diagnostic-only; stderr/exit code remain authoritative.
  }
}

recordBootstrapStatus('started')

void import('./index').catch((error: unknown) => {
  recordBootstrapStatus('failed', error)
  console.error('KnowBook main process failed during module initialization.', error)
  electron.app.exit(1)
})
