import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { planDocumentBlockTransfer } from '../../shared/documentBlockTransfer'
import { blockTransferFragmentId, blockTransferLinkBindingKey, rewriteBatchBlockTransferLinks, rewriteDocumentBlockTransferLinks,
  type BlockTransferPathChange, type BlockTransferWikiBinding } from '../../shared/documentBlockTransferLinks'
import { collectDocumentMarkdownLinks, type MarkdownDocumentLink } from '../../shared/markdownLinkMaintenance'
import { escapeMarkdownDestination, parseLocalMarkdownUrl, relativeMarkdownPath, resolveMarkdownDocumentPath } from '../../shared/markdownLinks'
import { parseWikiReference } from '../../shared/markdownWiki'
import { validateSyncedStructureInput } from '../../shared/syncedBlockInputs'
import type { SyncedEditingMethods } from '../../shared/synced-editing-session'
import { assertSyncedShape, isSyncedBlockId, isSyncedUuid, SYNCED_MAX_BLOCKS, SyncedValidationError, validateSyncedHostForest,
  validateSyncedOrigin } from '../../shared/syncedBlockValidation'
import { getSyncedGroupSnapshots } from './synced-blocks-read'
import { readStrictHostDocument, hostJson, hostTime } from './synced-host-document-read'
import { hasSyncedInsertWorkingStructure } from './synced-host-insert-plan'
import { isHostMoveInput, type HostMoveInput } from './synced-host-move-plan'
import { isHostMoveBatchInput, planSyncedCrossMoveBatch, type HostMoveBatchInput } from './synced-host-cross-move-batch-plan'
import { hostEncode, hostEqual, hostHash, hostReferencedGroups, sameHostContent, validateHostContent, validateHostSides,
  type HostGroupDependency, type HostSide } from './synced-host-journal'
import type { SyncedHostHistoryBranchRow } from './synced-host-history-branch'
import { assertCrossMoveDependency, checkTitleHeadings, crossMoveSourcePlaceholder, linkProjection, MoveRefused, readCrossHostMovePlan } from './synced-host-cross-move-plan'
import { requireSyncedMetadataEditingFenceOwned2 } from './synced-editing-fence'
import { checkCrossMoveDraftOwned } from './synced-cross-move-draft-guard'
import { extendedCrossMoveLinkKey, isExtendedCrossMoveLink, proveExtendedCrossMoveLinks } from './synced-cross-host-markdown10'

type IndexedLink = { blockId: string; offset: number; url: string; kind: string; targetPath: string | null; fragment: string | null }
type Page = HostSide & { path: string; createdAt: string; updatedAt: string; births: Array<{ blockId: string; createdAt: string }>;
  indexedLinks: IndexedLink[] }
type Transfer = { blockId: string; from: string; to: string; createdAt: string }
type SourcePlaceholder = { version: 1; blockId: string; createdAt: string }
type BatchSourcePlaceholder = SourcePlaceholder & { documentId: string }
type CrossMoveVersion = 4 | 6 | 7 | 9 | 10 | 11
type KnownOriginal = { input: HostMoveInput; persisted: Page[]; groups: HostGroupDependency[]; before: HostSide[]; after: HostSide[];
  crossMove: { transfers: Transfer[]; outsideIncoming: string[]; sourcePlaceholder?: SourcePlaceholder } }

type BatchOriginal = Omit<KnownOriginal, 'input' | 'crossMove'> & { input: HostMoveBatchInput;
  crossMove: { transfers: Transfer[]; outsideIncoming: string[]; sourcePlaceholders: BatchSourcePlaceholder[] } }

export class CrossMoveJournalError extends Error {
  constructor() { super('跨页移动 v4 原始记录无效。') }
}
const fail = (): never => { throw new CrossMoveJournalError() }
const blockId = (value: unknown): string => isSyncedBlockId(value) ? value : fail()
const uuid = (value: unknown): string => isSyncedUuid(value) ? value : fail()
const text = (value: unknown): string => typeof value === 'string' ? value : fail()
const path = (value: unknown): string => typeof value === 'string' && value.trim() && !value.includes('\0') ? value : fail()
const nullable = (value: unknown): string | null => value === null ? null : text(value)
const offset = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fail()
function array<T>(value: unknown, read: (item: unknown) => T, key: (item: T) => string): T[] {
  if (!Array.isArray(value)) return fail()
  const items = value.map(read)
  if (new Set(items.map(key)).size !== items.length) return fail()
  return items
}

function readPage(raw: unknown): Page {
  assertSyncedShape(raw, ['documentId', 'path', 'createdAt', 'updatedAt', 'content', 'births', 'indexedLinks'])
  const content = validateHostContent(raw.content)
  const births = array(raw.births, item => {
    assertSyncedShape(item, ['blockId', 'createdAt'])
    return { blockId: blockId(item.blockId), createdAt: hostTime(item.createdAt) }
  }, item => item.blockId)
  if (!isDeepStrictEqual(births.map(item => item.blockId), content.blocks.map(item => item.id))) return fail()
  const indexedLinks = array(raw.indexedLinks, item => {
    assertSyncedShape(item, ['blockId', 'offset', 'url', 'kind', 'targetPath', 'fragment'])
    return { blockId: blockId(item.blockId), offset: offset(item.offset), url: text(item.url), kind: text(item.kind),
      targetPath: nullable(item.targetPath), fragment: nullable(item.fragment) }
  }, item => JSON.stringify([item.blockId, item.offset]))
  const indexedKinds = new Map(collectDocumentMarkdownLinks(content.blocks)
    .filter(link => link.kind === 'wiki' || parseLocalMarkdownUrl(link.url) || link.url.startsWith('file:')).map(link =>
    [JSON.stringify([link.blockId, link.start, link.url]), link.kind]))
  if (indexedLinks.length !== indexedKinds.size || indexedLinks.some(link =>
    indexedKinds.get(JSON.stringify([link.blockId, link.offset, link.url])) !== (link.kind === 'wiki-heading' ? 'wiki' : link.kind)
      || (link.targetPath === null) !== (link.fragment === null) || link.kind === 'image' && link.targetPath !== null)) return fail()
  return { documentId: blockId(raw.documentId), path: path(raw.path), createdAt: hostTime(raw.createdAt),
    updatedAt: hostTime(raw.updatedAt), content, births, indexedLinks }
}

