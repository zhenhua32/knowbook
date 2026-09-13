import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { scheduleTextareaResize } from '../utils/textareaLayout'

type Position = { index: string; offset: number } | { top: number }

export function useDocumentViewport({ documentId, reading, navigation, highlightedBlockId }: {
  documentId: string | null
  reading: boolean
  navigation: { index: number; documentId: string; sequence: number } | null
  highlightedBlockId?: string | null
}) {
  const scrollRef = useRef<HTMLElement | null>(null)
  const headerRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const positionRef = useRef<Position | null>(null)
  const [progress, setProgress] = useState(0)
  const [activeHeadingIndex, setActiveHeadingIndex] = useState<number | null>(null)

  const viewportTop = useCallback(() => (scrollRef.current?.getBoundingClientRect().top ?? 0)
    + (headerRef.current?.getBoundingClientRect().height ?? 0) + 12, [])

  const capturePosition = useCallback(() => {
    const container = scrollRef.current
    if (!container) return
    const top = viewportTop()
    const rows = Array.from(container.querySelectorAll<HTMLElement>('[data-block-index]'))
    const row = rows.find((element) => element.getBoundingClientRect().bottom > top)
    positionRef.current = container.scrollTop > 0 && row
      ? { index: row.dataset.blockIndex!, offset: row.getBoundingClientRect().top - top }
      : { top: container.scrollTop }
  }, [viewportTop])

  const scrollToElement = useCallback((element: HTMLElement, offset = 0) => {
    const container = scrollRef.current
    if (container) container.scrollTop += element.getBoundingClientRect().top - viewportTop() - offset
  }, [viewportTop])

  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0
    positionRef.current = null
    setActiveHeadingIndex(null)
    setProgress(0)
  }, [documentId])

  useLayoutEffect(() => {
    const position = positionRef.current
    if (!position) return
    const frame = requestAnimationFrame(() => {
      if ('top' in position) {
        if (scrollRef.current) scrollRef.current.scrollTop = position.top
      } else {
        const row = scrollRef.current?.querySelector<HTMLElement>(`[data-block-index="${position.index}"]`)
        if (row) scrollToElement(row, position.offset)
      }
      positionRef.current = null
    })
    return () => cancelAnimationFrame(frame)
  }, [reading, scrollToElement])

  useEffect(() => {
    if (!navigation || navigation.documentId !== documentId) return
    const frame = requestAnimationFrame(() => {
      const row = scrollRef.current?.querySelector<HTMLElement>(`[data-block-index="${navigation.index}"]`)
      if (row) scrollToElement(row)
    })
    return () => cancelAnimationFrame(frame)
  }, [documentId, navigation, scrollToElement])

  useEffect(() => {
    if (!highlightedBlockId) return
    const frame = requestAnimationFrame(() => {
      const row = Array.from(scrollRef.current?.querySelectorAll<HTMLElement>('[data-block-id]') ?? [])
        .find((element) => element.dataset.blockId === highlightedBlockId)
      if (row) scrollToElement(row)
    })
    return () => cancelAnimationFrame(frame)
  }, [highlightedBlockId, scrollToElement])

  useEffect(() => {
    const container = scrollRef.current
    const content = contentRef.current
    if (!container || !content) return
    let frame: number | null = null
    let width = content.clientWidth
    const update = () => {
      frame = null
      const extent = container.scrollHeight - container.clientHeight
      setProgress(extent > 0 ? Math.round(container.scrollTop / extent * 100) : 100)
      const headings = content.querySelectorAll<HTMLElement>('[data-heading-level]')
      let low = 0
      let high = headings.length - 1
      let current: number | null = null
      const top = viewportTop() + 2
      while (low <= high) {
        const middle = (low + high) >>> 1
        if (headings[middle].getBoundingClientRect().top <= top) {
          current = Number(headings[middle].dataset.blockIndex)
          low = middle + 1
        } else high = middle - 1
      }
      setActiveHeadingIndex(current)
    }
    const schedule = () => { if (frame === null) frame = requestAnimationFrame(update) }
    const observer = new ResizeObserver(() => {
      if (content.clientWidth !== width) {
        width = content.clientWidth
        container.querySelectorAll<HTMLTextAreaElement>('.block-inline-textarea').forEach(scheduleTextareaResize)
      }
      schedule()
    })
    observer.observe(container)
    observer.observe(content)
    container.addEventListener('scroll', schedule, { passive: true })
    schedule()
    return () => {
      observer.disconnect()
      container.removeEventListener('scroll', schedule)
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [documentId, reading, viewportTop])

  return { scrollRef, headerRef, contentRef, progress, activeHeadingIndex, capturePosition }
}
