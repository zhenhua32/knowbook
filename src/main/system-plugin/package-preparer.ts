import { cp, lstat, mkdir, rename, rm } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SqlitePluginPlatformRepository } from '../plugin-platform/repository'
import type {
  PreparePublishedSystemPluginPackage,
  PreparedPublishedSystemPluginPackage
} from './manager'
import {
  createSystemPluginDependencyTasks,
  executeSystemPluginDependencyTasks,
  probeSystemPluginNativeModules,
  type ProbeSystemPluginNativeModulesOptions,
  type SystemPluginNativeModuleProbeResult,
  type SystemPluginDependencyTask
} from './dependency-runner'
import type { SystemPluginDependencyPlan, SystemPluginPackageManager } from '@shared/system-plugin'
import { createSystemPluginLogWriter, redactSystemPluginLog } from './log-writer'
import { prepareSystemPluginRuntimeLinks } from './runtime-links'

export interface SystemPluginPackagePreparerOptions {
  repository: SqlitePluginPlatformRepository
  runtimeRoot: string
  logRoot: string
  process?: NodeJS.Process
  dependencyTimeoutMs?: number
  nativeProbeTimeoutMs?: number
  executeTasks?: typeof executeSystemPluginDependencyTasks
  probeNativeModules?: (
    options: ProbeSystemPluginNativeModulesOptions
  ) => Promise<SystemPluginNativeModuleProbeResult>
}

export interface SystemPluginElectronRebuildTarget {
  electron: string
  arch: string
  platform: NodeJS.Platform
}

/**
 * Installs confirmed dependencies into a mutable runtime copy. The published
 * artifact itself is never modified after the user confirms its exact hash.
 */
