import { toNamespacedPath } from 'node:path'

/** Native SQLite filename only. Never use this spelling in logical receipts, fences or inventories. */
export function restoreSqliteFilename(filename: string): string {
  return process.platform === 'win32' ? toNamespacedPath(filename) : filename
}
