import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { JSDOM } from 'jsdom'
import { markdownEngine } from '../../src/shared/markdownEngine'
import { parseMarkdownBlocks, serializeBlocksToMarkdown } from '../../src/shared/markdown'

export interface MarkdownSpecExample { example: number; section: string; markdown: string; html: string }
export type MarkdownSpecName = 'commonmark-0.31.2' | 'gfm-0.29'
export const markdownSpecNames: MarkdownSpecName[] = ['commonmark-0.31.2', 'gfm-0.29']
export function loadMarkdownSpec(name: MarkdownSpecName): MarkdownSpecExample[] {
  return JSON.parse(readFileSync(new URL(`../fixtures/markdown-spec/${name}.json`, import.meta.url), 'utf8'))
}

const blockParents = new Set(['#document-fragment', 'UL', 'OL', 'BLOCKQUOTE', 'TABLE', 'THEAD', 'TBODY', 'TR'])
/** Compare rendered meaning, retaining tags, list paragraph wrappers, attributes,
 * code whitespace and comments. Only HTML formatting whitespace, boolean/void
 * attribute spelling, and the equivalent table alignment spellings normalize. */
export function canonicalMarkdownHtml(html: string): string {
  const fragment = JSDOM.fragment(html)
  function visit(node: Node, pre = false): unknown {
    if (node.nodeType === 3) {
      const text = node.textContent ?? ''
      if (pre) return text
      const parent = node.parentNode?.nodeName ?? ''
      if (!text.trim() && text.includes('\n') && (blockParents.has(parent) || parent === 'LI'
        && (!node.previousSibling || !node.nextSibling || node.previousSibling.nodeName === 'P' || node.nextSibling.nodeName === 'P'))) return null
      return text.replace(/[\t\n\r ]+/g, ' ')
    }
    if (node.nodeType === 8) return ['comment', node.textContent]
    const attributes = Array.from((node as Element).attributes ?? []).map(({ name, value }) => {
      if (['TH', 'TD'].includes(node.nodeName) && name === 'style' && /^text-align:(left|center|right);?$/.test(value)) {
        return ['align', value.replace(/^text-align:|;$/g, '')]
      }
      return [name, ['disabled', 'checked'].includes(name) ? '' : value]
    }).sort(([a], [b]) => a.localeCompare(b))
    return [node.nodeName, attributes, Array.from(node.childNodes).map((child) => visit(child, pre || node.nodeName === 'PRE')).filter((child) => child !== null)]
  }
  return JSON.stringify(visit(fragment))
}

export interface MarkdownPolicyDifference { reason: 'html-as-text' | 'automatic-links' | 'wiki-links' | 'unsupported-protocol'; html: string }
export type MarkdownPolicyDifferences = Record<MarkdownSpecName, Record<string, MarkdownPolicyDifference>>
export function loadMarkdownPolicies(): MarkdownPolicyDifferences {
  return JSON.parse(readFileSync(new URL('../fixtures/markdown-spec/policy-differences.json', import.meta.url), 'utf8'))
}

export function auditMarkdownExample(example: MarkdownSpecExample, policy?: MarkdownPolicyDifference) {
  const html = markdownEngine.render(example.markdown)
  const actual = canonicalMarkdownHtml(html)
  const grammarMatches = actual === canonicalMarkdownHtml(example.html)
  const policyMatches = policy && !grammarMatches && actual === canonicalMarkdownHtml(policy.html)
  let source = example.markdown
  let previousExport: string | undefined
  const failures: string[] = []
  if (!grammarMatches && !policyMatches) failures.push('grammar')
  if (grammarMatches && policy) failures.push('obsolete-policy')
  for (let cycle = 1; cycle <= 3; cycle++) {
    const blocks = parseMarkdownBlocks(source)
    const exported = serializeBlocksToMarkdown(blocks)
    if (canonicalMarkdownHtml(markdownEngine.render(exported)) !== actual) failures.push(`plain-${cycle}`)
    const restored = parseMarkdownBlocks(serializeBlocksToMarkdown(blocks, { includeBlockMetadata: true }))
    if (canonicalMarkdownHtml(markdownEngine.render(serializeBlocksToMarkdown(restored))) !== actual) failures.push(`backup-${cycle}`)
    if (!isDeepStrictEqual(restored, blocks)) failures.push(`backup-blocks-${cycle}`)
    if (previousExport !== undefined && previousExport !== exported) failures.push(`stable-${cycle}`)
    previousExport = exported
    source = exported
  }
  return {
    example: example.example, section: example.section,
    grammar: grammarMatches ? 'match' : policyMatches ? 'policy' : 'failure',
    ...(policy ? { policy: policy.reason } : {}),
    plain: !failures.some((f) => f.startsWith('plain-')),
    backup: !failures.some((f) => f.startsWith('backup-')),
    stable: !failures.some((f) => f.startsWith('stable-')),
    failures
  }
}
