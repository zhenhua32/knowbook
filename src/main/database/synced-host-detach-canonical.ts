import type Database from 'better-sqlite3'
import { escapeMarkdownDestination, parseLocalMarkdownUrl } from '../../shared/markdownLinks'
import { parseWikiReference } from '../../shared/markdownWiki'
import { formatSyncedCanonicalBlockAddress, parseSyncedCanonicalBlockAddress, type SyncedCanonicalBlockAddress } from '../../shared/synced-canonical-block-address'
import type { SyncedBindingKey, SyncedLinkTarget } from '../../shared/synced-blocks'
import { readRawBlockIdentity, resolveRawLiveBlockOwner } from './block-identities-raw-read'
import type { Navigation3Destination } from './restore-knowledge-navigation3-rewrite-cells'
import { readRawSyncedGroupSnapshotsOwned } from './synced-blocks-raw-read'
import { findSyncedCanonicalBlockBirthOwned, readSyncedCanonicalBlockBirthOriginalOwned, type SyncedCanonicalBlockBirthPointer } from './synced-canonical-block-birth'
import { resolveSyncedCanonicalBlockAddress } from './synced-canonical-block-navigation'
import { UnsupportedSyncedHostCreate } from './synced-host-create-plan'
import type { HostDetachEvidence } from './synced-host-detach-evidence'
import type { RawHistoricalEvidenceLocator } from './synced-history-evidence-model'

export interface DetachCanonicalCopyTarget {
  target: Extract<SyncedLinkTarget, { kind: 'block' }>
  documentCreatedAt: null
  blockCreatedAt: string
  heading?: never
  canonical: { original: SyncedCanonicalBlockBirthPointer }
}

export function parseDetachedCanonicalDestination(syntax: SyncedBindingKey['syntax'], url: string) {
  return parseSyncedCanonicalBlockAddress(syntax === 'wiki' ? parseWikiReference(url).target : url)
}

export function renderDetachedCanonicalDestination(link: Navigation3Destination, address: SyncedCanonicalBlockAddress) {
  if (link.grammar.kind === 'autolink') return null
  const canonical = formatSyncedCanonicalBlockAddress(address)
  if (link.key.syntax === 'wiki') {
    const reference = parseWikiReference(link.url)
    if (reference.fragment !== '^' + address.blockId) return null
    const alias = reference.alias === null ? '|' + reference.target : link.url.slice(link.url.indexOf('|'))
    const url = canonical + alias
    return { url, replacement: link.key.raw.includes('\\|') ? url.replace(/\|/g, '\\|') : url }
  }
  const local = parseLocalMarkdownUrl(link.url)
  if (!local || local.fragment !== '^' + address.blockId || local.suffix.startsWith('?')) return null
  return { url: canonical, replacement: escapeMarkdownDestination(canonical, link.grammar.syntax ?? undefined) }
}

function unproved(): never { throw new UnsupportedSyncedHostCreate('semantic-binding') }

export function planDetachedCanonicalTarget(db: Database.Database, sourceGroupId: string, target: DetachCanonicalCopyTarget['target'],
  link: Navigation3Destination): { rendered: { url: string; replacement: string }; proof: DetachCanonicalCopyTarget } {
  const identity = readRawBlockIdentity(db, target.id), owner = resolveRawLiveBlockOwner(db, target.id)
  if (target.state !== 'live' || target.documentId !== null || !identity?.createdAt || owner?.kind !== 'group' || owner.id === sourceGroupId) return unproved()
  const group = readRawSyncedGroupSnapshotsOwned(db, [owner.id]).get(owner.id)
  const block = group?.blocks.find(item => item.id === target.id)
  if (!group || !block || block.createdAt !== identity.createdAt) return unproved()
  const address = { groupId: group.groupId, creationId: group.creationId, groupCreatedAt: group.createdAt, blockId: block.id, blockCreatedAt: block.createdAt }
  const rendered = renderDetachedCanonicalDestination(link, address)
  if (!rendered || resolveSyncedCanonicalBlockAddress(db, formatSyncedCanonicalBlockAddress(address)).status !== 'ready') return unproved()
  const birth = findSyncedCanonicalBlockBirthOwned(db, address)
  if (birth.status !== 'proved') return unproved()
  return { rendered, proof: { target, documentCreatedAt: null, blockCreatedAt: address.blockCreatedAt, canonical: { original: birth.original } } }
}

export function readDetachCanonicalSqlSupports(db: Database.Database, evidence: HostDetachEvidence) {
  const supports = new Map<string, RawHistoricalEvidenceLocator>()
  for (const { source, url, resolved } of evidence.projection.links) {
    if (!resolved.canonical) continue
    const address = parseDetachedCanonicalDestination(source.syntax, url)
    const birth = address && readSyncedCanonicalBlockBirthOriginalOwned(db, address, resolved.canonical.original)
    if (!birth || birth.status !== 'proved') throw Error('解除同步缺少跨组目标的原创建回执。')
    for (const row of birth.supports) {
      const key = JSON.stringify([row.table, row.key]), previous = supports.get(key)
      if (previous && previous.rowHash !== row.rowHash) throw Error('跨组目标的原创建支持行不一致。')
      supports.set(key, row)
    }
  }
  return [...supports.values()]
}
