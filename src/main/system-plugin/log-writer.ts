import { appendFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'

const DEFAULT_MAX_ENTRY_BYTES = 64 * 1_024
const DEFAULT_MAX_FILE_BYTES = 1_024 * 1_024
const DEFAULT_MAX_TOTAL_BYTES = 4 * 1_024 * 1_024
const TRUNCATION_MARKER = ' …[TRUNCATED]'

const SENSITIVE_KEY = [
  'authorization',
  'proxy[-_]?authorization',
  '[a-z0-9]*(?:api[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|token|client[-_]?secret|secret|password|passwd)'
].join('|')

const SENSITIVE_ASSIGNMENT = new RegExp(
  `((?:["']?)(?:${SENSITIVE_KEY})(?:["']?)\\s*[:=]\\s*)`
    + `("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|(?:bearer|basic)\\s+[^\\s,;&}\\]]+|[^\\s,;&}\\]]+)`,
  'gi'
)
const BEARER_CREDENTIAL = /\bbearer\s+(?!\[REDACTED\])([a-z0-9._~+/=-]+)/gi

export interface SystemPluginLogWriterOptions {
  maxEntryBytes?: number
  maxFileBytes?: number
  maxTotalBytes?: number
}

export interface SystemPluginLogWriter {
  /** Queues one physical log line after redaction and UTF-8 byte bounding. */
  append(record: string): Promise<void>
  /** Waits for all writes queued before or during the flush. */
  flush(): Promise<void>
}

/**
 * Creates a serialized, best-effort-safe writer for untrusted Full Trust output.
 * Rotations use `<path>.1`, `<path>.2`, ... and are conservatively bounded by
 * maxTotalBytes even when that means retaining less history than the limit.
 */
export function createSystemPluginLogWriter(
  path: string,
  options: SystemPluginLogWriterOptions = {}
): SystemPluginLogWriter {
  const limits = normalizeLimits(options)
  let tail = Promise.resolve()
  let firstFailure: unknown = null

  return Object.freeze({
    append(record: string): Promise<void> {
      if (typeof record !== 'string') {
        return Promise.reject(new TypeError('System plugin log record must be a string.'))
      }
      const entry = prepareLogEntry(record, limits.maxEntryBytes)
      const operation = tail.then(() => appendBounded(path, entry, limits))
      tail = operation.catch((error: unknown) => {
        firstFailure ??= error
      })
      return operation
    },
    async flush(): Promise<void> {
      while (true) {
        const pending = tail
        await pending
        if (pending === tail) break
      }
      if (firstFailure !== null) {
        const error = firstFailure
        firstFailure = null
        throw error
      }
    }
  })
}

/** Redacts common credential-bearing header, JSON, assignment, and query forms. */
export function redactSystemPluginLog(value: string): string {
  return value
    .replace(SENSITIVE_ASSIGNMENT, (_match, prefix: string, credential: string) => (
      `${prefix}${redactedCredential(credential)}`
    ))
    .replace(BEARER_CREDENTIAL, 'Bearer [REDACTED]')
}

interface NormalizedLogLimits {
  maxEntryBytes: number
  maxFileBytes: number
  maxTotalBytes: number
  backupCount: number
}

function normalizeLimits(options: SystemPluginLogWriterOptions): NormalizedLogLimits {
  const maxEntryBytes = positiveInteger(
    options.maxEntryBytes,
    DEFAULT_MAX_ENTRY_BYTES,
    'maxEntryBytes'
  )
  const maxFileBytes = positiveInteger(
    options.maxFileBytes,
    DEFAULT_MAX_FILE_BYTES,
    'maxFileBytes'
  )
  const maxTotalBytes = positiveInteger(
    options.maxTotalBytes,
    DEFAULT_MAX_TOTAL_BYTES,
    'maxTotalBytes'
  )
  if (maxEntryBytes > maxFileBytes) {
    throw new RangeError('System plugin log maxEntryBytes cannot exceed maxFileBytes.')
  }
  if (maxFileBytes > maxTotalBytes) {
    throw new RangeError('System plugin log maxFileBytes cannot exceed maxTotalBytes.')
  }
  return {
    maxEntryBytes,
    maxFileBytes,
    maxTotalBytes,
    backupCount: Math.max(0, Math.floor(maxTotalBytes / maxFileBytes) - 1)
  }
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 32) {
    throw new RangeError(`System plugin log ${name} must be an integer of at least 32 bytes.`)
  }
  return resolved
}

