import { randomUUID } from 'node:crypto'
import type { DocumentBlockDraft, UpdateDocumentInput } from '../../shared/contracts'
import type { DocumentBlockMoveHistoryEntry, DocumentBlockMoveResult, MoveDocumentBlocksInput, RestoreDocumentBlockMoveInput } from '../../shared/document-block-moves'
import { planDocumentBlockTransfer } from '../../shared/documentBlockTransfer'
import type { KnowbookStore } from './store'
import type { MarkdownLinkIndex, MarkdownIndexedDocument } from './markdown-link-index'

type Snapshot = { documentId: string; path: string; updatedAt: string; content: UpdateDocumentInput }
type OperationRow = {
  id: string; source_document_id: string; target_document_id: string; state: 'applied' | 'undone'
  moved_ids_json: string; before_json: string; after_json: string; expected_versions_json: string
}
const staleMessage = '移动涉及的文档已变化，请重新打开后操作；不会覆盖后续编辑。'

/** The journal, original block IDs, history and link projections commit together. */
export class DocumentBlockTransfers {
  private readonly db
  constructor(private readonly store: KnowbookStore, private readonly links: MarkdownLinkIndex) {
    this.db = store.getUnsafeDatabaseHandle()
  }

  private snapshot(documentId: string): Snapshot {
    const document = this.db.prepare('SELECT path, updated_at FROM documents WHERE id = ?').get(documentId) as
      { path: string; updated_at: string } | undefined
    if (!document) throw new Error('移动涉及的文档不存在或已删除。')
    return { documentId, path: document.path, updatedAt: document.updated_at,
      content: this.store.documentRecovery.readContent(documentId) }
  }

  private indexed(snapshot: Snapshot): MarkdownIndexedDocument {
    return { id: snapshot.documentId, path: snapshot.path, title: snapshot.content.title, blocks: snapshot.content.blocks }
  }

  private versions(snapshots: Snapshot[]): Record<string, string> {
    return Object.fromEntries(snapshots.map(snapshot => [snapshot.documentId, snapshot.updatedAt]))
  }

  private assertCurrent(expected: Snapshot[], versions: Record<string, string>): void {
    if (!versions || typeof versions !== 'object') throw new Error(staleMessage)
    for (const snapshot of expected) {
      const current = this.snapshot(snapshot.documentId)
      if (!Object.hasOwn(versions, snapshot.documentId) || versions[snapshot.documentId] !== current.updatedAt
        || current.path !== snapshot.path || JSON.stringify(current.content) !== JSON.stringify(snapshot.content)) {
        throw new Error(staleMessage)
      }
    }
  }

  private checkpoint(snapshots: Snapshot[]): void {
    for (const snapshot of snapshots) this.store.documentRecovery.checkpoint(snapshot.documentId, 'move', true)
  }

  private apply(desired: Snapshot[], current: Snapshot[]): Snapshot[] {
    const allowedOwners = new Set(current.map(snapshot => snapshot.documentId))
    const desiredOwners = new Map<string, string>()
    for (const snapshot of desired) for (const block of snapshot.content.blocks) {
      if (!block.id || desiredOwners.has(block.id)) throw new Error('移动快照中的块身份无效或重复。')
      desiredOwners.set(block.id, snapshot.documentId)
    }
    const owners = this.db.prepare('SELECT id, document_id FROM blocks WHERE id IN (SELECT value FROM json_each(?))')
      .all(JSON.stringify([...desiredOwners.keys()])) as Array<{ id: string; document_id: string }>
    if (owners.some(owner => !allowedOwners.has(owner.document_id))) {
      throw new Error('移动快照中的块已被其他文档占用，不能覆盖或取回该块。')
    }
    // Reassign existing rows first. Never DELETE/INSERT moved identities: that
    // would erase original timestamps and cascade their routes/child pointers.
    const now = new Date(Math.max(Date.now(), ...current.map(snapshot => Date.parse(snapshot.updatedAt) + 1))).toISOString()
    const transfer = this.db.prepare('UPDATE blocks SET document_id = ?, updated_at = ? WHERE id = ?')
    const changedOwnerIds: string[] = [], previousOwnerIds = new Set<string>()
    for (const owner of owners) {
      const documentId = desiredOwners.get(owner.id)!
      if (documentId !== owner.document_id) {
        transfer.run(documentId, now, owner.id)
        changedOwnerIds.push(owner.id)
        previousOwnerIds.add(owner.document_id)
      }
    }
    const currentVersions = this.versions(current)
    for (const snapshot of desired) {
      this.store.updateDocument(snapshot.documentId, { ...snapshot.content,
        expectedUpdatedAt: currentVersions[snapshot.documentId] }, { skipCheckpoint: true, skipLinkMaintenance: true })
      // A move can remove the final subtree without changing remaining rows;
      // always advance both document revisions, including no-op projections.
      this.db.prepare('UPDATE documents SET updated_at = ? WHERE id = ?').run(now, snapshot.documentId)
    }
    this.store.refreshDocumentBlockMoveLinks(desired.map(snapshot => snapshot.documentId), changedOwnerIds,
      current.filter(snapshot => previousOwnerIds.has(snapshot.documentId)).map(snapshot => snapshot.path))
    return desired.map(snapshot => this.snapshot(snapshot.documentId))
  }

