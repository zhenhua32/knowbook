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

/** Original ledger/physical ownership facts only. These read-only SQL helpers
 * neither test effective document write capability nor load lifecycle/K state.
 * The caller owns consistency/admission; original standalone read semantics stay. */
function mapIdentity(row: IdentityRow): BlockIdentity {
  return { id: row.id, owner: { kind: row.last_owner_kind, id: row.last_owner_id },
    state: row.state, createdAt: row.created_at }
}

export function readRawBlockIdentity(db: Database.Database, id: string): BlockIdentity | null {
  const row = db.prepare('SELECT * FROM block_identities WHERE id = ?').get(id) as IdentityRow | undefined
  return row ? mapIdentity(row) : null
}

export function readRawBlockIdentities(db: Database.Database, ids: readonly string[]): Map<string, BlockIdentity> {
  if (!ids.length) return new Map()
  const rows = db.prepare('SELECT * FROM block_identities WHERE id IN (SELECT value FROM json_each(?))')
    .all(JSON.stringify(ids)) as IdentityRow[]
  return new Map(rows.map(row => [row.id, mapIdentity(row)]))
}

export function resolveRawLiveBlockOwner(db: Database.Database, id: string): LiveBlockOwner | null {
  const rows = db.prepare(`SELECT 'document' AS kind, document_id AS id, created_at FROM blocks WHERE id = ?
    UNION ALL SELECT 'group' AS kind, group_id AS id, created_at FROM synced_group_blocks WHERE id = ?`).all(id, id) as Array<LiveBlockOwner & { created_at: string }>
  const identity = readRawBlockIdentity(db, id)
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
