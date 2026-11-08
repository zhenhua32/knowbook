import { parentPort, workerData } from 'node:worker_threads'
import { parseMarkdownBackupDocument } from '@shared/markdown'
import type { ParsedBackupDocument } from './importer'
import { readBackupV3Archive } from './v3-reader'

type RestoreParseWorkerResponse =
  | { ok: true; parsedDocuments: ParsedBackupDocument[] }
  | { ok: true; archive: ReturnType<typeof readBackupV3Archive> }
  | { ok: false; message: string; stack?: string }

try {
  if (workerData && typeof workerData === 'object' && !Array.isArray(workerData)
    && Object.keys(workerData).length === 2 && workerData.kind === 'synced-v3' && typeof workerData.root === 'string') {
    const archive = readBackupV3Archive(workerData.root)
    const buffers = archive.assets.map(({ bytes }) => {
      if (!(bytes.buffer instanceof ArrayBuffer) || bytes.byteOffset !== 0 || bytes.byteLength !== bytes.buffer.byteLength) {
        throw new Error('V3 archive inspection requires independently owned asset buffers.')
      }
      return bytes.buffer
    })
    parentPort?.postMessage({ ok: true, archive } satisfies RestoreParseWorkerResponse, buffers)
  } else {
    if (!Array.isArray(workerData) || !workerData.every((markdown) => typeof markdown === 'string')) {
      throw new Error('Restore parser worker received an invalid Markdown batch.')
    }

    const parsedDocuments = workerData.map((markdown) => parseMarkdownBackupDocument(markdown))
    parentPort?.postMessage({
      ok: true,
      parsedDocuments
    } satisfies RestoreParseWorkerResponse)
  }
} catch (error) {
  const normalizedError = error instanceof Error ? error : new Error(String(error))
  parentPort?.postMessage({
    ok: false,
    message: normalizedError.message,
    stack: normalizedError.stack
  } satisfies RestoreParseWorkerResponse)
}
