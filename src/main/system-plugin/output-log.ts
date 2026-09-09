import { AsyncLocalStorage } from 'node:async_hooks'
import { createSystemPluginLogWriter, type SystemPluginLogWriter } from './log-writer'

type Stream = 'stdout' | 'stderr'
type OutputProcess = Pick<NodeJS.Process, Stream>
const context = new AsyncLocalStorage<SystemPluginOutputLog>()
const hooks = new Map<NodeJS.WriteStream, { original: NodeJS.WriteStream['write']; wrapper: NodeJS.WriteStream['write']; users: number }>()
const MAX_LINE = 64 * 1024
const MAX_PENDING = 64
const DEFAULT_FLUSH_TIMEOUT_MS = 1_000

interface OutputLogOptions {
  flushTimeoutMs?: number
  onError?: (error: Error) => void
  writer?: SystemPluginLogWriter
}

/** Attribute ordinary Main stdout/stderr to its lifecycle and inherited async work. */
export class SystemPluginOutputLog {
  private readonly writer
  private readonly buffers: Record<Stream, string> = { stdout: '', stderr: '' }
  private readonly truncated: Record<Stream, boolean> = { stdout: false, stderr: false }
  private pending = 0
  private dropped = 0
  private closed = false
  private closing: Promise<void> | null = null

  constructor(path: string, private readonly outputProcess: OutputProcess = process, private readonly options: OutputLogOptions = {}) {
    if (options.flushTimeoutMs !== undefined && (!Number.isSafeInteger(options.flushTimeoutMs) || options.flushTimeoutMs < 1)) {
      throw new Error('Main output log flush timeout must be a positive integer.')
    }
    this.writer = options.writer ?? createSystemPluginLogWriter(path)
    for (const name of ['stdout', 'stderr'] as const) {
      const stream = outputProcess[name]
      const existing = hooks.get(stream)
      if (existing) { existing.users += 1; continue }
      const original = stream.write
      const wrapper = function (this: NodeJS.WriteStream, ...args: unknown[]): boolean {
        const scope = context.getStore()
        if (scope && scope.outputProcess[name] === stream) scope.capture(name, args[0])
        return Reflect.apply(original, this, args) as boolean
      } as NodeJS.WriteStream['write']
      hooks.set(stream, { original, wrapper, users: 1 })
      stream.write = wrapper
    }
  }

  run<T>(operation: () => T): T { return context.run(this, operation) }

  close(): Promise<void> {
    if (this.closing) return this.closing
    for (const name of ['stdout', 'stderr'] as const) {
      if (this.buffers[name]) this.enqueue(name, this.buffers[name])
      this.buffers[name] = ''
      const stream = this.outputProcess[name]
      const hook = hooks.get(stream)
      if (hook && --hook.users === 0) {
        if (stream.write === hook.wrapper) stream.write = hook.original
        hooks.delete(stream)
      }
    }
    this.closed = true
    this.closing = this.flushBestEffort()
    return this.closing
  }

  private async flushBestEffort(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const flush = this.writer.flush().then(async () => {
        if (this.dropped) await this.writer.append(`[host] Dropped ${this.dropped} log lines while the output queue was full.`)
      })
      await Promise.race([flush, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Full Trust Main output log flush timed out.')),
          this.options.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS)
      })])
    } catch (error) {
      // Logging failures must not turn successful plugin disposal into failed
      // shutdown or prevent the remaining plugins and services from stopping.
      const failure = error instanceof Error ? error : new Error(String(error))
      context.exit(() => {
        try {
          if (this.options.onError) this.options.onError(failure)
          else console.warn('Full Trust Main output log could not be flushed.', failure)
        } catch { /* Diagnostics cannot change plugin lifecycle state. */ }
      })
    } finally { if (timer) clearTimeout(timer) }
  }

  private capture(stream: Stream, value: unknown): void {
    if (this.closed || (typeof value !== 'string' && !(value instanceof Uint8Array))) return
    // Bound conversion and pending writes even for a single huge output chunk.
    const text = typeof value === 'string' ? value.slice(0, MAX_LINE * 2) : Buffer.from(value.subarray(0, MAX_LINE * 2)).toString('utf8')
    for (const [index, fragment] of text.split('\n').entries()) {
      if (index > 0) {
        this.enqueue(stream, this.buffers[stream])
        this.buffers[stream] = ''
        this.truncated[stream] = false
      }
      if (!this.truncated[stream]) {
        const combined = this.buffers[stream] + fragment
        this.buffers[stream] = combined.slice(0, MAX_LINE)
        if (combined.length > MAX_LINE) {
          this.buffers[stream] += ' …[TRUNCATED]'
          this.truncated[stream] = true
        }
      }
    }
    if (value.length > MAX_LINE * 2) this.truncated[stream] = true
  }

  private enqueue(stream: Stream, text: string): void {
    if (this.pending >= MAX_PENDING) { this.dropped += 1; return }
    this.pending += 1
    void this.writer.append(`[${new Date().toISOString()}] [${stream}] ${text}`)
      .catch(() => undefined).finally(() => { this.pending -= 1 })
  }
}
