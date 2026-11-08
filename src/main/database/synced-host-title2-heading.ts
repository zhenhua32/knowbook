import type { SyncedLinkBinding } from '../../shared/synced-blocks'
import { hostEqual } from './synced-host-journal'
import type { SyncedProjectedHeading2 } from './synced-heading-projection2'

export function title2BindingKey(binding: SyncedLinkBinding) {
  return { blockId: binding.blockId, from: binding.from, to: binding.to, raw: binding.raw, syntax: binding.syntax }
}

export function title2HeadingLocations(headings: readonly SyncedProjectedHeading2[]) {
  return headings.map(({ key, slug, location }) => ({ key, slug, location }))
}

/** A pure title change can move an anchor's slug even if no body block was
 * edited. Require the same parser occurrence and physical birth on both
 * sides. Caption or slug matches alone never identify the destination. */
export function continueTitle2Heading(
  slug: string,
  before: readonly SyncedProjectedHeading2[],
  after: readonly SyncedProjectedHeading2[]
) {
  const sources = before.filter(heading => heading.slug === slug)
  if (sources.length !== 1) return null
  const source = sources[0]
  const continuations = after.filter(heading => heading.key === source.key && hostEqual(heading.location, source.location))
  if (continuations.length !== 1) return null
  const destination = continuations[0]
  if (after.filter(heading => heading.slug === destination.slug).length !== 1) return null
  return { source, destination }
}
