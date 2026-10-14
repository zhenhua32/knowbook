import { parseFragment, type DefaultTreeAdapterTypes as Html } from 'parse5'

export const INLINE_TEXT_COLORS = Object.freeze(['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'] as const)
export type InlineTextColor = typeof INLINE_TEXT_COLORS[number]
export type InlineTextPresentation = { underline?: boolean; textColor?: InlineTextColor; backgroundColor?: InlineTextColor }
export const INLINE_TEXT_COLOR_ATTRIBUTE = 'data-knowbook-text-color'
export const INLINE_BACKGROUND_COLOR_ATTRIBUTE = 'data-knowbook-background-color'
/** A canonical neutral shell does not change marks or inherited colors. */
export const INLINE_TEXT_SHELL_ATTRIBUTE = 'data-knowbook-inline'

export type InlineTextPaletteEntry = {
  readonly light: { readonly text: string; readonly background: string }
  readonly dark: { readonly text: string; readonly background: string }
}
function entry(lightText: string, lightBackground: string, darkText: string, darkBackground: string): InlineTextPaletteEntry {
  return Object.freeze({ light: Object.freeze({ text: lightText, background: lightBackground }),
    dark: Object.freeze({ text: darkText, background: darkBackground }) })
}

/** Fixed theme values keep arbitrary CSS out of persisted documents. */
export const INLINE_TEXT_PALETTE: Readonly<Record<InlineTextColor, InlineTextPaletteEntry>> = Object.freeze({
  gray: entry('#5c6370', '#ebeef2', '#b9bec9', '#363b45'),
  brown: entry('#795548', '#f0e4df', '#d7aa92', '#49372f'),
  orange: entry('#a84a05', '#fff0df', '#ffb56e', '#523a25'),
  yellow: entry('#856500', '#fff5c4', '#e4c868', '#4b4425'),
  green: entry('#207347', '#e2f1e8', '#85cda2', '#264334'),
  blue: entry('#215da8', '#e3edfb', '#8ebcff', '#253c59'),
  purple: entry('#7041a1', '#eee5f8', '#c4a0ec', '#40314f'),
  pink: entry('#a33575', '#fae5f0', '#f4a5d1', '#4f2d43'),
  red: entry('#b43132', '#fbe5e5', '#ff9b9b', '#512e32'),
})

/** Undefined means the inherited/default color; null denotes invalid input. */
export function normalizeInlineTextColor(value: unknown): InlineTextColor | undefined | null {
  if (value === undefined) return undefined
  return typeof value === 'string' && (INLINE_TEXT_COLORS as readonly string[]).includes(value) ? value as InlineTextColor : null
}

export function normalizeInlineTextPresentation(value: unknown): InlineTextPresentation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  const underline = input.underline, textColor = normalizeInlineTextColor(input.textColor), backgroundColor = normalizeInlineTextColor(input.backgroundColor)
  if (underline !== undefined && typeof underline !== 'boolean' || textColor === null || backgroundColor === null) return null
  return { ...(underline ? { underline: true } : {}), ...(textColor === undefined ? {} : { textColor }),
    ...(backgroundColor === undefined ? {} : { backgroundColor }) }
}

export type InlineTextPresentationAttribute = { name: string; value: string; namespace?: string | null; prefix?: string | null }

/** Both safe HTML and rich-text conversion can read this attribute boundary.
 * Unknown attributes, styles and conflicting duplicates must remain source.
 */
export function parseInlineTextPresentationAttributes(tagName: string, attributes: readonly InlineTextPresentationAttribute[]): InlineTextPresentation | null {
  if (tagName !== 'u' && tagName !== 'span') return null
  const result: InlineTextPresentation = tagName === 'u' ? { underline: true } : {}
  const seen = new Set<string>()
  let neutralShell = false
  for (const attribute of attributes) {
    if (attribute.namespace || attribute.prefix || seen.has(attribute.name)) return null
    seen.add(attribute.name)
    if (attribute.name === INLINE_TEXT_SHELL_ATTRIBUTE) {
      if (tagName !== 'span' || attribute.value !== 'true') return null
      neutralShell = true
      continue
    }
    if (attribute.name !== INLINE_TEXT_COLOR_ATTRIBUTE && attribute.name !== INLINE_BACKGROUND_COLOR_ATTRIBUTE) return null
    const color = normalizeInlineTextColor(attribute.value)
    if (color === null || color === undefined) return null
    if (attribute.name === INLINE_TEXT_COLOR_ATTRIBUTE) result.textColor = color
    else result.backgroundColor = color
  }
  return tagName === 'span' && !neutralShell && !result.textColor && !result.backgroundColor ? null : result
}

