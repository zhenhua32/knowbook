declare module '*?nodeWorker' {
  import type { Worker, WorkerOptions } from 'node:worker_threads'

  export default function createWorker(options: WorkerOptions): Worker
}

declare module '*?modulePath' {
  const modulePath: string
  export default modulePath
}
