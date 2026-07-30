import { parentPort, workerData } from 'node:worker_threads'
import { parseMarkdownBackupDocument } from '@shared/markdown'
import type { ParsedBackupDocument } from './importer'

type RestoreParseWorkerResponse =
  | { ok: true; parsedDocuments: ParsedBackupDocument[] }
  | { ok: false; message: string; stack?: string }

try {
  if (!Array.isArray(workerData) || !workerData.every((markdown) => typeof markdown === 'string')) {
    throw new Error('Restore parser worker received an invalid Markdown batch.')
  }

  const parsedDocuments = workerData.map((markdown) => parseMarkdownBackupDocument(markdown))
  parentPort?.postMessage({
    ok: true,
    parsedDocuments
  } satisfies RestoreParseWorkerResponse)
} catch (error) {
  const normalizedError = error instanceof Error ? error : new Error(String(error))
  parentPort?.postMessage({
    ok: false,
    message: normalizedError.message,
    stack: normalizedError.stack
  } satisfies RestoreParseWorkerResponse)
}
