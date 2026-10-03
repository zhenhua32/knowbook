import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { getActiveUiText } from '../i18n'
import { getErrorMessage } from '../utils/errorMessage'
import { trapFocusWithinDialog } from '../utils/dialogFocus'
import { isImeKeyboardEvent } from '../utils/imeKeyboard'
import { registerModalFamily } from '../hooks/useDialogCloseFocus'

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

type ConfirmationAction = {
  dialog: HTMLDialogElement
  parentModal: HTMLElement | null
  canFocus: boolean
  canReveal: boolean
  failed: boolean
  watchingScroll: boolean
  scrollTop: [number, number]
  cleanup: () => void
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
  const action = useRef<ConfirmationAction | null>(null), originModal = useRef<HTMLElement | null>(null)
  const modalFamily = useRef<ReturnType<typeof registerModalFamily> | null>(null)
  dismiss.current = onCancel
  restoreAllowed.current = canReturnFocus
  returnDelegate.current = onReturnFocus
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [scrollable, setScrollable] = useState({ heading: false, body: false })
  const titleId = useId(), descriptionId = useId(), noteId = useId()
  const zh = getActiveUiText().language === 'zh-CN'

  const cancelActionAttention = useCallback((request: ConfirmationAction) => {
    request.canFocus = false
    request.canReveal = false
    request.cleanup()
    request.cleanup = () => {}
  }, [])
  const isCurrentAction = (request: ConfirmationAction) => mounted.current && action.current === request
    && dialog.current === request.dialog && request.dialog.isConnected
  const hasForeignActionModal = (request: ConfirmationAction) => [...request.dialog.ownerDocument.querySelectorAll<HTMLElement>(
    'dialog[open], [aria-modal="true"][role="dialog"], [aria-modal="true"][role="alertdialog"]')]
    .some(modal => modal !== request.dialog && modal !== request.parentModal && !modal.contains(request.dialog) && isVisible(modal))

  useLayoutEffect(() => () => {
    // DOM removal can blur the still-connected child before passive cleanup.
    modalFamily.current?.closing()
    if (action.current) cancelActionAttention(action.current)
    action.current = null
  }, [cancelActionAttention])

  const measureScrollability = useCallback(() => {
    if (!dialog.current?.open || !dialog.current.isConnected) return
    const hasOverflow = (element: HTMLElement | null) => !!element && element.clientHeight > 0 && element.scrollHeight > element.clientHeight
    const next = { heading: hasOverflow(heading.current), body: hasOverflow(body.current) }
    setScrollable(previous => previous.heading === next.heading && previous.body === next.body ? previous : next)
  }, [])

  // Content can grow without changing the scrollport's observed size.
  useLayoutEffect(measureScrollability)

  useLayoutEffect(() => {
    const request = action.current
    if (!request || !isCurrentAction(request)) return
    if (busy && !request.watchingScroll) {
      // Clearing the previous error can clamp an old scroll position. Read
      // the committed layout before treating later scrolling as new reading.
      body.current?.getBoundingClientRect()
      heading.current?.getBoundingClientRect()
      request.scrollTop = [body.current?.scrollTop ?? 0, heading.current?.scrollTop ?? 0]
      request.watchingScroll = true
    }
    if (busy || !request.failed || (!request.canFocus && !request.canReveal)) return
    const owner = request.dialog.ownerDocument, target = cancel.current
    if (!request.dialog.open || !owner.hasFocus() || !isVisible(request.dialog) || hasForeignActionModal(request)) {
      cancelActionAttention(request)
      return
    }
    if (request.canFocus && target?.matches(':disabled, [aria-disabled="true"]')) return
    const canFocus = request.canFocus && target && request.dialog.contains(target) && isVisible(target)
      && (owner.activeElement === request.dialog || owner.activeElement === owner.body)
    const canReveal = request.canReveal, port = body.current, message = failure.current
    // Consume both qualifications before our own scrolling and focus events.
    cancelActionAttention(request)
    if (canReveal && error && port && message) {
      port.scrollTop += message.getBoundingClientRect().top - port.getBoundingClientRect().top - port.clientTop
    }
    if (canFocus) target.focus()
  })

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
    originModal.current = owner.activeElement?.closest<HTMLElement>('dialog[open], [aria-modal="true"][role="dialog"], [aria-modal="true"][role="alertdialog"]') ?? parentModal
    const hasForeignModal = () => [...owner.querySelectorAll<HTMLElement>('dialog[open], [aria-modal="true"][role="dialog"], [aria-modal="true"][role="alertdialog"]')]
      .some(modal => modal !== element && modal !== parentModal && !modal.contains(element) && isVisible(modal))
    const family = registerModalFamily(element, originModal.current)
    modalFamily.current = family
    element.showModal()
    measureScrollability()
    cancel.current?.focus()
    family.opened()
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
      if (action.current) cancelActionAttention(action.current)
      view.removeEventListener('keydown', keydown, true)
      owner.removeEventListener('focusin', focusMoved, true)
      view.removeEventListener('blur', abandonAttention)
      const active = owner.activeElement
      const shouldRestore = attentive.current && (active === owner.body || active === previous || element.contains(active))
      family.closing()
      try {
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
      } finally {
        family.release()
        if (modalFamily.current === family) modalFamily.current = null
      }
    }
  }, [returnFocus, measureScrollability, cancelActionAttention])

  const execute = async () => {
    if (lock.current) return
    lock.current = true
    if (action.current) cancelActionAttention(action.current)
    const element = dialog.current!, owner = element.ownerDocument, view = owner.defaultView!, origin = owner.activeElement
    const request: ConfirmationAction = {
      dialog: element, parentModal: originModal.current, canFocus: false, canReveal: false,
      failed: false, watchingScroll: false, scrollTop: [0, 0], cleanup: () => {}
    }
    action.current = request
    const eligible = mounted.current && element.open && owner.hasFocus() && isVisible(element)
      && origin instanceof view.HTMLElement && element.contains(origin) && isVisible(origin)
      && !origin.matches(':disabled, [aria-disabled="true"]') && !hasForeignActionModal(request)
    if (eligible) element.focus()
    request.canFocus = request.canReveal = eligible && owner.activeElement === element
    if (request.canFocus) {
      const abandon = () => cancelActionAttention(request)
      const focusMoved = (event: FocusEvent) => { if (event.target !== element) abandon() }
      const blurred = (event: FocusEvent) => { if (event.target === element) abandon() }
      const scrolled = () => {
        if (request.watchingScroll && ((body.current?.scrollTop ?? 0) !== request.scrollTop[0]
          || (heading.current?.scrollTop ?? 0) !== request.scrollTop[1])) request.canReveal = false
      }
      owner.addEventListener('pointerdown', abandon, true)
      view.addEventListener('keydown', abandon, true)
      owner.addEventListener('compositionstart', abandon, true)
      owner.addEventListener('focusin', focusMoved, true)
      element.addEventListener('focusout', blurred)
      view.addEventListener('blur', abandon)
      element.addEventListener('wheel', abandon, true)
      body.current?.addEventListener('scroll', scrolled)
      heading.current?.addEventListener('scroll', scrolled)
      const port = body.current, title = heading.current
      request.cleanup = () => {
        owner.removeEventListener('pointerdown', abandon, true)
        view.removeEventListener('keydown', abandon, true)
        owner.removeEventListener('compositionstart', abandon, true)
        owner.removeEventListener('focusin', focusMoved, true)
        element.removeEventListener('focusout', blurred)
        view.removeEventListener('blur', abandon)
        element.removeEventListener('wheel', abandon, true)
        port?.removeEventListener('scroll', scrolled)
        title?.removeEventListener('scroll', scrolled)
      }
    }
    setBusy(true)
    setError('')
    try {
      await onConfirm()
      if (isCurrentAction(request)) { cancelActionAttention(request); onComplete() }
    }
    catch (cause) {
      if (isCurrentAction(request)) {
        request.failed = true
        setError(getErrorMessage(cause, zh ? '操作失败，请重试。' : 'Action failed. Please retry.'))
      }
    } finally {
      if (isCurrentAction(request)) { lock.current = false; setBusy(false) }
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
