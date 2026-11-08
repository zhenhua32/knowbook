import type { SyncedBindingKey, SyncedLinkTarget } from '../../shared/synced-blocks'
import { escapeMarkdownDestination, parseLocalMarkdownUrl, relativeMarkdownPath, resolveMarkdownDocumentPath } from '../../shared/markdownLinks'
import { parseWikiReference, wikiDocumentPaths } from '../../shared/markdownWiki'
import type { Navigation3Destination } from './restore-knowledge-navigation3-rewrite-cells'

export type DetachUnresolvedTarget = Extract<SyncedLinkTarget, { kind: 'unresolved-url' }>

function lexical(syntax: SyncedBindingKey['syntax'], url: string, sourcePath: string) {
  if (syntax === 'markdown') {
    const target = resolveMarkdownDocumentPath(sourcePath, url)
    return target && { paths: [target.path], fragment: target.fragment || null, titleFallback: false }
  }
  const wiki = parseWikiReference(url)
  if (/[#|\[\]\r\n]/.test(wiki.path) || /[#|\[\]\r\n]/.test(wiki.fragment)) return null
  const paths = wikiDocumentPaths(wiki.path, sourcePath)
  return paths.length ? { paths, fragment: wiki.fragment || null,
    titleFallback: Boolean(wiki.path && !wiki.path.includes('/') && !/[:\\]/.test(wiki.path)) } : null
}

function sameDetachedUnresolvedDestination(syntax: SyncedBindingKey['syntax'], before: { path: string; url: string },
  after: { path: string; url: string }, stored: DetachUnresolvedTarget): boolean {
  const original = lexical(syntax, before.url, before.path), projected = lexical(syntax, after.url, after.path)
  return Boolean(original && projected && original.paths[0] === stored.path && original.fragment === stored.fragment
    && original.fragment === projected.fragment && original.titleFallback === projected.titleFallback
    && original.paths.length === projected.paths.length && original.paths.every((value, index) => value === projected.paths[index]))
}

/** Only the lexical address moves here. The caller separately checks both
 * the complete prospective binding and the actual ordinary navigation resolver. */
export function renderDetachedUnresolvedDestination(link: Navigation3Destination, originPath: string, hostPath: string, target: DetachUnresolvedTarget) {
  if (link.grammar.kind === 'autolink') return null
  const same = (url: string) => sameDetachedUnresolvedDestination(link.key.syntax, { path: originPath, url: link.url }, { path: hostPath, url }, target)
  if (same(link.url)) return { url: link.url, replacement: link.key.raw }

  if (link.key.syntax === 'wiki') {
    const wiki = parseWikiReference(link.url)
    if ((wiki.path && !/^\.\.?\//.test(wiki.path)) || /[#|\[\]\r\n]/.test(target.path)
      || (wiki.alias !== null && (!wiki.hasFragment || wiki.alias.includes('#')))) return null
    const separator = link.url.search(/[#|]/), cut = separator < 0 ? link.url.length : separator
    const rawPath = link.url.slice(0, cut), lead = rawPath.length - rawPath.trimStart().length
    const trailing = Math.max(lead, rawPath.trimEnd().length)
    const url = rawPath.slice(0, lead) + '/' + target.path + rawPath.slice(trailing) + link.url.slice(cut)
    // A rooted spelling keeps the full relative path candidate list without
    // enabling short-title matching in the receiving host.
    return same(url) ? { url, replacement: link.key.raw.includes('\\|') ? url.replace(/\|/g, '\\|') : url } : null
  }

  const local = parseLocalMarkdownUrl(link.url)
  if (!local) return null
  try {
    const url = relativeMarkdownPath(hostPath + '.md', target.path + '.md') + local.suffix
    return same(url) ? { url, replacement: escapeMarkdownDestination(url, link.grammar.syntax ?? undefined) } : null
  } catch (error) {
    if (error instanceof URIError) return null
    throw error
  }
}
