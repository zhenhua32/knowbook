import { lstatSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

export const SYNC_RECEIVER_PROFILE_KEY = 'workspace.initializedForSyncedReceive'
const INITIALIZE_RECEIVER = '--knowbook-initialize-sync-receiver'
const PROFILE_ARGUMENT = '--knowbook-user-data-dir='

/** One-shot bootstrap. A distinct new profile must be chosen on the command line. */
export function requestsEmptySyncReceiver(argv: readonly string[], actualProfile: string): boolean {
  const flags = argv.filter(value => value === INITIALIZE_RECEIVER || value.startsWith(INITIALIZE_RECEIVER + '='))
  if (!flags.length) return false
  const profiles = argv.filter(value => value.startsWith(PROFILE_ARGUMENT))
  const requested = profiles[0]?.slice(PROFILE_ARGUMENT.length)
  if (flags.length !== 1 || flags[0] !== INITIALIZE_RECEIVER || profiles.length !== 1 || !requested
    || !isAbsolute(requested) || resolve(requested) !== resolve(actualProfile)) {
    throw new Error('初始化同步接收端时，请显式指定一个新的绝对 KnowBook 用户数据目录。')
  }
  for (const name of ['storage', 'backups', 'system-plugins', 'database-restore-pending.json', 'database-restore-fence.json', 'database-restore-safe-mode.json']) {
    if (lstatSync(join(actualProfile, name), { throwIfNoEntry: false })) {
      throw new Error('此目录已有工作区或恢复数据。请选择新的目录，原工作区未修改。')
    }
  }
  return true
}
