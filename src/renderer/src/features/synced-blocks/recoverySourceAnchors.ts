import type { MarkdownSourceDraft } from '../../utils/markdownSourceDraft'

/** Keep the original editor's identities and positions, without serializing
 * duplicate opening blocks or inferring identity from repeated text. */
export function captureRecoveryAnchors(draft: MarkdownSourceDraft) {
  return draft.anchors.map(({ block, from, to }) => ({ id: block.id, from, to }))
}

export function restoreRecoveryAnchors(opening: MarkdownSourceDraft, source: string, value: unknown): MarkdownSourceDraft {
  if (!Array.isArray(value)) throw new Error('The draft has no retained source identities.')
  const originals = new Map(opening.anchors.map(anchor => [anchor.block.id, anchor])), seen = new Set<string>()
  const anchors = value.map(item => {
    const original = originals.get(item?.id)
    if (!original || typeof item.id !== 'string' || seen.has(item.id) || !Number.isSafeInteger(item.from)
      || !Number.isSafeInteger(item.to) || item.from < 0 || item.to < item.from || item.to > source.length) {
      throw new Error('The retained source identities no longer match the opening.')
    }
    seen.add(item.id)
    return { ...original, from: item.from as number, to: item.to as number }
  })
  return { ...opening, source, anchors }
}