  private result(row: OperationRow, expected: Record<string, string>): DocumentBlockMoveResult {
    const source = this.store.getDocumentDetail(row.source_document_id), target = this.store.getDocumentDetail(row.target_document_id)
    if (!source || !target) throw new Error('移动涉及的文档不存在或已删除。')
    return { operationId: row.id, state: row.state, source, target,
      movedBlockIds: JSON.parse(row.moved_ids_json), affectedDocumentIds: Object.keys(expected),
      expectedUpdatedAtByDocument: expected }
  }

  move(input: MoveDocumentBlocksInput): DocumentBlockMoveResult {
    if (!input || typeof input.fromDocumentId !== 'string' || typeof input.toDocumentId !== 'string'
      || input.fromDocumentId === input.toDocumentId || !Array.isArray(input.blockIds) || !input.blockIds.length
      || input.blockIds.some(id => typeof id !== 'string' || !id.trim())
      || typeof input.expectedFromUpdatedAt !== 'string' || typeof input.expectedToUpdatedAt !== 'string') {
      throw new Error('请选择不同的来源和目标文档及有效块，并提供双方当前版本。')
    }
    if (input.beforeBlockId !== undefined && (typeof input.beforeBlockId !== 'string' || !input.beforeBlockId.trim())
      || input.parentBlockId !== undefined && input.parentBlockId !== null
        && (typeof input.parentBlockId !== 'string' || !input.parentBlockId.trim())) {
      throw new Error('目标位置无效：请提供有效的块身份，父级可以为空，但位置不能是空字符串或其他类型。')
    }
    return this.store.runInTransaction(() => {
      const source = this.snapshot(input.fromDocumentId), target = this.snapshot(input.toDocumentId)
      if (source.updatedAt !== input.expectedFromUpdatedAt || target.updatedAt !== input.expectedToUpdatedAt) throw new Error(staleMessage)
      const plan = planDocumentBlockTransfer({ from: source.content.blocks, to: target.content.blocks,
        selectedIds: input.blockIds, beforeBlockId: input.beforeBlockId, parentBlockId: input.parentBlockId })
      if (!plan) throw new Error('所选块必须形成完整连续子树，目标父级和位置必须有效，嵌套不得超过六层。')
      const rewritten = this.links.planBlockTransferReferences({ source: this.indexed(source), target: this.indexed(target),
        sourceBlocks: plan.sourceBlocks, targetBlocks: plan.targetBlocks, movedIds: plan.movedIds },
      id => this.indexed(this.snapshot(id)))
      const before = rewritten.map(update => this.snapshot(update.documentId))
      const desired = rewritten.map((update, index) => ({ ...before[index], content: { ...before[index].content, blocks: update.blocks } }))
      this.checkpoint(before)
      const alias = this.db.prepare('INSERT OR IGNORE INTO document_block_routes (document_path, block_id) VALUES (?, ?)')
      for (const id of plan.movedIds) { alias.run(source.path, id); alias.run(target.path, id) }
      const after = this.apply(desired, before)
      const id = randomUUID(), expected = this.versions(after), now = new Date().toISOString()
      this.db.prepare('INSERT INTO document_block_moves (id, source_document_id, target_document_id, state, moved_ids_json, before_json, after_json, expected_versions_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, source.documentId, target.documentId, 'applied', JSON.stringify(plan.movedIds), JSON.stringify(before),
          JSON.stringify(after), JSON.stringify(expected), now, now)
      return this.result({ id, source_document_id: source.documentId, target_document_id: target.documentId,
        state: 'applied', moved_ids_json: JSON.stringify(plan.movedIds), before_json: JSON.stringify(before),
        after_json: JSON.stringify(after), expected_versions_json: JSON.stringify(expected) }, expected)
    })
  }

