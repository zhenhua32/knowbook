import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ForestRichTextEditor, type ForestRichTextBinding, type ForestRichTextViewProps } from './ForestRichTextEditor'
import type { SyncedGroupBinding, SyncedScopeBookmark } from '../features/synced-blocks/types'
import { syncedSnapshotGuard } from '../features/synced-blocks/types'
import { validateSyncedCanonicalEdit } from '@shared/syncedBlockValidation'
import { areDocumentDraftBlocksEqual } from '../utils/documentDraftComparison'
import { captureAsyncHistoryFocusPermission, restoreEditorHistoryBookmark, type EditorHistoryBookmark } from '../utils/editorHistoryFocus'

type Props = Omit<ForestRichTextViewProps, 'blocks' | 'visibleIndices'> & {
  binding: SyncedGroupBinding
  visibleIndices?: number[]
}
type RestoreRequest = {
  binding: SyncedGroupBinding
  sequence: number
  bookmark: SyncedScopeBookmark
  permission: ReturnType<typeof captureAsyncHistoryFocusPermission>
}

/** The workspace shell supplies the canonical Markdown/navigation/DB providers.
 * This adapter owns only this occurrence's view and selection, never a writer/history. */
export function SyncedRichTextEditor({ binding, visibleIndices, ...props }: Props) {
  const state = useSyncExternalStore(binding.subscribe, binding.getCurrent, binding.getCurrent)
  const root = useRef<HTMLDivElement>(null), latest = useRef({ binding, state })
  const mounted = useRef(false)
  latest.current = { binding, state }
  const transaction = useRef(crypto.randomUUID())
  const [failure, setFailure] = useState('')
  const [restore, setRestore] = useState<RestoreRequest | null>(null)
  const pendingRestore = useRef<RestoreRequest | null>(null)
  const bookmark = (selection: EditorHistoryBookmark): SyncedScopeBookmark => ({
    owner: binding.scope.owner, instanceId: binding.scope.instanceId, mountEpoch: binding.scope.mountEpoch,
    bindingEpoch: binding.scope.bindingEpoch, selection
  })
  useLayoutEffect(() => { mounted.current = true; return () => {
    mounted.current = false; pendingRestore.current?.permission.dispose(); pendingRestore.current = null
  } }, [binding])
  useLayoutEffect(() => {
    if (!restore) return
    const current = restore.binding.getCurrent()
    if (latest.current.binding === restore.binding && restore.binding.isCurrent()
      && current.editSequence === restore.sequence && state.editSequence === restore.sequence
      && restore.bookmark.mountEpoch === binding.scope.mountEpoch && restore.bookmark.bindingEpoch === binding.scope.bindingEpoch
      && restore.bookmark.instanceId === binding.scope.instanceId && restore.permission.canRestore() && root.current) {
      restoreEditorHistoryBookmark(restore.bookmark.selection, state.working, root.current)
    }
    restore.permission.dispose()
    if (pendingRestore.current === restore) pendingRestore.current = null
    setRestore(null)
  }, [restore, state, binding])
  const history = async (direction: 'undo' | 'redo') => {
    if (!binding.isCurrent()) return
    pendingRestore.current?.permission.dispose()
    const permission = captureAsyncHistoryFocusPermission()
    try {
      const accepted = await binding[direction]()
      if (!accepted || !mounted.current || latest.current.binding !== binding || !binding.isCurrent() || !permission.canRestore()) return
      const selected = binding.getBookmark()
      if (!selected) return
      const request = { binding, sequence: binding.getCurrent().editSequence, bookmark: selected, permission }
      pendingRestore.current = request
      setRestore(request)
    } catch (error) { if (mounted.current && latest.current.binding === binding && binding.isCurrent()) setFailure(error instanceof Error ? error.message : String(error)) }
    finally { if (pendingRestore.current?.permission !== permission) permission.dispose() }
  }
  const forestBinding: ForestRichTextBinding = {
    scope: binding.scope,
    apply: (blocks, selection) => {
      if (!binding.isCurrent() || latest.current.binding !== binding) return false
      const current = binding.getCurrent()
      // A subscription can arrive before React mirrors it into this PM view.
      // Never replace that newer shared working forest with this view's old base.
      if (!areDocumentDraftBlocksEqual(current.working, state.working)) return false
      if (areDocumentDraftBlocksEqual(blocks, current.working)) return true
      let candidate
      try { candidate = validateSyncedCanonicalEdit(blocks) }
      catch { return false }
      return binding.apply({ expectedEditSequence: current.editSequence, guards: syncedSnapshotGuard(current.snapshot),
        blocks: candidate, bookmark: bookmark(selection), transactionId: transaction.current })
    },
    // A new transaction ID separates frames without sealing history on rejected input.
    checkpoint: () => { transaction.current = crypto.randomUUID() },
    undo: () => { void history('undo') }, redo: () => { void history('redo') },
    setComposing: binding.setComposing,
    rememberSelection: selection => binding.setBookmark(bookmark(selection))
  }
  return <>
    <ForestRichTextEditor {...props} rootRef={root} blocks={state.working}
      visibleIndices={visibleIndices ?? state.working.map((_block, index) => index)} binding={forestBinding} />
    {failure && <p role="alert">{failure}</p>}
  </>
}
