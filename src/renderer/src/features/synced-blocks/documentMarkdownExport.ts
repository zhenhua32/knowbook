import type { DocumentBlockDraft } from '@shared/contracts'
import { collectDocumentMarkdownLinks } from '@shared/markdownLinkMaintenance'
import { escapeMarkdownDestination, parseLocalMarkdownUrl, relativeMarkdownPath } from '@shared/markdownLinks'
import { parseWikiReference } from '@shared/markdownWiki'
import type { SyncedBindingClaim, SyncedBindingKey, SyncedCanonicalEdit, SyncedGroupSnapshot, SyncedGroupWire, SyncedLinkBinding } from '@shared/synced-blocks'
import { parseSyncedBlockPayload, syncedCanonicalEdits, validateSyncedHostForest } from '@shared/syncedBlockValidation'
import type { SyncedInlineInstanceAddress } from '@shared/workspace-search-occurrence'
import type { DocumentMarkdownSource, DraftMarkdownSource } from '../../utils/documentMarkdown'
import { renderPublicSyncedClipboard } from './clipboardMarkdown'
import { peekCanonicalInlineRuntime } from './inlineRuntime'

const unavailable = () => new Error('同步块快照已变化或不可用，请重新打开文档后再导出 Markdown。')

function hostBlocks(input: readonly DocumentBlockDraft[]) {
  const used = new Set(input.flatMap(block => block.id === undefined ? [] : [block.id]))
  let ordinal = 0
  const nextId = () => {
    let id: string
    do { id = `markdown-export-${++ordinal}` } while (used.has(id))
    used.add(id)
    return id
  }
  return validateSyncedHostForest(input.map((block: DocumentBlockDraft & { sortOrder?: number }) => {
    const { sortOrder: _sortOrder, ...value } = block
    return { ...value, id: value.id ?? nextId(), parentBlockId: value.parentBlockId ?? null }
  }))
}

function sameGroup(left: SyncedGroupSnapshot, right: SyncedGroupSnapshot) {
  return left.groupId === right.groupId && left.creationId === right.creationId && left.createdAt === right.createdAt
    && left.revision === right.revision && left.topologyRevision === right.topologyRevision
}

function sameHost(left: SyncedInlineInstanceAddress, right: SyncedInlineInstanceAddress) {
  return left.workspaceScope === right.workspaceScope && left.recoveryEpoch === right.recoveryEpoch
    && left.hostDocumentId === right.hostDocumentId && left.hostCreatedAt === right.hostCreatedAt
}

type Link = ReturnType<typeof collectDocumentMarkdownLinks>[number]
const addressKey = (key: SyncedBindingKey) => JSON.stringify([key.blockId, key.from, key.to, key.raw, key.syntax])

/** Only the editor's occurrence trace can carry a stored target into a draft.
 * New addresses and claims without a verified stored source keep their spelling. */
export function bindingsForExport(snapshot: SyncedGroupSnapshot, steps: ReadonlyArray<readonly SyncedBindingClaim[] | undefined>) {
  let bindings = new Map(snapshot.bindings.map(binding => [addressKey(binding), binding]))
  for (const claims of steps) {
    const next = new Map<string, SyncedLinkBinding>()
    for (const claim of claims ?? []) {
      const source = claim.kind === 'continue' ? claim.source
        : claim.kind === 'copy' && claim.source.kind === 'current' ? claim.source.key : null
      const binding = source && bindings.get(addressKey(source))
      if (binding) next.set(addressKey(claim.destination), binding)
    }
    bindings = next
  }
  return bindings
}

