import { serializeMarkdownWithBlockRanges, type MarkdownRenderableBlock } from './markdown'
import { collectMarkdownSourceLinks, parseLocalMarkdownUrl, relativeMarkdownPath, resolveMarkdownDocumentPath, type MarkdownSourceLink } from './markdownLinks'
import { markdownEngine, type MarkdownEnvironment } from './markdownEngine'
import { markdownHeadingSlug, markdownInlineText } from './markdownHeadingText'
import type { MarkdownHeading } from './markdownAdvanced'

export type MarkdownDocumentLink = MarkdownSourceLink & { blockIndex: number; blockId?: string }
export type MarkdownHeadingTarget = { key: string; blockId: string | null; text: string; slug: string }

/** Translate parser positions back into block content, without re-importing a
 * serialized document and losing block identities or editor metadata. */
export function collectDocumentMarkdownLinks(blocks: MarkdownRenderableBlock[]): MarkdownDocumentLink[] {
  if (!blocks.some((block) => /[\[<]/.test(block.content))) return []
  const { markdown, ranges } = serializeMarkdownWithBlockRanges(blocks)
  const lines = markdown.split('\n')
  const lineOffsets = [0]
  for (let index = 0; index < lines.length; index++) lineOffsets.push(lineOffsets[index] + lines[index].length + 1)
  const localLines = new Map<number, { lines: string[]; offsets: number[] }>()
  const result: MarkdownDocumentLink[] = []
  let line = 0, rangeIndex = 0
  for (const link of collectMarkdownSourceLinks(markdown)) {
    while (line + 1 < lineOffsets.length && lineOffsets[line + 1] <= link.start) line++
    while (rangeIndex < ranges.length && ranges[rangeIndex].endLine <= line) rangeIndex++
    const range = ranges[rangeIndex], block = blocks[rangeIndex]
    if (!range || !block || line < range.startLine || ['code', 'math'].includes(block.type)) continue
    let local = localLines.get(rangeIndex)
    if (!local) {
      const blockLines = block.content.split('\n'), offsets = [0]
      for (let index = 0; index < blockLines.length; index++) offsets.push(offsets[index] + blockLines[index].length + 1)
      local = { lines: blockLines, offsets }; localLines.set(rangeIndex, local)
    }
    const localLine = line - range.startLine, contentLine = local.lines[localLine]
    if (contentLine === undefined || !lines[line].endsWith(contentLine) || link.end > lineOffsets[line] + lines[line].length) continue
    const prefix = lines[line].length - contentLine.length
    const start = local.offsets[localLine] + link.start - lineOffsets[line] - prefix
    if (start < local.offsets[localLine]) continue
    result.push({ ...link, blockIndex: rangeIndex, blockId: block.id, start, end: start + link.end - link.start })
  }
  return result
}

export function getMarkdownHeadingTargets(blocks: MarkdownRenderableBlock[], title: string): MarkdownHeadingTarget[] {
  const { markdown, ranges } = serializeMarkdownWithBlockRanges(blocks)
  const environment: MarkdownEnvironment = { documentTitle: title }
  markdownEngine.parse(markdown, environment)
  const titleText = markdownInlineText(markdownEngine.parseInline(title, { references: environment.references })[0]?.children ?? [])
  const targets: MarkdownHeadingTarget[] = [{ key: '$title', blockId: null, text: titleText, slug: markdownHeadingSlug(titleText, new Set()) }]
  const ordinals = new Map<string, number>()
  let rangeIndex = 0
  for (const heading of (environment.documentHeadings ?? []) as MarkdownHeading[]) {
    while (rangeIndex < ranges.length && ranges[rangeIndex].endLine <= heading.line) rangeIndex++
    const block = blocks[rangeIndex]
    if (!block?.id || heading.line < ranges[rangeIndex].startLine) continue
    const ordinal = ordinals.get(block.id) ?? 0
    ordinals.set(block.id, ordinal + 1)
    targets.push({ key: `${block.id}:${ordinal}`, blockId: block.id, text: heading.text, slug: heading.slug })
  }
  return targets
}

function missingHeadingSlug(key: string): string {
  // A removed heading must never silently retarget a surviving duplicate.
  // Keep its identity in an unresolved fragment so undo can restore the link.
  return 'knowbook-missing-heading-' + Array.from(key).map((character) => character.codePointAt(0)!.toString(16)).join('-')
}

export function getMarkdownHeadingRewrites(before: MarkdownHeadingTarget[], after: MarkdownHeadingTarget[], matchRecreated = false): Map<string, string> {
  if (matchRecreated) {
    // A plain Markdown import can recreate block IDs. Only identical, unique
    // heading text is sufficient evidence to retain that section's identity.
    const oldBlocks = new Set(before.map((heading) => heading.blockId))
    const newBlocks = new Set(after.map((heading) => heading.blockId))
    after = after.map((heading) => {
      if (oldBlocks.has(heading.blockId)) return heading
      const matches = before.filter((old) => old.text === heading.text && !newBlocks.has(old.blockId))
      return matches.length === 1 && after.filter((item) => item.text === heading.text).length === 1
        ? { ...heading, key: matches[0].key, blockId: matches[0].blockId } : heading
    })
  }
  const rewrites = new Map<string, string>()
  const used = new Set(after.map((heading) => heading.slug))
  const byBlock = new Map<string | null, MarkdownHeadingTarget[]>()
  for (const heading of after) byBlock.set(heading.blockId, [...(byBlock.get(heading.blockId) ?? []), heading])
  const oldByBlock = new Map<string | null, MarkdownHeadingTarget[]>()
  for (const heading of before) oldByBlock.set(heading.blockId, [...(oldByBlock.get(heading.blockId) ?? []), heading])
  for (const [blockId, old] of oldByBlock) {
    const current = byBlock.get(blockId) ?? []
    const remaining = new Set(current)
    const matched = new Map<MarkdownHeadingTarget, MarkdownHeadingTarget>()
    for (const heading of old) {
      // Several headings inside one raw block have no individual block IDs.
      // A changed duplicate count cannot tell us which occurrence survived.
      if (old.filter((item) => item.text === heading.text).length !== current.filter((item) => item.text === heading.text).length) continue
      const sameText = [...remaining].find((item) => item.text === heading.text)
      if (sameText) { matched.set(heading, sameText); remaining.delete(sameText) }
    }
    const unmatched = old.filter((heading) => !matched.has(heading))
    if (unmatched.length === 1 && remaining.size === 1) matched.set(unmatched[0], [...remaining][0])
    for (const heading of old) {
      const target = matched.get(heading)
      let slug = target?.slug
      if (slug === undefined) {
        slug = missingHeadingSlug(heading.key)
        while (used.has(slug)) slug += '-missing'
      }
      if (slug !== heading.slug) rewrites.set(heading.slug, slug)
    }
  }
  const oldSlugs = new Set(before.map((heading) => heading.slug))
  const oldKeys = new Set(before.map((heading) => heading.key))
  for (const heading of after) {
    let missing = missingHeadingSlug(heading.key)
    while (oldSlugs.has(missing)) missing += '-missing'
    if (!oldKeys.has(heading.key)) rewrites.set(missing, heading.slug)
  }
  return rewrites
}

export type MarkdownPathChange = { before: string; after: string; headings?: Map<string, string> }

/** Resolve using the old source directory, then express the same destination
 * from the new directory. Rebase unresolved outlinks too, preserving intent. */
export function rewriteLocalMarkdownLink(url: string, oldSourcePath: string, newSourcePath: string, changes: ReadonlyMap<string, MarkdownPathChange>): string | null {
  const local = parseLocalMarkdownUrl(url)
  const target = resolveMarkdownDocumentPath(oldSourcePath, url)
  if (!local || !target) return null
  const change = changes.get(target.path)
  const targetPath = change?.after ?? target.path
  // A plain document link (including a trailing #) refers to its top, not an
  // empty slug generated from a punctuation-only heading.
  const fragment = target.fragment ? change?.headings?.get(target.fragment) ?? target.fragment : target.fragment
  const pathChanged = Boolean(local.path) && (targetPath !== target.path || (!local.path.startsWith('/') && oldSourcePath.split('/').slice(0, -1).join('/') !== newSourcePath.split('/').slice(0, -1).join('/')))
  const fragmentChanged = fragment !== target.fragment
  if (!pathChanged && !fragmentChanged) return null
  let path = url.split(/[?#]/, 1)[0]
  if (local.path && pathChanged) path = local.path.startsWith('/')
    ? '/' + targetPath.split('/').map(encodeURIComponent).join('/') + '.md'
    : relativeMarkdownPath(`${newSourcePath}.md`, `${targetPath}.md`)
  const suffix = fragmentChanged ? local.suffix.split('#', 1)[0] + '#' + encodeURIComponent(fragment) : local.suffix
  return path + suffix
}

export function rewriteDocumentMarkdownLinks<T extends MarkdownRenderableBlock>(blocks: T[], rewrite: (link: MarkdownDocumentLink) => string | null | undefined): T[] {
  const next = [...blocks]
  for (const link of collectDocumentMarkdownLinks(blocks).reverse()) {
    const replacement = rewrite(link)
    if (replacement == null || replacement === link.url) continue
    const escaped = link.kind === 'wiki' ? replacement : replacement.replace(/[\s<>()[\]\\]/g, (character) => encodeURIComponent(character).replace('(', '%28').replace(')', '%29'))
    const block = next[link.blockIndex]
    next[link.blockIndex] = { ...block, content: block.content.slice(0, link.start) + escaped + block.content.slice(link.end) }
  }
  return next
}
