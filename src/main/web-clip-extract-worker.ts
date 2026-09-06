import { parentPort } from 'node:worker_threads'
import {
  extractWebClip,
  type ExtractedWebClip
} from './web-clipper'
import type { WebClipExtractionWorkerRequest } from './web-clip-extract-worker-pool'

type WebClipExtractionWorkerResponse =
  | { id: number; ok: true; clip: ExtractedWebClip }
  | { id: number; ok: false; message: string; stack?: string }

const port = parentPort
port?.on('message', (request: WebClipExtractionWorkerRequest) => {
  if ('type' in request && request.type === 'shutdown') {
    port.close()
    return
  }
  if (!('id' in request)) return
  try {
    const { input } = request
    const clip = extractWebClip(input.html, input.sourceUrl, input.overrides)
    port.postMessage({ id: request.id, ok: true, clip } satisfies WebClipExtractionWorkerResponse)
  } catch (error) {
    const normalizedError = error instanceof Error ? error : new Error(String(error))
    port.postMessage({
      id: request.id,
      ok: false,
      message: normalizedError.message,
      stack: normalizedError.stack
    } satisfies WebClipExtractionWorkerResponse)
  }
})
