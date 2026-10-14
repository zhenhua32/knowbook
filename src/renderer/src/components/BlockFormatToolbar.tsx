import { useLayoutEffect, type ReactNode, type RefObject } from 'react'
import { MarkdownFormatToolbar } from './MarkdownFormatToolbar'
import type { MarkdownFormat } from '../utils/markdownFormatting'
import '../styles/block-format-toolbar.css'

type VerticalBox = { top: number; bottom: number }

export function blockFormatToolbarTop(anchor: VerticalBox, height: number, viewport: VerticalBox, caret?: VerticalBox): number {
  const gap = 6
  const above = anchor.top - height - gap
  if (above >= viewport.top + gap) return above
  const below = anchor.bottom + gap
  if (below + height <= viewport.bottom - gap) return below
  const top = viewport.top + gap
  const bottom = Math.max(top, viewport.bottom - height - gap)
  const line = caret ?? anchor
  if (top + height + gap <= line.top) return top
  if (bottom >= line.bottom + gap) return bottom
  return Math.abs(top + height / 2 - (line.top + line.bottom) / 2)
    > Math.abs(bottom + height / 2 - (line.top + line.bottom) / 2) ? top : bottom
}

export function blockFormatToolbarSafeTop(anchor: VerticalBox, height: number, viewport: VerticalBox,
  controls: VerticalBox[], caret?: VerticalBox, canPlace: (top: number) => boolean = () => true): number {
  const preferred = blockFormatToolbarTop(anchor, height, viewport, caret), gap = 6
  const topEdge = viewport.top + gap, bottomEdge = Math.max(topEdge, viewport.bottom - height - gap)
  const candidates = [...new Set([preferred, anchor.top - height - gap, anchor.bottom + gap, ...controls.flatMap(box => [box.top - height - gap, box.bottom + gap])])]
    .sort((a, b) => Math.abs(a - preferred) - Math.abs(b - preferred)).slice(0, 9)
  candidates.push(topEdge, bottomEdge)
  const line = caret ?? anchor
  return candidates.find(top => top >= topEdge && top <= bottomEdge
    && (top + height + gap <= line.top || top >= line.bottom + gap)
    && controls.every(box => top + height + gap <= box.top || top >= box.bottom + gap)
    && canPlace(top)) ?? preferred
}

// Textarea selections have no Range rectangle. Measure the current line only
// when a long paragraph fills the viewport and neither outer edge has space.
function caretBox(textarea: HTMLTextAreaElement): VerticalBox {
  const bounds = textarea.getBoundingClientRect()
  const mirror = document.createElement('div')
  const style = getComputedStyle(textarea)
  mirror.style.cssText = 'position:fixed;visibility:hidden;white-space:pre-wrap;overflow-wrap:break-word;pointer-events:none'
  for (const property of ['font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing', 'line-height',
    'padding', 'border', 'box-sizing', 'word-break', 'tab-size', 'text-align', 'text-indent']) {
    mirror.style.setProperty(property, style.getPropertyValue(property))
  }
  mirror.style.width = `${bounds.width}px`
  mirror.style.left = `${bounds.left}px`
  mirror.style.top = `${bounds.top - textarea.scrollTop}px`
  mirror.textContent = textarea.value.slice(0, textarea.selectionStart)
  const caret = document.createElement('span')
  caret.textContent = textarea.value[textarea.selectionStart] || '\u200b'
  mirror.append(caret)
  document.body.append(mirror)
  try {
    const line = caret.getBoundingClientRect()
    return { top: line.top, bottom: line.bottom }
  } finally { mirror.remove() }
}

