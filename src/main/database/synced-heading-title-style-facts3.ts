// Finite destination spelling DATA from one actual P→W/A observation. It
// authorizes no target or mutation and never stores a historical block body.
import type { SyncedStableBlockDraft } from '../../shared/synced-blocks'
import { assertSyncedShape, isSyncedBlockId } from '../../shared/syncedBlockValidation'
import { collectDocumentMarkdownLinks, type MarkdownDocumentLink } from '../../shared/markdownLinkMaintenance'
import { resolveMarkdownDocumentPath, type MarkdownDestination } from '../../shared/markdownLinks'
import { hostEncode, hostEqual } from './synced-host-journal'
import { hostTime } from './synced-host-document-read'
import { resolveHeadingTitleWikiStyle3, headingTitleWikiFingerprint3, type HeadingTitleWikiDocuments3, type HeadingTitleWikiStyleContext3 } from './synced-heading-title-wiki-style3'
import { restyleHeadingTitleOrdinaryBlocks3, normalizeHeadingTitleRaw3, headingTitleLinkSyntax3, HeadingTitle3StyleRequired } from './synced-heading-title-style3'

export interface HeadingTitleOrdinaryField3 {
  from: number; to: number; raw: string; url: string; sourcePath: string
  targetPath: string; fragment: string; targetKind: 'live' | 'unresolved-local'; targetId: string | null; targetCreatedAt: string | null; targetIdentity: string
}
export interface HeadingTitleOrdinaryStyleFact3 {
  documentId: string; documentCreatedAt: string; blockId: string; blockCreatedAt: string
  kind: MarkdownDocumentLink['kind']; syntax: MarkdownDestination['syntax'] | null
  persisted: HeadingTitleOrdinaryField3; working: HeadingTitleOrdinaryField3; after: HeadingTitleOrdinaryField3
}
export interface HeadingTitleOrdinaryRestoreFact3 {
  documentId: string; documentCreatedAt: string; blockId: string; blockCreatedAt: string
  kind: MarkdownDocumentLink['kind']; syntax: MarkdownDestination['syntax'] | null
  from: HeadingTitleOrdinaryField3; to: HeadingTitleOrdinaryField3
}
const bad = (message: string): never => { throw new HeadingTitle3StyleRequired(message) }
const percentCase = (value: string) => value.replace(/%[a-f\d]{2}/gi, token => token.toUpperCase())
const query = (value: string) => percentCase(value.match(/^[^?#]*(\?[^#]*)?/)?.[1] ?? '')
const identity = (field: HeadingTitleOrdinaryField3) => [field.targetKind, field.targetId, field.targetCreatedAt, field.targetIdentity]
const opaque = (value: unknown) => isSyncedBlockId(value) ? value : bad('style source identity missing')
const text = (value: unknown): string => typeof value === 'string' ? value : bad('style field text missing')
const hash = (value: unknown) => typeof value === 'string' && /^[a-f\d]{64}$/.test(value) ? value : bad('style target identity commitment missing')
export function validateHeadingTitleOrdinaryStyleFacts3(value: unknown, wikiScopes?:{persisted:HeadingTitleWikiDocuments3;working:HeadingTitleWikiDocuments3;after:HeadingTitleWikiDocuments3}): HeadingTitleOrdinaryStyleFact3[] {
  if (!Array.isArray(value)) return bad('finite ordinary style closure missing')
  const seen = new Set<string>()
  const field = (value: unknown, syntax: MarkdownDestination['syntax'] | null,kind:string,side:'persisted'|'working'|'after'): HeadingTitleOrdinaryField3 => {
    assertSyncedShape(value, ['from', 'to', 'raw', 'url', 'sourcePath', 'targetPath', 'fragment', 'targetKind', 'targetId', 'targetCreatedAt', 'targetIdentity'])
    if (!Number.isSafeInteger(value.from) || !Number.isSafeInteger(value.to) || (value.from as number) < 0
      || (value.to as number) < (value.from as number) || (value.to as number) - (value.from as number) !== text(value.raw).length)
      return bad('finite original destination range differs')
    for (const name of ['url', 'sourcePath', 'targetPath', 'fragment']) text(value[name])
    if(kind==='wiki'){
      if(!wikiScopes||(value.raw!==value.url&&(value.raw as string).replace(/\\\|/g,'|')!==value.url))return bad('Wiki field lacks its exact raw native naming scope')
      const {document,reference}=resolveHeadingTitleWikiStyle3(value.url as string,value.sourcePath as string,wikiScopes[side])
      if(value.targetKind!=='live'||document.documentId!==value.targetId||document.documentCreatedAt!==value.targetCreatedAt||document.path!==value.targetPath||reference.fragment!==value.fragment)return bad('finite raw Wiki differs from complete native document/fragment scope')
    }else{
    const target = resolveMarkdownDocumentPath(value.sourcePath as string, value.url as string)
    if (!target || target.path !== value.targetPath || target.fragment !== value.fragment
      || normalizeHeadingTitleRaw3(value.raw as string, syntax) !== value.url) return bad('finite raw spelling differs from native local semantics')
    }
    if (value.targetKind === 'live') { opaque(value.targetId); hostTime(value.targetCreatedAt) }
    else if (value.targetKind !== 'unresolved-local' || value.targetId !== null || value.targetCreatedAt !== null) return bad('ordinary target union differs')
    hash(value.targetIdentity)
    return value as unknown as HeadingTitleOrdinaryField3
  }
  const result = value.map(raw => {
    assertSyncedShape(raw, ['documentId', 'documentCreatedAt', 'blockId', 'blockCreatedAt', 'kind', 'syntax', 'persisted', 'working', 'after'])
    opaque(raw.documentId); opaque(raw.blockId); hostTime(raw.documentCreatedAt); hostTime(raw.blockCreatedAt)
    if (!['link', 'definition', 'autolink','wiki'].includes(String(raw.kind)) || ![null, 'html', 'bare'].includes(raw.syntax as null | string)) return bad('finite destination grammar differs')
    const syntax = raw.syntax as MarkdownDestination['syntax'] | null
    const persisted = field(raw.persisted, syntax,String(raw.kind),'persisted'), working = field(raw.working, syntax,String(raw.kind),'working'), after = field(raw.after, syntax,String(raw.kind),'after')
    if (!hostEqual(identity(persisted), identity(working)) || !hostEqual(identity(persisted), identity(after))) return bad('ordinary style crossed its actual target incarnation')
    if (raw.kind!=='wiki'&&(query(persisted.url) !== query(working.url) || query(persisted.url) !== query(after.url))) return bad('title-only style changed its original query semantics')
    if (persisted.raw === working.raw && persisted.raw === after.raw) return bad('unmodified ordinary destination was added to style closure')
    const address = hostEncode([raw.documentId, raw.blockId, persisted.from, persisted.to])
    if (seen.has(address)) return bad('duplicate finite ordinary destination'); seen.add(address)
    return raw as unknown as HeadingTitleOrdinaryStyleFact3
  })
  for (const side of ['persisted', 'working', 'after'] as const) {
    const cells = new Map<string, HeadingTitleOrdinaryField3[]>()
    for (const fact of result) { const address = hostEncode([fact.documentId, fact.blockId]), fields = cells.get(address) ?? []; fields.push(fact[side]); cells.set(address, fields) }
    for (const fields of cells.values()) {
      fields.sort((a, b) => a.from - b.from || a.to - b.to)
      if (fields.some((field, index) => index > 0 && (field.from < fields[index - 1].to || field.from === fields[index - 1].from)))
        return bad('finite original destination ranges overlap')
    }
  }
  return result
}
export function headingTitleOrdinaryRestorationFacts3(styles: readonly HeadingTitleOrdinaryStyleFact3[], direction: 'undo' | 'redo'): HeadingTitleOrdinaryRestoreFact3[] {
  return styles.map(({ persisted: _persisted, working, after, ...facts }) => ({ ...facts,
    from: direction === 'undo' ? after : working, to: direction === 'undo' ? working : after }))
}
export interface HeadingTitleStyleSource3 {
  documentId: string; documentCreatedAt: string; path: string
  blocks: readonly SyncedStableBlockDraft[]; births: ReadonlyMap<string, string>
}
export type HeadingTitleStyleTarget3 = Pick<HeadingTitleOrdinaryField3, 'targetPath' | 'fragment' | 'targetKind' | 'targetId' | 'targetCreatedAt' | 'targetIdentity'>
const semantic = (field: Pick<HeadingTitleOrdinaryField3, 'url' | 'sourcePath' | 'targetPath' | 'fragment'>) => [field.targetPath, field.fragment, query(field.url)]
/** Current exact native field/role/birth and its projected local semantics are
 * checked before admitting any finite historical raw. Other current text is
 * preserved. Every actual changed destination needs original facts. */
export function restoreHeadingTitleOrdinaryFields3<T extends SyncedStableBlockDraft>(source: HeadingTitleStyleSource3,
  canonical: readonly T[], newPath: string, facts: readonly HeadingTitleOrdinaryRestoreFact3[],
  target?: (side: 'before' | 'after', link: MarkdownDocumentLink) => HeadingTitleStyleTarget3, wiki?:HeadingTitleWikiStyleContext3) {
  const before = collectDocumentMarkdownLinks([...source.blocks]), after = collectDocumentMarkdownLinks([...canonical])
  if (before.length !== after.length) return bad('inverse ordinary complete native parser changed shape')
  const overrides = new Map<number, string>()
  for (let index = 0; index < before.length; index++) {
    const old = before[index], next = after[index]
    if (old.kind === 'image') continue
    const oldBlock = source.blocks[old.blockIndex], nextBlock = canonical[next.blockIndex]
    const raw = oldBlock.content.slice(old.start, old.end), nextRaw = nextBlock.content.slice(next.start, next.end)
    if (raw === nextRaw) continue
    const fact = facts.find(item => item.documentId === source.documentId && item.documentCreatedAt === source.documentCreatedAt
      && item.blockId === oldBlock.id && item.blockCreatedAt === source.births.get(oldBlock.id)
      && item.kind === old.kind && item.syntax === (headingTitleLinkSyntax3(old) ?? null) && item.from.sourcePath === source.path
      && item.from.from === old.start && item.from.to === old.end && item.from.raw === raw && item.from.url === old.url)
    if (!fact || next.blockId !== old.blockId || next.kind !== old.kind || headingTitleLinkSyntax3(next) !== headingTitleLinkSyntax3(old))
      return bad('changed ordinary URI lacks its exact original from-field/birth')
    if(old.kind==='wiki'){
      if(!wiki||fact.to.sourcePath!==newPath||headingTitleWikiFingerprint3(fact.to.url,newPath,wiki.after)!==headingTitleWikiFingerprint3(next.url,newPath,wiki.after))return bad('historical Wiki raw changes its current native document/fragment resolution')
    }else{
    const resolved = resolveMarkdownDocumentPath(newPath, next.url)
    if (!resolved || fact.to.sourcePath !== newPath || !hostEqual(semantic(fact.to), semantic({ url: next.url, sourcePath: newPath,
      targetPath: resolved.path, fragment: resolved.fragment }))) return bad('original destination spelling differs from actual projected local semantics')
    }
    if (target && (!hostEqual(target('before', old), { targetPath: fact.from.targetPath, fragment: fact.from.fragment,
      targetKind: fact.from.targetKind, targetId: fact.from.targetId, targetCreatedAt: fact.from.targetCreatedAt, targetIdentity: fact.from.targetIdentity })
      || !hostEqual(target('after', next), { targetPath: fact.to.targetPath, fragment: fact.to.fragment,
        targetKind: fact.to.targetKind, targetId: fact.to.targetId, targetCreatedAt: fact.to.targetCreatedAt, targetIdentity: fact.to.targetIdentity })))
      return bad('current ordinary URI target Key/incarnation differs from original style facts')
    overrides.set(index, fact.to.raw)
  }
  return restyleHeadingTitleOrdinaryBlocks3(source.blocks, canonical, newPath, undefined, undefined, overrides,wiki)
}

/** Historical inverse facts must be the same finite fields of their actual
 * initial action. A newly added backlink cannot become inverse authority. */
export function validateHeadingTitleOrdinaryRestoreRecord3(initial: readonly HeadingTitleOrdinaryStyleFact3[],
  current: readonly HeadingTitleOrdinaryStyleFact3[], direction: 'undo' | 'redo') {
  const expected = headingTitleOrdinaryRestorationFacts3(initial, direction)
  for (const fact of current) {
    const original = expected.find(item => item.documentId === fact.documentId && item.documentCreatedAt === fact.documentCreatedAt
      && item.blockId === fact.blockId && item.blockCreatedAt === fact.blockCreatedAt && item.kind === fact.kind && item.syntax === fact.syntax
      && hostEqual(item.from, fact.persisted))
    if (!original || !hostEqual(fact.persisted, fact.working)
      || fact.after.raw !== original.to.raw || fact.after.url !== original.to.url || fact.after.sourcePath !== original.to.sourcePath
      || !hostEqual(semantic(fact.after), semantic(original.to)) || !hostEqual(identity(fact.after), identity(original.to)))
      return bad('inverse ordinary field is not its exact initial operation destination')
  }
}
