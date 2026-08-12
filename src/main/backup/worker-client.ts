import createBackupWorker from './export-worker?nodeWorker'
import type { BackupExportJob, BackupExportRunner } from './exporter'

type BackupWorkerResponse =
  | { ok: true; exported: number }
  | { ok: false; message: string; stack?: string }

const BACKUP_WORKER_TIMEOUT_MS = 2 * 60 * 1000

export const runBackupExportInWorker: BackupExportRunner = (job: BackupExportJob) => (
  new Promise<number>((resolve, reject) => {
    const worker = createBackupWorker({ workerData: job })
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      void worker.terminate()
      reject(new Error(`Backup worker timed out after ${BACKUP_WORKER_TIMEOUT_MS}ms.`))
    }, BACKUP_WORKER_TIMEOUT_MS)

    const fail = (error: Error): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      reject(error)
    }

    worker.once('message', (response: BackupWorkerResponse) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      if (response.ok) {
        resolve(response.exported)
        return
      }

      const error = new Error(response.message)
      error.stack = response.stack ?? error.stack
      reject(error)
    })
    worker.once('error', fail)
    worker.once('exit', (code: number) => {
      if (!settled) {
        fail(new Error(`Backup worker exited before reporting completion (code ${code}).`))
      }
    })
  })
)
