import { parentPort, workerData } from 'node:worker_threads'
import type { BackupExportJob } from './exporter'
import { writeBackupSnapshot } from './exporter'

type BackupWorkerResponse =
  | { ok: true }
  | { ok: false; message: string; stack?: string }

try {
  writeBackupSnapshot(workerData as BackupExportJob)
  parentPort?.postMessage({ ok: true } satisfies BackupWorkerResponse)
} catch (error) {
  const normalizedError = error instanceof Error ? error : new Error(String(error))
  parentPort?.postMessage({
    ok: false,
    message: normalizedError.message,
    stack: normalizedError.stack
  } satisfies BackupWorkerResponse)
}