export function BlockFormatToolbar({ textareaRef, onFormat, onReturnToEditor, isZh, children }: {
  textareaRef: RefObject<HTMLTextAreaElement | null>
  onFormat: (format: MarkdownFormat) => void
  onReturnToEditor: () => void
  isZh: boolean
  children?: ReactNode
}) {
  useLayoutEffect(() => {
    const textarea = textareaRef.current
    const column = textarea?.parentElement
    const toolbar = column?.querySelector<HTMLElement>(':scope > .markdown-format-toolbar')
    if (!textarea || !column || !toolbar) return
    const panel = textarea.closest<HTMLElement>('.preview-panel')
    const update = () => {
      const anchor = textarea.getBoundingClientRect()
      const bounds = panel?.getBoundingClientRect()
      const viewport = {
        top: Math.max(0, bounds ? bounds.top + (panel?.clientTop ?? 0) : 0),
        bottom: Math.min(window.innerHeight, bounds ? bounds.top + (panel?.clientTop ?? 0) + (panel?.clientHeight || bounds.height) : window.innerHeight),
        left: Math.max(0, bounds ? bounds.left + (panel?.clientLeft ?? 0) : 0),
        right: Math.min(window.innerWidth, bounds ? bounds.left + (panel?.clientLeft ?? 0) + (panel?.clientWidth || bounds.width) : window.innerWidth)
      }
      const left = Math.max(anchor.left, viewport.left)
      const columnBounds = column.getBoundingClientRect()
      const right = Math.min(columnBounds.right, viewport.right)
      if (anchor.height <= 0 || window.getComputedStyle(textarea).maxHeight === '0px'
        || anchor.bottom <= viewport.top || anchor.top >= viewport.bottom || right <= left) {
        toolbar.style.visibility = 'hidden'
        return
      }
      toolbar.style.maxWidth = `${right - left}px`
      toolbar.style.maxHeight = `${Math.max(0, viewport.bottom - viewport.top - 12)}px`
      const height = toolbar.getBoundingClientRect().height
      const needsCaret = anchor.top - height - 6 < viewport.top + 6 && anchor.bottom + height + 6 > viewport.bottom - 6
      const width = toolbar.getBoundingClientRect().width, owner = textarea.ownerDocument
      const selector = 'textarea,input,select,button,a[href],[contenteditable="true"]'
      const row = textarea.closest<HTMLElement>('.block-editor-row'), neighbors = row ? [row] : []
      // Bound layout reads to this row and two immediate neighbors each side.
      // Typing in a large document never scans its full block list.
      for (const direction of ['previousElementSibling', 'nextElementSibling'] as const) {
        let sibling = row?.[direction]
        for (let count = 0; sibling && count < 2; count++, sibling = sibling[direction]) {
          if (sibling instanceof HTMLElement && sibling.matches('.block-editor-row')) neighbors.push(sibling)
        }
      }
      const controls: VerticalBox[] = []
      for (const neighbor of neighbors) {
        let measured = 0
        for (const element of neighbor.querySelectorAll<HTMLElement>(selector)) {
          if (element === textarea || toolbar.contains(element)) continue
          if (++measured > 12) break
          const box = element.getBoundingClientRect()
          if (box.width > 0 && box.height > 0 && box.right > left && box.left < left + width
            && box.bottom > viewport.top && box.top < viewport.bottom) controls.push(box)
        }
      }
      const canPlace = (top: number) => {
        if (typeof owner.elementsFromPoint !== 'function') return true
        // Sample the candidate surface to catch controls beyond the bounded
        // neighbors without enumerating or measuring thousands of DOM nodes.
        for (const x of [left + 2, left + width / 2, left + width - 2]) {
          for (const y of [top + 2, top + height / 2, top + height - 2]) {
            for (const hit of owner.elementsFromPoint(x, y)) {
              if (toolbar.contains(hit)) continue
              const control = hit.closest(selector)
              if (control && control !== textarea && !toolbar.contains(control)) return false
            }
          }
        }
        return true
      }
      const top = blockFormatToolbarSafeTop(anchor, height, viewport, controls, needsCaret ? caretBox(textarea) : undefined, canPlace)
      toolbar.style.left = `${left - columnBounds.left + column.scrollLeft - column.clientLeft}px`
      toolbar.style.top = `${top - columnBounds.top + column.scrollTop - column.clientTop}px`
      toolbar.style.visibility = 'visible'
    }
    update()
    document.addEventListener('scroll', update, true)
    document.addEventListener('selectionchange', update)
    textarea.addEventListener('select', update)
    window.addEventListener('resize', update)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    for (const element of [textarea, column, toolbar, panel]) if (element) observer?.observe(element)
    return () => {
      document.removeEventListener('scroll', update, true)
      document.removeEventListener('selectionchange', update)
      textarea.removeEventListener('select', update)
      window.removeEventListener('resize', update)
      observer?.disconnect()
    }
  }, [textareaRef])
  return <MarkdownFormatToolbar isZh={isZh} onFormat={onFormat} onReturnToEditor={onReturnToEditor}>{children}</MarkdownFormatToolbar>
}
