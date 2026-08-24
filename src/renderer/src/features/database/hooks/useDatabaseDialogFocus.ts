import { useEffect, useRef, type RefObject } from 'react'

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
  open
}: {
  containerRef: RefObject<HTMLElement | null>
  initialFocusRef?: RefObject<HTMLElement | null>
  onClose: () => void
  open: boolean
}) {
  const closeHandlerRef = useRef(onClose)
  closeHandlerRef.current = onClose

  useEffect(() => {
    if (!open) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusFrame = requestAnimationFrame(() => {
      const firstFocusable = focusableElements(containerRef.current)[0]
      ;(initialFocusRef?.current ?? firstFocusable ?? containerRef.current)?.focus()
    })
    const handleKeyDown = (event: KeyboardEvent) => {
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
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      cancelAnimationFrame(focusFrame)
      window.removeEventListener('keydown', handleKeyDown)
      if (previousFocus?.isConnected) requestAnimationFrame(() => previousFocus.focus())
    }
  }, [containerRef, initialFocusRef, open])
}

function focusableElements(container: HTMLElement | null): HTMLElement[] {
  if (!container) return []
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter((element) => {
    const style = window.getComputedStyle(element)
    return style.visibility !== 'hidden' && style.display !== 'none'
  })
}
