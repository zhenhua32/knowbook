import { readFileSync } from 'node:fs'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createPluginRootRequire } from './context'
import type {
  LoadedSystemPluginLifecycle,
  SystemPluginDisposable,
  SystemPluginErrorStage,
  SystemPluginLifecycle,
  SystemPluginModuleFormat
} from './types'
import { SystemPluginLifecycleTimeoutError, SystemPluginRuntimeError } from './types'

type DisposableRecord = {
  active: boolean
  label: string
  dispose: SystemPluginDisposable
}

export interface SystemPluginDisposalFailure {
  label: string
  error: Error
}

export class SystemPluginDisposableStack {
  private readonly records: DisposableRecord[] = []
  private accepting = true
  private disposal: Promise<readonly SystemPluginDisposalFailure[]> | null = null

  get size(): number {
    return this.records.reduce((count, record) => count + (record.active ? 1 : 0), 0)
  }

  register(dispose: SystemPluginDisposable, label = 'disposable'): void {
    if (!this.accepting) {
      throw new Error('System plugin disposable registration is closed.')
    }
    if (typeof dispose !== 'function') {
      throw new TypeError('System plugin disposable must be a function.')
    }
    this.records.push({
      active: true,
      label: label.trim() || 'disposable',
      dispose
    })
  }

  close(): void {
    this.accepting = false
  }

  disposeAll(timeoutMs: number): Promise<readonly SystemPluginDisposalFailure[]> {
    if (this.disposal) return this.disposal
    this.close()
    this.disposal = this.runDisposal(timeoutMs)
    return this.disposal
  }

  private async runDisposal(timeoutMs: number): Promise<readonly SystemPluginDisposalFailure[]> {
    assertPositiveTimeout(timeoutMs, 'disposeMs')
    const failures: SystemPluginDisposalFailure[] = []
    const deadline = Date.now() + timeoutMs

    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      const record = this.records[index]
      if (!record.active) continue
      record.active = false

      let result: void | Promise<void>
      try {
        result = record.dispose()
      } catch (error) {
        failures.push({ label: record.label, error: normalizeError(error) })
        continue
      }
      if (!isPromiseLike(result)) continue

      const remainingMs = deadline - Date.now()
      const operation = Promise.resolve(result)
      if (remainingMs <= 0) {
        failures.push({
          label: record.label,
          error: new SystemPluginLifecycleTimeoutError('dispose', timeoutMs, `Disposable "${record.label}"`)
        })
        void operation.catch(() => undefined)
        continue
      }

      try {
        await runWithTimeout(
          operation,
          remainingMs,
          'dispose',
          `Disposable "${record.label}"`
        )
      } catch (error) {
        failures.push({ label: record.label, error: normalizeError(error) })
      }
    }

    return failures
  }
}

export async function loadSystemPluginLifecycle<TContext extends object>(input: {
  pluginRoot: string
  mainEntry: string
  importNonce?: string
}): Promise<LoadedSystemPluginLifecycle<TContext>> {
  const pluginRoot = resolve(input.pluginRoot)
  const entryPath = resolveSystemPluginEntry(pluginRoot, input.mainEntry)
  const format = detectSystemPluginModuleFormat(pluginRoot, entryPath)
  const rootRequire = createPluginRootRequire(pluginRoot)

  let moduleExports: unknown
  if (format === 'cjs') {
    const entryRequire = createPluginRootRequire(entryPath.endsWith('package.json')
      ? pluginRoot
      : resolve(entryPath, '..'))
    const resolvedEntry = entryRequire.resolve(entryPath)
    delete entryRequire.cache[resolvedEntry]
    moduleExports = entryRequire(resolvedEntry)
  } else {
    const url = pathToFileURL(entryPath)
    url.searchParams.set('knowbookSystemRun', input.importNonce ?? createImportNonce())
    moduleExports = await import(url.href)
  }

  return {
    entryPath,
    format,
    rootRequire,
    lifecycle: normalizeSystemPluginLifecycle<TContext>(moduleExports)
  }
}

