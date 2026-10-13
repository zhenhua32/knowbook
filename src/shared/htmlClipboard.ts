import { parseFragment, serializeOuter, type DefaultTreeAdapterTypes as Html } from 'parse5'
import { normalizeMarkdownExternalUrl } from './markdownEngine'
import { parseImageFigure, serializeImageFigure } from './markdownMedia'

type Node = Html.ChildNode
const discarded = new Set(['script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed', 'svg', 'math', 'head', 'title', 'meta', 'link'])
const blocks = new Set(['p', 'div', 'section', 'article', 'main', 'header', 'footer', 'aside', 'figure', 'figcaption', 'address', 'dl', 'dt', 'dd'])

function element(node: Node): node is Html.Element { return 'tagName' in node }
function attr(node: Html.Element, name: string): string { return node.attrs.find(attribute => attribute.name === name)?.value ?? '' }
function allowed(node: Html.Element): boolean { return node.namespaceURI === 'http://www.w3.org/1999/xhtml' && !discarded.has(node.tagName) }
function escapeText(value: string): string {
  return value.replace(/[\t\r\n ]+/g, ' ').replace(/([\\`*_[\]<>#!|~+\-=])/g, '\\$1')
    .replace(/^(\s*\d{1,9})([.)])(?=\s)/, '$1\\$2')
}
function boundary(value: string): string { return value.trim() ? '\n\n' + value.trim() + '\n\n' : '' }
function clean(value: string): string { return value.replace(/\n{3,}/g, '\n\n').trim() }
function mark(value: string, marker: string): string {
  const body = value.trim()
  return body ? value.slice(0, value.indexOf(body)) + marker + body + marker + value.slice(value.indexOf(body) + body.length) : value
}
function safeUrl(value: string, image = false): string | null {
  const url = value.trim()
  // Match the safe HTML grammar; clipboard HTML never gets an implicit origin.
  if (!url || /[\u0000-\u001f\u007f\\]/.test(url) || url.startsWith('//')) return null
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(url)?.[1]
  if (!scheme) return url
  const normalized = normalizeMarkdownExternalUrl(url)
  return normalized && (!image || !normalized.startsWith('mailto:')) ? normalized : null
}
function destination(url: string): string { return '<' + url.replace(/</g, '%3C').replace(/>/g, '%3E') + '>' }
function htmlAttribute(value: string): string { return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }
function literalText(nodes: Node[]): string {
  return nodes.map(node => 'value' in node ? node.value : element(node) && allowed(node)
    ? node.tagName === 'br' ? '\n' : literalText(node.childNodes) : '').join('')
}
function codeSpan(value: string): string {
  const text = value.replace(/\r\n?|\n/g, ' ')
  if (!text) return ''
  const width = Math.max(0, ...Array.from(text.matchAll(/`+/g), match => match[0].length)) + 1
  const fence = '`'.repeat(width), padding = /^`|`$/.test(text) || /^ .* $/.test(text) && text.trim() ? ' ' : ''
  return fence + padding + text + padding + fence
}
function image(node: Html.Element): string {
  const label = escapeText(attr(node, 'alt')), url = safeUrl(attr(node, 'src'), true)
  if (!url) return label
  const dimensions = ['width', 'height'].flatMap(name => /^(?:[1-9]\d{0,3}|10000)$/.test(attr(node, name)) ? [`${name}="${attr(node, name)}"`] : [])
  const title = attr(node, 'title')
  if (dimensions.length) return `<img src="${htmlAttribute(url)}" alt="${htmlAttribute(attr(node, 'alt'))}" ${dimensions.join(' ')}${title ? ` title="${htmlAttribute(title)}"` : ''}>`
  return `![${label}](${destination(url)}${title ? ' "' + title.replace(/[\r\n]/g, ' ').replace(/[\\"]/g, '\\$&') + '"' : ''})`
}
function inline(nodes: Node[]): string {
  return nodes.map(node => {
    if ('value' in node) return escapeText(node.value)
    if (!element(node) || !allowed(node)) return ''
    const tag = node.tagName
    if (tag === 'br') return '  \n'
    if (tag === 'img') return image(node)
    if (tag === 'code' || tag === 'kbd') return codeSpan(literalText(node.childNodes))
    if (tag === 'input') return ''
    let content = inline(node.childNodes)
    if (tag === 'a') {
      const url = safeUrl(attr(node, 'href'))
      return url ? '[' + (content.trim() || escapeText(url)) + '](' + destination(url) + ')' : content
    }
    if (tag === 'strong' || tag === 'b') content = mark(content, '**')
    else if (tag === 'em' || tag === 'i') content = mark(content, '*')
    else if (['s', 'strike', 'del'].includes(tag)) content = mark(content, '~~')
    else if (tag === 'mark') content = mark(content, '==')
    else if (tag === 'span') {
      // Word often copies semantic text formatting as span styles. Interpret
      // only these values; never serialize arbitrary CSS or HTML attributes.
      const styles = attr(node, 'style').toLowerCase()
      if (/(?:^|;)\s*font-weight\s*:\s*(?:bold|[7-9]00)\s*(?:;|$)/.test(styles)) content = mark(content, '**')
      if (/(?:^|;)\s*font-style\s*:\s*italic\s*(?:;|$)/.test(styles)) content = mark(content, '*')
      if (/(?:^|;)\s*text-decoration(?:-line)?\s*:[^;]*\bline-through\b/.test(styles)) content = mark(content, '~~')
    }
    return content
  }).join('')
}
function checkbox(node: Html.Element): boolean | null {
  if (node.tagName === 'input' && attr(node, 'type').toLowerCase() === 'checkbox') return node.attrs.some(attribute => attribute.name === 'checked')
  if (attr(node, 'role') === 'checkbox' && ['true', 'false'].includes(attr(node, 'aria-checked'))) return attr(node, 'aria-checked') === 'true'
  for (const child of node.childNodes) {
    if (!element(child) || ['ul', 'ol'].includes(child.tagName) || !allowed(child)) continue
    const value = checkbox(child)
    if (value !== null) return value
  }
  return null
}
function list(node: Html.Element): string {
  const ordered = node.tagName === 'ol', parsedStart = Number(attr(node, 'start'))
  let number = Number.isSafeInteger(parsedStart) && parsedStart >= 1 && parsedStart <= 999999999 ? parsedStart : 1
  return node.childNodes.map(child => {
    if (!element(child) || child.tagName !== 'li') return clean(flow([child]))
    const explicit = Number(attr(child, 'value'))
    if (ordered && Number.isSafeInteger(explicit) && explicit >= 1 && explicit <= 999999999) number = explicit
    const prefix = ordered ? `${number++}. ` : '- '
    const checked = checkbox(child), task = checked === null ? '' : `[${checked ? 'x' : ' '}] `
    const content = clean(flow(child.childNodes)), lines = content.split('\n')
    return prefix + task + (lines[0] ?? '') + lines.slice(1).map(line => '\n' + (line ? ' '.repeat(prefix.length) + line : '')).join('')
  }).filter(Boolean).join('\n')
}
function table(node: Html.Element): string {
  const rows: Html.Element[] = [], captions: string[] = []
  const collect = (nodes: Node[]) => {
    for (const child of nodes) {
      if (!element(child) || !allowed(child)) continue
      if (child.tagName === 'table') continue
      if (child.tagName === 'tr') rows.push(child)
      else if (child.tagName === 'caption') captions.push(clean(flow(child.childNodes)))
      else collect(child.childNodes)
    }
  }
  collect(node.childNodes)
  const grid: string[][] = [], occupied: number[] = []
  for (const row of rows) {
    const cells: string[] = [], nextOccupied = occupied.map(value => Math.max(0, value - 1))
    let column = 0
    for (const cell of row.childNodes.filter((child): child is Html.Element => element(child) && ['td', 'th'].includes(child.tagName))) {
      while (occupied[column] > 0) cells[column++] = ''
      const span = (name: string) => { const value = Number(attr(cell, name)); return Number.isInteger(value) && value > 0 ? Math.min(value, 1000) : 1 }
      const colspan = span('colspan'), rowspan = span('rowspan')
      cells[column] = clean(flow(cell.childNodes)).replace(/\n/g, '<br>')
      for (let offset = 0; offset < colspan; offset++) {
        if (offset) cells[column + offset] = ''
        nextOccupied[column + offset] = Math.max(nextOccupied[column + offset] ?? 0, rowspan - 1)
      }
      column += colspan
    }
    while (column < occupied.length) { cells[column] = cells[column] ?? ''; column++ }
    grid.push(cells)
    occupied.splice(0, occupied.length, ...nextOccupied)
  }
  if (!grid.length) return clean(flow(node.childNodes))
  const width = Math.max(...grid.map(row => row.length))
  if (!width) return captions.filter(Boolean).join('\n\n')
  const row = (values: string[]) => '| ' + Array.from({ length: width }, (_, index) => (values[index] ?? '').replace(/(?<!\\)\|/g, '\\|')).join(' | ') + ' |'
  return [...captions.filter(Boolean), row(grid[0]), row(Array(width).fill('---')), ...grid.slice(1).map(row)].join('\n')
}
function flow(nodes: Node[]): string {
  let result = '', run: Node[] = []
  const flush = () => { result += inline(run); run = [] }
  for (const node of nodes) {
    if (!element(node)) { run.push(node); continue }
    if (!allowed(node)) continue
    const tag = node.tagName
    const heading = /^h([1-6])$/.exec(tag)
    if (!blocks.has(tag) && !heading && !['ul', 'ol', 'li', 'blockquote', 'pre', 'table', 'hr'].includes(tag)) { run.push(node); continue }
    flush()
    const media = tag === 'figure' ? parseImageFigure(serializeOuter(node)) : null
    if (media) result += boundary(serializeImageFigure(media))
    else if (heading) result += boundary('#'.repeat(Number(heading[1])) + ' ' + inline(node.childNodes).trim())
    else if (tag === 'ul' || tag === 'ol') result += boundary(list(node))
    else if (tag === 'blockquote') result += boundary(clean(flow(node.childNodes)).split('\n').map(line => '> ' + line).join('\n'))
    else if (tag === 'pre') {
      const content = literalText(node.childNodes).replace(/\r\n?/g, '\n').replace(/\n$/, '')
      const width = Math.max(2, ...Array.from(content.matchAll(/`+/g), match => match[0].length)) + 1
      const fence = '`'.repeat(width), code = node.childNodes.find((child): child is Html.Element => element(child) && child.tagName === 'code')
      const language = code ? /(?:^|\s)language-([\w+-]+)(?:\s|$)/.exec(attr(code, 'class'))?.[1] ?? '' : ''
      result += boundary(fence + language + '\n' + content + '\n' + fence)
    } else if (tag === 'table') result += boundary(table(node))
    else if (tag === 'hr') result += boundary('---')
    else result += boundary(flow(node.childNodes))
  }
  flush()
  return result
}

/** Convert external clipboard HTML without executing it or accepting block IDs.
 * All emitted markup is generated from semantic tags and a small URL/attribute
 * allowlist. Unknown containers retain their text; executable content is dropped.
 */
export function htmlClipboardToMarkdown(html: string): string {
  return html.trim() ? clean(flow(parseFragment(html).childNodes)) : ''
}
