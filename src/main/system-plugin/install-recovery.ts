import { lstat, readdir, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { SystemPluginPackageRecord } from '@shared/system-plugin-state'
import type { SqlitePluginPlatformRepository } from '../plugin-platform/repository'
import { isSystemPluginManagedPath } from './managed-paths'

const ERROR_NAME = 'SystemPluginInstallInterruptedError'
const TEMPORARY_NAME = /^\.preparing-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

export interface SystemPluginInstallRecoveryOptions {
  repository: SqlitePluginPlatformRepository
  runtimeRoot: string | null
  /** Used only for conservative liveness checks. Recovery never signals a PID. */
  isProcessAlive?: (pid: number) => boolean | Promise<boolean>
  packageIds?: readonly string[]
}

export function isInterruptedSystemPluginPackage(record: SystemPluginPackageRecord): boolean {
  return record.status === 'failed' && object(record.error)?.name === ERROR_NAME
}

export function canRetryInterruptedSystemPluginPackage(record: SystemPluginPackageRecord): boolean {
  return isInterruptedSystemPluginPackage(record) && object(record.error)?.retryBlocked === false
}

/** Run before activation. This repairs metadata, never resumes install scripts. */
export async function recoverInterruptedSystemPluginInstalls(options: SystemPluginInstallRecoveryOptions): Promise<void> {
  const repository = options.repository
  const allCandidates = repository.listSystemPluginPackagesAwaitingInstallRecovery()
  const candidates = allCandidates
    .filter((record) => !options.packageIds || options.packageIds.includes(record.id))
  const isAlive = options.isProcessAlive ?? ((pid) => {
    try { process.kill(pid, 0); return true }
    catch (error) { if (code(error) === 'ESRCH') return false; throw error }
  })
  for (const record of candidates) {
    // A package marked ready with old pending jobs is also inconsistent: never
    // infer that an unrecorded process exit or native probe succeeded.
    const jobs = repository.listSystemPluginDependencyJobsAwaitingRecovery(record.id)
    if (canRetryInterruptedSystemPluginPackage(record) && jobs.length === 0
      && !object(object(record.runtimeFingerprint)?.installPreparation)) continue
    const inspectionJobs = object(object(record.runtimeFingerprint)?.installPreparation) ? jobs : [
      ...jobs,
      ...allCandidates.filter((peer) => peer.id !== record.id && peer.pluginId === record.pluginId)
        .flatMap((peer) => repository.listSystemPluginDependencyJobsAwaitingRecovery(peer.id))
    ]
    const blockedPids: number[] = []
    const unidentifiedJobs = inspectionJobs.filter((job) => (
      (job.status === 'running' && job.pid === null) || object(job.error)?.unidentifiedProcess === true
    )).map((job) => job.id)
    const inspectionErrors: string[] = []
    for (const job of inspectionJobs) {
      if (job.pid === null) continue
      try { if (await isAlive(job.pid)) blockedPids.push(job.pid) }
      catch (error) { blockedPids.push(job.pid); inspectionErrors.push(String(error)) }
    }
    const cleanupErrors: string[] = []
    const removedDirectories: string[] = []
    if (!blockedPids.length && !unidentifiedJobs.length && options.runtimeRoot) {
      try {
        await cleanupPreparationDirectories(options.runtimeRoot, record, removedDirectories)
      } catch (error) { cleanupErrors.push(String(error)) }
    }
    const error = {
      name: ERROR_NAME,
      message: blockedPids.length || unidentifiedJobs.length
        ? 'Dependency preparation was interrupted. A started process has no recorded PID, is still present, or cannot be inspected; no process was killed. Temporary runtime cleanup and retry remain blocked until process termination can be verified.'
        : cleanupErrors.length
          ? 'Dependency preparation was interrupted. Temporary runtime cleanup could not be verified; retry after resolving the recorded cleanup error.'
          : 'Dependency preparation was interrupted. No script was resumed. Select this artifact again and explicitly confirm it to retry.',
      retryBlocked: blockedPids.length > 0 || unidentifiedJobs.length > 0 || cleanupErrors.length > 0,
      blockedPids, unidentifiedJobs, inspectionErrors, cleanupErrors,
      previousError: isInterruptedSystemPluginPackage(record) ? object(record.error)?.previousError ?? null : record.error,
      recoveredAt: new Date().toISOString()
    }
    for (const job of jobs) {
      const blocked = job.pid !== null && blockedPids.includes(job.pid)
      repository.updateSystemPluginDependencyJob(job.id, {
        status: job.status === 'pending' ? 'cancelled' : 'failed',
        pid: blocked ? job.pid : null,
        error: { ...error, recordedPid: job.pid, unidentifiedProcess: unidentifiedJobs.includes(job.id) },
        exitCode: null
      })
    }
    const fingerprint = object(record.runtimeFingerprint)
    const restoredFingerprint = fingerprint ? { ...fingerprint } : null
    if (!error.retryBlocked && restoredFingerprint) delete restoredFingerprint.installPreparation
    repository.updateSystemPluginPackage(record.id, {
      status: 'failed', error, runtimeFingerprint: restoredFingerprint
    })
    if (record.sourceRequestId && repository.getSystemPluginInstallRequest(record.sourceRequestId)) {
      repository.updateSystemPluginInstallRequestState(record.sourceRequestId, { error })
    }
    repository.appendSystemPluginAudit({
      pluginId: record.pluginId, packageId: record.id, requestId: record.sourceRequestId ?? undefined,
      actor: 'system', action: 'install.interrupted-recovered', outcome: error.retryBlocked ? 'failure' : 'success',
      details: { ...error, removedDirectories, resumedScripts: false }
    })
  }
}

async function cleanupPreparationDirectories(runtimeRoot: string, record: SystemPluginPackageRecord, removed: string[]): Promise<void> {
  const root = resolve(runtimeRoot)
  const pluginRoot = resolve(root, record.pluginId)
  if (dirname(pluginRoot) !== root) throw new Error('Recovery plugin runtime path is outside its managed root.')
  if (!await exists(root)) return
  await assertRealDirectory(root)
  if (!await exists(pluginRoot)) return
  await assertRealDirectory(pluginRoot)
  if (!await isSystemPluginManagedPath(pluginRoot, root, record.pluginId)) throw new Error('Plugin runtime redirects outside its managed root.')
  const preparation = object(object(record.runtimeFingerprint)?.installPreparation)
  let paths: string[]
  if (preparation) {
    if (preparation.schemaVersion !== 1 || preparation.packageId !== record.id || preparation.contentHash !== record.contentHash
      || typeof preparation.temporaryRoot !== 'string') throw new Error('Preparation recovery identity does not match its package.')
    const temporary = resolve(preparation.temporaryRoot)
    if (!TEMPORARY_NAME.test(basename(temporary)) || !await isSystemPluginManagedPath(temporary, pluginRoot, basename(temporary))) {
      throw new Error('Preparation recovery path is not an owned temporary runtime directory.')
    }
    paths = [temporary]
  } else {
    // Legacy releases did not persist a temporary directory identity. There is
    // no safe way to associate an arbitrary sibling directory with one package.
    // Only exact host-generated names are eligible, and the manager waits for
    // every interrupted PID of this plugin before allowing this legacy sweep.
    paths = (await readdir(pluginRoot)).filter((name) => TEMPORARY_NAME.test(name)).map((name) => join(pluginRoot, name))
  }
  for (const path of paths) {
    if (!await exists(path)) continue
    await assertRealDirectory(path)
    if (!await isSystemPluginManagedPath(path, pluginRoot, basename(path))) throw new Error('Temporary runtime redirects outside its managed root.')
    await rm(path, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 })
    removed.push(path)
  }
}

async function assertRealDirectory(path: string): Promise<void> {
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Refusing to clean a linked or redirected preparation path: ${path}`)
  }
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) { if (code(error) === 'ENOENT') return false; throw error }
}
function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function code(error: unknown): string | undefined { return (error as NodeJS.ErrnoException | null)?.code }
