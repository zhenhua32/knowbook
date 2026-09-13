import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { scheduleTextareaResize } from '../utils/textareaLayout'
import { readDocumentPosition, saveDocumentPosition, type DocumentReadingPosition } from '../utils/documentReadingPosition'

type ViewportSession = {
  documentId: string
  position: DocumentReadingPosition | null
  restoring: { position: DocumentReadingPosition; until: number } | null
}

export function useDocumentViewport({ documentId, reading, navigation, highlightedBlockId, onRevealBlock }: {
  documentId: string | null
  reading: boolean
  navigation: { index: number; documentId: string; sequence: number } | null
  highlightedBlockId?: string | null
  onRevealBlock: (blockId: string) => void
}) {
  const scrollRef = useRef<HTMLElement | null>(null)
  const headerRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const sessionRef = useRef<ViewportSession | null>(null)
  const modePositionRef = useRef<DocumentReadingPosition | null>(null)
  const consumedNavigationRef = useRef<typeof navigation>(null)
  const revealBlockRef = useRef(onRevealBlock)
  revealBlockRef.current = onRevealBlock
  const [progress, setProgress] = useState(0)
  const [activeHeadingIndex, setActiveHeadingIndex] = useState<number | null>(null)

  const viewportTop = useCallback(() => (scrollRef.current?.getBoundingClientRect().top ?? 0)
    + (headerRef.current?.getBoundingClientRect().height ?? 0) + 12, [])

  const readPosition = useCallback((): DocumentReadingPosition | null => {
    const container = scrollRef.current
    if (!container) return null
    const top = viewportTop()
    const rows = contentRef.current?.querySelectorAll<HTMLElement>('[data-block-id]') ?? []
    // Only measure log(n) rows while scrolling a long document.
    let low = 0
    let high = rows.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (rows[middle].getBoundingClientRect().bottom <= top) low = middle + 1
      else high = middle
    }
    const row = rows[low]
    return {
      blockId: container.scrollTop > 0 ? row?.dataset.blockId ?? null : null,
      offset: row ? row.getBoundingClientRect().top - top : 0,
      scrollTop: container.scrollTop,
      updatedAt: Date.now()
    }
  }, [viewportTop])

  const capturePosition = useCallback(() => {
    modePositionRef.current = readPosition()
    if (sessionRef.current) sessionRef.current.position = modePositionRef.current
  }, [readPosition])

  useLayoutEffect(() => () => {
    // Capture before page unmount removes the DOM, even if its last scroll RAF
    // has not run yet. Document switches keep using their cached session below.
    const session = sessionRef.current
    if (!session) return
    session.position = session.restoring?.position ?? readPosition() ?? session.position
    if (session.position) saveDocumentPosition(session.documentId, session.position)
  }, [readPosition])

  const scrollToElement = useCallback((element: HTMLElement, offset = 0) => {
    const container = scrollRef.current
    if (container) container.scrollTop += element.getBoundingClientRect().top - viewportTop() - offset
  }, [viewportTop])

  useLayoutEffect(() => {
    const previous = sessionRef.current
    if (previous?.position) saveDocumentPosition(previous.documentId, previous.position)
    if (scrollRef.current) scrollRef.current.scrollTop = 0
    modePositionRef.current = null
    const position = documentId ? readDocumentPosition(documentId) : null
    sessionRef.current = documentId ? {
      documentId, position,
      restoring: position ? { position, until: Date.now() + 1500 } : null
    } : null
    if (position?.blockId) revealBlockRef.current(position.blockId)
    setActiveHeadingIndex(null)
    setProgress(0)
  }, [documentId])

  useLayoutEffect(() => {
    const position = modePositionRef.current
    if (position && sessionRef.current) {
      sessionRef.current.restoring = { position, until: Date.now() + 1500 }
    }
    modePositionRef.current = null
  }, [reading])

  useEffect(() => {
    if (!navigation || navigation.documentId !== documentId || navigation === consumedNavigationRef.current) return
    if (sessionRef.current) sessionRef.current.restoring = null
    const frame = requestAnimationFrame(() => {
      consumedNavigationRef.current = navigation
      const row = scrollRef.current?.querySelector<HTMLElement>(`[data-block-index="${navigation.index}"]`)
      if (row) scrollToElement(row)
    })
    return () => cancelAnimationFrame(frame)
  }, [documentId, navigation, scrollToElement])

  useEffect(() => {
    if (!highlightedBlockId) return
    if (sessionRef.current) sessionRef.current.restoring = null
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
    const session = sessionRef.current
    if (!container || !content || !session) return
    let frame: number | null = null
    let saveTimer: ReturnType<typeof setTimeout> | null = null
    let width = content.clientWidth
    const persist = () => {
      if (saveTimer !== null) clearTimeout(saveTimer)
      saveTimer = null
      if (session.position) saveDocumentPosition(session.documentId, session.position)
    }
    const update = () => {
      frame = null
      const restoring = session.restoring
      if (restoring && Date.now() <= restoring.until) {
        const position = restoring.position
        const row = position.blockId
          ? Array.from(content.querySelectorAll<HTMLElement>('[data-block-id]')).find((element) => element.dataset.blockId === position.blockId)
          : null
        if (row) scrollToElement(row, Math.max(position.offset, 1 - row.getBoundingClientRect().height))
        else container.scrollTop = position.scrollTop
      } else session.restoring = null
      session.position = readPosition()
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
    const onScroll = () => {
      schedule()
      if (saveTimer !== null) clearTimeout(saveTimer)
      saveTimer = setTimeout(persist, 250)
    }
    const cancelRestoration = () => { session.restoring = null }
    const onPageHide = () => {
      // Capture the final frame even when the page closes before its scroll RAF.
      if (!session.restoring) session.position = readPosition()
      persist()
    }
    const observer = new ResizeObserver(() => {
      if (content.clientWidth !== width) {
        width = content.clientWidth
        container.querySelectorAll<HTMLTextAreaElement>('.block-inline-textarea').forEach(scheduleTextareaResize)
      }
      schedule()
    })
    observer.observe(container)
    observer.observe(content)
    container.addEventListener('scroll', onScroll, { passive: true })
    container.addEventListener('wheel', cancelRestoration, { passive: true })
    container.addEventListener('touchstart', cancelRestoration, { passive: true })
    container.addEventListener('pointerdown', cancelRestoration, { passive: true })
    container.addEventListener('keydown', cancelRestoration)
    window.addEventListener('pagehide', onPageHide)
    schedule()
    return () => {
      // Use the cached old document position; React may already show the next document.
      persist()
      observer.disconnect()
      container.removeEventListener('scroll', onScroll)
      container.removeEventListener('wheel', cancelRestoration)
      container.removeEventListener('touchstart', cancelRestoration)
      container.removeEventListener('pointerdown', cancelRestoration)
      container.removeEventListener('keydown', cancelRestoration)
      window.removeEventListener('pagehide', onPageHide)
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [documentId, reading, readPosition, scrollToElement, viewportTop])

  return { scrollRef, headerRef, contentRef, progress, activeHeadingIndex, capturePosition }
}
