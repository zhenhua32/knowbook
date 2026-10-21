import type Database from 'better-sqlite3'
import { assertSyncedDocumentNotLogicallyDeleted } from './synced-logical-deletion-read'
import { readRawBlockIdentity, readRawBlockIdentities, resolveRawLiveBlockOwner, type BlockIdentity, type LiveBlockOwner } from './block-identities-raw-read'
export type { LiveBlockOwner, BlockOwner, BlockIdentity } from './block-identities-raw-read'

/** A read-only view of the global identity authority. Retained IDs remain
 * occupied even when neither physical content table has a current row. */
export class BlockIdentityRepository {
  constructor(private readonly db: Database.Database) {}


  get(id: string): BlockIdentity | null {
    return readRawBlockIdentity(this.db, id)
  }

  getMany(ids: readonly string[]): Map<string, BlockIdentity> {
    return readRawBlockIdentities(this.db, ids)
  }

  resolveLiveOwner(id: string): LiveBlockOwner | null {
    return resolveRawLiveBlockOwner(this.db, id)
  }

  findForeignDocumentIdentity(documentId: string, ids: readonly string[]): BlockIdentity | null {
    for (const identity of this.getMany(ids).values()) {
      if (identity.owner.kind !== 'document' || identity.owner.id !== documentId) return identity
    }
    return null
  }

  assertDocumentWrite(documentId: string, ids: readonly string[]): void {
    if ((this.db.pragma('user_version', { simple: true }) as number) >= 27) {
      const check = () => assertSyncedDocumentNotLogicallyDeleted(this.db, documentId)
      if (this.db.inTransaction) check(); else this.db.transaction(check)()
    }
    const unique = new Set<string>()
    for (const id of ids) {
      if (typeof id !== 'string' || !id.trim() || unique.has(id)) throw new Error('块身份无效或重复。')
      unique.add(id)
    }
    if (this.findForeignDocumentIdentity(documentId, ids)) {
      throw new Error('块身份已由其他文档或同步块保留，不能覆盖或取回该块。')
    }
  }

  getWorkspaceIdentity(): { workspaceScope: string; recoveryEpoch: string } {
    const row = this.db.prepare('SELECT workspace_scope, recovery_epoch FROM synced_workspace_state WHERE singleton = 1')
      .get() as { workspace_scope: string; recovery_epoch: string } | undefined
    if (!row) throw new Error('同步块工作区身份缺失。')
    return { workspaceScope: row.workspace_scope, recoveryEpoch: row.recovery_epoch }
  }
}