  /** Expose only a latest transition whose complete semantic state still matches.
   * A changed target/reference document must never become an editor Undo entry. */
  history(documentId: string): DocumentBlockMoveHistoryEntry | null {
    const rows = this.db.prepare('SELECT * FROM document_block_moves WHERE source_document_id = ? OR target_document_id = ? ORDER BY rowid DESC LIMIT 20')
      .all(documentId, documentId) as OperationRow[]
    for (const row of rows) {
      const before: Snapshot[] = JSON.parse(row.before_json), after: Snapshot[] = JSON.parse(row.after_json)
      const expected = row.state === 'applied' ? after : before
      try {
        const current = expected.map(snapshot => this.snapshot(snapshot.documentId))
        const versions = this.versions(current)
        this.assertCurrent(expected, versions)
        const beforeDocument = before.find(snapshot => snapshot.documentId === documentId)
        const afterDocument = after.find(snapshot => snapshot.documentId === documentId)
        if (beforeDocument && afterDocument) return { operationId: row.id, state: row.state,
          beforeBlocks: beforeDocument.content.blocks, afterBlocks: afterDocument.content.blocks,
          expectedUpdatedAtByDocument: versions }
      } catch { /* A stale or deleted participant makes this transition unavailable. */ }
    }
    return null
  }

  restore(input: RestoreDocumentBlockMoveInput, state: 'applied' | 'undone'): DocumentBlockMoveResult {
    if (!input || typeof input.operationId !== 'string' || !input.operationId.trim()) throw new Error('请选择有效的成对移动记录。')
    return this.store.runInTransaction(() => {
      const row = this.db.prepare('SELECT * FROM document_block_moves WHERE id = ?').get(input.operationId) as OperationRow | undefined
      if (!row) throw new Error('成对移动记录不存在。')
      if (row.state === state) throw new Error(state === 'undone' ? '此移动已撤销。' : '此移动已应用。')
      const currentSnapshots: Snapshot[] = JSON.parse(row.state === 'applied' ? row.after_json : row.before_json)
      const expected: Record<string, string> = JSON.parse(row.expected_versions_json)
      // Each affected document must match both the caller's acknowledged current
      // revision and the journal's semantic snapshot. Reverting an intervening
      // editor change may create a new revision with identical content.
      const acknowledged = input.expectedUpdatedAtByDocument
      if (!acknowledged || typeof acknowledged !== 'object' || Object.keys(expected).some(id =>
        !Object.hasOwn(acknowledged, id) || typeof acknowledged[id] !== 'string')) {
        throw new Error(staleMessage)
      }
      this.assertCurrent(currentSnapshots, acknowledged)
      const current = currentSnapshots.map(snapshot => this.snapshot(snapshot.documentId))
      const desired: Snapshot[] = JSON.parse(state === 'applied' ? row.after_json : row.before_json)
      this.checkpoint(current)
      const after = this.apply(desired, current), versions = this.versions(after)
      const updated = this.db.prepare('UPDATE document_block_moves SET state = ?, expected_versions_json = ?, updated_at = ? WHERE id = ? AND state = ?')
        .run(state, JSON.stringify(versions), new Date().toISOString(), row.id, row.state)
      if (updated.changes !== 1) throw new Error(staleMessage)
      return this.result({ ...row, state }, versions)
    })
  }
}
