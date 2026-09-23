import type { MarkdownImportIssue } from './contracts'
import { serializeMarkdownWithBlockRanges, type MarkdownRenderableBlock } from './markdown'
import { markdownEngine, type MarkdownEnvironment } from './markdownEngine'
import { capturedMarkdownCompatibility } from './markdownSourceLinks'

/** Report only syntax actually visited by the shared parser, with block identity. */
export function collectDocumentMarkdownCompatibility(blocks: MarkdownRenderableBlock[]): MarkdownImportIssue[] {
  const { markdown, ranges } = serializeMarkdownWithBlockRanges(blocks)
  const env: MarkdownEnvironment = { captureSourceLinks: true, captureCompatibility: true }
  markdownEngine.parse(markdown, env)
  const lines = markdown.split('\n'), offsets = [0]
  for (const line of lines) offsets.push(offsets.at(-1)! + line.length + 1)
  let line = 0, blockIndex = 0
  const seen = new Set<string>()
  const issues: MarkdownImportIssue[] = []
  for (const finding of capturedMarkdownCompatibility(env).sort((a, b) => a.start - b.start)) {
    if (!Number.isFinite(finding.start) || !Number.isFinite(finding.end)) continue
    while (line + 1 < offsets.length && offsets[line + 1] <= finding.start) line++
    while (blockIndex < ranges.length && ranges[blockIndex].endLine <= line) blockIndex++
    const block = blocks[blockIndex], range = ranges[blockIndex]
    if (!range || !block?.id || line < range.startLine || ['code', 'math', 'frontmatter'].includes(block.type)) continue
    const contentLines = block.content.split('\n'), localLine = line - range.startLine
    const contentLine = contentLines[localLine]
    if (contentLine === undefined || !lines[line].endsWith(contentLine)) continue
    const offset = contentLines.slice(0, localLine).reduce((sum, text) => sum + text.length + 1, 0)
      + finding.start - offsets[line] - (lines[line].length - contentLine.length)
    if (offset < 0) continue
    const key = `${block.id}:${offset}:${finding.reason}`
    if (seen.has(key)) continue
    seen.add(key)
    issues.push({ reason: finding.reason, blockId: block.id, offset, source: markdown.slice(finding.start, Math.min(finding.end, finding.start + 240)) })
  }
  return issues
}
