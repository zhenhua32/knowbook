import { randomUUID } from 'node:crypto'
import { mkdir, realpath } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type Database from 'better-sqlite3'
import { prepareDurableSqlCapsuleOriginal, readOwnedRawCapsuleOriginal } from '../../src/main/database/restore-knowledge-capsule-files'
import { restoreInventory } from '../../src/main/database/restore-safety-files'

/** Actual native SQLite online backup and the existing Main original owner. */
export async function captureAssetOriginal(source: { userDataRoot: string; db: Database.Database }) {
  const profileRoot = await realpath(source.userDataRoot), recoveryDirectory = join(profileRoot, 'backups', 'database-restore', randomUUID())
  const sealedDirectory = join(recoveryDirectory, 'sealed')
  await mkdir(sealedDirectory, { recursive: true }); await source.db.backup(join(sealedDirectory, 'knowbook.db'))
  const original = await prepareDurableSqlCapsuleOriginal({ profileRoot, recoveryDirectory, sealedDirectory, capsuleId: randomUUID(), label: 'actual-managed-assets' })
  const info = readOwnedRawCapsuleOriginal(original), id = basename(info.capsuleDirectory)
  return { original, info, inventory: await restoreInventory(info.originalDirectory),
    output: join(recoveryDirectory, 'knowledge-managed-assets-v2', id), knownOutput: join(recoveryDirectory, 'knowledge-asset-originals-v2', id) }
}
