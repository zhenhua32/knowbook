import type { DocumentBlockDraft } from './contracts'
import { markdownEngine, type MarkdownEnvironment, type MarkdownToken } from './markdownEngine'
import { serializeMarkdownWithBlockRanges } from './markdown'
import { collectDocumentMarkdownLinks, type MarkdownDocumentLink } from './markdownLinkMaintenance'
import { escapeMarkdownDestination, parseLocalMarkdownUrl, relativeMarkdownPath, resolveMarkdownDocumentPath } from './markdownLinks'
import { parseWikiReference, wikiDocumentPaths, type WikiReference } from './markdownWiki'

export type BlockTransferWikiBinding = { path: string; fragment: string; kind: 'block' | 'heading' | 'document' }
export interface BlockTransferLinkContext {
  sourcePath: string
  fromPath: string
  toPath: string
  movedIds: ReadonlySet<string>
  /** Bindings from the index before the move: ambiguous titles must stay unresolved. */
  bindings: ReadonlyMap<string, BlockTransferWikiBinding>
  targetContent?: string
}
export function blockTransferLinkBindingKey(blockId: string | undefined, url: string): string {
  return JSON.stringify([blockId, url])
}
/** The caret denotes a block fragment; its spelling remains in the source URL. */
export function blockTransferFragmentId(fragment: string): string {
  return fragment.startsWith('^') ? fragment.slice(1) : fragment
}

