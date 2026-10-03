import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'

type DialogActionOperation = {
  dialog: HTMLDialogElement
  canFocus: boolean
  frame: number | null
  pending: { getTarget: () => HTMLElement | null; afterFocus?: () => void } | null
  cleanup: () => void
}

function isVisible(element: HTMLElement): boolean {
  if (!element.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]') || !element.getClientRects().length) return false
  const style = element.ownerDocument.defaultView?.getComputedStyle(element)
  return style?.display !== 'none' && style?.visibility !== 'hidden' && style?.visibility !== 'collapse'
}

function hasForeignModal(dialog: HTMLDialogElement): boolean {
  return [...dialog.ownerDocument.querySelectorAll<HTMLElement>('dialog[open], [aria-modal="true"][role="dialog"], [aria-modal="true"][role="alertdialog"]')]
    .some(element => element !== dialog && !element.contains(dialog) && isVisible(element))
}

/** Preserve a dialog's failure focus only while the accepted action still owns the user's attention. */
export function useDialogActionFocus(dialogRef: RefObject<HTMLDialogElement | null>) {
  const mounted = useRef(false)
  const current = useRef<DialogActionOperation | null>(null)
  const [, commit] = useState(0)

  const cancelFocus = useCallback((operation: DialogActionOperation) => {
    operation.canFocus = false
    operation.pending = null
    operation.cleanup()
    operation.cleanup = () => {}
    if (operation.frame !== null) operation.dialog.ownerDocument.defaultView?.cancelAnimationFrame(operation.frame)
    operation.frame = null
  }, [])

  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (current.current) cancelFocus(current.current)
      current.current = null
    }
  }, [cancelFocus])

  const isCurrent = useCallback((operation: DialogActionOperation | null) => !!operation && mounted.current
    && current.current === operation && dialogRef.current === operation.dialog && operation.dialog.isConnected, [dialogRef])

  useLayoutEffect(() => {
    const operation = current.current
    if (!operation?.pending || !operation.canFocus || operation.frame !== null) return
    const { dialog, pending } = operation, document = dialog.ownerDocument, view = document.defaultView
    const target = pending.getTarget()
    if (!isCurrent(operation) || !view || !dialog.open || !document.hasFocus() || !isVisible(dialog)
      || hasForeignModal(dialog) || (document.activeElement !== dialog && document.activeElement !== document.body)
      || !target || !dialog.contains(target) || !isVisible(target)) {
      cancelFocus(operation)
      return
    }
    // The action promise can settle before React has re-enabled the target.
    // A later commit, rather than a polling frame, authorizes restoration.
    if (target.matches(':disabled, [aria-disabled="true"]')) return
    operation.frame = view.requestAnimationFrame(() => {
      operation.frame = null
      if (!isCurrent(operation) || !operation.canFocus || operation.pending !== pending) return
      const active = document.activeElement, currentTarget = pending.getTarget()
      const canRestore = dialog.open && document.hasFocus() && isVisible(dialog) && !hasForeignModal(dialog)
        && (active === dialog || active === document.body) && currentTarget && dialog.contains(currentTarget) && isVisible(currentTarget)
        && !currentTarget.matches(':disabled, [aria-disabled="true"]')
      // Consume before focusing, so our own focus event cannot cancel a newer operation.
      cancelFocus(operation)
      if (canRestore) { currentTarget.focus(); pending.afterFocus?.() }
    })
  })

  const begin = useCallback(() => {
    if (current.current) cancelFocus(current.current)
    const dialog = dialogRef.current
    if (!mounted.current || !dialog) return null
    const document = dialog.ownerDocument, view = document.defaultView, origin = document.activeElement
    const operation: DialogActionOperation = {
      dialog, frame: null, pending: null, cleanup: () => {},
      canFocus: !!view && origin instanceof view.HTMLElement && dialog.open && document.hasFocus()
        && dialog.contains(origin) && isVisible(dialog) && isVisible(origin)
        && !origin.matches(':disabled, [aria-disabled="true"]') && !hasForeignModal(dialog)
    }
    current.current = operation
    // This is the existing submission handoff; listen only after it has completed.
    if (operation.canFocus) dialog.focus()
    if (document.activeElement !== dialog) operation.canFocus = false
    if (!operation.canFocus || !view) return operation
    const abandon = () => cancelFocus(operation)
    const focusMoved = (event: FocusEvent) => {
      if (event.target !== dialog && event.target !== document.body) abandon()
    }
    const blurred = (event: FocusEvent) => {
      // The dialog itself stays enabled while its fields are disabled.
      if (event.target === dialog) abandon()
    }
    document.addEventListener('pointerdown', abandon, true)
    document.addEventListener('keydown', abandon, true)
    document.addEventListener('compositionstart', abandon, true)
    document.addEventListener('focusin', focusMoved, true)
    dialog.addEventListener('focusout', blurred)
    view.addEventListener('blur', abandon)
    operation.cleanup = () => {
      document.removeEventListener('pointerdown', abandon, true)
      document.removeEventListener('keydown', abandon, true)
      document.removeEventListener('compositionstart', abandon, true)
      document.removeEventListener('focusin', focusMoved, true)
      dialog.removeEventListener('focusout', blurred)
      view.removeEventListener('blur', abandon)
    }
    return operation
  }, [cancelFocus, dialogRef])

  const cancel = useCallback((operation: DialogActionOperation | null) => {
    if (operation && current.current === operation) cancelFocus(operation)
  }, [cancelFocus])

  const restore = useCallback((operation: DialogActionOperation | null, getTarget: () => HTMLElement | null, afterFocus?: () => void) => {
    if (!operation || !isCurrent(operation) || !operation.canFocus || operation.pending || operation.frame !== null) return
    operation.pending = { getTarget, afterFocus }
    commit(value => value + 1)
  }, [isCurrent])

  return { begin, isCurrent, cancel, restore }
}
