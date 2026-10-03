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
  canReturnFocus?: () => boolean
  /** Delegate the closing handoff instead of restoring the original opener. */
  onReturnFocus?: () => void
}

function isVisible(element: HTMLElement): boolean {
  if (!element.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]') || !element.getClientRects().length) return false
  const style = element.ownerDocument.defaultView?.getComputedStyle(element)
  return style?.display !== 'none' && style?.visibility !== 'hidden' && style?.visibility !== 'collapse'
}

export function ConfirmationDialog({ title, description, confirmLabel = title, tone = 'danger', note, children,
  onConfirm, onCancel, onComplete = onCancel, returnFocus, canReturnFocus, onReturnFocus,
}: ConfirmationOptions & { onCancel: () => void; onComplete?: () => void; returnFocus?: HTMLElement | null }) {
  const dialog = useRef<HTMLDialogElement>(null), cancel = useRef<HTMLButtonElement>(null)
  const heading = useRef<HTMLHeadingElement>(null), body = useRef<HTMLDivElement>(null)
  const failure = useRef<HTMLParagraphElement>(null)
  const lock = useRef(false), mounted = useRef(false), composing = useRef(false)
  const dismiss = useRef(onCancel)
  const restoreAllowed = useRef(canReturnFocus)
  const returnDelegate = useRef(onReturnFocus), cancelReturn = useRef<(() => void) | null>(null)
  const attentive = useRef(true)
  dismiss.current = onCancel
  restoreAllowed.current = canReturnFocus
  returnDelegate.current = onReturnFocus
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
    cancelReturn.current?.()
    mounted.current = true
    const element = dialog.current!, owner = element.ownerDocument, view = owner.defaultView!
    const previous = returnFocus === undefined ? owner.activeElement as HTMLElement | null : returnFocus
    const previousTree = previous?.closest<HTMLElement>('[role="tree"]') ?? null
    const parentModal = previous?.closest<HTMLElement>('dialog[open], [aria-modal="true"][role="dialog"], [aria-modal="true"][role="alertdialog"]') ?? null
    const hasForeignModal = () => [...owner.querySelectorAll<HTMLElement>('dialog[open], [aria-modal="true"][role="dialog"], [aria-modal="true"][role="alertdialog"]')]
      .some(modal => modal !== element && modal !== parentModal && !modal.contains(element) && isVisible(modal))
    element.showModal()
    measureScrollability()
    cancel.current?.focus()
    attentive.current = true
    const abandonAttention = () => { attentive.current = false }
    const focusMoved = (event: FocusEvent) => { if (!element.contains(event.target as Node)) abandonAttention() }
    owner.addEventListener('focusin', focusMoved, true)
    view.addEventListener('blur', abandonAttention)
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
    view.addEventListener('keydown', keydown, true)
    return () => {
      mounted.current = false
      view.removeEventListener('keydown', keydown, true)
      owner.removeEventListener('focusin', focusMoved, true)
      view.removeEventListener('blur', abandonAttention)
      const active = owner.activeElement
      const shouldRestore = attentive.current && (active === owner.body || active === previous || element.contains(active))
      element.close()
      const allowed = () => {
        const current = owner.activeElement
        return shouldRestore && owner.hasFocus() && !hasForeignModal()
          && (!restoreAllowed.current || restoreAllowed.current())
          && (current === owner.body || current === previous || element.contains(current))
      }
      if (returnDelegate.current) {
        if (allowed()) returnDelegate.current()
        return
      }
      if (!allowed()) return
      const target = () => previous?.isConnected ? previous
        : previousTree?.isConnected ? previousTree.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]') ?? null : null
      let pending = true, frame: number | null = null
      const abandon = () => {
        pending = false
        if (frame !== null) view.cancelAnimationFrame(frame)
        frame = null
        owner.removeEventListener('pointerdown', abandon, true)
        owner.removeEventListener('keydown', abandon, true)
        owner.removeEventListener('compositionstart', abandon, true)
        owner.removeEventListener('focusin', abandon, true)
        view.removeEventListener('blur', abandon)
        if (cancelReturn.current === abandon) cancelReturn.current = null
      }
      const restore = () => {
        if (!pending) return
        const next = target(), permitted = allowed() && !!next && isVisible(next) && !next.matches(':disabled, [aria-disabled="true"]')
        abandon()
        if (permitted) next!.focus({ preventScroll: true })
      }
      const next = target()
      if (next?.matches(':disabled') && isVisible(next)) {
        // Wait once for the awaiting owner to re-enable its opener; a new
        // interaction permanently revokes even a copied callback.
        cancelReturn.current = abandon
        owner.addEventListener('pointerdown', abandon, true)
        owner.addEventListener('keydown', abandon, true)
        owner.addEventListener('compositionstart', abandon, true)
        owner.addEventListener('focusin', abandon, true)
        view.addEventListener('blur', abandon)
        frame = view.requestAnimationFrame(restore)
      } else restore()
    }
  }, [returnFocus, measureScrollability])

  const focusCancel = () => {
    const element = dialog.current, owner = element?.ownerDocument, active = owner?.activeElement
    if (mounted.current && attentive.current && element?.open && owner?.hasFocus()
      && (active === owner.body || element.contains(active ?? null))) cancel.current?.focus()
  }
  useEffect(() => { if (!busy) focusCancel() }, [busy])

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
      if (mounted.current) { setBusy(false); focusCancel() }
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