export function createSystemPluginPackagePreparer(
  options: SystemPluginPackagePreparerOptions
): PreparePublishedSystemPluginPackage {
  const runtimeRoot = resolve(options.runtimeRoot)
  const logRoot = resolve(options.logRoot)
  const hostProcess = options.process ?? process
  const executeTasks = options.executeTasks ?? executeSystemPluginDependencyTasks
  const probeNativeModules = options.probeNativeModules ?? probeSystemPluginNativeModules

  return async ({ artifact, packageRecord, request }) => {
    const plan = artifact.manifest.dependencies
    const nativeRebuild = plan?.rebuildNativeModules
      ? {
          type: 'command' as const,
          command: createSystemPluginElectronRebuildCommand(plan.packageManager, {
            electron: requireRuntimeVersion(hostProcess.versions.electron, 'Electron'),
            arch: hostProcess.arch,
            platform: hostProcess.platform
          }, plan.yarnMode),
          environment: {
            ...createSystemPluginElectronRebuildEnvironment({
              electron: requireRuntimeVersion(hostProcess.versions.electron, 'Electron'),
              arch: hostProcess.arch,
              platform: hostProcess.platform
            }),
            ...(plan.packageManager === 'yarn' && plan.yarnMode === 'modern'
              ? { YARN_ENABLE_SCRIPTS: 'true', YARN_ENABLE_INLINE_BUILDS: 'true' }
              : {})
          }
        }
      : undefined
    const tasks = plan
      ? createSystemPluginDependencyTasks(plan, { nativeRebuild })
      : []

    const pluginRuntimeRoot = resolve(runtimeRoot, artifact.manifest.id)
    assertInside(pluginRuntimeRoot, runtimeRoot, 'plugin runtime root')
    const targetRoot = resolve(pluginRuntimeRoot, artifact.artifactSha256)
    assertInside(targetRoot, runtimeRoot, 'package runtime root')
    const temporaryRoot = resolve(pluginRuntimeRoot, `.preparing-${randomUUID()}`)
    assertInside(temporaryRoot, runtimeRoot, 'temporary runtime root')
    const logPath = resolve(
      logRoot,
      artifact.manifest.id,
      `${artifact.artifactSha256}-dependencies.log`
    )
    assertInside(logPath, logRoot, 'dependency log')
    const logWriter = createSystemPluginLogWriter(logPath)

    const previousFingerprint = packageRecord.runtimeFingerprint
    options.repository.updateSystemPluginPackage(packageRecord.id, {
      runtimeFingerprint: {
        ...(previousFingerprint && typeof previousFingerprint === 'object' && !Array.isArray(previousFingerprint)
          ? previousFingerprint : {}),
        installPreparation: {
          schemaVersion: 1, packageId: packageRecord.id, contentHash: artifact.artifactSha256,
          requestId: request.id, temporaryRoot, startedAt: new Date().toISOString()
        }
      }
    })

    await mkdir(pluginRuntimeRoot, { recursive: true })
    await mkdir(dirname(logPath), { recursive: true })
    await cp(artifact.artifactDirectory, temporaryRoot, {
      recursive: true,
      force: false,
      errorOnExist: true,
      dereference: false
    })

    const jobs = plan
      ? tasks.map((task) => options.repository.createSystemPluginDependencyJob({
          packageId: packageRecord.id,
          requestId: request.id,
          kind: task.kind,
          packageManager: plan.packageManager,
          command: [...task.command],
          logPath
        }))
      : []
    let dependencyTasksCompleted = false

    try {
      if (tasks.length > 0) {
        await executeTasks({
          rootDirectory: temporaryRoot,
          tasks,
          timeoutMs: options.dependencyTimeoutMs,
          onLog: (event) => {
            const prefix = `[${event.timestamp}] [${event.stream}] [${event.task.kind}] `
            void logWriter.append(`${prefix}${event.text}`).catch(() => undefined)
          },
          onStatus: (event) => {
            options.repository.updateSystemPluginDependencyJob(jobs[event.taskIndex].id, {
              status: event.status,
              ...(event.error ? { error: serializeError(event.error) } : {})
            })
          },
          onProcess: (event) => {
            const update = event.phase === 'started'
              ? { pid: event.pid }
              : event.phase === 'exited'
                ? { pid: event.pid, exitCode: event.exitCode }
                : { pid: event.pid }
            options.repository.updateSystemPluginDependencyJob(jobs[event.taskIndex].id, update)
          }
        })
      }
      dependencyTasksCompleted = true
      const nativeModuleProbe = await probeNativeModules({
        rootDirectory: temporaryRoot,
        executable: hostProcess.execPath,
        environment: hostProcess.env,
        timeoutMs: options.nativeProbeTimeoutMs,
        onLog: (event) => {
          const prefix = `[${event.timestamp}] [${event.stream}] [native-probe:${event.modulePath}] `
          void logWriter.append(`${prefix}${event.text}`).catch(() => undefined)
        }
      })
      await logWriter.flush()
      await replaceRuntimeDirectory(temporaryRoot, targetRoot, pluginRuntimeRoot)
      return {
        runtimeFingerprint: {
          ...createRuntimeFingerprint(hostProcess, artifact.artifactSha256, nativeModuleProbe),
          runtimeRoot: targetRoot,
          dependencyPlan: plan ?? null,
          dependencyTasks: tasks.map(describeTask)
        }
      } satisfies PreparedPublishedSystemPluginPackage
    } catch (error) {
      if (dependencyTasksCompleted && jobs.length > 0) {
        options.repository.updateSystemPluginDependencyJob(jobs[jobs.length - 1].id, {
          status: 'failed',
          error: serializeError(error)
        })
      }
      await logWriter.flush().catch(() => undefined)
      await rm(temporaryRoot, { recursive: true, force: true }).then(() => {
        options.repository.updateSystemPluginPackage(packageRecord.id, { runtimeFingerprint: previousFingerprint })
      }).catch(() => undefined)
      throw error
    }
  }
}

/**
 * Builds the exact package-manager command recorded in the dependency job.
 * Electron's target runtime, architecture, and platform are always explicit so
 * node-gyp/prebuild tooling cannot silently fall back to the installer process.
 */
export function createSystemPluginElectronRebuildCommand(
  packageManager: SystemPluginPackageManager,
  target: SystemPluginElectronRebuildTarget,
  yarnMode: SystemPluginDependencyPlan['yarnMode'] = 'classic'
): readonly string[] {
  if (packageManager !== 'npm' && packageManager !== 'pnpm' && packageManager !== 'yarn') {
    throw new Error('System plugin native rebuild package manager is invalid.')
  }
  const electron = normalizeCommandValue(target.electron, 'Electron target')
  const arch = normalizeCommandValue(target.arch, 'architecture')
  const platform = normalizeCommandValue(target.platform, 'platform')
  // pnpm rejects npm's target CLI flags, and Yarn Classic has no `rebuild`.
  // Both receive the pinned Electron target through the task environment.
  if (packageManager === 'pnpm') return Object.freeze(['pnpm', 'rebuild'])
  if (packageManager === 'yarn') return Object.freeze(yarnMode === 'modern'
    ? ['yarn', 'rebuild']
    : ['yarn', 'install', '--force', '--frozen-lockfile'])
  return Object.freeze([
    packageManager,
    'rebuild',
    // npm otherwise captures lifecycle output internally; the host's job log
    // must receive compiler diagnostics even when the build succeeds.
    ...(packageManager === 'npm' ? ['--foreground-scripts', '--loglevel=notice'] : []),
    '--runtime=electron',
    `--target=${electron}`,
    `--arch=${arch}`,
    `--platform=${platform}`,
    '--dist-url=https://electronjs.org/headers'
  ])
}

