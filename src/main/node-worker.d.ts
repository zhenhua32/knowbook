declare module '*?nodeWorker' {
  import type { Worker, WorkerOptions } from 'node:worker_threads'

  export default function createWorker(options: WorkerOptions): Worker
}
