import { isAbsolute, resolve } from 'node:path'
import type { SystemPluginOsPersistenceCommand } from '../../shared/system-plugin-state'

const USER_DATA_ARGUMENT = '--knowbook-user-data-dir='

/** Resolve before requesting Electron's profile-specific single-instance lock. */
export function resolveKnowbookUserDataOverride(
  argv: readonly string[],
  environmentOverride?: string
): string | undefined {
  const explicit = argv.filter((argument) => argument.startsWith(USER_DATA_ARGUMENT))
  if (explicit.length > 1) throw new Error('KnowBook user data directory was specified more than once.')
  if (explicit.length === 1) {
    const directory = explicit[0].slice(USER_DATA_ARGUMENT.length)
    if (!isAbsolute(directory) || directory.includes('\0')) {
      throw new Error('KnowBook startup user data directory must be an absolute path.')
    }
    return resolve(directory)
  }
  const directory = environmentOverride?.trim()
  return directory ? resolve(directory) : undefined
}

/** Login startup has neither the original cwd nor its environment overrides. */
export function createSystemPluginStartupCommand(input: {
  executable: string
  appPath: string
  isPackaged: boolean
  userDataRoot: string
  pluginId: string
}): SystemPluginOsPersistenceCommand {
  return {
    executable: resolve(input.executable),
    args: [
      ...(input.isPackaged ? [] : [resolve(input.appPath)]),
      `${USER_DATA_ARGUMENT}${resolve(input.userDataRoot)}`,
      `--knowbook-system-plugin-os-startup=${input.pluginId}`
    ]
  }
}
