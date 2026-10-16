import type Database from 'better-sqlite3'

export type LiveBlockOwner = { kind: 'document' | 'group'; id: string }
export type BlockOwner = LiveBlockOwner | { kind: 'reserved'; id: string }
export interface BlockIdentity {
  id: string
  owner: BlockOwner
  state: 'live' | 'retained'
  /** Historical drafts did not record block creation time. Never invent it. */
  createdAt: string | null
}
interface IdentityRow {
  id: string
  last_owner_kind: BlockOwner['kind']
  last_owner_id: string
  state: BlockIdentity['state']
  created_at: string | null
}

/** A read-only view of the global identity authority. Retained IDs remain
 * occupied even when neither physical content table has a current row. */
export class BlockIdentityRepository {
  constructor(private readonly db: Database.Database) {}

  private map(row: IdentityRow): BlockIdentity {
    return { id: row.id, owner: { kind: row.last_owner_kind, id: row.last_owner_id },
      state: row.state, createdAt: row.created_at }
  }

  get(id: string): BlockIdentity | null {
    const row = this.db.prepare('SELECT * FROM block_identities WHERE id = ?').get(id) as IdentityRow | undefined
    return row ? this.map(row) : null
  }

  getMany(ids: readonly string[]): Map<string, BlockIdentity> {
    if (!ids.length) return new Map()
    const rows = this.db.prepare('SELECT * FROM block_identities WHERE id IN (SELECT value FROM json_each(?))')
      .all(JSON.stringify(ids)) as IdentityRow[]
    return new Map(rows.map(row => [row.id, this.map(row)]))
  }

  resolveLiveOwner(id: string): LiveBlockOwner | null {
    const rows = this.db.prepare(`SELECT 'document' AS kind, document_id AS id, created_at FROM blocks WHERE id = ?
      UNION ALL SELECT 'group' AS kind, group_id AS id, created_at FROM synced_group_blocks WHERE id = ?`).all(id, id) as Array<LiveBlockOwner & { created_at: string }>
    const identity = this.get(id)
    if (!rows.length) {
      if (identity?.state === 'live') throw new Error('块身份标记为存活，但实际归属缺失。')
      return null
    }
    const owner = rows[0]
    if (rows.length !== 1 || !identity || identity.state !== 'live'
      || identity.owner.kind !== owner.kind || identity.owner.id !== owner.id || identity.createdAt !== owner.created_at) {
      throw new Error('块身份与实际归属不一致。')
    }
    return { kind: owner.kind, id: owner.id }
  }

  findForeignDocumentIdentity(documentId: string, ids: readonly string[]): BlockIdentity | null {
    for (const identity of this.getMany(ids).values()) {
      if (identity.owner.kind !== 'document' || identity.owner.id !== documentId) return identity
    }
    return null
  }

  assertDocumentWrite(documentId: string, ids: readonly string[]): void {
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
