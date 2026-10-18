import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const [repository, profile, backup, mode, transcript] = process.argv.slice(2)
if (![repository, profile, backup, transcript].every(value => typeof value === 'string' && isAbsolute(value)) || !['prepared', 'moving', 'installed', 'recover'].includes(mode)) throw new Error('Invalid isolated controlled restore child arguments')
const source = join(repository, 'src/main/database/restore-maintenance.ts')
const note = { pid: process.pid, mode, sourceSHA256: createHash('sha256').update(readFileSync(source)).digest('hex'), scriptSHA256: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex') }
const save = value => writeFileSync(transcript, JSON.stringify({ ...note, ...value }, null, 2) + '\n')
// Only real completed durable rename boundaries are observed. No journal,
// receipt, epoch, source fact or successful SQL row is synthesized by this worker.
if (mode === 'prepared' || mode === 'installed') {
  const require = createRequire(import.meta.url), fsPromises = require('node:fs/promises'), original = fsPromises.rename
  fsPromises.rename = async function (from, to) {
    const result = await original.call(this, from, to)
    const target = resolve(String(to))
    const expected = mode === 'prepared' ? join(profile, 'database-restore-fence.json') : join(profile, 'database-restore-pending.json')
    if (target === resolve(expected)) {
      const actual = JSON.parse(readFileSync(target, 'utf8'))
      if (mode === 'prepared' && actual.kind === 'controlled-database-restore-fence' && actual.version === 1 && actual.phase === 'prepared'
        || mode === 'installed' && actual.kind === 'controlled-database-restore-journal' && actual.version === 2 && actual.phase === 'installed') {
        save({ interrupted: true, actual }); process.exit(mode === 'prepared' ? 75 : 74)
      }
    }
    return result
  }
  syncBuiltinESMExports()
}
const api = await import(pathToFileURL(source).href)
try {
  if (mode === 'recover') save({ recovered: await api.recoverInterruptedDatabaseRestore(profile) })
  else {
    const result = await api.restoreKnowbookDatabase({ userDataRoot: profile, backupPath: backup, stopProcesses: async () => [], beforeReplace: async () => {
      if (mode === 'moving') {
        const actual = JSON.parse(readFileSync(join(profile, 'database-restore-pending.json'), 'utf8'))
        if (actual.version !== 2 || actual.phase !== 'moving') throw new Error('The real beforeReplace did not reach a durable v2 moving journal')
        save({ interrupted: true, actual }); process.exit(73)
      }
    } })
    save({ unexpectedCompletion: true, result })
    process.exitCode = 2
  }
} catch (error) { save({ error: String(error), stack: error?.stack }); process.exitCode = 1 }
