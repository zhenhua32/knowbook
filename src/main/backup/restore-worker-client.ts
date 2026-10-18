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

/** Main-only inspection of a complete V3 directory. No restore plan or write authority. */
export function readBackupV3ArchiveInWorker(root: string): Promise<ReturnType<typeof import('./v3-format').parseBackupV3Files>> {
  return new Promise((resolve, reject) => {
    const worker = createRestoreParseWorker({ workerData: { kind: 'synced-v3', root } })
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(error)
    }
    const timeout = setTimeout(() => {
      if (settled) return
      fail(new Error('V3 backup inspection worker timed out.'))
      void worker.terminate()
    }, RESTORE_PARSE_WORKER_TIMEOUT_MS)
    worker.once('message', (response: { ok: true; archive: ReturnType<typeof import('./v3-format').parseBackupV3Files> }
      | { ok: false; message: string; stack?: string }) => {
      if (settled) return
      if (!response.ok) { const error = new Error(response.message); error.stack = response.stack ?? error.stack; fail(error); return }
      settled = true
      clearTimeout(timeout)
      resolve(response.archive)
    })
    worker.once('error', fail)
    worker.once('exit', (code: number) => {
      if (!settled) fail(new Error('V3 backup inspection worker exited before reporting completion (code ' + code + ').'))
    })
  })
}