function portableDestination(link: Link, path: string, fragment: string | null, document: DocumentMarkdownSource, self: boolean) {
  if (link.kind === 'wiki') {
    // Legacy Wiki destinations can contain characters that the current form
    // cannot represent unambiguously. Keep the saved spelling in that case.
    if (/[#|\[\]\r\n]/.test(path) || fragment !== null && /[|\[\]\r\n]/.test(fragment)) return link.url
    const wiki = parseWikiReference(link.url)
    return (!wiki.path && self ? '' : path) + (fragment === null ? wiki.hasFragment ? '#' : '' : '#' + fragment)
      + (wiki.alias === null ? '' : link.url.slice(link.url.indexOf('|')))
  }
  const local = parseLocalMarkdownUrl(link.url)
  if (!local || link.kind === 'autolink') return link.url
  const file = !local.path && self ? '' : local.path.startsWith('/')
    ? '/' + path.split('/').map(encodeURIComponent).join('/') + '.md' : relativeMarkdownPath(document.path + '.md', path + '.md')
  const hash = fragment === null ? local.suffix.includes('#') ? '#' : ''
    : fragment.startsWith('^') ? '#^' + encodeURIComponent(fragment.slice(1)) : '#' + encodeURIComponent(fragment)
  return file + local.suffix.split('#', 1)[0] + hash
}

async function projectCanonicalLinks(blocks: SyncedCanonicalEdit[], bindings: ReadonlyMap<string, SyncedLinkBinding>, instance: SyncedInlineInstanceAddress,
  document: DocumentMarkdownSource, readDocument: (id: string) => Promise<{ path: string } | null>) {
  const edits = new Map<number, Array<{ from: number; to: number; text: string }>>()
  for (const link of collectDocumentMarkdownLinks(blocks)) {
    if (!link.blockId || link.kind === 'image') continue
    const { blockIndex, start: from, end: to } = link, raw = blocks[blockIndex].content.slice(from, to)
    const binding = bindings.get(addressKey({ blockId: link.blockId, from, to, raw, syntax: link.kind === 'wiki' ? 'wiki' : 'markdown' }))
    const target = binding?.target
    let destination: { path: string; fragment: string | null; id?: string } | undefined
    if (target && target.kind !== 'unresolved-url') {
      if (target.state !== 'live') continue
      if (target.kind === 'block') {
        if (target.documentId === null) continue // Canonical block addresses remain canonical.
        const { target: _target, ...bindingKey } = binding!
        const owner = await window.knowbook.resolveSyncedStoredBlockLink({ source: instance, binding: bindingKey })
        if (owner.status === 'stale') throw unavailable()
        if (owner.status !== 'ready' || owner.kind !== 'document') continue
        const detail = await readDocument(owner.documentId)
        if (!detail) continue
        destination = { path: detail.path, fragment: '^' + owner.blockId, id: owner.documentId }
      } else {
        const id = target.kind === 'document' ? target.id : target.documentId
        const detail = await readDocument(id)
        if (!detail) continue
        destination = { path: detail.path, fragment: target.kind === 'heading' ? target.slug : null, id }
      }
    } else if (target) {
      destination = { path: target.path, fragment: target.fragment }
    }
    if (!destination) continue
    const url = portableDestination(link, destination.path, destination.fragment, document, destination.id === document.id)
    if (url === link.url) continue
    const text = link.kind === 'wiki' ? raw.includes('\\|') ? url.replace(/\|/g, '\\|') : url
      : escapeMarkdownDestination(url, link.syntax)
    const row = edits.get(blockIndex) ?? []
    row.push({ from, to, text }); edits.set(blockIndex, row)
  }
  return blocks.map((block, index) => {
    const row = edits.get(index)
    if (!row) return block
    const parts: string[] = []
    let start = 0
    for (const edit of row.sort((left, right) => left.from - right.from)) {
      if (edit.from < start) throw unavailable()
      parts.push(block.content.slice(start, edit.from), edit.text)
      start = edit.to
    }
    parts.push(block.content.slice(start))
    return { ...block, content: parts.join('') }
  })
}

/** Capture the exact stored references before projecting the latest local body.
 * Public Markdown never gains authority to create or rebind a shared group. */
export async function readSyncedDocumentMarkdownBody(document: DocumentMarkdownSource | DraftMarkdownSource,
  input: readonly DocumentBlockDraft[]): Promise<string> {
  const draft = 'isCurrent' in document ? document : undefined
  if (draft && !draft.isCurrent()) throw unavailable()
  const blocks = hostBlocks(input)
  const references = blocks.filter(block => block.type === 'synced-block')
    .map(block => ({ block, groupId: parseSyncedBlockPayload(block.content).groupId }))
  const runtime = draft ? peekCanonicalInlineRuntime() : undefined
  const groupIds = new Set(references.map(reference => reference.groupId))
  const local = new Map([...groupIds].flatMap(id => {
    const state = runtime?.readMarkdownExportGroup(id)
    return state ? [[id, state] as const] : []
  }))
  const captures = new Map<string, { snapshot: SyncedGroupSnapshot; instance: SyncedInlineInstanceAddress }>()
  let host: SyncedInlineInstanceAddress | undefined
  for (const { block, groupId } of references) {
    const result = await window.knowbook.resolveSyncedInlineInstance({ hostDocumentId: document.id, instanceId: block.id, groupId })
    if (result.status !== 'ready') throw unavailable()
    const { instance, snapshot } = result, previous = captures.get(groupId), current = local.get(groupId)
    const binding = snapshot.instances.find(item => item.instanceId === block.id)
    if (instance.hostDocumentId !== document.id || instance.instanceId !== block.id || instance.groupId !== groupId
      || instance.parentBlockId !== block.parentBlockId || instance.depth !== block.depth
      || instance.creationId !== snapshot.creationId || instance.groupCreatedAt !== snapshot.createdAt
      || instance.revision !== snapshot.revision || instance.topologyRevision !== snapshot.topologyRevision || snapshot.groupId !== groupId
      || binding?.hostDocumentId !== document.id || binding.bindingVersion !== instance.bindingVersion
      || (host && !sameHost(host, instance)) || (previous && !sameGroup(previous.snapshot, snapshot))
      || (current && !sameGroup(current.state.snapshot, snapshot))) throw unavailable()
    host ??= instance
    captures.set(groupId, { snapshot, instance })
  }

  const paths = new Map<string, Promise<{ path: string } | null>>()
  const readDocument = (id: string) => {
    const saved = paths.get(id) ?? window.knowbook.getDocumentDetail(id)
    paths.set(id, saved)
    return saved
  }
  const working = new Map<string, readonly SyncedCanonicalEdit[]>()
  const wires: SyncedGroupWire[] = []
  for (const [id, { snapshot, instance }] of captures) {
    const { creationId, createdAt, origin, bindings, blocks } = snapshot
    wires.push({ kind: 'synced-group', id, creationId, createdAt, origin, bindings, blocks })
    const current = local.get(id)
    working.set(id, await projectCanonicalLinks(current?.state.working ?? syncedCanonicalEdits(blocks),
      bindingsForExport(snapshot, current?.bindingSteps ?? []), instance, document, readDocument))
  }

  if (draft) {
    const changed = [...groupIds].some(id => {
      const before = local.get(id)?.state, after = runtime?.readMarkdownExportGroup(id)?.state
      if (!before) return Boolean(after?.dirty)
      return !after || before.working !== after.working || before.editSequence !== after.editSequence || !sameGroup(before.snapshot, after.snapshot)
    })
    if (!draft.isCurrent() || changed) throw unavailable()
  } else {
    const saved = await window.knowbook.getDocumentDetail(document.id)
    if (!saved || saved.path !== document.path || saved.updatedAt !== document.updatedAt) throw unavailable()
  }

  return renderPublicSyncedClipboard(document.id, blocks, wires, working)
}
