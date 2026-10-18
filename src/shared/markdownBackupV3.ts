/** Cold trusted V3 adapter. Ordinary Markdown, V2 and Source defaults are unchanged. */
import { parseMarkdownBlocksCore, serializeMarkdownWithBlockRangesCore, type MarkdownBlockMetadata,
  type MarkdownRenderableBlock, type MarkdownSourceSerializationPolicy, type MarkdownTrustedBackupPolicy } from './markdown'
import { markdownEngine, markdownTokenTree, type MarkdownNode } from './markdownEngine'
import { isListBlockType } from './blockTypes'
import { parseStrictJson } from './strictJson'
import { validateSyncedHostForest, parseSyncedBlockPayload, SYNCED_BLOCK_FENCE_INFO } from './syncedBlockValidation'
import type { SyncedStableBlockDraft } from './synced-blocks'

const prefix = '<!-- knowbook:block ', suffix = ' -->'
function invalid(message: string): never { throw new Error('Invalid V3 Markdown: ' + message) }
function identity(value: unknown): string { return typeof value === 'string' && value.trim() ? value : invalid('raw identity missing') }
function rawMetadata(line: string): MarkdownBlockMetadata {
  if (!line.startsWith(prefix) || !line.endsWith(suffix)) return invalid('unknown metadata envelope')
  const raw = parseStrictJson(line.slice(prefix.length, -suffix.length), { maxBytes: 5 * 1024 * 1024, maxDepth: 32 })
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid('metadata is not an object')
  const item = raw as Record<string, unknown>, allowed = ['id','type','depth','parentBlockId','tags','highlight','listStart','markdownFormat','language']
  if (Object.keys(item).some(key => !allowed.includes(key)) || ['id','type','depth','parentBlockId'].some(key => !Object.hasOwn(item, key))) return invalid('closed metadata fields')
  const id = identity(item.id), parentBlockId = item.parentBlockId === null ? null : identity(item.parentBlockId)
  if (typeof item.type !== 'string' || !item.type || item.type !== item.type.trim() || !Number.isSafeInteger(item.depth) || Number(item.depth) < 0 || Number(item.depth) > 6) return invalid('metadata type/depth')
  if (item.language !== undefined && (item.type !== 'code' || item.language !== null && (typeof item.language !== 'string' || !item.language.trim() || item.language !== item.language.trim()))) return invalid('code language provenance')
  return { ...item, id, parentBlockId, parentSpecified: true } as MarkdownBlockMetadata
}
function metadata(block: MarkdownRenderableBlock): string {
  const raw = { id: identity(block.id), type: block.type, depth: block.depth ?? 0, parentBlockId: block.parentBlockId === null ? null : identity(block.parentBlockId),
    ...(block.tags === undefined ? {} : { tags: block.tags }), ...(block.highlight === undefined ? {} : { highlight: block.highlight }),
    ...(block.listStart === undefined ? {} : { listStart: block.listStart }), ...(block.markdownFormat === undefined ? {} : { markdownFormat: block.markdownFormat }),
    ...(block.type === 'code' ? { language: block.language ?? null } : {}) }
  const line = prefix + JSON.stringify(raw) + suffix
  rawMetadata(line); return line
}
function reference(body: string): MarkdownRenderableBlock {
  const nodes = markdownTokenTree(markdownEngine.parse(body, {})), fences: MarkdownNode[] = []
  const visit = (node: MarkdownNode) => {
    if (node.token.type === 'fence') { fences.push(node); return }
    if (!['bullet_list_open','ordered_list_open','list_item_open'].includes(node.token.type)) return invalid('reference is not exactly one trusted fence')
    node.children.forEach(visit)
  }
  nodes.forEach(visit)
  if (fences.length !== 1) return invalid('reference fence count')
  const token = fences[0].token
  if (token.info !== SYNCED_BLOCK_FENCE_INFO || token.markup !== '```') return invalid('reference version/attributes')
  const payload = token.content.replace(/\n$/, '')
  parseSyncedBlockPayload(payload)
  return { type: 'synced-block', content: payload, checked: false, depth: 0 }
}
export function serializeBackupV3Blocks(input: SyncedStableBlockDraft[]): string {
  const checked = validateSyncedHostForest(input)
  const policy: MarkdownSourceSerializationPolicy = {
    depths: blocks => blocks.map(block => block.depth ?? 0),
    listMember: (block, parentType) => isListBlockType(block.type) || block.type === 'synced-block' && parentType !== null && isListBlockType(parentType),
    render(block, indent, parentType) {
      if (block.type !== 'synced-block') return null
      const payload = block.content, list = parentType !== null && isListBlockType(parentType)
      parseSyncedBlockPayload(payload)
      const prefix = list ? indent + '- ' : '', continuation = list ? indent + '  ' : ''
      const markdown = [prefix + '```' + SYNCED_BLOCK_FENCE_INFO, continuation + payload, continuation + '```'].join('\n')
      return { markdown, from: prefix.length, to: markdown.length }
    }
  }
  return serializeMarkdownWithBlockRangesCore(checked, { includeBlockMetadata: true, trustedBackupMetadata: metadata }, policy).markdown
}
export function parseBackupV3Blocks(body: string): SyncedStableBlockDraft[] {
  const policy: MarkdownTrustedBackupPolicy = { metadata: rawMetadata, reference,
    finish(blocks) { validateSyncedHostForest(blocks) } }
  return validateSyncedHostForest(parseMarkdownBlocksCore(body, undefined, undefined, undefined, policy))
}
