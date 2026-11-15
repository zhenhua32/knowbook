import { parentPort, workerData } from 'node:worker_threads'
import type { BackupExportJob } from './exporter'
import { writeBackupSnapshot } from './exporter'
import { authorizeInstalledRestoreBackupWorker } from '../database/restore-safety'

type BackupWorkerResponse =
  | { ok: true; exported: number }
  | { ok: false; message: string; stack?: string }

async function run(job: BackupExportJob) {
  try {
    if ('kind' in job && job.kind === 'synced-v3') await authorizeInstalledRestoreBackupWorker(job.userDataRoot, job.databasePath)
    const exported = writeBackupSnapshot(job)
    parentPort?.postMessage({ ok: true, exported } satisfies BackupWorkerResponse)
  } catch (error) {
    const normalizedError = error instanceof Error ? error : new Error(String(error))
    parentPort?.postMessage({
      ok: false,
      message: normalizedError.message,
      stack: normalizedError.stack
    } satisfies BackupWorkerResponse)
  }
}

void run(workerData as BackupExportJob)
