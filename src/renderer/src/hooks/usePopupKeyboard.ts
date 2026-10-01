import { useEffect, useRef, type RefObject } from 'react'
import { isImeKeyboardEvent } from '../utils/imeKeyboard'

const FOCUSABLE = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

/** Keep action popovers usable from the keyboard, including mixed form controls. */
export function usePopupKeyboard(containerRef: RefObject<HTMLElement | null>, onClose: () => void) {
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const controls = () => Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter((element) => element.getClientRects().length > 0 && !element.closest('[hidden], [inert]'))

    const initialFocus = controls()[0] ?? container
    initialFocus.focus({ preventScroll: true })

    const handleKeyDown = (event: KeyboardEvent) => {
      if (isImeKeyboardEvent(event)) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeRef.current()
        return
      }
      const items = controls()
      if (!items.length) return
      const current = items.indexOf(document.activeElement as HTMLElement)
      if (event.key === 'Tab') {
        if (event.shiftKey && current <= 0) {
          event.preventDefault()
          items.at(-1)?.focus()
        } else if (!event.shiftKey && (current < 0 || current === items.length - 1)) {
          event.preventDefault()
          items[0].focus()
        }
        return
      }
      // Text fields and native selects keep their own arrow/Home/End behavior.
      if (document.activeElement?.matches('input, textarea, select, [contenteditable="true"]')) return
      let next: number | undefined
      if (event.key === 'ArrowDown') next = (current + 1) % items.length
      else if (event.key === 'ArrowUp') next = (current - 1 + items.length) % items.length
      else if (event.key === 'Home') next = 0
      else if (event.key === 'End') next = items.length - 1
      if (next === undefined) return
      event.preventDefault()
      event.stopPropagation()
      items[next].focus()
    }
    container.addEventListener('keydown', handleKeyDown)
    return () => {
      container.removeEventListener('keydown', handleKeyDown)
      // Do not steal focus from a dialog opened by one of the actions.
      if (previousFocus?.isConnected && (container.contains(document.activeElement) || document.activeElement === document.body)) {
        previousFocus.focus({ preventScroll: true })
      }
    }
  }, [containerRef])
}
