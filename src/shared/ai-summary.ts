const DEFAULT_MAX_SUMMARY_SOURCE_CHARACTERS = 12_000

export function buildDocumentSummarySource(
  blockContents: string[],
  maxCharacters = DEFAULT_MAX_SUMMARY_SOURCE_CHARACTERS
): string {
  const content = blockContents
    .map((blockContent) => blockContent.trim())
    .filter(Boolean)
    .join('\n')

  if (content.length <= maxCharacters) {
    return content
  }

  const omissionMarker = '\n\n[Middle content omitted for length]\n\n'
  const availableCharacters = Math.max(0, maxCharacters - omissionMarker.length)
  const headCharacters = Math.ceil(availableCharacters * 0.6)
  const tailCharacters = availableCharacters - headCharacters

  return `${content.slice(0, headCharacters)}${omissionMarker}${content.slice(-tailCharacters)}`
}
