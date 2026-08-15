import type { DocumentBlockDraft } from '@shared/contracts'

function areTagsEqual(left: string[] | undefined, right: string[] | undefined): boolean {
  const leftTags = left ?? []
  const rightTags = right ?? []
  if (leftTags.length !== rightTags.length) {
    return false
  }
  if (leftTags.every((tag, index) => tag === rightTags[index])) {
    return true
  }

  const sortedLeft = [...leftTags].sort()
  const sortedRight = [...rightTags].sort()
  return sortedLeft.every((tag, index) => tag === sortedRight[index])
}

export function normalizeComparableDocumentTitle(title: string): string {
  return title.trim() || 'Untitled'
}

export function areDocumentDraftBlocksEqual(
  left: DocumentBlockDraft[],
  right: DocumentBlockDraft[]
): boolean {
  if (left === right) {
    return true
  }
  if (left.length !== right.length) {
    return false
  }

  for (let index = 0; index < left.length; index += 1) {
    const leftBlock = left[index]
    const rightBlock = right[index]
    if (
      leftBlock.id !== rightBlock.id
      || leftBlock.type !== rightBlock.type
      || leftBlock.content !== rightBlock.content
      || Boolean(leftBlock.checked) !== Boolean(rightBlock.checked)
      || leftBlock.depth !== rightBlock.depth
      || (leftBlock.parentBlockId ?? null) !== (rightBlock.parentBlockId ?? null)
      || (leftBlock.language ?? null) !== (rightBlock.language ?? null)
      || (leftBlock.highlight ?? null) !== (rightBlock.highlight ?? null)
      || !areTagsEqual(leftBlock.tags, rightBlock.tags)
    ) {
      return false
    }
  }

  return true
}