/** Tags wrap escaped text or already validated canonical inline HTML. Markdown
 * marks inside HTML cannot be assumed to parse as formatting on reload.
 */
export function inlineTextPresentationTags(value: InlineTextPresentation): { open: string; close: string } {
  const presentation = normalizeInlineTextPresentation(value)
  if (!presentation) throw new Error('Invalid inline text presentation.')
  if (!presentation.underline && !presentation.textColor && !presentation.backgroundColor) return { open: '', close: '' }
  const tag = presentation.underline ? 'u' : 'span'
  const color = presentation.textColor ? ` ${INLINE_TEXT_COLOR_ATTRIBUTE}="${presentation.textColor}"` : ''
  const background = presentation.backgroundColor ? ` ${INLINE_BACKGROUND_COLOR_ATTRIBUTE}="${presentation.backgroundColor}"` : ''
  return { open: `<${tag}${color}${background}>`, close: `</${tag}>` }
}

function safeText(value: unknown): value is string { return typeof value === 'string' && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) }
function escapeText(value: string) { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#13;').replace(/\n/g, '&#10;') }

/** Plain-text convenience API. It never accepts untrusted markup as content. */
export function serializeInlineTextPresentation(text: string, value: InlineTextPresentation): string {
  if (!safeText(text)) throw new Error('Invalid inline text content.')
  const { open, close } = inlineTextPresentationTags(value)
  return `${open}${escapeText(text)}${close}`
}

/** Parse one closed, literal-text wrapper. Recursive inline parsers should use
 * parseInlineTextPresentationAttributes so nested marks keep their structure.
 */
export function parseInlineTextPresentation(source: string): { text: string; presentation: InlineTextPresentation } | null {
  if (!safeText(source)) return null
  let duplicateAttribute = false
  const nodes = parseFragment(source, { sourceCodeLocationInfo: true,
    onParseError: error => { if (error.code === 'duplicate-attribute') duplicateAttribute = true },
  }).childNodes
  if (duplicateAttribute) return null
  if (nodes.length !== 1 || !('tagName' in nodes[0])) return null
  const node = nodes[0] as Html.Element
  if (node.namespaceURI !== 'http://www.w3.org/1999/xhtml' || !node.sourceCodeLocation?.endTag) return null
  const presentation = parseInlineTextPresentationAttributes(node.tagName, node.attrs)
  if (!presentation || node.childNodes.some(child => child.nodeName !== '#text')) return null
  const text = node.childNodes.map(child => 'value' in child ? child.value : '').join('')
  return safeText(text) ? { text, presentation } : null
}

export type InlineTextPresentationStyle = { color?: string; backgroundColor?: string; textDecorationLine?: 'underline' }

/** Returns fresh, finite styles for rendering; no DOM, theme globals or engine. */
export function inlineTextPresentationStyle(value: InlineTextPresentation, theme: 'light' | 'dark' = 'light'): InlineTextPresentationStyle {
  const presentation = normalizeInlineTextPresentation(value)
  if (!presentation || theme !== 'light' && theme !== 'dark') throw new Error('Invalid inline text presentation.')
  return { ...(presentation.underline ? { textDecorationLine: 'underline' as const } : {}),
    ...(presentation.textColor ? { color: INLINE_TEXT_PALETTE[presentation.textColor][theme].text } : {}),
    ...(presentation.backgroundColor ? { backgroundColor: INLINE_TEXT_PALETTE[presentation.backgroundColor][theme].background } : {}) }
}
