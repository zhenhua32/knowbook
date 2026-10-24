import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const runFile = promisify(execFile)
const helperRoot = dirname(fileURLToPath(import.meta.url))
const electronRoot = dirname(createRequire(import.meta.url).resolve('electron/package.json'))

export type DatabaseSnapshot = {
  schema: Array<Record<string, unknown>>
  tables: Record<string, Array<Record<string, unknown>>>
}

/** Read the launched app's actual database without using its Main inspector context. */
export async function readDatabaseSnapshot(userDataRoot: string): Promise<DatabaseSnapshot> {
  const executable = join(electronRoot, 'dist', readFileSync(join(electronRoot, 'path.txt'), 'utf8').trim())
  const { stdout } = await runFile(executable, [join(helperRoot, 'database-snapshot.cjs'), join(userDataRoot, 'storage', 'knowbook.db')], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true,
    timeout: 30_000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8'
  })
  return JSON.parse(stdout) as DatabaseSnapshot
}
