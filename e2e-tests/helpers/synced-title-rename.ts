import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { TestInfo } from '@playwright/test'
import { closeElectronApp, launchElectronApp, type ElectronAppContext } from './electron'
import type { TitleRenameAudit, TitleRenameSeed } from './synced-title-rename-seed'

const runFile = promisify(execFile), helperRoot = dirname(fileURLToPath(import.meta.url)), repoRoot = join(helperRoot, '..', '..')
const electronRoot = dirname(createRequire(import.meta.url).resolve('electron/package.json'))
const executable = join(electronRoot, 'dist', readFileSync(join(electronRoot, 'path.txt'), 'utf8').trim())

async function prepare(scenario: TitleRenameSeed['scenario']): Promise<{ profile: string; seed: TitleRenameSeed }> {
  if (process.env.KNOWBOOK_E2E_EXECUTABLE?.trim()) throw new Error('Title rename seed requires the matching current local build')
  const profile = mkdtempSync(join(realpathSync(tmpdir()), 'knowbook-e2e-title-rename-'))
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', KNOWBOOK_USER_DATA_DIR: profile }
  delete env.ELECTRON_RENDERER_URL
  await runFile(executable, ['--import', 'tsx', join(helperRoot, 'synced-title-rename-seed.ts'), profile, scenario], {
    cwd: repoRoot, env, windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8'
  })
  const seed = JSON.parse(readFileSync(join(profile, 'synced-title-rename-seed.json'), 'utf8')) as TitleRenameSeed
  if (seed.version !== 1 || seed.profile !== profile || seed.scenario !== scenario || seed.original.titleOperations.length) throw new Error('Incomplete genuine title seed')
  return { profile, seed }
}

export async function withSyncedTitleRenameApp(info: TestInfo, scenario: TitleRenameSeed['scenario'], run: (fixture: {
  context: () => ElectronAppContext; seed: TitleRenameSeed
  restart: () => Promise<TitleRenameAudit>
  stopAndInspect: () => Promise<TitleRenameAudit>
}) => Promise<void>): Promise<void> {
  const { profile, seed } = await prepare(scenario)
  let current: ElectronAppContext | null = null, failed = true, inspection = 0
  await info.attach('title-rename-original-seed', { body: Buffer.from(JSON.stringify(seed, null, 2)), contentType: 'application/json' })
  const beginTrace = async (value: ElectronAppContext) => value.app.context().tracing.start({ screenshots: true, snapshots: true, sources: true })
  const context = () => { if (!current) throw new Error('The actual title rename app is stopped'); return current }
  const stopAndInspect = async (): Promise<TitleRenameAudit> => {
    const prior = context()
    await prior.app.context().tracing.stop()
    await closeElectronApp(prior, { preserveUserData: true }); current = null
    const name = 'synced-title-rename-inspect-' + ++inspection + '.json'
    const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', KNOWBOOK_USER_DATA_DIR: profile }
    delete env.ELECTRON_RENDERER_URL
    await runFile(executable, ['--import', 'tsx', join(helperRoot, 'synced-title-rename-seed.ts'), profile, 'inspect', name], {
      cwd: repoRoot, env, windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8'
    })
    const audit = JSON.parse(readFileSync(join(profile, name), 'utf8')) as TitleRenameAudit
    await info.attach('title-rename-stopped-originals-' + inspection, { body: Buffer.from(JSON.stringify(audit, null, 2)), contentType: 'application/json' })
    return audit
  }
  try {
    current = await launchElectronApp({}, { userDataRoot: profile, editorMode: 'markdown' }); await beginTrace(current)
    await run({ seed, context, stopAndInspect, restart: async () => {
      const audit = await stopAndInspect()
      current = await launchElectronApp({}, { userDataRoot: profile, editorMode: 'markdown' }); await beginTrace(current)
      return audit
    } })
    failed = false
  } catch (error) {
    if (current) {
      try {
        const trace = info.outputPath('title-rename-first-attempt-trace.zip')
        await current.app.context().tracing.stop({ path: trace })
        await info.attach('title-rename-first-attempt-trace', { path: trace, contentType: 'application/zip' })
      } catch (captureError) {
        await info.attach('title-rename-trace-capture-error', { body: String(captureError), contentType: 'text/plain' }).catch(() => undefined)
      }
    }
    throw error
  } finally {
    if (current) {
      if (!failed) await current.app.context().tracing.stop()
      // Established helper owns process/profile teardown. It is never an oracle
      // for a successful normal close, a rejected rename, or loss of the draft.
      await closeElectronApp(current, { preserveUserData: failed })
    }
  }
}
