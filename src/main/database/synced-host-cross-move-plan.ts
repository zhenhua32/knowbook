import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { planDocumentBlockTransfer } from '../../shared/documentBlockTransfer'
import { collectDocumentMarkdownLinks, getMarkdownHeadingRewrites, getMarkdownHeadingTargets } from '../../shared/markdownLinkMaintenance'
import { canonicalSyncedPortableJson } from '../../shared/syncedBlockPortable'
import type { SyncedStableBlockDraft } from '../../shared/synced-blocks'
import { SyncedValidationError, validateSyncedHostForest } from '../../shared/syncedBlockValidation'
import { MarkdownLinkIndex, type MarkdownIndexedDocument } from './markdown-link-index'
import { readStrictHostDocument, type HostContent, type StrictHostDocument } from './synced-host-document-read'
import { hasSyncedInsertWorkingStructure } from './synced-host-insert-plan'
import { assertSyncedDocumentNotLogicallyDeleted } from './synced-logical-deletion-read'
import { sameHostContent } from './synced-host-journal'
import { BlockIdentityRepository } from './block-identities'
import type { HostMoveInput } from './synced-host-move-plan'

type HostSide = { documentId: string; content: HostContent }
type Move = { blockId: string; from: string; to: string; createdAt: string }

export class MoveRefused extends Error {
  constructor(readonly reason: 'stale-host' | 'working-structure' | 'heading-rewrite' | 'working-links' | 'link-participants',
    readonly documentIds: readonly string[]) {
    super(`跨页移动前置拒绝：${reason}`)
  }
}

function owners(sides: readonly HostSide[]): Map<string, string> {
  const result = new Map<string, string>()
  for (const side of sides) for (const block of side.content.blocks) {
    if (result.has(block.id)) throw new SyncedValidationError('identity', '同一实际块出现在多个参与宿主。')
    result.set(block.id, side.documentId)
  }
  return result
}

export function checkTitleHeadings(documentId: string, before: HostContent, after: HostContent): void {
  if (before.title !== after.title || getMarkdownHeadingRewrites(getMarkdownHeadingTargets(before.blocks, before.title),
    getMarkdownHeadingTargets(after.blocks, after.title)).size) throw new MoveRefused('heading-rewrite', [documentId])
}

export function linkProjection(content: HostContent): string {
  return canonicalSyncedPortableJson(collectDocumentMarkdownLinks(content.blocks)
    .filter(link => link.kind !== 'image')
    .map(({ blockId, kind, url }) => [blockId, kind, url]))
}

function indexShape(host: StrictHostDocument, content: HostContent): MarkdownIndexedDocument {
  return { id: host.detail.id, path: host.detail.path, title: content.title, blocks: content.blocks }
}

export function crossMoveSourcePlaceholder(blockId: string): SyncedStableBlockDraft {
  return { id: blockId, type: 'paragraph', content: '', checked: false, depth: 0, parentBlockId: null, tags: [] }
}

/** Read-only candidate. This value conveys no authority to transfer SQL owners.
 * The original writer still needs its production fence, exact group guards,
 * journal/receipt and reciprocal inverse, all under its own IMMEDIATE transaction. */
