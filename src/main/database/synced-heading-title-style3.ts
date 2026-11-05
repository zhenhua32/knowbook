// Pure destination spelling projection. It grants no owner, target or write.
import type { SyncedStableBlockDraft, SyncedGroupWire, SyncedBindingKey } from '../../shared/synced-blocks'
import { parseFragment } from 'parse5'
import { markdownEngine } from '../../shared/markdownEngine'
import { collectDocumentMarkdownLinks, type MarkdownDocumentLink } from '../../shared/markdownLinkMaintenance'
import { parseLocalMarkdownUrl, resolveMarkdownDocumentPath, type MarkdownDestination } from '../../shared/markdownLinks'
import { validateSyncedGroupWire } from '../../shared/syncedBlockValidation'
import { projectSyncedGroupBudget } from '../../shared/syncedBlockPortable'
import { collectSyncedBindingOccurrences } from '../sync/synced-binding-occurrences'
import { projectSyncedMetadataCell2 } from './synced-metadata-cell2'
import type { projectSyncedMetadataGroupLinks2 } from './synced-metadata-group-links2'
import { hostEncode, hostEqual } from './synced-host-journal'
import { headingTitleWikiFingerprint3, styleHeadingTitleWikiDestination3, type HeadingTitleWikiStyleContext3 } from './synced-heading-title-wiki-style3'

export class HeadingTitle3StyleRequired extends Error {
  constructor(message: string) { super('Heading title3 exact URI style requires proof: ' + message); this.name = 'HeadingTitle3StyleRequired' }
}
const bad = (message: string): never => { throw new HeadingTitle3StyleRequired(message) }
type DestinationSyntax3 = MarkdownDestination['syntax']
export const headingTitleLinkSyntax3 = (link: MarkdownDocumentLink): DestinationSyntax3 => 'syntax' in link ? link.syntax : undefined
type Unit = { raw: string; normalized: string; rawFrom: number; rawTo: number; from: number; to: number }
type Parts = { path: string; query: string; fragment: string; pathEnd: number; queryEnd: number }
const percentCase = (value: string) => value.replace(/%[a-f\d]{2}/gi, token => token.toUpperCase())
function parts(value: string): Parts {
  const hash = value.indexOf('#'), query = value.indexOf('?'), pathEnd = query >= 0 && (hash < 0 || query < hash) ? query : hash >= 0 ? hash : value.length
  const queryEnd = hash >= 0 ? hash : value.length
  return { path: value.slice(0, pathEnd), query: value.slice(pathEnd, queryEnd), fragment: value.slice(queryEnd), pathEnd, queryEnd }
}
/** Retain a raw-to-normalized map for escapes/entities as well as UTF16. A
 * standalone URL guess is never used when it disagrees with the real parser. */
