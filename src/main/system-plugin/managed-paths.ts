import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Resolve OS path aliases, including missing descendants during repeat cleanup. */
export async function resolveSystemPluginPhysicalPath(input: string): Promise<string> {
  const path = resolve(input)
  try {
    return await realpath(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const parent = dirname(path)
    if (parent === path) throw error
    return join(await resolveSystemPluginPhysicalPath(parent), basename(path))
  }
}

/** OS redirection may change the spelling of Roaming/userData in packaged apps. */
export async function isSystemPluginManagedPath(candidate: string, root: string, child?: string): Promise<boolean> {
  const entry = resolve(candidate)
  try {
    if ((await lstat(entry)).isSymbolicLink()) return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  // Preserve the final directory entry identity: following a leaf junction
  // would admit an outside alias or another request pointing at this request.
  const [physicalCandidate, physicalRoot] = await Promise.all([
    resolveSystemPluginPhysicalPath(dirname(entry)).then(parent => join(parent, basename(entry))),
    resolveSystemPluginPhysicalPath(root)
  ])
  const location = relative(physicalRoot, physicalCandidate)
  if (!location || location === '..' || location.startsWith(`..${sep}`) || isAbsolute(location)) return false
  return child === undefined || relative(resolve(physicalRoot, child), physicalCandidate) === ''
}
