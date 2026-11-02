import type { DocumentBlockDraft } from '@shared/contracts'
import type { SyncedHostSourceCurrent } from './SyncedHostSourceDialog'
import { areDocumentDraftBlocksEqual } from '../../utils/documentDraftComparison'
import { getCanonicalInlineRuntime } from './inlineRuntime'

/** Loaded only by a host save that actually contains references or an original
 * uncertain request. The ordinary app entry does not import the controller. */
export async function persistCanonicalHostDraft(current: SyncedHostSourceCurrent,
  draft: { title: string; summary: string; blocks: DocumentBlockDraft[] }) {
  if (draft.blocks.some(block => typeof block.id !== 'string' || !block.id)) throw new Error('The complete host draft needs its stable block identities')
  const saved = await getCanonicalInlineRuntime().saveHostWorking({ ...current, host: { ...current.host,
    workingBefore: { title: draft.title, summary: draft.summary,
      blocks: draft.blocks.map(block => ({ ...block, id: block.id!, parentBlockId: block.parentBlockId ?? null })) } } })
  const row = saved.result.hosts[0], submitted = saved.submitted.host.workingBefore
  if (!row || row.documentId !== current.host.documentId || row.logicalBefore.title !== submitted.title
    || row.logicalBefore.summary !== submitted.summary || !areDocumentDraftBlocksEqual(row.logicalBefore.blocks, submitted.blocks)) {
    throw new Error('The original complete host acknowledgement did not match the submitted working body')
  }
  return { document: row.after, submitted }
}
