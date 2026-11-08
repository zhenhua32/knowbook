import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { DocumentBlockDraft } from '@shared/contracts'
import type { UiText } from '../../i18n'
import { parseSyncedBlockPayload } from '@shared/syncedBlockValidation'
import { parseMarkdownDocumentBlocks } from '@shared/markdownDocument'
import { markdownTaskPatch } from '@shared/markdownTasks'
import { MarkdownBlockNodesContext, MarkdownDocumentProvider } from '../../components/MarkdownDocumentContext'
import { MarkdownNodes, MarkdownReferencesContext } from '../../components/MarkdownContent'
import { serializeBlocksToMarkdown } from '@shared/markdown'
import { collectDocumentMarkdownLinks } from '@shared/markdownLinkMaintenance'
import { isSameWorkspaceSearchOccurrence } from '@shared/workspace-search-occurrence'
import { areDocumentDraftBlocksEqual } from '../../utils/documentDraftComparison'
import { MarkdownNavigationContext } from '../../components/MarkdownNavigationContext'
import { DatabaseEmbedProvider, useDatabaseEmbedContext } from '../database/DatabaseEmbedContext'
import { BlockReadingRow } from '../../components/BlockReadingRow'
import { useInlineHostView, type InlineHostView } from './InlineSyncedContext'
import type { InlineOpening } from './inlineRuntime'
import { syncedSnapshotGuard } from './types'
import { focusExactCanonicalSearchOccurrence } from './inlineFocus'

const SyncedRichTextEditor = lazy(() => import('../../rich-text/SyncedRichTextEditor').then(module => ({ default: module.SyncedRichTextEditor })))
type Props = { block: DocumentBlockDraft; mode: 'reading' | 'edit'; isZh: boolean; ui?: UiText }

/** This is an instance view. Canonical blocks never enter the host draft or
 * its ordinary updateDocument path. Main.open owns the actual birth/binding. */
