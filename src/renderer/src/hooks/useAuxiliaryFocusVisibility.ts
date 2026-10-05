import { useEffect, useLayoutEffect, type RefObject } from 'react'

const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

/** Keep a focused control inside its own auxiliary scroller, without refocusing it. */
export function useAuxiliaryFocusVisibility(ref: RefObject<HTMLElement | null>) {
  const reveal = () => {
    const panel = ref.current
    const document = panel?.ownerDocument
    const active = document?.activeElement
    if (!panel || !document?.hasFocus() || !(active instanceof HTMLElement)
      || !panel.contains(active) || !active.matches('input, textarea, select, button')) return
    const bounds = panel.getBoundingClientRect()
    const control = active.getBoundingClientRect()
    const top = bounds.top + panel.clientTop + 12
    const bottom = bounds.top + panel.clientTop + panel.clientHeight - 12
    if (panel.clientHeight <= 0 || control.height <= 0 || control.height > bottom - top) return
    const delta = control.top < top ? control.top - top : control.bottom > bottom ? control.bottom - bottom : 0
    if (delta) panel.scrollTop += delta
  }

  useBrowserLayoutEffect(() => {
    const panel = ref.current
    const view = panel?.ownerDocument.defaultView
    if (!panel || !view) return
    let frame: number | null = null
    let observedControl: Element | null = null
    const schedule = () => {
      reveal()
      if (frame !== null) return
      frame = view.requestAnimationFrame(() => { frame = null; reveal() })
    }
    const observer = typeof view.ResizeObserver === 'undefined' ? null : new view.ResizeObserver(schedule)
    const onFocus = () => {
      const active = panel.ownerDocument.activeElement
      if (observedControl) observer?.unobserve(observedControl)
      observedControl = active && panel.contains(active) ? active : null
      if (observedControl) observer?.observe(observedControl)
      schedule()
    }
    observer?.observe(panel)
    panel.addEventListener('focusin', onFocus)
    panel.addEventListener('keydown', schedule)
    panel.addEventListener('input', schedule)
    return () => {
      observer?.disconnect()
      if (frame !== null) view.cancelAnimationFrame(frame)
      panel.removeEventListener('focusin', onFocus)
      panel.removeEventListener('keydown', schedule)
      panel.removeEventListener('input', schedule)
    }
  }, [ref])
}