export function readCrossHostMovePlan(db: Database.Database, input: HostMoveInput, findDependency = false) {
  if (!db.inTransaction) throw new Error('跨页移动预检需要实际 SQLite 快照。')
  const { selection, target } = input.action
  if (selection.documentId === target.documentId) throw new SyncedValidationError('identity', '跨页移动须有两个不同的参与宿主。')
  const before = input.hostsWorkingBefore.map(side => ({ documentId: side.documentId, content: side.workingBefore }))
  const originalOwners = owners(before), byId = new Map(before.map(side => [side.documentId, side]))
  const source = byId.get(selection.documentId), destination = byId.get(target.documentId)
  if (byId.size !== before.length || !source || !destination) throw new MoveRefused('link-participants', [selection.documentId, target.documentId])
  const persisted = new Map<string, StrictHostDocument>()
  for (const side of input.hostsWorkingBefore) {
    assertSyncedDocumentNotLogicallyDeleted(db, side.documentId)
    const host = readStrictHostDocument(db, side.documentId)
    if (!host || host.detail.updatedAt !== side.expectedPersistedUpdatedAt) throw new MoveRefused('stale-host', [side.documentId])
    if (!hasSyncedInsertWorkingStructure(host.content, side.workingBefore)) throw new MoveRefused('working-structure', [side.documentId])
    checkTitleHeadings(side.documentId, host.content, side.workingBefore)
    // The existing transfer index describes persisted P. A W introducing a link
    // or changing its target needs a source-projection reader before admission.
    if (linkProjection(host.content) !== linkProjection(side.workingBefore)) throw new MoveRefused('working-links', [side.documentId])
    persisted.set(side.documentId, host)
  }
  const parent = target.parentBlockId === null ? undefined : destination.content.blocks.find(block => block.id === target.parentBlockId)
  if ((target.parentBlockId !== null && !parent) || target.depth !== (parent ? parent.depth + 1 : 0)) {
    throw new SyncedValidationError('depth', '跨页移动目标 depth 与真实目标父块不一致。')
  }
  const tree = planDocumentBlockTransfer({ from: source.content.blocks, to: destination.content.blocks, selectedIds: selection.selectedRootIds,
    beforeBlockId: target.beforeBlockId ?? undefined, parentBlockId: target.parentBlockId, allowSyncedPlaceholders: true })
  if (!tree) throw new SyncedValidationError('forest', '跨页移动须使用完整连续根及真实目标锚点。')
  const repository = new BlockIdentityRepository(db)
  let placeholder: SyncedStableBlockDraft | undefined
  if (!tree.sourceBlocks.length) {
    let id = randomUUID()
    while (originalOwners.has(id) || repository.get(id)) id = randomUUID()
    placeholder = crossMoveSourcePlaceholder(id)
  }
  const links = new MarkdownLinkIndex(db).planBlockTransferReferences({
    source: indexShape(persisted.get(source.documentId)!, source.content),
    target: indexShape(persisted.get(destination.documentId)!, destination.content),
    sourceBlocks: placeholder ? [placeholder] : tree.sourceBlocks, targetBlocks: tree.targetBlocks, movedIds: tree.movedIds
  }, documentId => {
    const working = byId.get(documentId), actual = persisted.get(documentId) ?? readStrictHostDocument(db, documentId)
    if (!actual) throw new MoveRefused('stale-host', [documentId])
    return indexShape(actual, working?.content ?? actual.content)
  })
  const updates = new Map(links.map(update => [update.documentId, update.blocks]))
  const dependencies = links.filter(update => update.documentId !== source.documentId && update.documentId !== destination.documentId)
  if (findDependency) for (const { documentId } of dependencies) {
    if (byId.has(documentId)) continue
    const host = readStrictHostDocument(db, documentId)
    if (!host) throw new MoveRefused('stale-host', [documentId])
    assertSyncedDocumentNotLogicallyDeleted(db, documentId)
    const side = { documentId, content: host.content }
    persisted.set(documentId, host); byId.set(documentId, side); before.push(side)
    for (const block of host.content.blocks) {
      if (originalOwners.has(block.id)) throw new SyncedValidationError('identity', '同一实际块出现在多个参与宿主。')
      originalOwners.set(block.id, documentId)
    }
  }
  if (updates.size !== before.length || before.some(side => !updates.has(side.documentId))) {
    throw new MoveRefused('link-participants', [...updates.keys()])
  }
  const after = before.map(side => ({ documentId: side.documentId,
    content: { ...side.content, blocks: validateSyncedHostForest(updates.get(side.documentId)) } }))
  for (const [index, side] of after.entries()) checkTitleHeadings(side.documentId, before[index].content, side.content)
  const finalOwners = owners(after), movedIds = new Set(tree.movedIds), moved: Move[] = []
  if (placeholder) {
    if (finalOwners.get(placeholder.id) !== source.documentId) throw new SyncedValidationError('identity', '跨页移动源页空段落归属无效。')
    finalOwners.delete(placeholder.id)
  }
  if (originalOwners.size !== finalOwners.size) throw new SyncedValidationError('identity', '移动前后实际块集合不同。')
  const identities = repository.getMany([...originalOwners.keys()])
  for (const [blockId, from] of originalOwners) {
    const to = finalOwners.get(blockId)
    if (!to || movedIds.has(blockId) !== (from !== to) || (movedIds.has(blockId) && (from !== source.documentId || to !== destination.documentId))) {
      throw new SyncedValidationError('identity', '跨页移动只有同一真实子树可转移所有者。')
    }
    const ledger = identities.get(blockId), birth = persisted.get(from)!.births.get(blockId)
    if (ledger && (ledger.owner.kind !== 'document' || ledger.owner.id !== from || ledger.createdAt === null)
      || birth !== undefined && (ledger?.state !== 'live' || ledger.createdAt !== birth)
      || birth === undefined && ledger?.state === 'live') {
      throw new SyncedValidationError('identity', '实际 W 活块或保留身份的 owner/birth 不一致。')
    }
    if (from !== to) {
      // Until the persisted journal can prove a W-only birth independently,
      // the narrow physical transfer requires an actual live source row.
      if (birth === undefined) throw new SyncedValidationError('identity', '跨页移动块须具有实际来源活块及准确创建时间。')
      moved.push({ blockId, from, to, createdAt: birth })
    }
  }
  return { before, after, moved, dependencies: dependencies.map(({ documentId }) => persisted.get(documentId)!),
    ...(placeholder ? { sourcePlaceholderId: placeholder.id } : {}) }
}

/** Dependent pages contribute their exact persisted body, never a local W. */
export function assertCrossMoveDependency(db: Database.Database, input: HostMoveInput, documentId: string): void {
  const persisted = readStrictHostDocument(db, documentId), side = input.hostsWorkingBefore.find(host => host.documentId === documentId)
  if (!persisted || !side || !sameHostContent(persisted.content, side.workingBefore)) throw new MoveRefused('link-participants', [documentId])
}
