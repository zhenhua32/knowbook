import { useLayoutEffect, type RefObject } from 'react'

export function revealDatabaseResizeFocus(node: HTMLElement, headerHeight = 0): void {
  const active = node.ownerDocument.activeElement
  if (!(active instanceof HTMLElement) || !node.contains(active) || active.closest('thead')) return
  const bounds = node.getBoundingClientRect()
  const control = active.getBoundingClientRect()
  const top = bounds.top + node.clientTop + headerHeight + 4
  const bottom = bounds.top + node.clientTop + node.clientHeight - 4
  if (control.height <= 0 || control.height > bottom - top) return
  const adjustment = control.bottom > bottom ? control.bottom - bottom : control.top < top ? control.top - top : 0
  if (adjustment !== 0) {
    node.scrollTop = Math.max(0, Math.min(node.scrollTop + adjustment, node.scrollHeight - node.clientHeight))
  }
}

export function useDatabaseResizeFocus(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    let height = node.clientHeight
    const update = () => {
      const nextHeight = node.clientHeight
      if (nextHeight > 0 && nextHeight !== height) revealDatabaseResizeFocus(node)
      height = nextHeight
    }
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update)
      return () => window.removeEventListener('resize', update)
    }
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => observer.disconnect()
  }, [ref])
}
