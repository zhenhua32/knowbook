import { randomUUID } from 'node:crypto'
import type { PluginJsonValue, PluginRevisionPackage } from '@shared/plugin-platform'
import { CompileFlags, EvalFlags, JSException, QuickJS } from 'quickjs-wasi'
import type {
  PluginRevisionValidationResult,
  PluginRevisionValidator
} from '../assistant/plugin-authoring-service'
import { loadQuickJsWasm } from './quickjs-realm'
import { resolvePluginStandardModules } from './standard-modules'

const VALIDATION_MEMORY_LIMIT_BYTES = 32 * 1024 * 1024
const VALIDATION_TIMEOUT_MS = 1_000

/** Compile-only validation. Plugin top-level code is never evaluated here. */
export class QuickJsPluginRevisionValidator implements PluginRevisionValidator {
  async validate(revision: PluginRevisionPackage): Promise<PluginRevisionValidationResult> {
    const diagnostics: PluginJsonValue[] = []
    try {
      resolvePluginStandardModules(
        revision.manifest.standardModules,
        `__validation_bridge_${randomUUID().replaceAll('-', '')}`
      )
    } catch (error) {
      return failedDiagnostic('standard-module', error)
    }

    const forbiddenImport = findObviouslyForbiddenImport(revision.workerSource)
    if (forbiddenImport) {
      return {
        status: 'failed',
        diagnostics: [{
          code: 'forbidden-import',
          message: `Dynamic plugins cannot import "${forbiddenImport}".`
        }]
      }
    }

    const wasm = await loadQuickJsWasm()
    const deadline = { value: performance.now() + VALIDATION_TIMEOUT_MS }
    let vm: QuickJS | null = null
    try {
      vm = await QuickJS.create({
        wasm,
        memoryLimit: VALIDATION_MEMORY_LIMIT_BYTES,
        interruptHandler: () => performance.now() >= deadline.value,
        timezoneOffset: 0
      })
      deadline.value = performance.now() + VALIDATION_TIMEOUT_MS
      const bytecode = vm.compile(
        revision.workerSource,
        'worker.js',
        EvalFlags.TYPE_MODULE | EvalFlags.STRICT,
        CompileFlags.STRIP_SOURCE
      )
      diagnostics.push({
        code: 'quickjs-compile-passed',
        message: 'worker.js compiled successfully for the isolated QuickJS runtime.',
        bytecodeBytes: bytecode.byteLength
      })
      return { status: 'passed', diagnostics }
    } catch (error) {
      return failedDiagnostic('quickjs-compile-failed', normalizeValidationError(error))
    } finally {
      vm?.dispose()
    }
  }
}

function findObviouslyForbiddenImport(source: string): string | null {
  const match = source.match(/(?:from\s*|import\s*\(\s*|import\s*)['"]((?:node:|electron(?:\/|['"]))[^'"]*)['"]/) 
  return match?.[1] ?? null
}

function failedDiagnostic(code: string, error: unknown): PluginRevisionValidationResult {
  const normalized = normalizeValidationError(error)
  return {
    status: 'failed',
    diagnostics: [{ code, message: normalized.message.slice(0, 2_000) }]
  }
}

function normalizeValidationError(error: unknown): Error {
  if (error instanceof JSException) {
    const normalized = new Error(`${error.name}: ${error.message}`)
    error.dispose()
    return normalized
  }
  if (error instanceof Error) {
    return error
  }
  return new Error(typeof error === 'string' ? error : 'Plugin validation failed.')
}
