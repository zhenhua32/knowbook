import type { ExtractedWebClip, WebClipExtractionInput } from './web-clipper'

export type WebClipExtractionWorkerLike = {
  on: (event: string, listener: (payload: unknown) => void) => unknown
  postMessage: (message: { id: number; input: WebClipExtractionInput }) => void
  terminate: () => Promise<unknown>
}

export type WebClipExtractionWorkerFactory = () => WebClipExtractionWorkerLike

type WebClipExtractionWorkerResponse =
  | { id: number; ok: true; clip: ExtractedWebClip }
  | { id: number; ok: false; message: string; stack?: string }

type PendingExtraction = {
  resolve: (clip: ExtractedWebClip) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

const DEFAULT_EXTRACTION_TIMEOUT_MS = 30_000

type WorkerPoolOptions = {
  timeoutMilliseconds?: number
}

export class WebClipExtractionWorkerPool {
  private worker: WebClipExtractionWorkerLike | null
  private readonly pending = new Map<number, PendingExtraction>()
  private nextRequestId = 1
  private destroyed = false
  private readonly timeoutMilliseconds: number

  constructor(
    private readonly createWorker: WebClipExtractionWorkerFactory,
    options: WorkerPoolOptions = {}
  ) {
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? DEFAULT_EXTRACTION_TIMEOUT_MS
    this.worker = this.spawnWorker()
  }

  readonly run = (input: WebClipExtractionInput): Promise<ExtractedWebClip> => (
    new Promise<ExtractedWebClip>((resolve, reject) => {
      if (this.destroyed) {
        reject(new Error('Web clip extraction worker is unavailable.'))
        return
      }

      if (!this.worker) {
        this.worker = this.spawnWorker()
      }

      const id = this.nextRequestId
      this.nextRequestId += 1
      const worker = this.worker
      const timeout = setTimeout(() => {
        if (!this.pending.has(id)) {
          return
        }
        this.handleWorkerWedge(
          new Error(`Web clip extraction timed out after ${this.timeoutMilliseconds}ms.`)
        )
      }, this.timeoutMilliseconds)
      this.pending.set(id, { resolve, reject, timeout })
      worker.postMessage({ id, input })
    })
  )

  async destroy(): Promise<void> {
    if (this.destroyed) {
      return
    }
    this.destroyed = true
    this.failAll(new Error('Web clip extraction worker was shut down.'))
    const worker = this.worker
    this.worker = null
    if (worker) {
      await worker.terminate()
    }
  }

  private spawnWorker(): WebClipExtractionWorkerLike {
    const worker = this.createWorker()
    worker.on('message', (response: unknown) => {
      this.handleWorkerMessage(response as WebClipExtractionWorkerResponse)
    })
    worker.on('error', (error: unknown) => {
      this.handleWorkerDeath(
        error instanceof Error ? error : new Error('Web clip extraction worker crashed.')
      )
    })
    worker.on('exit', (code: unknown) => {
      if (!this.destroyed) {
        this.handleWorkerDeath(
          new Error(`Web clip extraction worker exited unexpectedly (code ${String(code)}).`)
        )
      }
    })
    return worker
  }

  private handleWorkerMessage(response: WebClipExtractionWorkerResponse): void {
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
  }

  private handleWorkerDeath(error: Error): void {
    this.failAll(error)
    this.terminateCurrentWorker()
  }

  private handleWorkerWedge(error: Error): void {
    this.failAll(error)
    this.terminateCurrentWorker()
  }

  private terminateCurrentWorker(): void {
    const worker = this.worker
    this.worker = null
    if (worker) {
      void worker.terminate().catch(() => {})
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pending.clear()
  }
}
