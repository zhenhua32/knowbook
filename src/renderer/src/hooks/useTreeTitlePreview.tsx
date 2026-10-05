import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ComponentType } from 'react'

export type TreeTitleEntries = ReadonlyMap<string, { node: { title: string } }>
export type TreeTitlePreviewApi = {
  enter: (id: string, row: HTMLLIElement) => void
  leave: () => void
  focus: (id: string, row: HTMLLIElement) => void
  blur: (id: string) => void
  dismiss: (id?: string | null) => void
  scrolled: () => void
}
export type TreeTitlePreviewProps = {
  entries: TreeTitleEntries; dragging: boolean; isZh: boolean; id: string
  register: (api: TreeTitlePreviewApi | null) => void
  onOwnerChange: (id: string | undefined) => void
}
type Intent = { method: 'enter' | 'focus'; id: string; row: HTMLLIElement; title: string }
let loading: Promise<ComponentType<TreeTitlePreviewProps>> | undefined

export function useTreeTitlePreview(entries: TreeTitleEntries, dragging: boolean, isZh: boolean) {
  const id = useId(), api = useRef<TreeTitlePreviewApi | null>(null), pending = useRef<Intent | null>(null)
  const latest = useRef({ entries, dragging }), mounted = useRef(true)
  const [Controller, setController] = useState<ComponentType<TreeTitlePreviewProps> | null>(null)
  const [ownerId, setOwnerId] = useState<string>()
  latest.current = { entries, dragging }
  const valid = (intent: Intent) => !latest.current.dragging && intent.row.isConnected
    && latest.current.entries.get(intent.id)?.node.title === intent.title
    && intent.row.querySelector('.tree-document-title')?.textContent === intent.title
  const register = useCallback((next: TreeTitlePreviewApi | null) => {
    api.current = next
    const intent = pending.current
    if (!next || !intent) return
    pending.current = null
    if (valid(intent) && (intent.method === 'enter' || intent.row.ownerDocument.activeElement === intent.row)) next[intent.method](intent.id, intent.row)
  }, [])
  const start = (method: Intent['method'], documentId: string, row: HTMLLIElement) => {
    if (api.current) { api.current[method](documentId, row); return }
    const text = row.querySelector<HTMLElement>('.tree-document-title'), title = entries.get(documentId)?.node.title
    if (dragging || title === undefined || !text || text.textContent !== title || text.scrollWidth <= text.clientWidth + 1) {
      const intent = pending.current
      if (method !== 'enter' || !intent || intent.method !== 'focus' || !valid(intent) || intent.row.ownerDocument.activeElement !== intent.row) pending.current = null
      return
    }
    pending.current = { method, id: documentId, row, title }
    // Loading the optional reader does not add work to startup or change focus.
    loading ??= import('./TreeTitlePreviewController').then(module => module.default).catch(error => { loading = undefined; throw error })
    void loading.then(component => { if (mounted.current) setController(() => component) }, () => { pending.current = null })
  }
  const clear = () => { pending.current = null }
  useLayoutEffect(() => { if (pending.current && !valid(pending.current)) clear() })
  useEffect(() => {
    mounted.current = true
    const focus = (event: FocusEvent) => { if (pending.current && event.target !== pending.current.row) clear() }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.isComposing && event.keyCode !== 229) clear() }
    window.addEventListener('resize', clear); window.addEventListener('blur', clear)
    window.addEventListener('pointerdown', clear, true); window.addEventListener('focusin', focus, true); window.addEventListener('keydown', key, true)
    return () => {
      mounted.current = false; clear(); window.removeEventListener('resize', clear); window.removeEventListener('blur', clear)
      window.removeEventListener('pointerdown', clear, true); window.removeEventListener('focusin', focus, true); window.removeEventListener('keydown', key, true)
    }
  }, [])
  return { id, ownerId,
    enter: (documentId: string, row: HTMLLIElement) => start('enter', documentId, row),
    focus: (documentId: string, row: HTMLLIElement) => start('focus', documentId, row),
    leave: () => { if (pending.current?.method !== 'focus') clear(); api.current?.leave() },
    blur: (documentId: string) => { if (pending.current?.id === documentId) clear(); api.current?.blur(documentId) },
    dismiss: (documentId?: string | null) => { clear(); api.current?.dismiss(documentId) },
    scrolled: () => { if (pending.current?.method !== 'focus') clear(); api.current?.scrolled() },
    content: Controller && <Controller entries={entries} dragging={dragging} isZh={isZh} id={id} register={register} onOwnerChange={setOwnerId} /> }
}