function originGroups(raw: unknown): HostGroupDependency[] {
  return array(raw, item => {
    assertSyncedShape(item, ['groupId', 'creationId', 'createdAt', 'origin'])
    return { groupId: uuid(item.groupId), creationId: uuid(item.creationId), createdAt: hostTime(item.createdAt), origin: validateSyncedOrigin(item.origin) }
  }, item => item.groupId)
}

function transferRows(raw: unknown): Transfer[] {
  return array(raw, item => {
    assertSyncedShape(item, ['blockId', 'from', 'to', 'createdAt'])
    return { blockId: blockId(item.blockId), from: blockId(item.from), to: blockId(item.to), createdAt: hostTime(item.createdAt) }
  }, item => item.blockId)
}

function thirdInboundLinks(page: Page, from: string, movedIds: ReadonlySet<string>) {
  return page.indexedLinks.filter(link => link.kind !== 'image' && link.targetPath === from
    && movedIds.has(blockTransferFragmentId(link.fragment ?? '')))
}

function thirdMarkdownReplacement(item: MarkdownDocumentLink, row: IndexedLink, raw: string, source: string, from: string, to: string): string {
  if (item.kind !== 'link' || item.syntax !== undefined) return fail()
  const actual = resolveMarkdownDocumentPath(source, item.url), original = resolveMarkdownDocumentPath(source, raw)
  const local = parseLocalMarkdownUrl(raw)
  if (!local?.path || !local.suffix.includes('#') || actual?.path !== from || original?.path !== from
    || actual.fragment !== row.fragment || original.fragment !== row.fragment) return fail()
  const path = local.path.startsWith('/') ? '/' + to.split('/').map(encodeURIComponent).join('/') + '.md'
    : relativeMarkdownPath(source + '.md', to + '.md')
  return escapeMarkdownDestination(path) + local.suffix
}

function thirdWikiReplacement(item: MarkdownDocumentLink, row: IndexedLink, raw: string, from: string, to: string): string {
  if (item.kind !== 'wiki') return fail()
  const ref = parseWikiReference(row.url)
  if (!ref.hasFragment || ref.path !== from || ref.fragment !== row.fragment || !raw.startsWith(from + '#' + ref.fragment)) return fail()
  return to + raw.slice(from.length)
}