function prepareLogEntry(record: string, maxEntryBytes: number): Buffer {
  const boundedSource = record.slice(0, maxEntryBytes)
  const singleLine = redactSystemPluginLog(boundedSource)
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
  const withNewline = `${singleLine}\n`
  if (Buffer.byteLength(withNewline, 'utf8') <= maxEntryBytes) {
    return Buffer.from(withNewline, 'utf8')
  }
  const contentBudget = maxEntryBytes - Buffer.byteLength(`${TRUNCATION_MARKER}\n`, 'utf8')
  return Buffer.from(`${truncateUtf8(singleLine, contentBudget)}${TRUNCATION_MARKER}\n`, 'utf8')
}

function truncateUtf8(value: string, maxBytes: number): string {
  const characters: string[] = []
  let bytes = 0
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8')
    if (bytes + size > maxBytes) break
    characters.push(character)
    bytes += size
  }
  return characters.join('')
}

function redactedCredential(value: string): string {
  const quote = value[0] === '"' || value[0] === "'" ? value[0] : ''
  const unquoted = quote && value.at(-1) === quote ? value.slice(1, -1) : value
  const scheme = /^(bearer|basic)\s+/i.exec(unquoted)?.[1]
  const replacement = scheme ? `${scheme} [REDACTED]` : '[REDACTED]'
  return quote ? `${quote}${replacement}${quote}` : replacement
}

async function appendBounded(
  path: string,
  entry: Buffer,
  limits: NormalizedLogLimits
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await pruneRotations(path, limits)
  const currentSize = await fileSize(path)
  if (currentSize + entry.byteLength > limits.maxFileBytes) {
    await rotate(path, currentSize, limits)
  }
  await appendFile(path, entry)
}

async function rotate(
  path: string,
  currentSize: number,
  limits: NormalizedLogLimits
): Promise<void> {
  if (limits.backupCount === 0) {
    await rm(path, { force: true })
    return
  }
  await rm(rotationPath(path, limits.backupCount), { force: true })
  for (let index = limits.backupCount - 1; index >= 1; index -= 1) {
    await renameIfPresent(rotationPath(path, index), rotationPath(path, index + 1))
  }
  if (currentSize > 0 && currentSize <= limits.maxFileBytes) {
    await renameIfPresent(path, rotationPath(path, 1))
  } else {
    await rm(path, { force: true })
  }
}

async function pruneRotations(path: string, limits: NormalizedLogLimits): Promise<void> {
  const directory = dirname(path)
  const name = basename(path)
  const pattern = new RegExp(`^${escapeRegExp(name)}\\.(\\d+)$`)
  const entries = await readdir(directory, { withFileTypes: true })
  await Promise.all(entries.map(async (entry) => {
    const match = pattern.exec(entry.name)
    if (!match) return
    const index = Number(match[1])
    const candidate = `${path}.${index}`
    if (!entry.isFile() || index < 1 || index > limits.backupCount) {
      await rm(candidate, { recursive: true, force: true })
      return
    }
    if (await fileSize(candidate) > limits.maxFileBytes) {
      await rm(candidate, { force: true })
    }
  }))
}

async function renameIfPresent(source: string, destination: string): Promise<void> {
  await rename(source, destination).catch((error: unknown) => {
    if (!isNodeError(error, 'ENOENT')) throw error
  })
}

async function fileSize(path: string): Promise<number> {
  return stat(path).then(
    (details) => details.size,
    (error: unknown) => {
      if (isNodeError(error, 'ENOENT')) return 0
      throw error
    }
  )
}

function rotationPath(path: string, index: number): string {
  return `${path}.${index}`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === code
}
