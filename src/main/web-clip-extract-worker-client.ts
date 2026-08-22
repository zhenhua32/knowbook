import createWebClipExtractionWorker from './web-clip-extract-worker?nodeWorker'
import { WebClipExtractionWorkerPool, type WebClipExtractionWorkerLike } from './web-clip-extract-worker-pool'

export class WebClipExtractionWorkerRunner extends WebClipExtractionWorkerPool {
  constructor() {
    super(() => createWebClipExtractionWorker({}) as unknown as WebClipExtractionWorkerLike)
  }
}