function extendedMarkdownReplacement(item: MarkdownDocumentLink, row: IndexedLink, raw: string, source: string, from: string, to: string): string {
  const actual = resolveMarkdownDocumentPath(source, item.url), local = parseLocalMarkdownUrl(item.url)
  if (!local?.path || !local.suffix.includes('#') || actual?.path !== from || actual.fragment !== row.fragment) return fail()
  const destination = local.path.startsWith('/') ? '/' + to.split('/').map(encodeURIComponent).join('/') + '.md'
    : relativeMarkdownPath(source + '.md', to + '.md')
  const escaped = escapeMarkdownDestination(destination + local.suffix, item.kind === 'link' ? item.syntax : undefined)
  return raw.includes('#^') ? escaped.replace(/#%5e/i, '#^') : escaped
}

/** Check each dependent page against independently derived source edits. V6
 * stays Wiki-only, and V7 still requires an inline link in its single page. */
function assertDependentLinkChanges(page: Page, from: string, to: string, movedIds: ReadonlySet<string>, blocks: HostSide['content']['blocks'],
  rewritten: ReturnType<typeof rewriteDocumentBlockTransferLinks>, version: CrossMoveVersion): boolean {
  if (/[#|\\\[\]\r\n]/.test(from + to)) return fail()
  const allowExtended = version === 10 || version === 11
  const allowMarkdown = version === 7 || version === 9 || allowExtended
  const incoming = thirdInboundLinks(page, from, movedIds)
  if (!incoming.length || incoming.some(link => link.kind !== 'wiki' && (!allowMarkdown || link.kind !== 'link')
    && (!allowExtended || link.kind !== 'definition'))
    || version === 7 && !incoming.some(link => link.kind === 'link')) return fail()
  const key = (id: string, start: number) => JSON.stringify([id, start])
  const parsed = new Map(collectDocumentMarkdownLinks(blocks).filter(link => link.blockId !== undefined
    && (link.kind === 'wiki' || allowMarkdown && link.kind !== 'image'))
    .map(item => [key(item.blockId!, item.start), item]))
  const expected = [...parsed.values()].filter(item => {
    const ref = item.kind === 'wiki' ? parseWikiReference(item.url) : resolveMarkdownDocumentPath(page.path, item.url)
    return ref?.path === from && movedIds.has(blockTransferFragmentId(ref.fragment))
  })
  if (expected.length !== incoming.length) return fail()
  const extended = allowExtended && expected.some(isExtendedCrossMoveLink)
  const beforeProof = extended ? proveExtendedCrossMoveLinks(blocks) : undefined
  const changes = new Map<string, Array<{ item: MarkdownDocumentLink; replacement: string; extended: boolean }>>()
  for (const row of incoming) {
    const item = parsed.get(key(row.blockId, row.offset)) ?? fail()
    if (version === 11 && blocks[item.blockIndex].type === 'synced-block') return fail()
    const raw = blocks[item.blockIndex].content.slice(item.start, item.end)
    if (item.url !== row.url || item.kind !== row.kind) return fail()
    let replacement: string
    if (item.kind === 'wiki') {
      replacement = thirdWikiReplacement(item, row, raw, from, to)
    } else if (allowExtended && isExtendedCrossMoveLink(item)) {
      if (!beforeProof?.has(extendedCrossMoveLinkKey(item))) return fail()
      replacement = extendedMarkdownReplacement(item, row, raw, page.path, from, to)
    } else replacement = thirdMarkdownReplacement(item, row, raw, page.path, from, to)
    const edits = changes.get(row.blockId) ?? []
    edits.push({ item, replacement, extended: allowExtended && isExtendedCrossMoveLink(item) })
    changes.set(row.blockId, edits)
  }
  const afterProof = extended ? proveExtendedCrossMoveLinks(rewritten) : undefined
  const afterLinks = extended ? new Map(collectDocumentMarkdownLinks(rewritten)
    .filter(item => item.blockId && isExtendedCrossMoveLink(item)).map(item => [key(item.blockId!, item.start), item])) : undefined
  for (const [index, block] of blocks.entries()) {
    let expected = '', end = 0
    for (const { item, replacement, extended: prove } of (changes.get(block.id) ?? []).sort((left, right) => left.item.start - right.item.start)) {
      if (item.start < end) return fail()
      expected += block.content.slice(end, item.start)
      if (prove) {
        const after = afterLinks?.get(key(block.id, expected.length))
        if (!after || after.end !== after.start + replacement.length || after.kind !== item.kind || !afterProof?.has(extendedCrossMoveLinkKey(after))
          || resolveMarkdownDocumentPath(page.path, after.url)?.path !== to
          || parseLocalMarkdownUrl(after.url)?.suffix !== parseLocalMarkdownUrl(item.url)?.suffix) return fail()
      }
      expected += replacement
      end = item.end
    }
    expected += block.content.slice(end)
    if (rewritten[index].content !== expected) return fail()
  }
  return extended
}

function rederive(input: HostMoveInput, pages: Page[], version: CrossMoveVersion, dependencyIds: string[], placeholder?: SourcePlaceholder) {
  const { selection, target } = input.action
  const dependencies = new Set(dependencyIds)
  if (pages.length !== dependencies.size + 2 || input.hostsWorkingBefore.length !== pages.length || selection.documentId === target.documentId
    || dependencies.has(selection.documentId) || dependencies.has(target.documentId)) return fail()
  if ((version === 9 || version === 10 || version === 11) && new Set(pages.map(page => page.path)).size !== pages.length) return fail()
  const old = new Map(pages.map(page => [page.documentId, page]))
  const distinctBlocks = new Set(input.hostsWorkingBefore.flatMap(side => side.workingBefore.blocks.map(block => block.id)))
  if (distinctBlocks.size !== input.hostsWorkingBefore.reduce((count, side) => count + side.workingBefore.blocks.length, 0)) return fail()
  const before = input.hostsWorkingBefore.map(({ documentId, workingBefore, expectedPersistedUpdatedAt }) => {
    const page = old.get(documentId)
    if (!page || page.updatedAt !== expectedPersistedUpdatedAt || !hasSyncedInsertWorkingStructure(page.content, workingBefore)
      || linkProjection(page.content) !== linkProjection(workingBefore)) return fail()
    checkTitleHeadings(documentId, page.content, workingBefore)
    return { documentId, content: workingBefore }
  })
  const source = before.find(side => side.documentId === selection.documentId)
  const dest = before.find(side => side.documentId === target.documentId)
  if (!source || !dest) return fail()
  const dependents = before.filter(side => dependencies.has(side.documentId))
  const dependentReferences = dependents.some(side => side.content.blocks.some(block => block.type === 'synced-block'))
  if (dependents.length !== dependencies.size || dependentReferences !== (version === 11)
    || dependents.some(side => !sameHostContent(side.content, old.get(side.documentId)!.content))) return fail()
  const sourcePage = old.get(source.documentId)!, destPage = old.get(dest.documentId)!
  if (sourcePage.path === destPage.path) return fail()
  const parent = target.parentBlockId === null ? null : dest.content.blocks.find(block => block.id === target.parentBlockId)
  if (parent === undefined || target.depth !== (parent ? parent.depth + 1 : 0)) return fail()
  const tree = planDocumentBlockTransfer({ from: source.content.blocks, to: dest.content.blocks, selectedIds: selection.selectedRootIds,
    beforeBlockId: target.beforeBlockId ?? undefined, parentBlockId: target.parentBlockId, allowSyncedPlaceholders: true })
  if (!tree || (tree.sourceBlocks.length === 0) !== Boolean(placeholder)) return fail()
  if (placeholder && (distinctBlocks.has(placeholder.blockId)
    || pages.some(page => page.births.some(birth => birth.blockId === placeholder.blockId)))) return fail()
  const movedIds = new Set(tree.movedIds), rewritten = new Map<string, string>()
  const targetContent = dest.content.blocks.map(block => block.content).join('\n')
  let extended = false
  for (const side of before) {
    const page = old.get(side.documentId)!, bindings = new Map<string, BlockTransferWikiBinding>()
    for (const link of page.indexedLinks) {
      if (link.targetPath === null) continue
      const fragment = blockTransferFragmentId(link.fragment ?? ''), key = blockTransferLinkBindingKey(link.blockId, link.url)
      const binding: BlockTransferWikiBinding = { path: link.targetPath, fragment,
        kind: link.kind === 'wiki-heading' ? 'heading' : fragment && movedIds.has(fragment) && link.targetPath === sourcePage.path ? 'block' : 'document' }
      const previous = bindings.get(key)
      if (previous && !hostEqual(previous, binding)) return fail()
      bindings.set(key, binding)
    }
    const blocks = rewriteDocumentBlockTransferLinks(side.content.blocks, { sourcePath: page.path, fromPath: sourcePage.path,
      toPath: destPage.path, movedIds, bindings, targetContent })
    if (dependencies.has(side.documentId) && assertDependentLinkChanges(page, sourcePage.path, destPage.path, movedIds, side.content.blocks, blocks, version))
      extended = true
    for (const block of blocks) rewritten.set(blockId(block.id), block.content)
  }
  if (version === 10 && !extended) return fail()
  const after = before.map(side => {
    const sideBlocks = side === source ? tree.sourceBlocks : side === dest ? tree.targetBlocks : side.content.blocks
    const blocks = side === source && placeholder ? [crossMoveSourcePlaceholder(placeholder.blockId)]
      : sideBlocks.map(block => ({ ...block, content: rewritten.get(blockId(block.id)) ?? fail() }))
    const content = { ...side.content, blocks: validateSyncedHostForest(blocks) }
    checkTitleHeadings(side.documentId, side.content, content)
    return { documentId: side.documentId, content }
  })
  const births = new Map(sourcePage.births.map(birth => [birth.blockId, birth.createdAt]))
  const transfers: Transfer[] = tree.movedIds.map(blockId => ({ blockId, from: source.documentId, to: dest.documentId, createdAt: births.get(blockId) ?? fail() }))
  return { before, after, transfers }
}

function decodeCrossHostJournalVersion(row: Readonly<SyncedHostHistoryBranchRow>, version: CrossMoveVersion): KnownOriginal {
  uuid(row.id)
  hostTime(row.created_at)
  const action = hostJson(row.action_json)
  assertSyncedShape(action, ['kind', 'version', 'input', 'persisted', 'groups', 'crossMove', 'originalHash'])
  if (action.kind !== 'host-command' || action.version !== version || hostHash({ input: action.input, persisted: action.persisted, groups: action.groups,
    crossMove: action.crossMove }) !== action.originalHash) return fail()
  const input = validateSyncedStructureInput(action.input)
  if (!isHostMoveInput(input)) return fail()
  const persisted = array(action.persisted, readPage, page => page.documentId), groups = originGroups(action.groups)
  const before = validateHostSides(hostJson(row.before_json)), after = validateHostSides(hostJson(row.after_json))
  const multipleDependencies = version === 9 || version === 10 || version === 11
  assertSyncedShape(action.crossMove, ['transfers', 'outsideIncoming'], version === 4 || multipleDependencies ? ['sourcePlaceholder'] : [])
  const dependencyIds = array(action.crossMove.outsideIncoming, blockId, id => id)
  if (multipleDependencies ? dependencyIds.length < 1 || dependencyIds.length > SYNCED_MAX_BLOCKS - 2
    || dependencyIds.some((id, index) => index > 0 && dependencyIds[index - 1] >= id)
    : dependencyIds.length !== (version === 4 ? 0 : 1)) return fail()
  let placeholder: SourcePlaceholder | undefined
  if ('sourcePlaceholder' in action.crossMove) {
    const value = action.crossMove.sourcePlaceholder
    assertSyncedShape(value, ['version', 'blockId', 'createdAt'])
    if (value.version !== 1 || value.createdAt !== row.created_at) return fail()
    placeholder = { version: 1, blockId: uuid(value.blockId), createdAt: row.created_at }
  }
  if (version === 9 && dependencyIds.length === 1 && !placeholder) return fail()
  const transfers = transferRows(action.crossMove.transfers), planned = rederive(input, persisted, version, dependencyIds, placeholder)
  if (!hostEqual(planned.before, before) || !hostEqual(planned.after, after) || !hostEqual(planned.transfers, transfers)
    || row.before_hash !== hostHash(before) || row.after_hash !== hostHash(after)) return fail()
  assertCrossMoveDependencies(input, persisted, before, after, groups)
  return { input, persisted, groups, before, after, crossMove: { transfers, outsideIncoming: dependencyIds,
    ...(placeholder ? { sourcePlaceholder: placeholder } : {}) } }
}

export function decodeCrossHostJournal4(row: Readonly<SyncedHostHistoryBranchRow>): KnownOriginal { return decodeCrossHostJournalVersion(row, 4) }
export function decodeCrossHostJournal6(row: Readonly<SyncedHostHistoryBranchRow>): KnownOriginal { return decodeCrossHostJournalVersion(row, 6) }
export function decodeCrossHostJournal7(row: Readonly<SyncedHostHistoryBranchRow>): KnownOriginal { return decodeCrossHostJournalVersion(row, 7) }
export function decodeCrossHostJournal9(row: Readonly<SyncedHostHistoryBranchRow>): KnownOriginal { return decodeCrossHostJournalVersion(row, 9) }
export function decodeCrossHostJournal10(row: Readonly<SyncedHostHistoryBranchRow>): KnownOriginal { return decodeCrossHostJournalVersion(row, 10) }
export function decodeCrossHostJournal11(row: Readonly<SyncedHostHistoryBranchRow>): KnownOriginal { return decodeCrossHostJournalVersion(row, 11) }

/** An outside host has no moved blocks. Prove every replacement at its bound
 * source offset, using one original parse even when links follow two edges. */
function assertBatchDependentLinks(page: Page, paths: ReadonlyMap<string, BlockTransferPathChange>,
  rewritten: NonNullable<ReturnType<typeof rewriteBatchBlockTransferLinks>>): void {
  const blocks = page.content.blocks
  const moveFor = (path: string | null, fragment: string | null) => {
    const edge = paths.get(blockTransferFragmentId(fragment ?? ''))
    return edge?.fromPath === path ? edge : undefined
  }
  const incoming = page.indexedLinks.filter(row => row.kind !== 'image' && moveFor(row.targetPath, row.fragment))
  if (!incoming.length) return fail()
  const key = (id: string, start: number) => JSON.stringify([id, start])
  const parsed = new Map(collectDocumentMarkdownLinks(blocks).filter(item => item.blockId !== undefined && item.kind !== 'image')
    .map(item => [key(item.blockId!, item.start), item]))
  const exact = [...parsed.values()].filter(item => {
    const target = item.kind === 'wiki' ? parseWikiReference(item.url) : resolveMarkdownDocumentPath(page.path, item.url)
    return target && moveFor(target.path, target.fragment)
  })
  if (exact.length !== incoming.length) return fail()
  const extended = exact.some(isExtendedCrossMoveLink)
  const beforeProof = extended ? proveExtendedCrossMoveLinks(blocks) : undefined
  const edits = new Map<string, Array<{ item: MarkdownDocumentLink; replacement: string; edge: BlockTransferPathChange }>>()
  for (const row of incoming) {
    const item = parsed.get(key(row.blockId, row.offset)) ?? fail()
    const block = blocks[item.blockIndex], edge = moveFor(row.targetPath, row.fragment) ?? fail()
    if (block.type === 'synced-block' || item.url !== row.url || item.kind !== row.kind || /[#|\\\[\]\r\n]/.test(edge.fromPath + edge.toPath)) return fail()
    const original = block.content.slice(item.start, item.end)
    let replacement: string
    if (item.kind === 'wiki') replacement = thirdWikiReplacement(item, row, original, edge.fromPath, edge.toPath)
    else if (isExtendedCrossMoveLink(item)) {
      if (!beforeProof?.has(extendedCrossMoveLinkKey(item))) return fail()
      replacement = extendedMarkdownReplacement(item, row, original, page.path, edge.fromPath, edge.toPath)
    } else replacement = thirdMarkdownReplacement(item, row, original, page.path, edge.fromPath, edge.toPath)
    const changes = edits.get(row.blockId) ?? []
    changes.push({ item, replacement, edge })
    edits.set(row.blockId, changes)
  }
  const afterProof = extended ? proveExtendedCrossMoveLinks(rewritten) : undefined
  const afterLinks = extended ? new Map(collectDocumentMarkdownLinks(rewritten)
    .filter(item => item.blockId && isExtendedCrossMoveLink(item)).map(item => [key(item.blockId!, item.start), item])) : undefined
  for (const [index, block] of blocks.entries()) {
    let expected = '', end = 0
    for (const { item, replacement, edge } of (edits.get(block.id) ?? []).sort((a, b) => a.item.start - b.item.start)) {
      if (item.start < end) return fail()
      expected += block.content.slice(end, item.start)
      if (isExtendedCrossMoveLink(item)) {
        const after = afterLinks?.get(key(block.id, expected.length))
        if (!after || after.end !== after.start + replacement.length || after.kind !== item.kind || !afterProof?.has(extendedCrossMoveLinkKey(after))
          || resolveMarkdownDocumentPath(page.path, after.url)?.path !== edge.toPath
          || parseLocalMarkdownUrl(after.url)?.suffix !== parseLocalMarkdownUrl(item.url)?.suffix) return fail()
      }
      expected += replacement
      end = item.end
    }
    if (rewritten[index].content !== expected + block.content.slice(end)) return fail()
  }
}

function batchPaths(transfers: readonly Pick<Transfer, 'blockId' | 'from' | 'to'>[], pages: readonly Page[]) {
  const paths = new Map(pages.map(page => [page.documentId, page.path]))
  return new Map(transfers.map(({ blockId, from, to }) => {
    const fromPath = paths.get(from) ?? fail(), toPath = paths.get(to) ?? fail()
    if (fromPath === toPath) return fail()
    return [blockId, { fromPath, toPath }]
  }))
}

function rewriteBatchPage(page: Page, blocks: HostSide['content']['blocks'], paths: ReadonlyMap<string, BlockTransferPathChange>,
  outgoing: Parameters<typeof rewriteBatchBlockTransferLinks>[4]) {
  const bindings = new Map<string, BlockTransferWikiBinding>()
  for (const source of page.indexedLinks) if (source.targetPath !== null) {
    const fragment = blockTransferFragmentId(source.fragment ?? '')
    const key = blockTransferLinkBindingKey(source.blockId, source.url)
    const binding: BlockTransferWikiBinding = { path: source.targetPath, fragment,
      kind: source.kind === 'wiki-heading' ? 'heading' : paths.get(fragment)?.fromPath === source.targetPath ? 'block' : 'document' }
    const previous = bindings.get(key)
    if (previous && !hostEqual(previous, binding)) return fail()
    bindings.set(key, binding)
  }
  return rewriteBatchBlockTransferLinks(blocks, page.path, paths, bindings, outgoing) ?? fail()
}

function deriveBatch(input: HostMoveBatchInput, pages: Page[], placeholders: BatchSourcePlaceholder[], dependencyIds: string[],
  planned = planSyncedCrossMoveBatch(input)) {
  const byId = new Map(pages.map(page => [page.documentId, page]))
  const births = new Map(pages.flatMap(page => page.births.map(birth => [birth.blockId, { owner: page.documentId, at: birth.createdAt }] as const)))
  const placeholderByPage = new Map(placeholders.map(entry => [entry.documentId, entry.blockId]))
  const emptyPages = planned.after.filter(side => !side.content.blocks.length).map(side => side.documentId)
  const originalIds = new Set(planned.before.flatMap(side => side.content.blocks.map(block => block.id)))
  const outside = planned.before.filter(side => !planned.movePages.has(side.documentId)).map(side => side.documentId).sort()
  if (pages.length !== planned.before.length || !hostEqual(outside, dependencyIds)
    || dependencyIds.length && new Set(pages.map(page => page.path)).size !== pages.length) return fail()
  const dependencies = new Set(dependencyIds)
  if (!hostEqual(placeholders.map(entry => entry.documentId), emptyPages)
    || new Set(placeholders.map(entry => entry.blockId)).size !== placeholders.length
    || placeholders.some(entry => originalIds.has(entry.blockId) || births.has(entry.blockId))) return fail()
  for (const [index, before] of planned.before.entries()) {
    const page = byId.get(before.documentId)
    if (!page || page.updatedAt !== input.hostsWorkingBefore[index].expectedPersistedUpdatedAt
      || !hasSyncedInsertWorkingStructure(page.content, before.content) || linkProjection(page.content) !== linkProjection(before.content)) return fail()
    if (dependencies.has(before.documentId) && !sameHostContent(page.content, before.content)) return fail()
    checkTitleHeadings(page.documentId, page.content, before.content)
  }
  const paths = batchPaths(planned.transfers, pages)
  const edges = new Map<string, { from: string; to: string; moved: Set<string> }>()
  const transfers = planned.transfers.map(({ blockId, from, to }) => {
    const key = JSON.stringify([from, to])
    const edge = edges.get(key) ?? { from, to, moved: new Set<string>() }
    edge.moved.add(blockId)
    edges.set(key, edge)
    const birth = births.get(blockId)
    return { blockId, from, to, createdAt: birth?.owner === from ? birth.at : fail() }
  })
  const originalBodies = new Map(planned.before.map(side => [side.documentId, side.content.blocks]))
  const rewritten = new Map<string, string>()
  for (const page of pages) {
    const outgoing = [...edges.values()].filter(edge => edge.from === page.documentId)
      .map(edge => ({ toPath: byId.get(edge.to)!.path, movedIds: edge.moved,
        targetContent: originalBodies.get(edge.to)!.map(block => block.content).join('\n') }))
    const blocks = rewriteBatchPage(page, originalBodies.get(page.documentId)!, paths, outgoing)
    if (dependencies.has(page.documentId)) assertBatchDependentLinks(page, paths, blocks)
    for (const block of blocks) rewritten.set(blockId(block.id), block.content)
  }
  const after = planned.after.map((side, index) => {
    const placeholder = placeholderByPage.get(side.documentId)
    const blocks = placeholder ? [crossMoveSourcePlaceholder(placeholder)] : side.content.blocks.map(block => ({
      ...block, content: rewritten.get(block.id) ?? fail()
    }))
    const content = { ...side.content, blocks: validateSyncedHostForest(blocks) }
    checkTitleHeadings(side.documentId, planned.before[index].content, content)
    return { ...side, content }
  })
  return { before: planned.before, after, transfers }
}

function decodeCrossHostBatchJournal(row: Readonly<SyncedHostHistoryBranchRow>, version: 8 | 12): BatchOriginal {
  uuid(row.id)
  hostTime(row.created_at)
  const action = hostJson(row.action_json)
  assertSyncedShape(action, ['kind', 'version', 'input', 'persisted', 'groups', 'crossMove', 'originalHash'])
  if (action.kind !== 'host-command' || action.version !== version || hostHash({ input: action.input, persisted: action.persisted,
    groups: action.groups, crossMove: action.crossMove }) !== action.originalHash) return fail()
  const input = validateSyncedStructureInput(action.input)
  if (!isHostMoveBatchInput(input)) return fail()
  const persisted = array(action.persisted, readPage, page => page.documentId), groups = originGroups(action.groups)
  const before = validateHostSides(hostJson(row.before_json)), after = validateHostSides(hostJson(row.after_json))
  assertSyncedShape(action.crossMove, ['transfers', 'outsideIncoming', 'sourcePlaceholders'])
  const outsideIncoming = array(action.crossMove.outsideIncoming, blockId, id => id)
  if (version === 8 ? outsideIncoming.length !== 0 : !outsideIncoming.length
    || outsideIncoming.some((id, index) => index > 0 && outsideIncoming[index - 1] >= id)) return fail()
  const placeholders = array(action.crossMove.sourcePlaceholders, value => {
    assertSyncedShape(value, ['version', 'documentId', 'blockId', 'createdAt'])
    if (value.version !== 1 || value.createdAt !== row.created_at) return fail()
    return { version: 1 as const, documentId: blockId(value.documentId), blockId: uuid(value.blockId), createdAt: row.created_at }
  }, item => item.documentId)
  const transfers = transferRows(action.crossMove.transfers), planned = deriveBatch(input, persisted, placeholders, outsideIncoming)
  if (!hostEqual(planned.before, before) || !hostEqual(planned.after, after) || !hostEqual(planned.transfers, transfers)
    || row.before_hash !== hostHash(before) || row.after_hash !== hostHash(after)) return fail()
  assertCrossMoveDependencies(input, persisted, before, after, groups)
  return { input, persisted, groups, before, after, crossMove: { transfers, outsideIncoming, sourcePlaceholders: placeholders } }
}

export function decodeCrossHostJournal8(row: Readonly<SyncedHostHistoryBranchRow>): BatchOriginal { return decodeCrossHostBatchJournal(row, 8) }
export function decodeCrossHostJournal12(row: Readonly<SyncedHostHistoryBranchRow>): BatchOriginal { return decodeCrossHostBatchJournal(row, 12) }

function assertCrossMoveDependencies(input: HostMoveInput | HostMoveBatchInput, persisted: Page[], before: HostSide[], after: HostSide[],
  groups: HostGroupDependency[]) {
  const referenced = hostReferencedGroups([...before, ...after, ...persisted])
  if (referenced.size !== groups.length || groups.some(group => !referenced.has(group.groupId)) || input.groups.length !== groups.length
    || input.groups.some(group => !referenced.has(group.groupId))) return fail()
  const refs = new Map(persisted.flatMap(page => page.content.blocks.filter(block => block.type === 'synced-block')
    .map(block => [block.id, page.documentId] as const)))
  if (refs.size !== input.expectedInstances.length || input.expectedInstances.some(guard => refs.get(guard.instanceId) !== guard.hostDocumentId)) return fail()
}

function captureBatchJournal(db: Database.Database, input: HostMoveBatchInput, now: string, findDependencies: boolean): SyncedHostHistoryBranchRow {
  if (!db.inTransaction) return fail()
  const persisted = capturePages(db, input), groups = captureGroups(db, input)
  const tree = planSyncedCrossMoveBatch(input)
  const outsideIncoming = findDependencies ? readBatchDependencies(db, batchPaths(tree.transfers, persisted), [...tree.movePages]).map(item => item.documentId) : []
  const version = outsideIncoming.length ? 12 : 8
  const sourcePlaceholders = tree.after.filter(side => !side.content.blocks.length).map(side => ({
    version: 1 as const, documentId: side.documentId, blockId: randomUUID(), createdAt: now
  }))
  const plan = deriveBatch(input, persisted, sourcePlaceholders, outsideIncoming, tree)
  const crossMove = { transfers: plan.transfers, outsideIncoming, sourcePlaceholders }
  const original = { input, persisted, groups, crossMove }
  const row: SyncedHostHistoryBranchRow = { id: randomUUID(), created_at: hostTime(now), before_json: hostEncode(plan.before),
    after_json: hostEncode(plan.after), before_hash: hostHash(plan.before), after_hash: hostHash(plan.after),
    action_json: hostEncode({ kind: 'host-command', version, ...original, originalHash: hostHash(original) }) }
  decodeCrossHostBatchJournal(row, version)
  return row
}

export function captureCrossHostBatchJournal(db: Database.Database, input: HostMoveBatchInput, now: string) {
  return captureBatchJournal(db, input, now, true)
}

function readBatchDependencies(db: Database.Database, paths: ReadonlyMap<string, BlockTransferPathChange>, participants: string[]) {
  const moves = [...paths].map(([fragment, { fromPath }]) => ({ fragment, fromPath }))
  const dependencies = db.prepare(`SELECT DISTINCT d.id AS documentId,d.updated_at AS updatedAt FROM json_each(?) AS move
    JOIN markdown_link_sources AS link ON link.target_path=json_extract(move.value,'$.fromPath')
      AND link.fragment IN (json_extract(move.value,'$.fragment'),'^'||json_extract(move.value,'$.fragment'))
    JOIN documents AS d ON d.id=link.source_document_id
    WHERE link.kind!='image' AND d.id NOT IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(moves), JSON.stringify(participants)) as Array<{ documentId: string; updatedAt: string }>
  return dependencies.sort((a, b) => a.documentId < b.documentId ? -1 : 1)
}

function capturePages(db: Database.Database, input: HostMoveInput | HostMoveBatchInput): Page[] {
  return input.hostsWorkingBefore.map(side => capturePage(db, side.documentId))
}

function capturePage(db: Database.Database, documentId: string): Page {
  const page = readStrictHostDocument(db, documentId) ?? fail()
  const indexedLinks = db.prepare(`SELECT source_block_id AS blockId,source_offset AS offset,url,kind,target_path AS targetPath,fragment
    FROM markdown_link_sources WHERE source_document_id=? ORDER BY source_block_id,source_offset`).all(documentId) as IndexedLink[]
  return { documentId, path: page.detail.path, createdAt: page.createdAt, updatedAt: page.detail.updatedAt, content: page.content,
    births: page.content.blocks.map(block => ({ blockId: block.id, createdAt: page.births.get(block.id) ?? fail() })), indexedLinks }
}

function captureGroups(db: Database.Database, input: HostMoveInput | HostMoveBatchInput): HostGroupDependency[] {
  const snapshots = getSyncedGroupSnapshots(db, { groupIds: input.groups.map(group => group.groupId) }).items.map(item => item.status === 'ready' ? item.snapshot : fail())
  const instances = new Map(snapshots.flatMap(snapshot => snapshot.instances.map(instance => [instance.instanceId, instance] as const)))
  for (const guard of input.expectedInstances) {
    const instance = instances.get(guard.instanceId)
    if (!instance || instance.hostDocumentId !== guard.hostDocumentId || instance.bindingVersion !== guard.bindingVersion) return fail()
  }
  for (const guard of input.groups) {
    const snapshot = snapshots.find(value => value.groupId === guard.groupId)
    if (!snapshot || snapshot.revision !== guard.expectedRevision || snapshot.topologyRevision !== guard.expectedTopologyRevision) return fail()
  }
  return snapshots.map(({ groupId, creationId, createdAt, origin }) => ({ groupId, creationId, createdAt, origin }))
}

/** Read-only isolated candidate factory. The SQL before-image is taken solely
 * from the original connection before any physical edit. No writer is exposed. */
function captureCrossHostJournalVersion(db: Database.Database, value: unknown, now: string, hasDependencies: boolean): SyncedHostHistoryBranchRow {
  if (!db.inTransaction) return fail()
  const input = validateSyncedStructureInput(value)
  if (!isHostMoveInput(input) || (hasDependencies ? input.hostsWorkingBefore.length < 3 : input.hostsWorkingBefore.length !== 2)) return fail()
  const plan = readCrossHostMovePlan(db, input)
  const dependencyIds = plan.dependencies.map(page => page.detail.id).sort()
  if (dependencyIds.length !== input.hostsWorkingBefore.length - 2) return fail()
  for (const id of dependencyIds) assertCrossMoveDependency(db, input, id)
  const persisted = capturePages(db, input)
  const source = persisted.find(page => page.documentId === input.action.selection.documentId) ?? fail()
  let journalVersion: CrossMoveVersion = 4
  if (hasDependencies) {
    const moved = new Set(plan.moved.map(item => item.blockId)), ids = new Set(dependencyIds)
    const dependents = persisted.filter(page => ids.has(page.documentId))
    const incoming = dependents.flatMap(page => {
      const links = thirdInboundLinks(page, source.path, moved)
      const keys = new Set(links.map(row => JSON.stringify([row.blockId, row.offset, row.kind, row.url])))
      return collectDocumentMarkdownLinks(page.content.blocks).filter(item => keys.has(JSON.stringify([item.blockId, item.start, item.kind, item.url])))
    })
    journalVersion = dependents.some(page => page.content.blocks.some(block => block.type === 'synced-block')) ? 11
      : incoming.some(isExtendedCrossMoveLink) ? 10 : dependencyIds.length > 1 || plan.sourcePlaceholderId ? 9
      : incoming.some(link => link.kind === 'link') ? 7 : 6
  }
  assertNoOutsideCrossMoveLinks(db, source.path, plan.moved, persisted.map(page => page.documentId))
  const groups = captureGroups(db, input)
  const crossMove = { transfers: plan.moved, outsideIncoming: dependencyIds, ...(plan.sourcePlaceholderId
    ? { sourcePlaceholder: { version: 1, blockId: plan.sourcePlaceholderId, createdAt: now } } : {}) }
  const original = { input, persisted, groups, crossMove }
  const row: SyncedHostHistoryBranchRow = { id: randomUUID(), created_at: hostTime(now), before_json: hostEncode(plan.before),
    after_json: hostEncode(plan.after), before_hash: hostHash(plan.before), after_hash: hostHash(plan.after),
    action_json: hostEncode({ kind: 'host-command', version: journalVersion, ...original, originalHash: hostHash(original) }) }
  decodeCrossHostJournalVersion(row, journalVersion)
  return row
}

export function captureCrossHostJournal4(db: Database.Database, value: unknown, now: string): SyncedHostHistoryBranchRow {
  return captureCrossHostJournalVersion(db, value, now, false)
}
export function captureCrossHostLinkJournal(db: Database.Database, value: unknown, now: string): SyncedHostHistoryBranchRow {
  return captureCrossHostJournalVersion(db, value, now, true)
}

export function prepareOwnedThirdLinkCrossMove(db: Database.Database, value: unknown): SyncedEditingMethods['prepareSyncedCrossHostMove']['result'] {
  return db.transaction((): SyncedEditingMethods['prepareSyncedCrossHostMove']['result'] => {
    requireSyncedMetadataEditingFenceOwned2(db)
    try {
      const input = validateSyncedStructureInput(value)
      if (isHostMoveBatchInput(input)) {
        const original = decodeCrossHostJournal8(captureBatchJournal(db, input, new Date().toISOString(), false))
        const participants = original.persisted.map(page => page.documentId)
        const paths = batchPaths(original.crossMove.transfers, original.persisted), dependencies = readBatchDependencies(db, paths, participants)
        if (dependencies.length > SYNCED_MAX_BLOCKS - participants.length) return { status: 'unsupported' }
        // The first host is the renderer's active editor. Its own pending head
        // is checked on apply, after the exact request has been checkpointed.
        for (const [index, page] of original.persisted.entries()) if (index > 0
          && (!sameHostContent(page.content, original.before[index].content) || !checkCrossMoveDraftOwned(db, page.documentId, page.content)))
          return { status: 'unsupported' }
        for (const { documentId } of dependencies) {
          const page = readPage(capturePage(db, documentId))
          if (!checkCrossMoveDraftOwned(db, documentId, page.content)) return { status: 'unsupported' }
          assertBatchDependentLinks(page, paths, rewriteBatchPage(page, page.content.blocks, paths, []))
        }
        const all = [...participants, ...dependencies.map(side => side.documentId)]
        for (const page of original.persisted) assertNoOutsideCrossMoveLinks(db, page.path, original.crossMove.transfers, all)
        return { status: 'ready', dependencies }
      }
      if (!isHostMoveInput(input) || input.hostsWorkingBefore.length !== 2) return { status: 'unsupported' }
      const { moved, dependencies } = readCrossHostMovePlan(db, input, true)
      const source = readStrictHostDocument(db, input.action.selection.documentId) ?? fail()
      assertNoOutsideCrossMoveLinks(db, source.detail.path, moved, [...input.hostsWorkingBefore.map(side => side.documentId), ...dependencies.map(side => side.detail.id)])
      if (dependencies.length > SYNCED_MAX_BLOCKS - 2
        || dependencies.some(page => !checkCrossMoveDraftOwned(db, page.detail.id, page.content))) return { status: 'unsupported' }
      return { status: 'ready', dependencies: dependencies.map(({ detail }) => ({ documentId: detail.id, updatedAt: detail.updatedAt })) }
    } catch (error) {
      if (error instanceof CrossMoveJournalError || error instanceof MoveRefused || error instanceof SyncedValidationError) return { status: 'unsupported' }
      throw error
    }
  })()
}

export function assertNoOutsideCrossMoveLinks(db: Database.Database, path: string, transfers: readonly Transfer[], participants: readonly string[]): void {
  const fragments = JSON.stringify(transfers.flatMap(move => [move.blockId, '^' + move.blockId]))
  if (db.prepare(`SELECT 1 FROM markdown_link_sources WHERE target_path=? AND fragment IN (SELECT value FROM json_each(?)) AND kind!='image'
    AND source_document_id NOT IN (SELECT value FROM json_each(?)) LIMIT 1`).get(path, fragments, JSON.stringify(participants))) return fail()
}
