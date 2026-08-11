import createWebClipExtractionWorker from './web-clip-extract-worker?nodeWorker'
import type {
  ExtractedWebClip,
  WebClipExtractionInput,
  WebClipExtractionRunner
} from './web-clipper'

type WebClipExtractionWorkerResponse =
  | { id: number; ok: true; clip: ExtractedWebClip }
  | { id: number; ok: false; message: string; stack?: string }

const WEB_CLIP_EXTRACTION_TIMEOUT_MS = 30_000

type PendingExtraction = {
  resolve: (clip: ExtractedWebClip) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

export class WebClipExtractionWorkerRunner {
  private readonly worker = createWebClipExtractionWorker({})
  private readonly pending = new Map<number, PendingExtraction>()
  private nextRequestId = 1
  private destroyed = false

  constructor() {
    this.worker.on('message', (response: WebClipExtractionWorkerResponse) => {
      const pending = this.pending.get(response.id)
      if (!pending) {
        return
      }
      this.pending.delete(response.id)
      clearTimeout(pending.timeout)

      if (response.ok) {
        pending.resolve(response.clip)
        return
      }

      const error = new Error(response.message)
      error.stack = response.stack ?? error.stack
      pending.reject(error)
    })
    this.worker.on('error', (error: Error) => this.failAll(error))
    this.worker.on('exit', (code: number) => {
      if (!this.destroyed) {
        this.failAll(new Error(`Web clip extraction worker exited unexpectedly (code ${code}).`))
      }
    })
  }

  readonly run: WebClipExtractionRunner = (input: WebClipExtractionInput) => (
    new Promise<ExtractedWebClip>((resolve, reject) => {
      if (this.destroyed) {
        reject(new Error('Web clip extraction worker is unavailable.'))
        return
      }

      const id = this.nextRequestId
      this.nextRequestId += 1
      const timeout = setTimeout(() => {
        const pending = this.pending.get(id)
        if (!pending) {
          return
        }
        this.pending.delete(id)
        pending.reject(new Error(`Web clip extraction timed out after ${WEB_CLIP_EXTRACTION_TIMEOUT_MS}ms.`))
      }, WEB_CLIP_EXTRACTION_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timeout })
      this.worker.postMessage({ id, input })
    })
  )

  async destroy(): Promise<void> {
    if (this.destroyed) {
      return
    }
    this.destroyed = true
    this.failAll(new Error('Web clip extraction worker was shut down.'))
    await this.worker.terminate()
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pending.clear()
  }
}
