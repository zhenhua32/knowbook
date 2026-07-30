import createRestoreParseWorker from './restore-parse-worker?nodeWorker'
import type {
  ParsedBackupDocument,
  RestoreMarkdownParseRunner
} from './importer'

type RestoreParseWorkerResponse =
  | { ok: true; parsedDocuments: ParsedBackupDocument[] }
  | { ok: false; message: string; stack?: string }

const RESTORE_PARSE_WORKER_TIMEOUT_MS = 5 * 60 * 1000

export const parseRestoreMarkdownInWorker: RestoreMarkdownParseRunner = (markdownSources) => (
  new Promise<ParsedBackupDocument[]>((resolve, reject) => {
    const worker = createRestoreParseWorker({ workerData: markdownSources })
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      void worker.terminate()
      reject(new Error(`Restore parser worker timed out after ${RESTORE_PARSE_WORKER_TIMEOUT_MS}ms.`))
    }, RESTORE_PARSE_WORKER_TIMEOUT_MS)

    const fail = (error: Error): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      reject(error)
    }

    worker.once('message', (response: RestoreParseWorkerResponse) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      if (response.ok) {
        resolve(response.parsedDocuments)
        return
      }

      const error = new Error(response.message)
      error.stack = response.stack ?? error.stack
      reject(error)
    })
    worker.once('error', fail)
    worker.once('exit', (code: number) => {
      if (!settled) {
        fail(new Error(`Restore parser worker exited before reporting completion (code ${code}).`))
      }
    })
  })
)
