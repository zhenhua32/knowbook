import { useMemo, useRef, useState } from 'react'
import { MarkdownSourceDialog } from '../../components/DocumentMarkdownSourceDialog'
import { areDocumentDraftBlocksEqual } from '../../utils/documentDraftComparison'
import { replaceMarkdownSourceChanges } from '../../utils/markdownSourceDraft'
import { canonicalSourceDraftToBlocks, createCanonicalSourceDraft } from './canonicalSource'
import type { SyncedGroupBinding } from './types'
import { syncedSnapshotGuard } from './types'

type Props = { binding: SyncedGroupBinding; isZh: boolean; opener: HTMLElement | null; onClose: () => void }

/** The instance shell supplies the real binding/opener. This dialog has no
 * second writer or history and never routes canonical content through a host. */
export function SyncedCanonicalSourceDialog(props: Props) {
  const latestBinding = useRef(props.binding)
  latestBinding.current = props.binding
  const openingKey = useMemo(() => crypto.randomUUID(), [props.binding])
  return <CanonicalSourceOpening key={openingKey} {...props} isOwnerCurrent={() => latestBinding.current === props.binding} />
}

function CanonicalSourceOpening({ binding, isZh, opener, onClose, isOwnerCurrent }: Props & { isOwnerCurrent: () => boolean }) {
  const [opening] = useState(() => {
    const state = binding.getCurrent()
    return { sessionKey: {}, editSequence: state.editSequence, guards: syncedSnapshotGuard(state.snapshot),
      working: structuredClone(state.working), draft: createCanonicalSourceDraft(state.working), bookmark: binding.getBookmark(), opener }
  })
  const isCurrent = () => isOwnerCurrent() && binding.isCurrent()
  return <MarkdownSourceDialog sessionKey={opening.sessionKey} isZh={isZh} onClose={onClose}
    createDraft={() => opening.draft} replaceChanges={(draft, changes) => replaceMarkdownSourceChanges(draft, [...changes])}
    isCurrent={isCurrent} getReturnFocus={() => opening.opener} onCompositionChange={binding.setComposing}
    text={{ title: isZh ? '编辑共享正文源码' : 'Edit shared body source',
      editorLabel: isZh ? '共享正文 Markdown 源码' : 'Shared body Markdown source',
      hint: isZh ? '只编辑这一组的共享正文；应用后进入该组独立历史。' : "Edit this group's shared body. Apply adds one step to its independent history.",
      conflict: isZh ? '共享正文或引用位置已变化。当前源码已保留，请复制后重新打开以合并。'
        : 'The shared body or reference positions changed. Your source is retained; copy it and reopen to merge.' }}
    onApply={draft => {
      if (!isCurrent()) return false
      const blocks = canonicalSourceDraftToBlocks(draft)
      // An untouched source is not permission to overwrite a newer body.
      if (areDocumentDraftBlocksEqual(blocks, opening.working)) return true
      const current = binding.getCurrent(), guards = syncedSnapshotGuard(current.snapshot)
      if (current.editSequence !== opening.editSequence || guards.expectedRevision !== opening.guards.expectedRevision
        || guards.expectedTopologyRevision !== opening.guards.expectedTopologyRevision) return false
      return binding.apply({ expectedEditSequence: opening.editSequence, guards: opening.guards, blocks,
        bookmark: opening.bookmark, transactionId: crypto.randomUUID() })
    }} />
}
