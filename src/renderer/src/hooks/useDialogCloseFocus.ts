import { useCallback, useLayoutEffect, useRef } from 'react'

type Membership = { child: HTMLElement; parent: HTMLElement; transitioning: boolean }
const parents = new WeakMap<HTMLElement, Membership>()
const children = new WeakMap<HTMLElement, Set<Membership>>()
const modalSelector = 'dialog[open], [aria-modal="true"][role="dialog"], [aria-modal="true"][role="alertdialog"]'

/** Register an exact portalled child before showModal moves its parent's focus. */
export function registerModalFamily(child: HTMLElement, parent: HTMLElement | null) {
  const membership = parent && parent !== child ? { child, parent, transitioning: true } : null
  if (membership) {
    parents.set(child, membership)
    const siblings = children.get(membership.parent) ?? new Set<Membership>()
    siblings.add(membership)
    children.set(membership.parent, siblings)
  }
  return {
    opened: () => { if (membership) membership.transitioning = false },
    closing: () => { if (membership) membership.transitioning = true },
    release: () => {
      if (!membership) return
      if (parents.get(child) === membership) parents.delete(child)
      const siblings = children.get(membership.parent)
      siblings?.delete(membership)
      if (!siblings?.size) children.delete(membership.parent)
    }
  }
}

function visible(element: HTMLElement): boolean {
  if (!element.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]') || !element.getClientRects().length) return false
  const style = element.ownerDocument.defaultView?.getComputedStyle(element)
  return style?.display !== 'none' && style?.visibility !== 'hidden' && style?.visibility !== 'collapse'
}

function belongsTo(target: EventTarget | null, dialog: HTMLElement): boolean {
  const view = dialog.ownerDocument.defaultView
  if (!view || !(target instanceof view.HTMLElement)) return false
  if (dialog.contains(target)) return true
  let modal: HTMLElement | null = target.closest(modalSelector)
  const visited = new Set<HTMLElement>()
  while (modal && !visited.has(modal)) {
    if (modal === dialog) return true
    visited.add(modal)
    modal = parents.get(modal)?.parent ?? null
  }
  return false
}

function transitioning(dialog: HTMLElement): boolean {
  return [...children.get(dialog) ?? []].some(member => parents.get(member.child) === member
    && (member.transitioning || transitioning(member.child)))
}

/** Track closing attention without changing a dialog's existing opening effect. */
export function useDialogCloseFocus() {
  const current = useRef<{ cancel: () => void; close: () => void } | null>(null)
  useLayoutEffect(() => () => { current.current?.close() }, [])
  return useCallback((dialog: HTMLDialogElement, opener: HTMLElement | null) => {
    current.current?.cancel()
    const owner = dialog.ownerDocument, view = owner.defaultView!
    const openerModal = opener?.closest<HTMLElement>(modalSelector) ?? null
    let owned = owner.hasFocus() && dialog.open && visible(dialog) && belongsTo(owner.activeElement, dialog)
    let closed = false, pending = false, frame: number | null = null
    const foreignModal = () => [...owner.querySelectorAll<HTMLElement>(modalSelector)]
      .some(modal => modal !== dialog && modal !== openerModal && !modal.contains(dialog) && visible(modal))
    const abandonOpen = () => { owned = false }
    const activity = (event: Event) => { if (!belongsTo(event.target, dialog)) abandonOpen() }
    const focusMoved = (event: FocusEvent) => {
      if (event.target === owner.body && transitioning(dialog)) return
      activity(event)
    }
    const blurred = (event: FocusEvent) => {
      const target = event.target
      if (!belongsTo(target, dialog) || belongsTo(event.relatedTarget, dialog) || transitioning(dialog)) return
      if (target instanceof view.HTMLElement && (!target.isConnected || target.matches(':disabled'))) return
      abandonOpen()
    }
    const stopOpen = () => {
      owner.removeEventListener('pointerdown', activity, true)
      view.removeEventListener('keydown', activity, true)
      owner.removeEventListener('compositionstart', activity, true)
      owner.removeEventListener('focusin', focusMoved, true)
      owner.removeEventListener('focusout', blurred, true)
      view.removeEventListener('blur', abandonOpen)
    }
    const cancel = () => {
      owned = false
      pending = false
      stopOpen()
      if (frame !== null) view.cancelAnimationFrame(frame)
      frame = null
      owner.removeEventListener('pointerdown', cancel, true)
      view.removeEventListener('keydown', cancel, true)
      owner.removeEventListener('compositionstart', cancel, true)
      owner.removeEventListener('focusin', cancel, true)
      view.removeEventListener('blur', cancel)
      if (current.current === session) current.current = null
    }
    const session = { cancel, close: closeDialog }
    current.current = session
    owner.addEventListener('pointerdown', activity, true)
    view.addEventListener('keydown', activity, true)
    owner.addEventListener('compositionstart', activity, true)
    owner.addEventListener('focusin', focusMoved, true)
    owner.addEventListener('focusout', blurred, true)
    view.addEventListener('blur', abandonOpen)

    function closeDialog() {
      if (closed) return
      closed = true
      stopOpen()
      const active = owner.activeElement
      const canReturn = owned && current.current === session && owner.hasFocus() && !foreignModal()
        && (active === owner.body || belongsTo(active, dialog))
      // Native close also restores its saved opener, even after blur. Block
      // only that exact target while focus still belongs to the old scope.
      const blockedOpener = !canReturn && (active === owner.body || dialog.contains(active)) && opener?.isConnected
        && opener !== active && opener !== owner.body && opener !== owner.documentElement ? opener : null
      const inert = blockedOpener?.getAttribute('inert') ?? null
      if (blockedOpener && inert === null) blockedOpener.setAttribute('inert', '')
      try {
        if (!canReturn && active instanceof view.HTMLElement && dialog.contains(active)) active.blur()
        dialog.close()
      } finally {
        if (blockedOpener) {
          if (inert === null) blockedOpener.removeAttribute('inert')
          else blockedOpener.setAttribute('inert', inert)
        }
      }
      if (!canReturn) { cancel(); return }
      pending = true
      const restore = () => {
        if (!pending || current.current !== session) return
        const active = owner.activeElement
        const allowed = owner.hasFocus() && !foreignModal() && !!opener && visible(opener)
          && !opener.matches(':disabled, [aria-disabled="true"]')
          && (active === owner.body || active === opener || dialog.contains(active))
        cancel()
        if (allowed) opener!.focus({ preventScroll: true })
      }
      if (opener?.matches(':disabled') && visible(opener)) {
        owner.addEventListener('pointerdown', cancel, true)
        view.addEventListener('keydown', cancel, true)
        owner.addEventListener('compositionstart', cancel, true)
        owner.addEventListener('focusin', cancel, true)
        view.addEventListener('blur', cancel)
        frame = view.requestAnimationFrame(restore)
      } else restore()
    }
    return closeDialog
  }, [])
}