export function normalizeHeadingTitleRaw3(raw: string, syntax?: DestinationSyntax3 | null): string {
  if (syntax !== 'html') return markdownEngine.normalizeLink(markdownEngine.utils.unescapeAll(raw))
  const element = parseFragment('<a href="' + raw.replace(/"/g, '&quot;') + '"></a>').childNodes[0]
  return element && 'attrs' in element ? element.attrs.find(attribute => attribute.name === 'href')?.value ?? raw : raw
}
function units(raw: string, normalized: string, syntax?: DestinationSyntax3): Unit[] | null {
  const result: Unit[] = []; let position = 0, projected = 0
  while (position < raw.length) {
    const rest = raw.slice(position), next = raw.charCodeAt(position + 1)
    const escaped = syntax !== 'html' && rest[0] === '\\' && ((next >= 33 && next <= 47) || (next >= 58 && next <= 64) || (next >= 91 && next <= 96) || (next >= 123 && next <= 126))
    const token = escaped ? rest.slice(0, 2) : rest.match(/^&(?:#\d+|#[xX][a-f\d]+|[A-Za-z][A-Za-z\d]+);/i)?.[0]
      ?? rest.match(/^%[a-f\d]{2}/i)?.[0] ?? String.fromCodePoint(raw.codePointAt(position)!)
    const value = normalizeHeadingTitleRaw3(token, syntax)
    result.push({ raw: token, normalized: value, rawFrom: position, rawTo: position + token.length, from: projected, to: projected + value.length })
    position += token.length; projected += value.length
  }
  return result.map(unit => unit.normalized).join('') === normalized ? result : null
}
function rawRange(raw: string, map: Unit[], from: number, to: number): string | null {
  const start = from === 0 ? 0 : from === (map.at(-1)?.to ?? 0) ? raw.length : map.find(unit => unit.from === from)?.rawFrom
  const end = to === (map.at(-1)?.to ?? 0) ? raw.length : map.find(unit => unit.from === to)?.rawFrom
  return start === undefined || end === undefined ? null : raw.slice(start, end)
}
function fingerprint(link: MarkdownDocumentLink, sourcePath: string, wiki?: HeadingTitleWikiStyleContext3): string {
  if(link.kind==='wiki'&&wiki)return hostEncode([link.blockIndex,link.blockId??null,link.kind,headingTitleWikiFingerprint3(link.url,sourcePath,wiki.after)])
  const local = parseLocalMarkdownUrl(link.url), target = resolveMarkdownDocumentPath(sourcePath, link.url)
  const destination = local && target ? ['local', target.path, target.fragment, percentCase(parts(link.url).query)] : ['other', link.url]
  return hostEncode([link.blockIndex, link.blockId ?? null, link.kind, headingTitleLinkSyntax3(link) ?? null, destination])
}
function styledDestination(oldRaw: string, oldLink: MarkdownDocumentLink, afterRaw: string, afterLink: MarkdownDocumentLink): string {
  if (oldLink.kind === 'wiki' || oldLink.kind === 'image' || oldRaw === afterRaw) return afterRaw
  const oldLocal = parseLocalMarkdownUrl(oldLink.url), afterLocal = parseLocalMarkdownUrl(afterLink.url)
  if (!oldLocal || !afterLocal) return afterRaw
  const oldUnits = units(oldRaw, oldLink.url, headingTitleLinkSyntax3(oldLink)), afterUnits = units(afterRaw, afterLink.url, headingTitleLinkSyntax3(afterLink))
  if (!oldUnits || !afterUnits) return bad('raw destination does not match its complete native parser spelling')
  const oldParts = parts(oldLink.url), afterParts = parts(afterLink.url)
  const oldPath = rawRange(oldRaw, oldUnits, 0, oldParts.pathEnd), oldQuery = rawRange(oldRaw, oldUnits, oldParts.pathEnd, oldParts.queryEnd)
  const oldFragment = rawRange(oldRaw, oldUnits, oldParts.queryEnd, oldLink.url.length)
  let path = rawRange(afterRaw, afterUnits, 0, afterParts.pathEnd)
  const query = rawRange(afterRaw, afterUnits, afterParts.pathEnd, afterParts.queryEnd), fragment = rawRange(afterRaw, afterUnits, afterParts.queryEnd, afterLink.url.length)
  if (oldPath === null || oldQuery === null || oldFragment === null || path === null || query === null || fragment === null) return bad('URI component is not an exact raw range')
  // Keep unchanged path components, including Unicode/percent spelling. A new
  // filename uses Main's existing rendering; inverse uses the original-side
  // template below when an earlier filename spelling cannot be inferred.
  if (oldLocal.path === afterLocal.path) path = oldPath
  else {
    const beforeSegments = oldParts.path.split('/'), afterSegments = afterParts.path.split('/'), output = path.split('/')
    const beforeRawSegments = oldPath.split('/'); let prefix = 0
    while (prefix < beforeSegments.length - 1 && prefix < afterSegments.length - 1
      && percentCase(beforeSegments[prefix]) === percentCase(afterSegments[prefix]) && output.length === afterSegments.length
      && beforeRawSegments.length === beforeSegments.length) { output[prefix] = beforeRawSegments[prefix]; prefix++ }
    path = output.join('/')
    if (oldPath.startsWith('./') && !/^(?:\/|\.\.?\/)/.test(path)) path = './' + path
    const extension = oldPath.match(/\.md$/i)?.[0]
    if (extension) path = path.replace(/\.md$/i, extension)
    const escapes = oldPath.match(/%[a-f\d]{2}/gi)?.filter(token => /[a-f]/i.test(token)) ?? []
    if (escapes.length && escapes.every(token => token === token.toLowerCase())) path = path.replace(/%[a-f\d]{2}/gi, token => token.toLowerCase())
    if (/[^\x00-\x7f]/.test(oldPath)) path = path.replace(/%[cd][a-f\d]%[89ab][a-f\d]|%e[a-f\d](?:%[89ab][a-f\d]){2}|%f[0-4](?:%[89ab][a-f\d]){3}/gi, encoded => {
      try { const decoded = decodeURIComponent(encoded); return /[^\x00-\x7f]/.test(decoded) && !/[\s\x00-\x1f<>()[\]\\]/u.test(decoded) ? decoded : encoded } catch { return encoded }
    })
  }
  return path + (percentCase(oldParts.query) === percentCase(afterParts.query) ? oldQuery : query)
    + (oldLocal.fragment === afterLocal.fragment && oldParts.fragment.startsWith('#') === afterParts.fragment.startsWith('#') ? oldFragment : fragment)
}
function eraseDestinations(blocks: readonly SyncedStableBlockDraft[]) {
  const links = collectDocumentMarkdownLinks([...blocks]), next = blocks.map(block => ({ ...block }))
  const seen = new Set<string>()
  for (const link of [...links].reverse()) {
    const address = hostEncode([link.blockIndex, link.start, link.end]); if (seen.has(address)) continue; seen.add(address)
    const block = next[link.blockIndex]
    block.content = block.content.slice(0, link.start) + '\u0000URI\u0000' + block.content.slice(link.end)
  }
  return next
}
/** Main has already produced `canonical`. Only exact destination ranges may
 * regain spelling; whole current blocks/canonical group wires are never copied
 * from a journal. Full grammar/target equality is checked after all edits. */
export function restyleHeadingTitleOrdinaryBlocks3<T extends SyncedStableBlockDraft>(before: readonly T[], canonical: readonly T[],
  newSourcePath: string, template?: readonly SyncedStableBlockDraft[], selected?: ReadonlySet<number>, overrides?: ReadonlyMap<number, string>, wiki?: HeadingTitleWikiStyleContext3) {
  if (before.length !== canonical.length || !hostEqual(before.map(({ content: _content, ...block }) => block), canonical.map(({ content: _content, ...block }) => block)))
    return bad('ordinary forest/attributes changed outside the owned title projection')
  const oldLinks = collectDocumentMarkdownLinks([...before]), nextLinks = collectDocumentMarkdownLinks([...canonical])
  if (oldLinks.length !== nextLinks.length) return bad('native parser Key closure changed during title-only maintenance')
  const targetLinks = template ? collectDocumentMarkdownLinks([...template]) : null
  if (template && (!hostEqual(eraseDestinations(canonical), eraseDestinations(template)) || targetLinks!.length !== nextLinks.length)) return bad('original target-side style lacks its exact current non-URI forest')
  const edits = new Map<string, { blockIndex: number; from: number; to: number; before: string; after: string }>()
  for (let index = 0; index < nextLinks.length; index++) {
    const old = oldLinks[index], next = nextLinks[index]
    if (hostEncode([old.blockIndex, old.blockId ?? null, old.kind, headingTitleLinkSyntax3(old) ?? null]) !== hostEncode([next.blockIndex, next.blockId ?? null, next.kind, headingTitleLinkSyntax3(next) ?? null])) return bad('ordinary destination role/order changed')
    const oldRaw = before[old.blockIndex].content.slice(old.start, old.end), raw = canonical[next.blockIndex].content.slice(next.start, next.end)
    let replacement = old.kind==='wiki'&&wiki&&oldRaw!==raw?styleHeadingTitleWikiDestination3(oldRaw,old.url,raw,next.url,newSourcePath,wiki):styledDestination(oldRaw, old, raw, next)
    if (targetLinks && (!selected || selected.has(index)) && next.kind !== 'image') {
      const target = targetLinks[index]
      const targetRaw=template![target.blockIndex].content.slice(target.start,target.end)
      if(targetRaw!==raw){
        if(next.kind==='wiki'&&!wiki)return bad('original Wiki spelling lacks its actual complete naming scope')
        if(fingerprint(target,newSourcePath,wiki)!==fingerprint(next,newSourcePath,wiki))return bad('original-side URI spelling no longer names the exact projected target')
      }
      replacement=targetRaw
    }
    if (overrides?.has(index)) replacement = overrides.get(index)!
    if (replacement === raw) continue
    const address = hostEncode([next.blockIndex, next.start, next.end]), prior = edits.get(address)
    if (prior && prior.after !== replacement) return bad('one original destination has contradictory style expectations')
    edits.set(address, { blockIndex: next.blockIndex, from: next.start, to: next.end, before: raw, after: replacement })
  }
  const blocks = canonical.map(block => ({ ...block })) as T[]
  const ordered = [...edits.values()].sort((a, b) => b.blockIndex - a.blockIndex || b.from - a.from)
  let previousBlock = -1, previousStart = Infinity
  for (const edit of ordered) {
    if (edit.blockIndex !== previousBlock) { previousBlock = edit.blockIndex; previousStart = Infinity }
    const block = blocks[edit.blockIndex]
    if (edit.to > previousStart || block.content.slice(edit.from, edit.to) !== edit.before) return bad('style destination overlaps or changed its exact raw range')
    block.content = block.content.slice(0, edit.from) + edit.after + block.content.slice(edit.to); previousStart = edit.from
  }
  const finalLinks = collectDocumentMarkdownLinks(blocks)
  if (finalLinks.length !== nextLinks.length || finalLinks.some((link,index)=>{
    const next=nextLinks[index]
    return link.blockIndex!==next.blockIndex||link.blockId!==next.blockId||link.kind!==next.kind||headingTitleLinkSyntax3(link)!==headingTitleLinkSyntax3(next)
      ||link.url!==next.url&&fingerprint(link,newSourcePath,wiki)!==fingerprint(next,newSourcePath,wiki)
  }))
    return bad('style projection changed the complete native destination semantics')
  return { blocks, changed: blocks.some((block, index) => block.content !== canonical[index].content), edits: [...edits.values()] }
}

export interface HeadingTitleRestoreGroupStyle3 { from: SyncedGroupWire; to: SyncedGroupWire }
export function headingTitleRestorationGroupStyles3(materials: readonly { working: SyncedGroupWire; after: SyncedGroupWire }[], direction: 'undo' | 'redo') {
  return materials.map(item => direction === 'undo' ? { from: item.after, to: item.working } : { from: item.working, to: item.after })
}
const bindingKey3 = ({ blockId, from, to, raw, syntax }: SyncedBindingKey) => hostEncode([blockId, from, to, raw, syntax])
const onlyBindingKey3 = ({ blockId, from, to, raw, syntax }: SyncedBindingKey): SyncedBindingKey => ({ blockId, from, to, raw, syntax })
function groupStyleIdentity3(wire: SyncedGroupWire) {
  return { id: wire.id, creationId: wire.creationId, createdAt: wire.createdAt, origin: wire.origin, blocks: eraseDestinations(wire.blocks) }
}
/** Reproject every physical binding Key through the exact finite destination
 * edits. Typed targets and all current non-URI content remain current. A
 * reverse template can only affect fields this operation already changed,
 * after both original typed sides and the full physical forest have closed. */
export function restyleHeadingTitleGroupProjection3(projection: ReturnType<typeof projectSyncedMetadataGroupLinks2>,
  styles?: readonly HeadingTitleRestoreGroupStyle3[], wiki?: HeadingTitleWikiStyleContext3): ReturnType<typeof projectSyncedMetadataGroupLinks2> {
  const before = projection.before, canonical = projection.after
  const oldLinks = collectDocumentMarkdownLinks(before.blocks), nextLinks = collectDocumentMarkdownLinks(canonical.blocks)
  const template = styles?.find(item => item.from.id === before.id)
  let target: SyncedGroupWire | undefined, selected: Set<number> | undefined
  if (template && hostEqual(groupStyleIdentity3(before), groupStyleIdentity3(template.from))
    && hostEqual(groupStyleIdentity3(canonical), groupStyleIdentity3(template.to))) {
    const fromLinks = collectDocumentMarkdownLinks(template.from.blocks), toLinks = collectDocumentMarkdownLinks(template.to.blocks)
    if (fromLinks.length !== oldLinks.length || toLinks.length !== nextLinks.length) return bad('original canonical parser order differs')
    const changed = new Set(projection.edits.map(edit => bindingKey3(edit.key)))
    const lookup = (wire: SyncedGroupWire, link: MarkdownDocumentLink) => wire.bindings.find(binding => binding.blockId === link.blockId
      && binding.from === link.start && binding.to === link.end && binding.raw === wire.blocks[link.blockIndex].content.slice(link.start, link.end))
    selected = new Set<number>()
    for (let index = 0; index < oldLinks.length; index++) {
      const current = lookup(before, oldLinks[index]), after = lookup(canonical, nextLinks[index])
      if (!current || !after) continue
      if (!changed.has(bindingKey3(current))) continue
      const from = lookup(template.from, fromLinks[index]), to = lookup(template.to, toLinks[index])
      if (from && to && from.syntax === current.syntax && to.syntax === after.syntax
        && hostEqual(from.target, current.target) && hostEqual(to.target, after.target)
        &&(current.syntax!=='wiki'||from.raw===current.raw)) selected.add(index)
    }
    target = template.to
  }
  if(styles){
    const changedWiki=new Set(projection.edits.filter(edit=>edit.key.syntax==='wiki').map(edit=>bindingKey3(edit.key)))
    for(let index=0;index<oldLinks.length;index++){
      const link=oldLinks[index]
      if(link.kind!=='wiki'||!link.blockId)continue
      const raw=before.blocks[link.blockIndex].content.slice(link.start,link.end)
      if(changedWiki.has(bindingKey3({blockId:link.blockId,from:link.start,to:link.end,raw,syntax:'wiki'}))&&!selected?.has(index))
        return bad('changed canonical Wiki lacks its exact original from-field and typed sides')
    }
  }
  const styled = restyleHeadingTitleOrdinaryBlocks3(before.blocks, canonical.blocks, before.origin.pathAtCreation, target?.blocks, selected,undefined,wiki)
  if (!styled.changed) return projection
  const cells = new Map(canonical.blocks.map((block, blockIndex) => {
    const bindings = canonical.bindings.filter(binding => binding.blockId === block.id)
    const edits = styled.edits.filter(edit => edit.blockIndex === blockIndex).map(edit => {
      const key = bindings.find(binding => binding.from === edit.from && binding.to === edit.to && binding.raw === edit.before)
      if (!key) return bad('canonical style range lacks its existing complete binding Key')
      return { key: onlyBindingKey3(key), after: edit.after }
    })
    return [block.id, projectSyncedMetadataCell2(block.content, bindings.map(onlyBindingKey3), edits)] as const
  }))
  const bindings = canonical.bindings.map(binding => ({ ...cells.get(binding.blockId)!.project(onlyBindingKey3(binding)), target: binding.target }))
  const after = validateSyncedGroupWire({ ...canonical, blocks: styled.blocks, bindings })
  const parsed = collectSyncedBindingOccurrences(after.origin, after.blocks), keys = new Set(parsed.map(bindingKey3))
  if (keys.size !== parsed.length || parsed.length !== bindings.length || bindings.some(binding => !keys.has(bindingKey3(binding))))
    return bad('styled canonical whole-forest parser closure differs')
  const edits = before.bindings.flatMap((binding, index) => binding.raw === bindings[index].raw ? []
    : [{ blockId: binding.blockId, key: onlyBindingKey3(binding), after: bindings[index].raw }])
  const composed = new Map(before.blocks.map(block => [block.id, projectSyncedMetadataCell2(block.content,
    before.bindings.filter(binding => binding.blockId === block.id).map(onlyBindingKey3), edits.filter(edit => edit.blockId === block.id))]))
  if (after.blocks.some(block => composed.get(block.id)!.text !== block.content)
    || before.bindings.some((binding, index) => !hostEqual(composed.get(binding.blockId)!.project(onlyBindingKey3(binding)), onlyBindingKey3(bindings[index]))))
    return bad('styled canonical result is not its exact original Key range projection')
  projectSyncedGroupBudget(after)
  return { before, after, edits, changed: !hostEqual(before, after) }
}
