import { lstat, readdir, readlink, realpath, stat, symlink, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Prepare internal absolute links (notably pnpm's Windows junctions) for rename. */
export async function prepareSystemPluginRuntimeLinks(source: string, destination: string): Promise<() => Promise<void>> {
  const root = await realpath(source)
  const links: Array<{ path: string; target: string; directory: boolean; absolute: boolean }> = []
  const pending = [{ path: root, depth: 0 }]
  let count = 0
  while (pending.length) {
    const current = pending.pop()!
    if (current.depth > 128) throw new Error('System plugin runtime links exceed 128 directory levels.')
    const entries = await readdir(current.path, { withFileTypes: true })
    count += entries.length
    if (count > 100_000) throw new Error('System plugin runtime links exceed 100000 entries.')
    for (const entry of entries) {
      const path = join(current.path, entry.name)
      const info = await lstat(path)
      if (info.isSymbolicLink()) {
        const target = await realpath(path)
        assertInside(target, root)
        links.push({ path, target, directory: (await stat(target)).isDirectory(), absolute: isAbsolute(await readlink(path)) })
      } else if (info.isDirectory()) {
        pending.push({ path, depth: current.depth + 1 })
      }
    }
  }

  // Resolve every link before changing any: dependency graphs may refer through
  // other links. Junctions can point at the future destination before it exists.
  for (const link of links) {
    if (!link.absolute) continue
    const target = process.platform === 'win32'
      ? resolve(destination, relative(root, link.target))
      : relative(dirname(link.path), link.target) || '.'
    await unlink(link.path)
    await symlink(target, link.path, process.platform === 'win32' && link.directory ? 'junction' : link.directory ? 'dir' : 'file')
  }
  return async () => {
    const publishedRoot = await realpath(destination)
    for (const link of links) {
      const actual = await realpath(join(destination, relative(root, link.path)))
      assertInside(actual, publishedRoot)
      if (relative(publishedRoot, actual) !== relative(root, link.target)) {
        throw new Error('System plugin runtime link changed target during publication.')
      }
    }
  }
}

function assertInside(candidate: string, root: string): void {
  const path = relative(root, candidate)
  if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error('System plugin runtime link resolves outside its runtime root.')
  }
}
