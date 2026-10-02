import { useEffect, useRef, type RefObject } from 'react'
import { isImeKeyboardEvent } from '../../../utils/imeKeyboard'

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

export function useDatabaseDialogFocus({
  containerRef,
  initialFocusRef,
  onClose,
  open,
  returnFocusTarget,
  canReturnFocus
}: {
  containerRef: RefObject<HTMLElement | null>
  initialFocusRef?: RefObject<HTMLElement | null>
  onClose: () => void
  open: boolean
  returnFocusTarget?: HTMLElement | null
  canReturnFocus?: () => boolean
}) {
  const closeHandlerRef = useRef(onClose)
  closeHandlerRef.current = onClose
  const returnTargetRef = useRef(returnFocusTarget)
  returnTargetRef.current = returnFocusTarget
  const returnGuardRef = useRef(canReturnFocus)
  returnGuardRef.current = canReturnFocus
  const mounted = useRef(false)
  const returnFrameRef = useRef<number | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (returnFrameRef.current !== null) cancelAnimationFrame(returnFrameRef.current)
      returnFrameRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!open) return
    if (returnFrameRef.current !== null) cancelAnimationFrame(returnFrameRef.current)
    returnFrameRef.current = null
    const container = containerRef.current
    const previousFocus = returnTargetRef.current === undefined
      ? document.activeElement instanceof HTMLElement ? document.activeElement : null
      : returnTargetRef.current
    const focusFrame = requestAnimationFrame(() => {
      const firstFocusable = focusableElements(containerRef.current)[0]
      ;(initialFocusRef?.current ?? firstFocusable ?? containerRef.current)?.focus()
    })
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isImeKeyboardEvent(event)) return
      if (event.key === 'Escape') {
        event.preventDefault()
        closeHandlerRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = focusableElements(containerRef.current)
      if (focusable.length === 0) {
        event.preventDefault()
        containerRef.current?.focus()
        return
      }
      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!
      const active = document.activeElement
      if (event.shiftKey && (active === first || !containerRef.current?.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || !containerRef.current?.contains(active))) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      cancelAnimationFrame(focusFrame)
      window.removeEventListener('keydown', handleKeyDown)
      if (!mounted.current || !previousFocus || returnGuardRef.current?.() === false) return
      returnFrameRef.current = requestAnimationFrame(() => {
        returnFrameRef.current = null
        if (!mounted.current || returnGuardRef.current?.() === false || !document.hasFocus()) return
        if (!isVisible(previousFocus) || previousFocus.matches(':disabled, [aria-disabled="true"]')) return
        if ([...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')]
          .some(dialog => dialog !== container && isVisible(dialog))) return
        const active = document.activeElement
        if (active !== document.body && active !== previousFocus && !container?.contains(active)) return
        previousFocus.focus({ preventScroll: true })
      })
    }
  }, [containerRef, initialFocusRef, open])
}

function isVisible(element: HTMLElement): boolean {
  if (!element.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false
  const style = window.getComputedStyle(element)
  return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0
}

function focusableElements(container: HTMLElement | null): HTMLElement[] {
  if (!container) return []
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter((element) => {
    if (element.matches(':disabled')) return false
    const style = window.getComputedStyle(element)
    return style.visibility !== 'hidden' && style.display !== 'none'
  })
}