export function createSystemPluginElectronRebuildEnvironment(
  target: SystemPluginElectronRebuildTarget
): Readonly<Record<string, string>> {
  const values = {
    runtime: 'electron',
    target: normalizeCommandValue(target.electron, 'Electron target'),
    arch: normalizeCommandValue(target.arch, 'architecture'),
    platform: normalizeCommandValue(target.platform, 'platform'),
    dist_url: 'https://electronjs.org/headers'
  }
  // Older prebuild tools use npm_config_*, newer node-gyp also accepts the
  // package-config prefix. Set both to avoid inheriting a system-Node target.
  return Object.freeze({
    ...Object.fromEntries(Object.entries(values).flatMap(([key, value]) => [
      [`npm_config_${key}`, value], [`npm_package_config_node_gyp_${key}`, value]
    ])),
    npm_config_disturl: values.dist_url,
    npm_config_ignore_scripts: 'false',
    pnpm_config_ignore_scripts: 'false'
  })
}

async function replaceRuntimeDirectory(
  temporaryRoot: string,
  targetRoot: string,
  pluginRuntimeRoot: string
): Promise<void> {
  const verifyLinks = await prepareSystemPluginRuntimeLinks(temporaryRoot, targetRoot)
  const previousRoot = resolve(pluginRuntimeRoot, `.replaced-${randomUUID()}`)
  assertInside(previousRoot, pluginRuntimeRoot, 'previous runtime root')
  const targetExists = await lstat(targetRoot).then(() => true, (error: unknown) => {
    if (isNodeError(error) && error.code === 'ENOENT') return false
    throw error
  })
  if (targetExists) await rename(targetRoot, previousRoot)
  let published = false
  try {
    await rename(temporaryRoot, targetRoot)
    published = true
    await verifyLinks()
  } catch (error) {
    // Move the rejected candidate back before restoring the previous runtime.
    // Its links need not remain usable: the caller removes the temporary tree.
    if (published) await rename(targetRoot, temporaryRoot)
    if (targetExists) await rename(previousRoot, targetRoot)
    throw error
  }
  if (targetExists) await rm(previousRoot, { recursive: true, force: true })
}

function describeTask(task: SystemPluginDependencyTask): Record<string, unknown> {
  return {
    kind: task.kind,
    packageManager: task.packageManager,
    command: [...task.command],
    ...(task.execution === 'process' && task.environment ? { environment: { ...task.environment } } : {})
  }
}

function createRuntimeFingerprint(
  hostProcess: NodeJS.Process,
  artifactSha256: string,
  nativeModuleProbe: SystemPluginNativeModuleProbeResult
): Record<string, unknown> {
  const versions = Object.fromEntries(
    Object.entries(hostProcess.versions)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .sort(([left], [right]) => left.localeCompare(right, 'en'))
  )
  return {
    artifactSha256,
    platform: hostProcess.platform,
    arch: hostProcess.arch,
    node: hostProcess.versions.node,
    electron: hostProcess.versions.electron ?? null,
    modules: hostProcess.versions.modules ?? null,
    napi: hostProcess.versions.napi ?? null,
    v8: hostProcess.versions.v8 ?? null,
    uv: hostProcess.versions.uv ?? null,
    openssl: hostProcess.versions.openssl ?? null,
    runtimeVersions: versions,
    nativeModuleProbe: {
      strategy: nativeModuleProbe.strategy,
      status: 'passed',
      moduleCount: nativeModuleProbe.nativeModules.length,
      modules: [...nativeModuleProbe.nativeModules]
    }
  }
}

function requireRuntimeVersion(value: string | undefined, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error(`System plugin native rebuild requires a valid ${label} runtime version.`)
  }
  return value
}

function normalizeCommandValue(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > 1_024) {
    throw new Error(`System plugin native rebuild ${label} is invalid.`)
  }
  return value
}

function assertInside(candidate: string, root: string, label: string): void {
  const path = relative(root, candidate)
  if (!path || path === '..' || path.startsWith(`..${sep}`)) {
    throw new Error(`System plugin ${label} is outside its managed root.`)
  }
}

function serializeError(error: unknown): Record<string, unknown> {
  const normalized = error instanceof Error ? error : new Error(String(error))
  return {
    name: redactSystemPluginLog(normalized.name).slice(0, 200),
    message: redactSystemPluginLog(normalized.message).slice(0, 4_000),
    ...(normalized.stack
      ? { stack: redactSystemPluginLog(normalized.stack).slice(0, 16_000) }
      : {})
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
