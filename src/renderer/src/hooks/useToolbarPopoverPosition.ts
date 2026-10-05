import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'

const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect
const MARGIN = 10
const GAP = 7

function samePosition(current: CSSProperties, next: CSSProperties) {
  return current.left === next.left && current.top === next.top
    && current.maxWidth === next.maxWidth && current.maxHeight === next.maxHeight
    && current.overflowY === next.overflowY
}

export function useToolbarPopoverPosition(
  detailsRef: RefObject<HTMLDetailsElement | null>,
  popoverRef: RefObject<HTMLDivElement | null>,
  open: boolean
): CSSProperties {
  const [position, setPosition] = useState<CSSProperties>({})
  const requestMeasure = useRef<(() => void) | null>(null)

  useBrowserLayoutEffect(() => {
    const details = detailsRef.current
    const popover = popoverRef.current
    const toolbar = details?.closest<HTMLElement>('.dbw-toolbar')
    const summary = details?.querySelector<HTMLElement>(':scope > summary')
    const owner = details?.ownerDocument
    const view = owner?.defaultView
    if (!open || !details || !popover || !toolbar || !summary || !owner || !view) {
      requestMeasure.current = null
      setPosition(current => Object.keys(current).length ? {} : current)
      return
    }

    const shell = details.closest<HTMLElement>('.dbw-shell')
    let disposed = false
    let frame: number | null = null
    const current = () => !disposed && detailsRef.current === details && popoverRef.current === popover
      && details.isConnected && popover.isConnected && details.open

    const measure = () => {
      if (!current()) return
      const anchor = summary.getBoundingClientRect()
      const toolbarRect = toolbar.getBoundingClientRect()
      const shellRect = shell?.getBoundingClientRect()
      const clipLeft = shellRect ? shellRect.left + shell!.clientLeft : 0
      const clipTop = shellRect ? shellRect.top + shell!.clientTop : 0
      const clipRight = shellRect ? clipLeft + shell!.clientWidth : view.innerWidth
      const clipBottom = shellRect ? clipTop + shell!.clientHeight : view.innerHeight
      const leftBound = Math.max(0, clipLeft) + MARGIN
      const rightBound = Math.min(view.innerWidth, clipRight) - MARGIN
      const topBound = Math.max(0, clipTop) + MARGIN
      const bottomBound = Math.min(view.innerHeight, clipBottom) - MARGIN
      const maxWidth = Math.max(0, rightBound - leftBound)

      // Preserve the CSS preferred width (Filter 560 / Sort 390). Measure at the
      // new capacity so wrapping, padding and borders contribute to natural height.
      const previousWidth = popover.style.maxWidth
      const previousHeight = popover.style.maxHeight
      const previousScrollTop = popover.scrollTop
      const previousScrollLeft = popover.scrollLeft
      let width = 0
      let naturalHeight = 0
      try {
        popover.style.maxWidth = `${maxWidth}px`
        popover.style.maxHeight = 'none'
        const rect = popover.getBoundingClientRect()
        const style = view.getComputedStyle(popover)
        const border = (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0)
        width = rect.width
        naturalHeight = Math.max(rect.height, popover.scrollHeight + border)
      } finally {
        popover.style.maxWidth = previousWidth
        popover.style.maxHeight = previousHeight
        // Uncapping can clamp scrollTop to zero; keep the user's reading position.
        popover.scrollTop = previousScrollTop
        popover.scrollLeft = previousScrollLeft
      }
      if (!current()) return

      const belowTop = Math.max(topBound, anchor.bottom + GAP)
      const aboveBottom = Math.min(bottomBound, anchor.top - GAP)
      const below = Math.max(0, bottomBound - belowTop)
      const above = Math.max(0, aboveBottom - topBound)
      const useBelow = naturalHeight <= below || (naturalHeight > above && below >= above)
      const maxHeight = useBelow ? below : above
      const height = Math.min(naturalHeight, maxHeight)
      const x = Math.max(leftBound, Math.min(anchor.left, rightBound - width))
      const rawY = useBelow ? belowTop : aboveBottom - height
      const y = Math.max(topBound, Math.min(rawY, bottomBound - height))
      const next: CSSProperties = {
        left: x - toolbarRect.left - toolbar.clientLeft + toolbar.scrollLeft,
        top: y - toolbarRect.top - toolbar.clientTop + toolbar.scrollTop,
        maxWidth,
        maxHeight,
        overflowY: 'auto'
      }
      setPosition(previous => samePosition(previous, next) ? previous : next)
    }

    const schedule = () => {
      if (!current() || frame !== null) return
      if (typeof view.requestAnimationFrame !== 'function') {
        measure()
        return
      }
      frame = view.requestAnimationFrame(() => {
        frame = null
        if (current()) measure()
      })
    }
    const onScroll = (event: Event) => {
      const target = event.target as Node | null
      if (target && typeof target.nodeType === 'number' && popover.contains(target)) return
      schedule()
    }
    requestMeasure.current = schedule
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    observer?.observe(toolbar)
    observer?.observe(summary)
    observer?.observe(popover)
    view.addEventListener('resize', schedule)
    owner.addEventListener('scroll', onScroll, true)
    return () => {
      disposed = true
      if (requestMeasure.current === schedule) requestMeasure.current = null
      if (frame !== null) view.cancelAnimationFrame(frame)
      observer?.disconnect()
      view.removeEventListener('resize', schedule)
      owner.removeEventListener('scroll', onScroll, true)
    }
  }, [detailsRef, popoverRef, open])

  // When a capped popover gains rows, its border box can stay unchanged and RO
  // cannot see the changed scrollHeight. React content updates request one measure.
  useBrowserLayoutEffect(() => { requestMeasure.current?.() })

  return open ? position : {}
}