export function resolveSystemPluginEntry(pluginRoot: string, mainEntry: string): string {
  if (typeof mainEntry !== 'string' || !mainEntry.trim()) {
    throw new Error('System plugin main entry must be a non-empty relative path.')
  }
  if (isAbsolute(mainEntry)) {
    throw new Error('System plugin main entry must be relative to the plugin root.')
  }
  const entryPath = resolve(pluginRoot, mainEntry)
  const relativePath = relative(pluginRoot, entryPath)
  if (relativePath === '..' || relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(relativePath)) {
    throw new Error('System plugin main entry escapes the plugin root.')
  }
  return entryPath
}

export function detectSystemPluginModuleFormat(
  pluginRoot: string,
  entryPath: string
): SystemPluginModuleFormat {
  const extension = extname(entryPath).toLowerCase()
  if (extension === '.cjs') return 'cjs'
  if (extension === '.mjs') return 'esm'
  if (extension !== '.js') {
    throw new Error(`Unsupported system plugin main entry extension "${extension || '(none)'}".`)
  }

  try {
    const packageJson = JSON.parse(readFileSync(resolve(pluginRoot, 'package.json'), 'utf8')) as unknown
    if (packageJson && typeof packageJson === 'object' && !Array.isArray(packageJson)) {
      return (packageJson as { type?: unknown }).type === 'module' ? 'esm' : 'cjs'
    }
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return 'cjs'
    throw new SystemPluginRuntimeError('System plugin package.json is invalid.', 'load', {
      cause: error
    })
  }
  return 'cjs'
}

export function normalizeSystemPluginLifecycle<TContext extends object>(
  moduleExports: unknown
): SystemPluginLifecycle<TContext> {
  const namespace = asRecord(moduleExports)
  const defaultExport = asRecord(namespace?.default)
  const lifecycleSource = defaultExport ?? namespace
  if (!lifecycleSource) {
    throw new Error('System plugin main entry must export lifecycle functions.')
  }

  const activate = pickLifecycleFunction(namespace, defaultExport, 'activate')
  if (!activate) {
    throw new Error('System plugin main entry must export an activate(context) function.')
  }

  return {
    activate: activate as SystemPluginLifecycle<TContext>['activate'],
    deactivate: pickLifecycleFunction(namespace, defaultExport, 'deactivate') as SystemPluginLifecycle<TContext>['deactivate'],
    healthCheck: pickLifecycleFunction(namespace, defaultExport, 'healthCheck') as SystemPluginLifecycle<TContext>['healthCheck'],
    beforeQuit: pickLifecycleFunction(namespace, defaultExport, 'beforeQuit') as SystemPluginLifecycle<TContext>['beforeQuit'],
    migrate: pickLifecycleFunction(namespace, defaultExport, 'migrate') as SystemPluginLifecycle<TContext>['migrate']
  }
}

export function runWithTimeout<T>(
  operation: PromiseLike<T> | T,
  timeoutMs: number,
  stage: SystemPluginErrorStage,
  label?: string
): Promise<T> {
  assertPositiveTimeout(timeoutMs, `${stage} timeout`)
  let timeout: NodeJS.Timeout | undefined
  return Promise.race([
    Promise.resolve(operation),
    new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new SystemPluginLifecycleTimeoutError(stage, timeoutMs, label))
      }, timeoutMs)
    })
  ]).finally(() => {
    if (timeout) clearTimeout(timeout)
  })
}

export function normalizeError(error: unknown): Error {
  if (error instanceof Error) return error
  if (typeof error === 'string' && error.trim()) return new Error(error.trim())
  return new Error('Unknown system plugin runtime failure.', { cause: error })
}

function pickLifecycleFunction(
  namespace: Record<string, unknown> | null,
  defaultExport: Record<string, unknown> | null,
  name: keyof SystemPluginLifecycle<object>
): ((...args: never[]) => unknown) | undefined {
  const named = namespace?.[name]
  if (named !== undefined) {
    if (typeof named !== 'function') throw new Error(`System plugin export "${name}" must be a function.`)
    return named as (...args: never[]) => unknown
  }
  const fallback = defaultExport?.[name]
  if (fallback !== undefined && typeof fallback !== 'function') {
    throw new Error(`System plugin default export "${name}" must be a function.`)
  }
  return fallback as ((...args: never[]) => unknown) | undefined
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function assertPositiveTimeout(timeoutMs: number, name: string): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error(`${name} must be a positive integer.`)
  }
}

function createImportNonce(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function isPromiseLike(value: void | Promise<void>): value is Promise<void> {
  return Boolean(value && typeof (value as Promise<void>).then === 'function')
}
