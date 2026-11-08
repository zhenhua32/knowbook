/** Display/routing information only. It is not a session, source or write permit. */
export interface DocumentRenameAdmissionInput { documentId: string; expectedUpdatedAt: string; headingSlugs?: string[] }
export type DocumentRenameAdmissionResult =
  | { status: 'ready'; documentId: string; documentCreatedAt: string; updatedAt: string; requiresFencedTitle2: boolean; writePermit: false }
  | { status: 'missing' | 'stale' }

export const isNativeSectionHeading = (type: string) => /^heading-[1-6]$/.test(type)

export function hasExistingNativeHeadingTextChange(
  before: readonly { id?: string; type: string; content: string }[],
  after: readonly { id?: string; type: string; content: string }[]
): boolean {
  const original = new Map(before.filter(block => block.id && isNativeSectionHeading(block.type)).map(block => [block.id, block]))
  return after.some(block => {
    const previous = original.get(block.id)
    return previous?.type === block.type && previous.content !== block.content
  })
}
