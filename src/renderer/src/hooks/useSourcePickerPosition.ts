import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'

const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect
const MARGIN = 10
const GAP = 10

function samePosition(current: CSSProperties, next: CSSProperties) {
  return current.left === next.left && current.top === next.top
    && current.maxWidth === next.maxWidth && current.maxHeight === next.maxHeight
    && current.overflowY === next.overflowY
}

export function useSourcePickerPosition(
  sourceWrapRef: RefObject<HTMLDivElement | null>,
  pickerRef: RefObject<HTMLDivElement | null>,
  open: boolean
): CSSProperties {
  const [position, setPosition] = useState<CSSProperties>({})
  const requestMeasure = useRef<(() => void) | null>(null)

  useBrowserLayoutEffect(() => {
    const wrap = sourceWrapRef.current, picker = pickerRef.current
    const owner = wrap?.ownerDocument, view = owner?.defaultView
    if (!open || !wrap || !picker || !owner || !view) {
      requestMeasure.current = null
      setPosition(current => Object.keys(current).length ? {} : current)
      return
    }

    let disposed = false
    let frame: number | null = null
    const current = () => !disposed && sourceWrapRef.current === wrap && pickerRef.current === picker
      && wrap.isConnected && picker.isConnected && picker.ownerDocument === owner

    const measure = () => {
      if (!current()) return
      const viewport = view.visualViewport
      const bounds = {
        left: viewport?.offsetLeft ?? 0,
        top: viewport?.offsetTop ?? 0,
        right: viewport ? viewport.offsetLeft + viewport.width : view.innerWidth,
        bottom: viewport ? viewport.offsetTop + viewport.height : view.innerHeight
      }
      for (let ancestor: HTMLElement | null = wrap; ancestor; ancestor = ancestor.parentElement) {
        const style = view.getComputedStyle(ancestor), rect = ancestor.getBoundingClientRect()
        const borderLeft = parseFloat(style.borderLeftWidth) || 0
        const borderRight = parseFloat(style.borderRightWidth) || 0
        const borderTop = parseFloat(style.borderTopWidth) || 0
        const borderBottom = parseFloat(style.borderBottomWidth) || 0
        // Use integer layout metrics only for scrollbar occupancy. The padding
        // edges themselves retain their real fractional DOMRect coordinates.
        const scrollbarWidth = /auto|scroll/.test(style.overflowY)
          ? Math.max(0, ancestor.offsetWidth - ancestor.clientWidth - Math.round(borderLeft + borderRight)) : 0
        const scrollbarHeight = /auto|scroll/.test(style.overflowX)
          ? Math.max(0, ancestor.offsetHeight - ancestor.clientHeight - Math.round(borderTop + borderBottom)) : 0
        if (/hidden|clip|auto|scroll/.test(style.overflowX)) {
          bounds.left = Math.max(bounds.left, rect.left + borderLeft)
          bounds.right = Math.min(bounds.right, rect.right - borderRight - scrollbarWidth)
        }
        if (/hidden|clip|auto|scroll/.test(style.overflowY)) {
          bounds.top = Math.max(bounds.top, rect.top + borderTop)
          bounds.bottom = Math.min(bounds.bottom, rect.bottom - borderBottom - scrollbarHeight)
        }
      }
      const horizontalMargin = Math.min(MARGIN, Math.max(0, bounds.right - bounds.left) / 2)
      const verticalMargin = Math.min(MARGIN, Math.max(0, bounds.bottom - bounds.top) / 2)
      const leftBound = bounds.left + horizontalMargin
      const rightBound = Math.max(leftBound, bounds.right - horizontalMargin)
      const topBound = bounds.top + verticalMargin
      const bottomBound = Math.max(topBound, bounds.bottom - verticalMargin)
      const maxWidth = rightBound - leftBound
      const anchor = wrap.getBoundingClientRect()
      const list = picker.querySelector<HTMLElement>('.dbw-source-list')
      const previousWidth = picker.style.maxWidth, previousHeight = picker.style.maxHeight
      const pickerScrollTop = picker.scrollTop, pickerScrollLeft = picker.scrollLeft
      const listScrollTop = list?.scrollTop, listScrollLeft = list?.scrollLeft
      let width = 0, naturalHeight = 0, fixedChromeHeight = 0
      try {
        // Measure wrapping at the current horizontal capacity while preserving
        // the CSS preferred width and the list's normal 320px reading limit.
        picker.style.maxWidth = `${maxWidth}px`
        picker.style.maxHeight = 'none'
        const rect = picker.getBoundingClientRect(), style = view.getComputedStyle(picker)
        const border = (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0)
        width = Math.min(rect.width, maxWidth)
        naturalHeight = Math.max(rect.height, picker.scrollHeight + border)
        fixedChromeHeight = Math.max(0, rect.height - (list?.getBoundingClientRect().height ?? 0))
      } finally {
        picker.style.maxWidth = previousWidth
        picker.style.maxHeight = previousHeight
        // Temporarily uncapping a flex list can clamp its reading position.
        picker.scrollTop = pickerScrollTop
        picker.scrollLeft = pickerScrollLeft
        if (list) {
          list.scrollTop = listScrollTop ?? 0
          list.scrollLeft = listScrollLeft ?? 0
        }
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
      const wrapStyle = view.getComputedStyle(wrap)
      const next: CSSProperties = {
        left: x - anchor.left - (parseFloat(wrapStyle.borderLeftWidth) || 0) + wrap.scrollLeft,
        top: y - anchor.top - (parseFloat(wrapStyle.borderTopWidth) || 0) + wrap.scrollTop,
        maxWidth,
        maxHeight,
        // Normally only the list scrolls. A non-scrolling outer clip also avoids
        // fractional scrollHeight rounding moving the search or Create button.
        overflowY: maxHeight < fixedChromeHeight ? 'auto' : 'clip'
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
      if (target && typeof target.nodeType === 'number' && picker.contains(target)) return
      schedule()
    }
    requestMeasure.current = schedule
    measure()
    const observer = typeof view.ResizeObserver === 'undefined' ? null : new view.ResizeObserver(schedule)
    observer?.observe(picker)
    const list = picker.querySelector<HTMLElement>('.dbw-source-list')
    if (list) observer?.observe(list)
    for (let ancestor: HTMLElement | null = wrap; ancestor; ancestor = ancestor.parentElement) observer?.observe(ancestor)
    view.addEventListener('resize', schedule)
    owner.addEventListener('scroll', onScroll, true)
    const viewport = view.visualViewport
    viewport?.addEventListener('resize', schedule)
    viewport?.addEventListener('scroll', schedule)
    return () => {
      disposed = true
      if (requestMeasure.current === schedule) requestMeasure.current = null
      if (frame !== null) view.cancelAnimationFrame(frame)
      observer?.disconnect()
      view.removeEventListener('resize', schedule)
      owner.removeEventListener('scroll', onScroll, true)
      viewport?.removeEventListener('resize', schedule)
      viewport?.removeEventListener('scroll', schedule)
    }
  }, [sourceWrapRef, pickerRef, open])

  // Filtering can change scrollHeight without changing a capped border box.
  useBrowserLayoutEffect(() => { requestMeasure.current?.() })

  return open ? position : {}
}
