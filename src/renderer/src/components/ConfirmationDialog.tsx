import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { getActiveUiText } from '../i18n'
import { getErrorMessage } from '../utils/errorMessage'
import { trapFocusWithinDialog } from '../utils/dialogFocus'
import { isImeKeyboardEvent } from '../utils/imeKeyboard'

export type ConfirmationOptions = {
  title: string
  description: string
  confirmLabel?: string
  tone?: 'danger' | 'warning'
  note?: string
  children?: ReactNode
  onConfirm: () => void | Promise<void>
}

export function ConfirmationDialog({ title, description, confirmLabel = title, tone = 'danger', note, children,
  onConfirm, onCancel, onComplete = onCancel, returnFocus, canReturnFocus,
}: ConfirmationOptions & { onCancel: () => void; onComplete?: () => void; returnFocus?: HTMLElement | null; canReturnFocus?: () => boolean }) {
  const dialog = useRef<HTMLDialogElement>(null), cancel = useRef<HTMLButtonElement>(null)
  const heading = useRef<HTMLHeadingElement>(null), body = useRef<HTMLDivElement>(null)
  const failure = useRef<HTMLParagraphElement>(null)
  const lock = useRef(false), mounted = useRef(false), composing = useRef(false)
  const dismiss = useRef(onCancel)
  const restoreAllowed = useRef(canReturnFocus)
  dismiss.current = onCancel
  restoreAllowed.current = canReturnFocus
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [scrollable, setScrollable] = useState({ heading: false, body: false })
  const titleId = useId(), descriptionId = useId(), noteId = useId()
  const zh = getActiveUiText().language === 'zh-CN'

  const measureScrollability = useCallback(() => {
    if (!dialog.current?.open || !dialog.current.isConnected) return
    const hasOverflow = (element: HTMLElement | null) => !!element && element.clientHeight > 0 && element.scrollHeight > element.clientHeight
    const next = { heading: hasOverflow(heading.current), body: hasOverflow(body.current) }
    setScrollable(previous => previous.heading === next.heading && previous.body === next.body ? previous : next)
  }, [])

  // Content can grow without changing the scrollport's observed size.
  useLayoutEffect(measureScrollability)

  useLayoutEffect(() => {
    const port = body.current, message = failure.current
    if (!error || !mounted.current || !dialog.current?.open || !port || !message) return
    // Reveal a new failure inside the details scrollport without moving focus
    // or scrolling the fixed heading and actions.
    port.scrollTop += message.getBoundingClientRect().top - port.getBoundingClientRect().top - port.clientTop
  }, [error])

  useEffect(() => {
    const view = dialog.current?.ownerDocument.defaultView
    if (!view) return
    let observing = true
    const measure = () => { if (observing) measureScrollability() }
    const observer = view.ResizeObserver ? new view.ResizeObserver(measure) : null
    if (heading.current) observer?.observe(heading.current)
    if (body.current) observer?.observe(body.current)
    view.addEventListener('resize', measure)
    return () => {
      observing = false
      observer?.disconnect()
      view.removeEventListener('resize', measure)
    }
  }, [measureScrollability])

  useEffect(() => {
    mounted.current = true
    const previous = returnFocus === undefined ? document.activeElement as HTMLElement | null : returnFocus
    const previousTree = previous?.closest<HTMLElement>('[role="tree"]') ?? null
    const element = dialog.current!
    element.showModal()
    measureScrollability()
    cancel.current?.focus()
    const keydown = (event: KeyboardEvent) => {
      if (!element.open) return
      if (isImeKeyboardEvent(event, composing.current)) {
        if (event.key === 'Escape') event.preventDefault()
        event.stopPropagation()
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        if (!lock.current) dismiss.current()
      }
      trapFocusWithinDialog(event, element)
      // Keep application/editor shortcuts from changing the action's target.
      event.stopPropagation()
    }
    window.addEventListener('keydown', keydown, true)
    return () => {
      mounted.current = false
      window.removeEventListener('keydown', keydown, true)
      const active = document.activeElement
      const shouldRestore = active === document.body || active === previous || element.contains(active)
      element.close()
      const restore = () => {
        if (restoreAllowed.current && !restoreAllowed.current()) return
        const current = document.activeElement
        // An action may navigate or open another dialog before this one unmounts.
        if (!shouldRestore || (current !== document.body && current !== previous && !element.contains(current))) return
        if (previous?.isConnected) {
          if (!previous.matches(':disabled')) previous.focus({ preventScroll: true })
          return
        }
        // Deleting a tree item removes its opener; return to the same tree's new keyboard entry.
        if (!previousTree?.isConnected || previousTree.closest('[hidden], [inert], [aria-hidden="true"]')) return
        const next = previousTree.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]')
        if (next && !next.closest('[hidden], [inert], [aria-hidden="true"]')) next.focus({ preventScroll: true })
      }
      restore()
      // The opener can remain disabled until the awaiting action has settled.
      if (shouldRestore && previous?.matches(':disabled')) window.requestAnimationFrame?.(restore)
    }
  }, [returnFocus, measureScrollability])

  useEffect(() => { if (!busy) cancel.current?.focus() }, [busy])

  const execute = async () => {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError('')
    dialog.current?.focus()
    try { await onConfirm(); if (mounted.current) onComplete() }
    catch (cause) {
      if (mounted.current) setError(getErrorMessage(cause, zh ? '操作失败，请重试。' : 'Action failed. Please retry.'))
    } finally {
      lock.current = false
      if (mounted.current) { setBusy(false); cancel.current?.focus() }
    }
  }

  return createPortal(<dialog data-block-shortcuts ref={dialog} className={`app-confirm-dialog app-confirm-${tone}`} role="alertdialog" aria-modal="true"
    aria-labelledby={titleId} aria-describedby={`${descriptionId}${note ? ` ${noteId}` : ''}`} aria-busy={busy} tabIndex={-1}
    onCancel={(event) => { event.preventDefault(); if (!lock.current && !composing.current) onCancel() }}
    onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}>
    <header><span className="app-confirm-icon" aria-hidden="true">!</span><h2 ref={heading} id={titleId} tabIndex={scrollable.heading ? 0 : undefined}>{title}</h2></header>
    <div ref={body} className="app-confirm-body" tabIndex={scrollable.body ? 0 : undefined}
      role={scrollable.body ? 'region' : undefined} aria-label={scrollable.body ? (zh ? '确认详情' : 'Confirmation details') : undefined}>
      <p id={descriptionId}>{description}</p>
      {children && <fieldset disabled={busy}>{children}</fieldset>}
      {note && <p id={noteId} className="app-confirm-note">{note}</p>}
      {error && <p ref={failure} className="app-confirm-error" role="alert">{error}</p>}
    </div>
    <footer><span role="status">{busy ? (zh ? '正在处理，请稍候…' : 'Working, please wait…') : ''}</span>
      <div><button type="button" className="secondary-button" ref={cancel} disabled={busy} onClick={onCancel}>{zh ? '取消' : 'Cancel'}</button>
        <button type="button" className={tone === 'danger' ? 'danger-button' : 'primary-button'} disabled={busy} onClick={() => { void execute() }}>
          {error ? (zh ? '重试' : 'Retry') : confirmLabel}</button></div></footer>
  </dialog>, document.body)
}
