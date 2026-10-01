export const DEFAULT_DOCUMENT_SUMMARY = 'New knowledge node ready for editing.'

/** A new document's placeholder is metadata, not a reading summary. */
export function documentSummaryText(summary: string): string {
  const text = summary.trim()
  return text === DEFAULT_DOCUMENT_SUMMARY ? '' : text
}
