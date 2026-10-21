import type { SyncedCanonicalWire, SyncedLinkBinding, SyncedOriginV1 } from '../../shared/synced-blocks'
import { collectDocumentMarkdownLinks } from '../../shared/markdownLinkMaintenance'
import { resolveMarkdownDocumentPath } from '../../shared/markdownLinks'
import { SyncedValidationError, validateSyncedCanonicalWire, validateSyncedOrigin } from '../../shared/syncedBlockValidation'

export type SyncedBindingOccurrence = Omit<SyncedLinkBinding, 'target'> & { url: string }
type Occurrence = SyncedBindingOccurrence
function fail(message: string): never { throw new SyncedValidationError('binding', message) }

/** Definitions are captured at their actual destination, never at each use.
 * The whole forest parser decides which references are active. */
function occurrences(origin: SyncedOriginV1, blocks: readonly SyncedCanonicalWire[]): Occurrence[] {
  const result: Occurrence[] = []
  for (const link of collectDocumentMarkdownLinks([...blocks])) {
    if (link.kind === 'image') continue
    if (!link.blockId || link.end < link.start) fail('实际链接无法映射到 canonical 块范围。')
    const wiki = link.kind === 'wiki'
    if (!wiki && !resolveMarkdownDocumentPath(origin.pathAtCreation, link.url)) continue
    const block = blocks[link.blockIndex]
    result.push({ blockId: link.blockId, from: link.start, to: link.end,
      raw: block.content.slice(link.start, link.end), syntax: wiki ? 'wiki' : 'markdown', url: link.url })
  }
  return result
}

/** Main-internal syntax scanner for origin/canonical values already checked by
 * its caller. It performs no identity/target lookup and returns no authority. */
export function parseSyncedBindingOccurrences(origin: SyncedOriginV1, blocks: readonly SyncedCanonicalWire[]): SyncedBindingOccurrence[] {
  return occurrences(origin, blocks)
}

/** Pure original-Key parser closure only; no target lookup or Main source authority. */
export function collectSyncedBindingOccurrences(origin: SyncedOriginV1, blocks: readonly SyncedCanonicalWire[]): Array<Omit<SyncedLinkBinding, 'target'> & { url: string }> {
  return occurrences(validateSyncedOrigin(origin), validateSyncedCanonicalWire(blocks))
}
