import type { Dispatch, SetStateAction } from 'react'
import type { DocumentBlockDraft, DocumentDetail, HomeData } from '@shared/contracts'
import { hasExistingNativeHeadingTextChange } from '@shared/document-rename-admission'
import { getMarkdownHeadingRewrites, getMarkdownHeadingTargets } from '@shared/markdownLinkMaintenance'
import type { SyncedHostSourceCurrent } from '../features/synced-blocks/SyncedHostSourceDialog'
import { toDraftBlock } from './draftBlockShape'
import { normalizeDraftBlocks } from './draftTreeNormalization'
import { areDocumentDraftBlocksEqual } from './documentDraftComparison'
import { applyIncrementalDocumentUpdate } from './homeDataDocumentUpdate'

type Ref<T> = { current: T }
type Context = {
  documentId: string; title: string; summary: string; normalizedBlocks: DocumentBlockDraft[]
  detail: DocumentDetail; baseTitle: string; renaming: boolean; saveFailed: string
  requiresSyncedWriter: boolean; syncedHost: () => SyncedHostSourceCurrent | null
  isCurrentSession: () => boolean; mountedRef: Ref<boolean>
  selectedDocumentRef: Ref<DocumentDetail | null>; draftTitleRef: Ref<string>; draftSummaryRef: Ref<string>
  draftBlocksRef: Ref<DocumentBlockDraft[]>; editHistoryRef: Ref<Array<{ move?: { versions: Record<string, string> } }>>
  onSelectedDocumentChange: (detail: DocumentDetail | null) => void
  setDraftTitle: (title: string) => void; setDraftSummary: (summary: string) => void
  setDraftBlocksState: (blocks: DocumentBlockDraft[]) => void
  onHomeDataChange: Dispatch<SetStateAction<HomeData>>
}

/** Loaded by an actual save after the hook reserves its original pending writer.
 * Any canonical opening still needs the submitted document's exact original CAS. */
export async function completeDocumentDraftWrite(context: Context): Promise<boolean> {
  const { documentId, title, summary, normalizedBlocks, detail, baseTitle, renaming, saveFailed,
    requiresSyncedWriter, syncedHost, isCurrentSession, mountedRef, selectedDocumentRef,
    draftTitleRef, draftSummaryRef, draftBlocksRef, editHistoryRef, onSelectedDocumentChange,
    setDraftTitle, setDraftSummary, setDraftBlocksState, onHomeDataChange } = context
  if (!isCurrentSession()) return false
  let updateResult: Awaited<ReturnType<typeof window.knowbook.updateDocument>> | null = null
  let submittedTitle = title, submittedSummary = summary, submittedBlocks = normalizedBlocks
  let refreshedDetail: DocumentDetail | null
  let useSyncedWriter = requiresSyncedWriter
  const headingSlugs = !useSyncedWriter && !renaming && hasExistingNativeHeadingTextChange(detail.blocks, normalizedBlocks)
    ? [...getMarkdownHeadingRewrites(getMarkdownHeadingTargets(detail.blocks, detail.title), getMarkdownHeadingTargets(normalizedBlocks, title)).keys()] : []
  if (!useSyncedWriter && (renaming || headingSlugs.length)) {
    const hint = await window.knowbook.getDocumentRenameAdmission({ documentId, expectedUpdatedAt: detail.updatedAt, ...(renaming ? {} : { headingSlugs }) })
    if (!isCurrentSession()) return false
    if (hint.status !== 'ready' || hint.documentId !== documentId || hint.updatedAt !== detail.updatedAt || hint.writePermit !== false) throw new Error(saveFailed)
    useSyncedWriter = hint.requiresFencedTitle2
  }
  if (useSyncedWriter) {
    const opening = syncedHost()
    if (!opening || opening.host.documentId !== documentId || opening.host.expectedPersistedUpdatedAt !== detail.updatedAt) throw new Error(saveFailed)
    const { persistCanonicalHostDraft } = await import('../features/synced-blocks/inlineHostPersistence')
    if (!isCurrentSession()) return false
    const saved = await persistCanonicalHostDraft(opening, { title, summary, blocks: normalizedBlocks })
    refreshedDetail = saved.document
    submittedTitle = saved.submitted.title; submittedSummary = saved.submitted.summary; submittedBlocks = saved.submitted.blocks
  } else {
    updateResult = await window.knowbook.updateDocument(documentId, {
      expectedUpdatedAt: detail.updatedAt, title, summary, blocks: normalizedBlocks
    })
    refreshedDetail = updateResult.document
  }
  if (renaming && (!refreshedDetail || refreshedDetail.id !== documentId)) throw new Error(saveFailed)
  if (isCurrentSession()) {
    selectedDocumentRef.current = refreshedDetail
    if (refreshedDetail) for (const snapshot of editHistoryRef.current) {
      if (snapshot.move && Object.hasOwn(snapshot.move.versions, documentId)) snapshot.move.versions[documentId] = refreshedDetail.updatedAt
    }
    onSelectedDocumentChange(refreshedDetail)
    if (refreshedDetail) {
      if (draftTitleRef.current === (renaming ? baseTitle : submittedTitle)) {
        draftTitleRef.current = refreshedDetail.title
        setDraftTitle(refreshedDetail.title)
      }
      if (draftSummaryRef.current === submittedSummary) {
        draftSummaryRef.current = refreshedDetail.summary
        setDraftSummary(refreshedDetail.summary)
      }
      if (areDocumentDraftBlocksEqual(normalizeDraftBlocks(draftBlocksRef.current), submittedBlocks)) {
        const refreshedBlocks = normalizeDraftBlocks(refreshedDetail.blocks.map(toDraftBlock))
        draftBlocksRef.current = refreshedBlocks
        setDraftBlocksState(refreshedBlocks)
      }
    }
  }
  if (mountedRef.current) {
    if (!updateResult || updateResult.requiresFullRefresh) {
      // An already committed document stays committed if workspace refresh fails.
      try {
        const home = await window.knowbook.getHomeData()
        if (mountedRef.current) onHomeDataChange(home)
      } catch (error) { console.warn('Failed to refresh workspace after saving the document.', error) }
    } else {
      const acknowledgedUpdate = updateResult
      onHomeDataChange(current => applyIncrementalDocumentUpdate(current, acknowledgedUpdate))
    }
  }
  return isCurrentSession()
}
