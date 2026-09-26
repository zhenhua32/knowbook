import type { GlobalSearchResult } from '@shared/contracts'

/** An absolute workspace Markdown link can be pasted into any document. */
export function searchResultDocumentLink(result: GlobalSearchResult): string {
  const path = result.documentPath.split('/').map((part) => encodeURIComponent(part).replace(/[()]/g, (char) => char === '(' ? '%28' : '%29')).join('/')
  const title = result.documentTitle.replace(/[\\`*_\[\]<>]/g, '\\$&').replace(/[\r\n]+/g, ' ')
  return `[${title}](/${path}.md)`
}
