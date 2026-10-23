import type Database from 'better-sqlite3'
import type { SyncedStableBlockDraft } from '../../shared/synced-blocks'
import type { DocumentBlockDraft } from '../../shared/contracts'
import { serializeMarkdownWithBlockRanges } from '../../shared/markdown'
import { collectStoredMarkdownAssetDestinations } from '../../shared/syncedBlockPortable'
import { capsuleBytesHash, capsuleJson, freezeCapsuleValue } from './restore-knowledge-capsule-model'
import { CAPSULE2_RAW_MAX_JSON_BYTES } from './restore-knowledge-capsule2-raw-model'
import { readRawCapsule2PhysicalGraphOwned } from './restore-knowledge-capsule2-physical-raw-read'
import { readRawCapsule2WorkspaceHistoryOwned } from './restore-knowledge-capsule2-workspace-history-read'

type Body = { summary: string; blocks: Array<DocumentBlockDraft | SyncedStableBlockDraft> }
type Destination = { section: 'summary' | 'body'; uri: string; raw: string; from: number; to: number; kind: string; syntax: string }
type Scope = { source: string[]; contentHash: string; bodyProjectionHash: string; destinations: Destination[] }
export interface RawCapsule2AssetReferences {
  readonly kind: 'capsule2-ordinary-and-current-group-asset-references'; readonly version: 1
  readonly state: 'source-markdown-destinations-only'; readonly certified: false; readonly semanticValidationComplete: false; readonly permit: false
  readonly sourceFileOwnershipVerified: false; readonly sourceFileBytesVerified: false
  readonly destinationCoordinates: 'original-summary-or-masked-body-markdown-utf16'
  readonly sourceContentHash: string; readonly workspaceHistoryObservationHash: string
  readonly scopes: readonly Scope[]; readonly observationHash: string
  readonly unresolved: readonly ['historical-synced-asset-scopes', 'policy-held-payload-asset-scopes', 'source-file-ownership-and-bytes', 'durable-asset-originals', 'complete-private-capsule2-certifier']
}
const bad = (message: string): never => { throw new Error('capsule2 asset references无效：' + message + '；不访问资产文件，不授认证或安装权。') }
const opaque = new Set(['code', 'code-block', 'math', 'frontmatter', 'database-view', 'synced-block'])

/** Complete ordinary/current-group discovery from the same actual readonly
 * snapshot, after full source/history checks. No caller IDs, URLs, paths, asset
 * roots, group DTOs or filesystem capability are accepted. Historical synced
 * ACK/journal/policy scopes remain explicit work, never silently certified. */
export function readRawCapsule2AssetReferencesOwned(db: Database.Database): RawCapsule2AssetReferences {
  const history = readRawCapsule2WorkspaceHistoryOwned(db), physical = readRawCapsule2PhysicalGraphOwned(db)
  const scopes: Scope[] = [], keys = new Set<string>()
  let bytes = 0
  const add = (source: string[], body: Body) => {
    const key = capsuleJson(source)
    if (keys.has(key)) return bad('原scope定位重复')
    keys.add(key)
    const contentHash = capsuleBytesHash('knowbook.capsule2.asset-scope-content.v1\0' + capsuleJson(body))
    // The actual ordinary serializer supplies cross-block reference/footnote
    // scope. Literal nodes and saved opaque template references cannot expose
    // their content or format/config strings as Markdown destinations.
    const blocks = body.blocks.map(block => opaque.has(block.type)
      ? { id: block.id, type: 'paragraph', content: '', checked: false, depth: block.depth, parentBlockId: block.parentBlockId ?? null }
      : block)
    const markdown = serializeMarkdownWithBlockRanges(blocks).markdown
    const bodyProjectionHash = capsuleBytesHash('knowbook.capsule2.asset-body-discovery-projection.v1\0' + markdown)
    const destinations: Destination[] = []
    for (const [section, text] of [['summary', body.summary], ['body', markdown]] as const) {
      for (const item of collectStoredMarkdownAssetDestinations(text)) {
        const destination: Destination = { section, uri: item.url, raw: text.slice(item.start, item.end), from: item.start, to: item.end, kind: item.kind, syntax: item.syntax ?? 'markdown' }
        bytes += Buffer.byteLength(capsuleJson(destination))
        if (bytes > CAPSULE2_RAW_MAX_JSON_BYTES) return bad('完整目标集合超准备预算，不能截断')
        destinations.push(destination)
      }
    }
    const scope = { source, contentHash, bodyProjectionHash, destinations }
    bytes += Buffer.byteLength(capsuleJson({ ...scope, destinations: [] }))
    if (bytes > CAPSULE2_RAW_MAX_JSON_BYTES) return bad('完整scope集合超准备预算，不能截断')
    scopes.push(scope)
  }
  for (const document of physical.documents) add(['documents', document.documentId], { summary: document.summary, blocks: document.blocks })
  for (const group of physical.groups) if (group.snapshot) add(['synced_groups', group.groupId], { summary: '', blocks: group.snapshot.blocks })
  const rows = (table: string) => db.prepare('SELECT * FROM ' + table + ' ORDER BY id').all() as Array<Record<string, string>>
  for (const row of rows('document_history')) add(['document_history', row.id, 'content_json'], JSON.parse(row.content_json) as Body)
  for (const row of rows('document_trash')) add(['document_trash', row.id, 'snapshot_json', 'content'], (JSON.parse(row.snapshot_json) as { content: Body }).content)
  for (const row of rows('document_block_moves')) for (const side of ['before_json', 'after_json'] as const) {
    for (const item of JSON.parse(row[side]) as Array<{ documentId: string; content: Body }>) add(['document_block_moves', row.id, side, item.documentId], item.content)
  }
  for (const row of rows('document_templates')) add(['document_templates', row.id], { summary: row.summary, blocks: JSON.parse(row.blocks_json) as DocumentBlockDraft[] })
  scopes.sort((a, b) => { const left = capsuleJson(a.source), right = capsuleJson(b.source); return left < right ? -1 : left > right ? 1 : 0 })
  const value = { kind: 'capsule2-ordinary-and-current-group-asset-references' as const, version: 1 as const,
    state: 'source-markdown-destinations-only' as const, certified: false as const, semanticValidationComplete: false as const, permit: false as const,
    sourceFileOwnershipVerified: false as const, sourceFileBytesVerified: false as const,
    destinationCoordinates: 'original-summary-or-masked-body-markdown-utf16' as const,
    sourceContentHash: history.sourceContentHash, workspaceHistoryObservationHash: history.observationHash, scopes,
    unresolved: ['historical-synced-asset-scopes', 'policy-held-payload-asset-scopes', 'source-file-ownership-and-bytes', 'durable-asset-originals', 'complete-private-capsule2-certifier'] as const }
  const encoded = capsuleJson(value)
  if (Buffer.byteLength(encoded) > CAPSULE2_RAW_MAX_JSON_BYTES) return bad('完整观察超准备预算，不能截断')
  return freezeCapsuleValue({ ...value, observationHash: capsuleBytesHash('knowbook.capsule2.ordinary-current-group-asset-references.v1\0' + encoded) })
}