export default function InlineSyncedBlock({ block, mode, isZh }: Props) {
  const host = useInlineHostView(), root = useRef<HTMLDivElement>(null)
  const [opening, setOpening] = useState<InlineOpening | null>(null), [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const latest = useRef({ host, block }); latest.current = { host, block }
  const parsed = useMemo(() => { try { return parseSyncedBlockPayload(block.content) } catch { return null } }, [block.content])
  useLayoutEffect(() => {
    if (!host || !block.id || !parsed) return
    let alive = true, owned: InlineOpening | null = null
    const hostId = host.documentId, hostSession = host.hostSession, instanceId = block.id, content = block.content, parentBlockId = block.parentBlockId ?? null, depth = block.depth
    const isCurrent = () => {
      const current = latest.current, state = current.host?.getCurrent()
      return alive && current.host?.hostSession === hostSession && state?.hostSession === hostSession
        && state.host.documentId === hostId && current.block.id === instanceId && current.block.content === content && (current.block.parentBlockId ?? null) === parentBlockId && current.block.depth === depth
        && state.host.workingBefore.blocks.some(row => row.id === instanceId && row.type === 'synced-block' && row.content === content && row.parentBlockId === parentBlockId && row.depth === depth)
    }
    setError(''); setOpening(null)
    void host.runtime.bind({ hostDocumentId: hostId, hostSession, instanceId, groupId: parsed.groupId, parentBlockId, depth,
      mountEpoch: Object.freeze({}), root: () => root.current, isCurrent }).then(value => {
      if (!alive) { if (value) host.runtime.unbind(value); return }
      owned = value; setOpening(value)
      if (!value) setError(isZh ? '这一引用已失效，未展开其他同名正文。' : 'This exact reference is unavailable.')
    }).catch(reason => { if (alive) setError(String(reason)) })
    return () => { alive = false; if (owned) host.runtime.unbind(owned) }
  }, [host?.runtime, host?.documentId, host?.hostSession, block.id, block.content, block.parentBlockId, block.depth, parsed?.groupId, retry, isZh])
  return <div ref={root} data-editor-island="synced-group" data-synced-instance-id={block.id}
    className="synced-inline-instance" role="group" aria-label={isZh ? '共享正文引用' : 'Shared body reference'}>
    {opening && host ? <BoundInlineBody host={host} opening={opening} mode={mode} root={() => root.current}
      onReopen={() => { void host.runtime.flush().then(ready => { if (ready && latest.current.host?.hostSession === host.hostSession) setRetry(value => value + 1) }) }} />
      : <p role={error ? 'alert' : 'status'}>{error || (isZh ? '正在读取共享正文…' : 'Loading shared body…')}
        {error && <button type="button" className="secondary-button" onClick={() => setRetry(value => value + 1)}>{isZh ? '重试原引用' : 'Retry this reference'}</button>}</p>}
  </div>
}

function BoundInlineBody({ host, opening, mode, root, onReopen }: {
  host: InlineHostView; opening: InlineOpening; mode: Props['mode']; root: () => HTMLElement | null; onReopen: () => void
}) {
  const { binding } = opening, { runtime, isZh, ui } = host
  const outerDatabase = useDatabaseEmbedContext(), databaseRegistry = useMemo(() => new Map<string, unknown>(), [binding])
  const state = useSyncExternalStore(binding.subscribe, binding.getCurrent, binding.getCurrent)
  const markdown = useMemo(() => parseMarkdownDocumentBlocks(state.working), [state.working])
  const containerRef = useMemo(() => ({ get current() { return binding.scope.root() } }), [binding])
  const runtimeState = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot)
  const [folded, setFolded] = useState<Set<string>>(() => new Set()), [message, setMessage] = useState('')
  const sourceBlock = useRef<string | null>(null), activeFocus = useRef<object | null>(null)
  const visibleIndices = useMemo(() => {
    const hidden = new Set<string>(), result: number[] = []
    state.working.forEach((block, index) => {
      if (block.parentBlockId && (hidden.has(block.parentBlockId) || folded.has(block.parentBlockId))) hidden.add(block.id)
      else result.push(index)
    }); return result
  }, [state.working, folded])
  const reveal = (id: string) => {
    const byId = new Map(state.working.map(block => [block.id, block])), parents = new Set<string>()
    let parent = byId.get(id)?.parentBlockId
    while (parent && !parents.has(parent)) { parents.add(parent); parent = byId.get(parent)?.parentBlockId }
    setFolded(previous => new Set([...previous].filter(value => !parents.has(value))))
  }
  const request = runtime.navigationFor(host.documentId, opening.address.instanceId)
  useLayoutEffect(() => {
    if (!request?.committed || !request.shouldContinue() || !binding.isCurrent()) return
    const target = request.occurrence, original = opening.address
    if (target.workspaceScope !== original.workspaceScope || target.recoveryEpoch !== original.recoveryEpoch
      || target.hostCreatedAt !== original.hostCreatedAt || target.instanceCreatedAt !== original.instanceCreatedAt
      || target.parentBlockId !== original.parentBlockId || target.depth !== original.depth) { request.finish(false); return }
    const id = request.occurrence.canonicalBlockId
    const byId = new Map(state.working.map(block => [block.id, block]))
    let parent = byId.get(id)?.parentBlockId, hidden = false
    const seen = new Set<string>()
    while (parent && !seen.has(parent)) { seen.add(parent); hidden ||= folded.has(parent); parent = byId.get(parent)?.parentBlockId }
    if (hidden) { reveal(id); return }
    const focusToken = Object.freeze({}); activeFocus.current = focusToken
    void window.knowbook.resolveWorkspaceSearchOccurrence(request.occurrence).then(exact => {
      if (activeFocus.current !== focusToken || !request.shouldContinue() || !binding.isCurrent()) return
      const owner = root()
      request.finish(Boolean(owner && exact.status === 'ready' && isSameWorkspaceSearchOccurrence(exact.occurrence, request.occurrence)
        && focusExactCanonicalSearchOccurrence(owner, binding, exact.occurrence, request.shouldContinue)))
    }).catch(() => { if (activeFocus.current === focusToken) request.finish(false) })
    return () => { if (activeFocus.current === focusToken) activeFocus.current = null }
  }, [request, runtimeState.revision, binding, state.editSequence, folded, mode])
  const apply = (blocks: typeof state.working) => {
    if (runtime.isLocked() || !binding.isCurrent()) return false
    const current = binding.getCurrent()
    if (!areDocumentDraftBlocksEqual(current.working, state.working)) return false
    return binding.apply({ blocks, expectedEditSequence: current.editSequence, guards: syncedSnapshotGuard(current.snapshot),
      bookmark: binding.getBookmark(), transactionId: crypto.randomUUID() })
  }
  const navigate = async (url: string, blockId = sourceBlock.current) => {
    if (!blockId || runtime.isLocked() || !binding.isCurrent()) return
    const generation = binding.getCurrent().editSequence
    const still = () => binding.isCurrent() && !runtime.isLocked() && binding.getCurrent().editSequence === generation
    if (!await binding.flush({ shouldContinue: still }) || !still()) return
    // Use the complete actual current group parser and its captured binding.
    // The current host path and another same-URI occurrence confer no target.
    const fresh = await window.knowbook.resolveSyncedInlineInstance({ hostDocumentId: host.documentId,
      instanceId: opening.address.instanceId, groupId: opening.address.groupId })
    if (!still() || fresh.status !== 'ready' || fresh.instance.bindingVersion !== opening.address.bindingVersion
      || fresh.instance.creationId !== opening.address.creationId || fresh.instance.workspaceScope !== opening.address.workspaceScope
      || fresh.instance.recoveryEpoch !== opening.address.recoveryEpoch || fresh.instance.hostCreatedAt !== opening.address.hostCreatedAt
      || fresh.instance.instanceCreatedAt !== opening.address.instanceCreatedAt
      || fresh.snapshot.revision !== binding.getCurrent().snapshot.revision || fresh.snapshot.topologyRevision !== binding.getCurrent().snapshot.topologyRevision) return
    const snapshot = fresh.snapshot, wiki = url.startsWith('knowbook-wiki:'), destination = wiki ? url.slice(14) : url
    const links = collectDocumentMarkdownLinks(snapshot.blocks).filter(link => link.blockId === blockId && link.kind !== 'image'
      && (link.kind === 'wiki') === wiki && link.url === destination)
    if (links.length !== 1) { setMessage(isZh ? '这一链接的原始位置不唯一，已保留当前位置。' : 'The original link position is ambiguous.'); return }
    const link = links[0], row = snapshot.blocks[link.blockIndex]
    const bindings = snapshot.bindings.filter(item => item.blockId === blockId && item.from === link.start && item.to === link.end
      && item.raw === row.content.slice(link.start, link.end) && item.syntax === (wiki ? 'wiki' : 'markdown'))
    if (bindings.length !== 1) return
    const target = bindings[0].target
    if (target.kind === 'unresolved-url' || target.state !== 'live') { setMessage(isZh ? '原链接目标不可用。' : 'The original link target is unavailable.'); return }
    if (target.kind === 'document') host.onOpenDocument(target.id)
    else if (target.kind === 'heading') host.onOpenAnchor(target.documentId, target.slug)
    else if (target.documentId) host.onOpenBlock(target.documentId, target.id)
    else {
      const child = snapshot.blocks.find(block => block.id === target.id)
      if (!child) { setMessage(isZh ? '该正文不属于当前引用，未跳到其他实例。' : 'The target is outside this exact instance.'); return }
      await runtime.openSearch({ ...fresh.instance, canonicalBlockId: child.id, canonicalCreatedAt: child.createdAt }, still)
    }
  }
  const capture = (target: EventTarget | null) => {
    const element = target instanceof Element ? target : null, owner = root()
    const row = element?.closest<HTMLElement>('[data-block-id]')
    sourceBlock.current = row && owner?.contains(row) && row.closest('[data-synced-instance-id]') === owner ? row.dataset.blockId ?? null : null
  }
  const stale = !binding.isCurrent()
  const database = outerDatabase ? { ...outerDatabase, session: binding.scope.bindingEpoch, registry: databaseRegistry,
    commitContent: (blockId: string, expected: string, next: string) => {
      const current = binding.getCurrent(), row = current.working.find(block => block.id === blockId)
      return Boolean(row && row.type === 'database-view' && row.content === expected && apply(current.working.map(block => block.id === blockId ? { ...block, content: next } : block)))
    } } : null
  return <DatabaseEmbedProvider value={database}>
    <MarkdownReferencesContext.Provider value={markdown.environment.references}>
    <MarkdownDocumentProvider model={markdown} documentId={JSON.stringify(['synced', host.documentId, opening.address.instanceId, opening.address.groupId])}
      isZh={isZh} containerRef={containerRef} onRevealBlock={reveal} onToggleTask={(offset, checked) => {
        const target = markdown.taskTargets.get(offset), current = binding.getCurrent()
        const patch = target && markdownTaskPatch(current.working[target.index], target, checked)
        if (patch && target) { binding.checkpoint(); apply(current.working.map((block, index) => index === target.index ? { ...block, ...patch } : block)) }
      }}>
    <MarkdownBlockNodesContext.Provider value={undefined}>
    <MarkdownNavigationContext.Provider value={url => { void navigate(url) }}>
    <div onPointerDownCapture={event => capture(event.target)} onKeyDownCapture={event => capture(event.target)}
      onClickCapture={event => {
        const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null
        if (!link || !root()?.contains(link) || /^(?:https?:|mailto:)/i.test(link.getAttribute('href') ?? '')) return
        capture(event.target); event.preventDefault(); event.stopPropagation(); void navigate(link.getAttribute('href') ?? '')
      }}>
      <div className="rich-text-toolbar" aria-label={isZh ? '共享正文操作' : 'Shared body actions'}>
        <span>{isZh ? '共享正文' : 'Shared body'} · {stale ? (isZh ? '原引用已变化' : 'Original reference changed')
          : state.phase === 'saving' ? (isZh ? '正在保存' : 'Saving') : state.dirty ? (isZh ? '未保存' : 'Unsaved') : (isZh ? '已保存' : 'Saved')}</span>
        <button type="button" disabled={stale || runtimeState.locked || !state.canUndo} onClick={() => { void binding.undo() }}>{isZh ? '撤销' : 'Undo'}</button>
        <button type="button" disabled={stale || runtimeState.locked || !state.canRedo} onClick={() => { void binding.redo() }}>{isZh ? '重做' : 'Redo'}</button>
        <button type="button" disabled={stale || runtimeState.locked} onClick={event => runtime.openCanonicalSource(binding, event.currentTarget)}>{isZh ? '编辑源码' : 'Edit source'}</button>
        {mode === 'edit' && <button type="button" disabled={stale || runtimeState.locked || Boolean(state.composingInstanceIds.length)}
          onClick={event => { void runtime.commands.openDetach(binding, event.currentTarget) }}>{isZh ? '解除同步…' : 'Unsync…'}</button>}
        <button type="button" disabled={runtimeState.locked || stale} onClick={() => { void binding.flush().then(saved => { if (!saved) setMessage(isZh ? '草稿仍保留，请处理保存阻断。' : 'The retained draft could not be saved.') }) }}>{isZh ? '保存／重试' : 'Save / retry'}</button>
        {stale && <button type="button" disabled={runtimeState.locked || state.dirty || Boolean(state.pending) || Boolean(state.composingInstanceIds.length)} onClick={onReopen}>{isZh ? '重开这个真实引用' : 'Reopen this exact reference'}</button>}
        <button type="button" onClick={() => { void window.knowbook.writeClipboardText(serializeBlocksToMarkdown(state.working)) }}>{isZh ? '复制保留正文' : 'Copy retained body'}</button>
      </div>
      {state.error || state.failure || message ? <p role="alert">{message || state.error || (isZh ? '共享正文存在冲突，当前完整草稿已保留。' : 'The shared body has a conflict; the complete draft is retained.')}</p> : null}
      {mode === 'reading' ? visibleIndices.map(index => {
        const block = state.working[index]
        return <MarkdownBlockNodesContext.Provider key={block.id} value={markdown.blockNodes[index]}><BlockReadingRow block={block} index={index} indentPx={block.depth * 24} numberLabel={String(index + 1)}
          isHighlighted={false} hasChildren={state.working.some(row => row.parentBlockId === block.id)} collapsed={folded.has(block.id)}
          onToggleCollapse={id => { if (binding.getCurrent().composingInstanceIds.length || runtime.isLocked()) return; setFolded(previous => { const next = new Set(previous); next.has(id) ? next.delete(id) : next.add(id); return next }) }}
          onNavigateReference={content => navigate('knowbook-wiki:' + content.slice(2, -2), block.id)} ui={ui} isZh={isZh}
          onToggleTask={checked => { binding.checkpoint(); apply(state.working.map(row => row.id === block.id ? { ...row, checked } : row)) }} /></MarkdownBlockNodesContext.Provider>
      }) : <Suspense fallback={<p role="status">{isZh ? '正在加载共享正文编辑器…' : 'Loading shared body editor…'}</p>}>
        <SyncedRichTextEditor binding={binding} isZh={isZh} references={markdown.environment.references} visibleIndices={visibleIndices}
          collapsedBlockIds={folded} onToggleCollapse={id => { if (binding.getCurrent().composingInstanceIds.length || runtime.isLocked()) return; setFolded(previous => { const next = new Set(previous); next.has(id) ? next.delete(id) : next.add(id); return next }) }}
          onEditSource={() => runtime.openCanonicalSource(binding, document.activeElement instanceof HTMLElement ? document.activeElement : null)} onRevealBlock={reveal} />
      </Suspense>}
      {!state.working.length && mode === 'edit' && <button type="button" disabled={stale || runtimeState.locked}
        onClick={() => apply([{ id: crypto.randomUUID(), parentBlockId: null, depth: 0, type: 'paragraph', content: '', checked: false }])}>{isZh ? '添加共享正文' : 'Add shared body'}</button>}
      {markdown.footnotes.length ? <MarkdownNodes nodes={markdown.footnotes} /> : null}
    </div>
  </MarkdownNavigationContext.Provider></MarkdownBlockNodesContext.Provider>
  </MarkdownDocumentProvider></MarkdownReferencesContext.Provider></DatabaseEmbedProvider>
}
