import { lstatSync, realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DocumentLinkIssueReason } from '@shared/contracts'

/** Match the managed-file policy without reading arbitrary linked files. */
export function checkMarkdownAttachment(url: string, assetRoot: string): DocumentLinkIssueReason | null {
  const normalized = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
  const inside = (path: string, root: string) => normalized(path).startsWith(normalized(root) + sep)
  let path: string
  try { path = fileURLToPath(url) } catch { return 'invalid-path' }
  if (!inside(path, assetRoot)) return 'unmanaged-attachment'
  try {
    const info = lstatSync(path, { throwIfNoEntry: false })
    if (!info) return 'missing-attachment'
    if (info.isSymbolicLink() || !info.isFile() || !inside(realpathSync(path), realpathSync(assetRoot))) return 'unmanaged-attachment'
    return null
  } catch { return 'missing-attachment' }
}
