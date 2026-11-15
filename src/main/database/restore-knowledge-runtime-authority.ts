import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync } from 'node:fs'
import { normalize, resolve } from 'node:path'
import type Database from 'better-sqlite3'
import type { RawPriorCoverageRequirements } from './restore-knowledge-coverage-model'
import { restoreJson } from './restore-safety-model'

type Identity = { dev: bigint; ino: bigint }
interface InstalledState {
  path: string
  identity: Identity
  workspaceScope: string
  recoveryEpoch: string
  requirements: RawPriorCoverageRequirements
  operationId?: string
  intentHash?: string
  installationProofHash?: string
}
const profiles = new Map<string, InstalledState>()
const connections = new WeakMap<Database.Database, InstalledState>()

function pathKey(path: string) {
  const absolute = normalize(resolve(path))
  return process.platform === 'win32'
    ? absolute.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '').toLowerCase()
    : absolute
}

function identity(path: string): Identity {
  const stat = lstatSync(path, { bigint: true })
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || !stat.ino || pathKey(realpathSync.native(path)) !== pathKey(path))
    throw new Error('The installed restore runtime database is not an independent file.')
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const file = fstatSync(fd, { bigint: true }), named = lstatSync(path, { bigint: true })
    const same = (entry: typeof stat) => entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1n && entry.ino === file.ino
      && (entry.dev === file.dev || process.platform === 'win32' && (entry.dev === 0n || BigInt.asUintN(32, entry.dev) === file.dev))
    if (!file.isFile() || !file.ino || process.platform === 'win32' && file.dev === 0n || !same(stat) || !same(named))
      throw new Error('The installed restore runtime database changed during opening.')
    return { dev: file.dev, ino: file.ino }
  } finally { closeSync(fd) }
}

/** Only controlled startup supplies the results of a verified installed
 * fence and independent SQLite read. Paths or raw SQL alone grant no access. */
export function registerInstalledRestoreRuntime(path: string, state: Omit<InstalledState, 'path' | 'identity'>) {
  if (!state.requirements.entries.length) throw new Error('Installed restore runtime has no verified coverage.')
  profiles.set(pathKey(path), { ...state, path, identity: identity(path) })
}

export function clearInstalledRestoreRuntime(path: string): void {
  profiles.delete(pathKey(path))
}

/** Bind a live connection or a Store preflight copy before it reads SQLite.
 * Callers of the preflight-copy path still own its independent filesystem copy. */
export function attachInstalledRestoreRuntime(db: Database.Database, installedPath: string): void {
  const state = profiles.get(pathKey(installedPath))
  if (state) connections.set(db, state)
}

export function readInstalledRestoreRuntime(db: Database.Database): InstalledState | undefined {
  const state = connections.get(db) ?? (!db.memory ? profiles.get(pathKey(db.name)) : undefined)
  if (!state) return undefined
  if (profiles.get(pathKey(state.path)) !== state) throw new Error('The installed restore runtime authorization has expired.')
  const live = identity(state.path)
  if (live.dev !== state.identity.dev || live.ino !== state.identity.ino) throw new Error('The installed restore runtime database identity changed.')
  return state
}

/** This read is restricted to the actual Store's named live connection. A
 * bound preflight copy may read coverage but cannot prepare continuation. */
export function readLiveInstalledRestoreRuntime(db: Database.Database, database: string) {
  const state = readInstalledRestoreRuntime(db)
  return state && !db.readonly && !db.memory && connections.get(db) === state
    && pathKey(db.name) === pathKey(database) && pathKey(state.path) === pathKey(database) ? state : undefined
}

export function assertInstalledRestoreRuntimeCoverage(db: Database.Database, state: InstalledState, requirements: RawPriorCoverageRequirements): void {
  const current = db.prepare('SELECT workspace_scope,recovery_epoch FROM main.synced_workspace_state WHERE singleton=1').get() as
    { workspace_scope: string; recovery_epoch: string } | undefined
  if (!current || current.workspace_scope !== state.workspaceScope || current.recovery_epoch !== state.recoveryEpoch
    || restoreJson(requirements) !== restoreJson(state.requirements)) throw new Error('The installed restore runtime coverage changed.')
}
