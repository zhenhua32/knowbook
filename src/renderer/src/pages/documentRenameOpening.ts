import { useLayoutEffect, useRef, useState } from 'react'
import type { DocumentRenameTarget } from '../hooks/useDocumentEditorState'

export type DocumentRenameOpening = {
  key: number
  target: DocumentRenameTarget
  opener: HTMLElement
  isCurrent: () => boolean
  claim: () => boolean
  canReturnFocus: () => boolean
  close: () => void
  invalidate: () => void
  saved: () => void
}

/** A delayed form load may only open for the click that still owns attention. */
export function useDocumentRenameOpening(getTarget: () => DocumentRenameTarget | null) {
  const [opening, setOpening] = useState<DocumentRenameOpening | null>(null)
  const current = useRef<DocumentRenameOpening | null>(null)
  const latest = useRef(getTarget), mounted = useRef(false), generation = useRef(0)
  const stopWatching = useRef<() => void>(() => {})
  latest.current = getTarget
  useLayoutEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; stopWatching.current() }
  }, [])
  useLayoutEffect(() => {
    if (opening && !opening.isCurrent()) opening.invalidate()
  })

  const open = (opener: HTMLElement, restorePosition?: () => void) => {
    const target = latest.current(), owner = opener.ownerDocument, view = owner.defaultView
    if (!mounted.current || !target || !view || !owner.hasFocus() || !opener.isConnected) return
    stopWatching.current()
    const token = ++generation.current
    let claimed = false, attentive = true, normallyClosing = false
    const sameTarget = () => {
      const next = latest.current()
      return mounted.current && generation.current === token && next?.documentId === target.documentId && next.session === target.session
    }
    const finish = (normal: boolean) => {
      if (current.current !== request) return
      normallyClosing = normal
      cleanup()
      current.current = null
      setOpening(null)
    }
    const request: DocumentRenameOpening = {
      key: token, target, opener,
      isCurrent: () => current.current === request && sameTarget(),
      canReturnFocus: () => sameTarget() && (current.current === request || normallyClosing),
      claim: () => {
        if (!request.isCurrent() || !attentive || !owner.hasFocus() || !opener.isConnected
          || opener.closest('[hidden], [inert]') || opener.matches(':disabled, [aria-disabled="true"]')
          || (owner.activeElement !== opener && owner.activeElement !== owner.body)
          || [...owner.querySelectorAll<HTMLElement>('dialog[open], [aria-modal="true"][role="dialog"], [aria-modal="true"][role="alertdialog"]')]
            .some(element => element.getClientRects().length > 0)) return false
        claimed = true
        cleanup()
        return true
      },
      close: () => finish(true), invalidate: () => finish(false),
      saved: () => {
        if (!request.isCurrent()) return
        restorePosition?.()
        finish(true)
      }
    }
    const abandon = () => { if (!claimed) { attentive = false; request.invalidate() } }
    const focusMoved = (event: FocusEvent) => { if (event.target !== opener && event.target !== owner.body) abandon() }
    function cleanup() {
      owner.removeEventListener('pointerdown', abandon, true)
      view!.removeEventListener('keydown', abandon, true)
      owner.removeEventListener('compositionstart', abandon, true)
      owner.removeEventListener('focusin', focusMoved, true)
      view!.removeEventListener('blur', abandon)
      if (stopWatching.current === cleanup) stopWatching.current = () => {}
    }
    stopWatching.current = cleanup
    owner.addEventListener('pointerdown', abandon, true)
    view.addEventListener('keydown', abandon, true)
    owner.addEventListener('compositionstart', abandon, true)
    owner.addEventListener('focusin', focusMoved, true)
    view.addEventListener('blur', abandon)
    current.current = request
    setOpening(request)
  }
  return { opening: opening?.isCurrent() ? opening : null, open }
}
