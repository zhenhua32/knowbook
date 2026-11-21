import type { ExportDocument, ExportStandaloneDatabase } from '../database/store'
import { freezeCapsuleValue } from '../database/restore-knowledge-capsule-model'
import { openStoredRestoreScopes } from '../database/restore-knowledge-stored-scopes'
import { scanCapturedBackupV3Inventory, type BackupV3FileDigest, type BackupV3Group, type ScopedBackupV3Archive } from './v3-format'

type ArchiveRecord = ExportDocument | ExportStandaloneDatabase | BackupV3Group

export function openScopedBackupV3Inventory(contents: readonly BackupV3FileDigest[], assets: readonly BackupV3FileDigest[],
  readBytes: (relativePath: string) => Uint8Array) {
  // The codec accounts for the original archive and per-document limits.
  // This scratch representation can encode the same values at a different size.
  const { projection: archive, close } = openStoredRestoreScopes<ArchiveRecord, ScopedBackupV3Archive>((append, store) => {
    function collection<T extends ArchiveRecord>(kind: string) {
      const keys: string[] = [], byId = new Map<string, string>()
      const read = (key: string) => store.byId(key) as T
      return {
        add(id: string, record: T) {
          const key = kind + ':' + keys.length
          append(key, record)
          keys.push(key)
          byId.set(id, key)
        },
        read(id: string) {
          const key = byId.get(id)
          return key === undefined ? undefined : read(key)
        },
        *[Symbol.iterator]() {
          for (const key of keys) yield read(key)
        }
      }
    }
    const documents = collection<ExportDocument>('document'), groups = collection<BackupV3Group>('group'),
      standaloneDatabases = collection<ExportStandaloneDatabase>('database')
    const index = scanCapturedBackupV3Inventory(contents, assets, readBytes, {
      documents, standaloneDatabases, groups, readGroup: groups.read,
      addDocument: record => documents.add(record.id, record),
      addDatabase: record => standaloneDatabases.add(record.id, record),
      addGroup: record => groups.add(record.wire.id, record)
    })
    return Object.freeze({ ...index, documentLocations: Object.freeze(index.documentLocations),
      catalog: freezeCapsuleValue(index.catalog),
      manifest: freezeCapsuleValue(index.manifest),
      documents: Object.freeze({ [Symbol.iterator]: documents[Symbol.iterator] }),
      groups: Object.freeze({ [Symbol.iterator]: groups[Symbol.iterator] }),
      standaloneDatabases: Object.freeze({ [Symbol.iterator]: standaloneDatabases[Symbol.iterator] }),
      readDocument: documents.read, readGroup: groups.read })
  }, Number.MAX_SAFE_INTEGER)
  return { archive, close }
}