function referenceForBinding(url: string, binding?: BlockTransferWikiBinding): WikiReference {
  if (binding?.path === url) return { target: url, path: url, fragment: '', hasFragment: false, alias: null }
  if (binding && /[#|]/.test(binding.path) && url.startsWith(binding.path + '#')) {
    const tail = parseWikiReference(url.slice(binding.path.length + 1))
    return { target: url, path: binding.path, fragment: tail.target, hasFragment: true, alias: tail.alias }
  }
  const reference = parseWikiReference(url)
  return binding?.kind === 'block' && !reference.hasFragment && reference.target === binding.fragment
    ? { ...reference, path: '', fragment: binding.fragment, hasFragment: true } : reference
}

function replaceWikiPath(url: string, reference: WikiReference, path: string): string {
  // Preserve the alias bytes, including spacing, instead of normalizing its text.
  const separator = url.indexOf('|', /[#|]/.test(reference.path) && url.startsWith(reference.path + '#') ? reference.path.length + 1 : 0)
  return path + (reference.hasFragment ? '#' + reference.fragment : '') + (separator < 0 ? '' : url.slice(separator))
}

function rebaseLocalUrl(url: string, context: BlockTransferLinkContext, movedSource: boolean, image: boolean, binding?: BlockTransferWikiBinding): string | null {
  const local = parseLocalMarkdownUrl(url)
  if (!local) return null
  const parsedTarget = image ? null : resolveMarkdownDocumentPath(context.sourcePath, url)
  const target = parsedTarget && binding?.kind === 'block' ? { path: binding.path, fragment: binding.fragment } : parsedTarget
  const newSource = movedSource ? context.toPath : context.sourcePath
  if (target) {
    const targetPath = target.path === context.fromPath && context.movedIds.has(blockTransferFragmentId(target.fragment)) ? context.toPath : target.path
    if (targetPath === target.path && !movedSource) return null
    if (targetPath === target.path && local.path.startsWith('/')) return null
    if (targetPath === newSource && !local.path) return null
    const path = local.path.startsWith('/') ? '/' + targetPath.split('/').map(encodeURIComponent).join('/') + '.md'
      : !local.path && targetPath === newSource ? '' : relativeMarkdownPath(newSource + '.md', targetPath + '.md')
    return path + local.suffix
  }
  if (!movedSource || !local.path || local.path.startsWith('/')) return null
  const parts = context.sourcePath.split('/').slice(0, -1)
  for (const part of local.path.split('/')) {
    if (part === '..') { if (!parts.length) return null; parts.pop() }
    else if (part && part !== '.') parts.push(part)
  }
  return parts.length ? relativeMarkdownPath(newSource + '.md', parts.join('/')) + local.suffix : null
}

function rewriteLink(link: MarkdownDocumentLink, context: BlockTransferLinkContext, forceMovedSource?: boolean): string | null {
  const movedSource = forceMovedSource ?? (context.sourcePath === context.fromPath && context.movedIds.has(link.blockId ?? ''))
  const binding = context.bindings.get(blockTransferLinkBindingKey(link.blockId, link.url))
  if (link.kind !== 'wiki') return rebaseLocalUrl(link.url, context, movedSource, link.kind === 'image', binding)
  const reference = referenceForBinding(link.url, binding)
  if (binding?.path === context.fromPath && binding.kind === 'block' && context.movedIds.has(blockTransferFragmentId(binding.fragment))) {
    const path = !reference.path && movedSource ? '' : context.toPath
    return replaceWikiPath(link.url, reference, path)
  }
  if (!movedSource || reference.path && !/^\.\.?\//.test(reference.path)) return null
  const oldTarget = binding?.path ?? wikiDocumentPaths(reference.path, context.sourcePath)[0]
  if (!oldTarget) return null
  // A local heading or surviving block still belongs to the original document.
  return replaceWikiPath(link.url, reference, oldTarget)
}

type ContentEdit = { blockIndex: number; start: number; end: number; replacement: string }

/** Definitions that cross the ownership boundary need an explicit binding.
 * Upstream link/image rules identify reference uses, including collapsed and
 * shortcut forms; source maps keep labels and escaped table cells byte-exact.
 */
function referenceBoundaryEdits(blocks: DocumentBlockDraft[], context: BlockTransferLinkContext, options: { inlineAllReferences?: boolean; forceMovedUse?: boolean } = {}): ContentEdit[] {
  if (context.sourcePath !== context.fromPath || !blocks.some(block => block.content.includes('['))) return []
  const { markdown, ranges } = serializeMarkdownWithBlockRanges(blocks)
  const env: MarkdownEnvironment = { captureSourceLinks: true }
  const tokens = markdownEngine.parse(markdown, env), definitions = new Map<string, number>()
  // The normal core pass strips definition tokens after recording their
  // destinations. A block-only pass retains their ownership and label maps
  // without mutating rules or changing the document-wide inline environment.
  const definitionTokens: MarkdownToken[] = []
  markdownEngine.block.parse(markdown.replace(/\r\n?/g, '\n').replace(/\0/g, '\uFFFD'), markdownEngine, {}, definitionTokens)
  const lines = markdown.split('\n'), offsets = [0]
  for (const line of lines) offsets.push(offsets.at(-1)! + line.length + 1)
  const normalizedOffsets: number[] = []
  for (let index = 0; index < markdown.length; index++) {
    normalizedOffsets.push(index)
    if (markdown[index] === '\r' && markdown[index + 1] === '\n') index++
  }
  normalizedOffsets.push(markdown.length)
  const blockAtLine = (line: number) => ranges.findIndex(range => range.startLine <= line && range.endLine > line)
  const localPosition = (blockIndex: number, position: number): number | null => {
    let line = 0
    while (line + 1 < offsets.length && offsets[line + 1] <= position) line++
    const range = ranges[blockIndex], localLines = blocks[blockIndex].content.split('\n'), localLine = line - range.startLine
    if (localLine < 0 || localLine >= localLines.length || !lines[line].endsWith(localLines[localLine])) return null
    const prefix = lines[line].length - localLines[localLine].length
    if (position - offsets[line] < prefix) return null
    return localLines.slice(0, localLine).reduce((length, text) => length + text.length + 1, 0) + position - offsets[line] - prefix
  }
  const movedNames = new Map<string, string>(), usedNames = new Set<string>(), edits: ContentEdit[] = []
  const existingContent = ((context.targetContent ?? '') + '\n' + markdown).toLowerCase()
  for (const token of definitionTokens) {
    const label = token.meta?.label
    if (token.type !== 'reference_definition' || !token.map || typeof label !== 'string') continue
    const blockIndex = blockAtLine(token.map[0])
    if (blockIndex < 0) continue
    if (!definitions.has(label)) definitions.set(label, blockIndex)
    if (options.inlineAllReferences || !context.movedIds.has(blocks[blockIndex].id ?? '')) continue
    let name = movedNames.get(label)
    if (!name) {
      let ordinal = movedNames.size + 1
      do { name = 'knowbook-moved-' + ordinal++ } while (existingContent.includes(name) || usedNames.has(name))
      movedNames.set(label, name)
      usedNames.add(name)
    }
    const rawLine = lines[token.map[0]]
    const labelMatch = [...rawLine.matchAll(/\[((?:\\.|[^\]\\])*)\]:/g)].find(match => markdownEngine.utils.normalizeReference(match[1]) === label)
    if (!labelMatch) continue
    const first = labelMatch.index, start = localPosition(blockIndex, offsets[token.map[0]] + first + 1)
    const end = localPosition(blockIndex, offsets[token.map[0]] + first + 1 + labelMatch[1].length)
    if (start !== null && end !== null) edits.push({ blockIndex, start, end, replacement: name })
  }
  const linkRule = markdownEngine.inline.ruler.__rules__.find(rule => rule.name === 'link')!.fn
  const imageRule = markdownEngine.inline.ruler.__rules__.find(rule => rule.name === 'image')!.fn
  const footnoteRule = markdownEngine.inline.ruler.__rules__.find(rule => rule.name === 'footnote_inline')!.fn
  const scanInline = (source: string, map: number[], depth = 0) => {
    const inlineEnv: MarkdownEnvironment = { references: env.references }
    const state = new markdownEngine.inline.State(source, markdownEngine, inlineEnv, [])
    while (state.pos < state.posMax) {
      const start = state.pos, first = state.tokens.length, image = source.startsWith('![', start)
      if (depth < markdownEngine.options.maxNesting && source.startsWith('^[', start) && footnoteRule(state, false)) {
        scanInline(source.slice(start + 2, state.pos - 1), map.slice(start + 2, state.pos - 1), depth + 1)
        continue
      }
      const accepted = image ? !source.startsWith('![[', start) && imageRule(state, false)
        : source[start] === '[' && !source.startsWith('[[', start) && linkRule(state, false)
      if (!accepted) { markdownEngine.inline.skipToken(state); continue }
      const link = state.tokens.slice(first).find(item => item.type === (image ? 'image' : 'link_open')), label = link?.meta?.label
      if (typeof label !== 'string' || !link) continue
      const sourceStart = normalizedOffsets[map[start]], sourceEnd = normalizedOffsets[map[state.pos - 1] + 1]
      const actualBlock = ranges.findIndex(range => sourceStart >= offsets[range.startLine] && sourceStart < offsets[range.endLine])
      if (actualBlock < 0 || ['code', 'math', 'frontmatter'].includes(blocks[actualBlock].type)) continue
      const movedUse = options.forceMovedUse ?? context.movedIds.has(blocks[actualBlock].id ?? ''), definition = definitions.get(label)
      if (definition === undefined) continue
      const movedDefinition = !options.inlineAllReferences && context.movedIds.has(blocks[definition].id ?? '')
      if (!options.inlineAllReferences && !movedUse && !movedDefinition) continue
      const localStart = localPosition(actualBlock, sourceStart), localEnd = localPosition(actualBlock, sourceEnd)
      const labelEnd = markdownEngine.helpers.parseLinkLabel(new markdownEngine.inline.State(source, markdownEngine, inlineEnv, []), start + (image ? 1 : 0), !image)
      if (labelEnd < 0) continue
      const localLabelEnd = localPosition(actualBlock, normalizedOffsets[map[labelEnd]] + 1)
      if (localStart === null || localEnd === null || localLabelEnd === null) continue
      const visible = blocks[actualBlock].content.slice(localStart, localLabelEnd)
      const renamed = movedNames.get(label)
      let replacement: string
      if (movedUse && movedDefinition && renamed) replacement = visible + '[' + renamed + ']'
      else {
        const url = String(link.attrGet(image ? 'src' : 'href') ?? '')
        const binding = context.bindings.get(blockTransferLinkBindingKey(blocks[definition].id, url))
        const destination = rebaseLocalUrl(url, context, movedUse, image, binding) ?? url
        const title = link.attrGet('title')
        replacement = visible + '(' + escapeMarkdownDestination(destination) + (title ? ' "' + String(title).replace(/[\\"]/g, '\\$&') + '"' : '') + ')'
      }
      edits.push({ blockIndex: actualBlock, start: localStart, end: localEnd, replacement })
    }
  }
  for (const token of tokens) {
    const map = token.meta?.sourceMap
    if (token.type === 'inline' && Array.isArray(map) && map.every(position => typeof position === 'number')) scanInline(token.content, map)
  }
  return edits
}

type FootnoteDefinition = { label: string; blockIndex: number; start: number; end: number; nameStart: number; nameEnd: number }
type FootnoteUse = { label: string; blockIndex: number; start: number; end: number }

function applyContentEdits(content: string, input: Array<{ start: number; end: number; replacement: string }>): string {
  const fail = (): never => { throw new Error('引用源范围发生重叠，未移动任何块。请先把嵌套引用整理为独立段落。') }
  type Edit = { start: number; end: number; replacement: string; children: Edit[] }
  const roots: Edit[] = []
  for (const edit of [...input].sort((a, b) => (b.end - b.start) - (a.end - a.start))) {
    if (!Number.isSafeInteger(edit.start) || !Number.isSafeInteger(edit.end) || edit.start < 0 || edit.end < edit.start || edit.end > content.length) fail()
    const same = roots.find(root => root.start === edit.start && root.end === edit.end)
    if (same) { if (same.replacement !== edit.replacement) fail(); continue }
    const owner = roots.find(root => root.start <= edit.start && root.end >= edit.end)
    if (owner) { owner.children.push({ ...edit, children: [] }); continue }
    if (roots.some(root => root.start < edit.end && edit.start < root.end)) fail()
    roots.push({ ...edit, children: [] })
  }
  for (const edit of roots.sort((a, b) => b.start - a.start)) {
    let replacement = edit.replacement
    if (edit.children.length) {
      const original = content.slice(edit.start, edit.end)
      for (const child of edit.children) {
        if (replacement.slice(0, child.end - edit.start) !== original.slice(0, child.end - edit.start)) fail()
      }
      replacement = applyContentEdits(replacement, edit.children.map(child => ({ ...child, start: child.start - edit.start, end: child.end - edit.start })))
    }
    content = content.slice(0, edit.start) + replacement + content.slice(edit.end)
  }
  return content
}

function normalLinkEdits(blocks: DocumentBlockDraft[], context: BlockTransferLinkContext, forceMovedSource?: boolean): ContentEdit[] {
  return collectDocumentMarkdownLinks(blocks).flatMap(link => {
    const replacement = rewriteLink(link, context, forceMovedSource)
    if (replacement === null || replacement === link.url) return []
    const raw = blocks[link.blockIndex].content.slice(link.start, link.end)
    const escaped = escapeMarkdownDestination(replacement, link.kind === 'wiki' ? undefined : link.syntax)
    return [{ blockIndex: link.blockIndex, start: link.start, end: link.end,
      replacement: link.kind === 'wiki' ? (raw.includes('\\|') ? replacement.replace(/\|/g, '\\|') : replacement)
        : raw.includes('#^') ? escaped.replace(/#%5e/i, '#^') : escaped }]
  })
}

/** Keep named notes bound to their complete original definition closure. Read
 * existing parser rules without installing, replacing or enabling grammar.
 * A copy is inserted only into a verifiable top-level paragraph, otherwise the
 * caller rejects the move before its transaction has written any data. */
function namedFootnoteEdits(blocks: DocumentBlockDraft[], context: BlockTransferLinkContext): ContentEdit[] {
  if (context.sourcePath !== context.fromPath || !blocks.some(block => context.movedIds.has(block.id ?? '')
    && !['code', 'math', 'frontmatter'].includes(block.type) && block.content.includes('[^'))) return []
  const { markdown, ranges } = serializeMarkdownWithBlockRanges(blocks)
  const env: MarkdownEnvironment = { captureSourceLinks: true }
  const state = new markdownEngine.core.State(markdown, markdownEngine, env)
  for (const rule of markdownEngine.core.ruler.__rules__) {
    if (rule.name === 'footnote_tail') break
    if (rule.enabled && rule.name !== 'strip_references') rule.fn(state)
  }
  const normalized = state.src, lines = normalized.split('\n'), offsets = [0], originalOffsets: number[] = []
  for (const line of lines) offsets.push(offsets.at(-1)! + line.length + 1)
  for (let index = 0; index < markdown.length; index++) {
    originalOffsets.push(index)
    if (markdown[index] === '\r' && markdown[index + 1] === '\n') index++
  }
  originalOffsets.push(markdown.length)
  const originalLines = markdown.split('\n'), originalLineOffsets = [0]
  for (const line of originalLines) originalLineOffsets.push(originalLineOffsets.at(-1)! + line.length + 1)
  const local = (position: number): { blockIndex: number; offset: number } | null => {
    const original = originalOffsets[position]
    if (original === undefined) return null
    let line = 0
    while (line + 1 < originalLineOffsets.length && originalLineOffsets[line + 1] <= original) line++
    const blockIndex = ranges.findIndex(range => range.startLine <= line && range.endLine > line)
    if (blockIndex < 0) return null
    const contentLines = blocks[blockIndex].content.split('\n'), localLine = line - ranges[blockIndex].startLine
    const contentLine = contentLines[localLine]
    if (contentLine === undefined || !originalLines[line].endsWith(contentLine)) return null
    const prefix = originalLines[line].length - contentLine.length, column = original - originalLineOffsets[line] - prefix
    if (column < 0 || column > contentLine.length) return null
    return { blockIndex, offset: contentLines.slice(0, localLine).reduce((sum, line) => sum + line.length + 1, 0) + column }
  }
  const fail = (): never => { throw new Error('脚注定义跨越无法安全定位的容器，未移动任何块。请先把脚注整理为独立的顶层段落。') }

  const targetEnvironment: MarkdownEnvironment = {}
  markdownEngine.block.parse((context.targetContent ?? '').replace(/\r\n?/g, '\n'), markdownEngine, targetEnvironment, [])
  const targetFootnotes = targetEnvironment.footnotes as { refs?: Record<string, number> } | undefined
  const literalEdits: ContentEdit[] = []

  const definitions: FootnoteDefinition[] = [], uses: FootnoteUse[] = []
  const linkRule = markdownEngine.inline.ruler.__rules__.find(rule => rule.name === 'link')!.fn
  const footnoteRef = markdownEngine.inline.ruler.__rules__.find(rule => rule.name === 'footnote_ref')!.fn
  const footnoteInline = markdownEngine.inline.ruler.__rules__.find(rule => rule.name === 'footnote_inline')!.fn
  const scanUses = (source: string, map: number[], depth = 0) => {
    const inline = new markdownEngine.inline.State(source, markdownEngine, env, [])
    while (inline.pos < inline.posMax) {
      const start = inline.pos, first = inline.tokens.length
      if (depth < markdownEngine.options.maxNesting && source.startsWith('^[', start) && footnoteInline(inline, false)) {
        scanUses(source.slice(start + 2, inline.pos - 1), map.slice(start + 2, inline.pos - 1), depth + 1)
        continue
      }

      if (source[start] === '[' && !source.startsWith('[[', start)) {
        const labelEnd = markdownEngine.helpers.parseLinkLabel(new markdownEngine.inline.State(source, markdownEngine, env, []), start, true)
        if (labelEnd >= 0 && linkRule(inline, false)) {
          if (depth < markdownEngine.options.maxNesting) scanUses(source.slice(start + 1, labelEnd), map.slice(start + 1, labelEnd), depth + 1)
          continue
        }
      }

      if (source.startsWith('[^', start)) {
        const literal = source.slice(start).match(/^\[\^([^\]\x20\n]+)\]/)
        const sourceFootnotes = env.footnotes as { refs?: Record<string, number> } | undefined
        if (literal && sourceFootnotes?.refs?.[':' + literal[1]] === undefined && targetFootnotes?.refs?.[':' + literal[1]] !== undefined) {
          const position = local(map[start])
          if (position && context.movedIds.has(blocks[position.blockIndex].id ?? '')) literalEdits.push({ blockIndex: position.blockIndex,
            start: position.offset, end: position.offset, replacement: '\\' })
        }
      }

      if (!source.startsWith('[^', start) || !footnoteRef(inline, false)) { markdownEngine.inline.skipToken(inline); continue }
      const label = inline.tokens.slice(first).find(token => token.type === 'footnote_ref')?.meta?.label
      if (typeof label !== 'string') continue
      const from = local(map[start] + 2), to = local(map[inline.pos - 1])
      if (!from || !to || from.blockIndex !== to.blockIndex) fail()
      uses.push({ label, blockIndex: from!.blockIndex, start: from!.offset, end: to!.offset })
    }
  }
  for (let index = 0; index < state.tokens.length; index++) {
    const token = state.tokens[index], map = token.meta?.sourceMap
    if (token.type === 'inline' && Array.isArray(map)) scanUses(token.content, map)
    if (token.type !== 'footnote_reference_open') continue
    const labelValue = token.meta?.label
    const label = typeof labelValue === 'string' ? labelValue : fail()
    const maps: Array<[number, number]> = []
    let cursor = index + 1
    for (; cursor < state.tokens.length && state.tokens[cursor].type !== 'footnote_reference_close'; cursor++) {
      if (state.tokens[cursor].map) maps.push(state.tokens[cursor].map!)
    }
    const priorMaps = state.tokens.slice(0, index).flatMap(token => token.map ? [token.map] : [])
    const lowerLine = priorMaps.at(-1)?.[1] ?? 0
    const followingLine = state.tokens.slice(cursor + 1).find(token => token.map)?.map?.[0] ?? lines.length - 1
    const firstBodyLine = maps.length ? Math.min(...maps.map(map => map[0])) : followingLine
    const headers: Array<{ line: number; match: RegExpMatchArray }> = []
    for (let line = lowerLine; line <= firstBodyLine && line < lines.length; line++) {
      const match = lines[line].match(/\[\^([^\]\x20\n]+)\]:/)
      if (match?.[1] === label && /^(?:[ \t>*+-]|\d+[.)])*$/.test(lines[line].slice(0, match.index))) headers.push({ line, match })
    }
    if (headers.length !== 1) fail()
    const { line: firstLine, match } = headers[0]
    let lastLine = maps.length ? Math.max(...maps.map(map => map[1])) - 1 : firstLine
    while (lastLine > firstLine && !lines[lastLine].trim()) lastLine--
    const definitionStart = offsets[firstLine] + match.index!, definitionEnd = offsets[lastLine] + lines[lastLine].length

    const from = local(definitionStart), to = local(definitionEnd)
    if (!from || !to || from.blockIndex !== to.blockIndex) fail()
    definitions.push({ label, blockIndex: from!.blockIndex, start: from!.offset, end: to!.offset,
      nameStart: from!.offset + 2, nameEnd: from!.offset + 2 + label.length })
  }
  if (!definitions.length) return literalEdits
  // markdown-it-footnote binds duplicate names to the last definition.
  const effective = new Map(definitions.map(definition => [definition.label, definition]))
  const moved = (blockIndex: number) => context.movedIds.has(blocks[blockIndex].id ?? '')
  const inside = (use: FootnoteUse, definition: FootnoteDefinition) => use.blockIndex === definition.blockIndex && use.start >= definition.start && use.end <= definition.end
  const closure = (roots: string[]) => {
    const labels = new Set<string>(), pending = [...roots]
    while (pending.length) {
      const label = pending.pop()!, definition = effective.get(label)
      if (!definition || labels.has(label)) continue
      labels.add(label)
      for (const use of uses) if (inside(use, definition)) pending.push(use.label)
    }
    return labels
  }
  const targetLabels = closure([...uses.filter(use => moved(use.blockIndex)).map(use => use.label),
    ...definitions.filter(definition => moved(definition.blockIndex)).map(definition => definition.label)])
  const sourceLabels = closure(uses.filter(use => !moved(use.blockIndex) && moved(effective.get(use.label)!.blockIndex)).map(use => use.label))
  let usedNames = (markdown + '\n' + (context.targetContent ?? '')).toLowerCase()
  const names = (labels: Set<string>, side: string) => {
    const result = new Map<string, string>()
    let ordinal = 1
    for (const label of [...labels].sort()) {
      let name: string
      do { name = 'knowbook-footnote-' + side + '-' + ordinal++ } while (usedNames.includes(name))
      usedNames += '\n' + name
      result.set(label, name)
    }
    return result
  }
  const targetNames = names(targetLabels, 'moved'), sourceNames = names(sourceLabels, 'source'), edits: ContentEdit[] = [...literalEdits]
  for (const use of uses) {
    const name = (moved(use.blockIndex) ? targetNames : sourceNames).get(use.label)
    if (name) edits.push({ blockIndex: use.blockIndex, start: use.start, end: use.end, replacement: name })
  }
  for (const definition of definitions) {
    if (moved(definition.blockIndex) && targetNames.has(definition.label)) edits.push({ blockIndex: definition.blockIndex,
      start: definition.nameStart, end: definition.nameEnd, replacement: targetNames.get(definition.label)! })
  }

  const namespaceReferenceDefinitions = (raw: string): string => {
    const tokens: MarkdownToken[] = [], normalized = raw.replace(/\r\n?/g, '\n'), lines = normalized.split('\n'), lineOffsets = [0], sourceOffsets: number[] = []
    for (const line of lines) lineOffsets.push(lineOffsets.at(-1)! + line.length + 1)
    for (let index = 0; index < raw.length; index++) { sourceOffsets.push(index); if (raw[index] === '\r' && raw[index + 1] === '\n') index++ }
    sourceOffsets.push(raw.length)
    markdownEngine.block.parse(normalized, markdownEngine, {}, tokens)
    const edits: Array<{ start: number; end: number; replacement: string }> = []
    for (const token of tokens) {
      if (token.type !== 'reference_definition' || !token.map || typeof token.meta?.label !== 'string') continue
      const line = lines[token.map[0]], match = [...line.matchAll(/\[((?:\\.|[^\]\\])*)\]:/g)]
        .find(match => markdownEngine.utils.normalizeReference(match[1]) === token.meta?.label)
      if (!match) fail()
      let ordinal = 1, name: string
      do { name = 'knowbook-footnote-reference-' + ordinal++ } while (usedNames.includes(name))
      usedNames += '\n' + name
      const start = lineOffsets[token.map[0]] + match!.index! + 1
      edits.push({ start: sourceOffsets[start], end: sourceOffsets[start + match![1].length], replacement: name })
    }
    return applyContentEdits(raw, edits)
  }

  const copied = (labels: Set<string>, sideNames: Map<string, string>, toTarget: boolean) => {
    const copies = [...labels].map(label => effective.get(label)!).filter(definition => !toTarget || !moved(definition.blockIndex))
      .sort((a, b) => a.blockIndex - b.blockIndex || a.start - b.start)
    if (!copies.length) return
    const linkEdits = [...referenceBoundaryEdits(blocks, context, { inlineAllReferences: true, forceMovedUse: toTarget }), ...normalLinkEdits(blocks, context, toTarget)]
    const raw = copies.map(definition => {
      const block = blocks[definition.blockIndex]
      if (block.type !== 'paragraph' || block.depth !== 0 || block.parentBlockId) fail()
      const localEdits = linkEdits.filter(edit => edit.blockIndex === definition.blockIndex && edit.start >= definition.start && edit.end <= definition.end)
      for (const use of uses.filter(use => inside(use, definition))) {
        const name = sideNames.get(use.label)
        if (name) localEdits.push({ blockIndex: definition.blockIndex, start: use.start, end: use.end, replacement: name })
      }
      localEdits.push({ blockIndex: definition.blockIndex, start: definition.nameStart, end: definition.nameEnd, replacement: sideNames.get(definition.label)! })
      return namespaceReferenceDefinitions(applyContentEdits(block.content.slice(definition.start, definition.end),
        localEdits.map(edit => ({ ...edit, start: edit.start - definition.start, end: edit.end - definition.start }))))
    }).join('\n\n')
    const hostIndex = blocks.findIndex((block, index) => moved(index) === toTarget && block.type === 'paragraph' && block.depth === 0 && !block.parentBlockId)
    if (hostIndex < 0) fail()
    const host = blocks[hostIndex], suffix = '\n\n' + raw
    const hostContent = applyContentEdits(host.content, edits.filter(edit => edit.blockIndex === hostIndex)) + suffix
    const verification = new markdownEngine.core.State(hostContent, markdownEngine, {})
    for (const rule of markdownEngine.core.ruler.__rules__) {
      if (rule.name === 'inline') break
      if (rule.enabled && rule.name !== 'strip_references') rule.fn(verification)
    }
    const found = new Set(verification.tokens.filter(token => token.type === 'footnote_reference_open').map(token => token.meta?.label))
    if (copies.some(definition => !found.has(sideNames.get(definition.label)))) fail()
    edits.push({ blockIndex: hostIndex, start: host.content.length, end: host.content.length, replacement: suffix })
  }
  copied(targetLabels, targetNames, true)
  copied(sourceLabels, sourceNames, false)
  return edits
}

/** Rewrite content before moving IDs into their new tree positions. Metadata,
 * literal code/math/HTML and ordinary incoming document links stay untouched. */
export function rewriteDocumentBlockTransferLinks(blocks: DocumentBlockDraft[], context: BlockTransferLinkContext): DocumentBlockDraft[] {
  const edits = [...referenceBoundaryEdits(blocks, context), ...normalLinkEdits(blocks, context), ...namedFootnoteEdits(blocks, context)]
  return blocks.map((block, blockIndex) => {
    const contentEdits = edits.filter(edit => edit.blockIndex === blockIndex)
    return contentEdits.length ? { ...block, content: applyContentEdits(block.content, contentEdits) } : block
  })

}
