const pending = new Set<HTMLTextAreaElement>()
let frame: number | null = null

// Measure a batch together: shrinking each textarea and reading it immediately
// forces a full document layout for every block in a long note.
export function scheduleTextareaResize(textarea: HTMLTextAreaElement | null): void {
  if (!textarea) return
  pending.add(textarea)
  if (frame !== null) return
  frame = requestAnimationFrame(() => {
    frame = null
    const textareas = [...pending].filter((element) => element.isConnected)
    pending.clear()
    const scrollPositions = new Map<Element, number>()
    for (const element of textareas) {
      const container = element.closest('.preview-panel') ?? document.documentElement
      if (!scrollPositions.has(container)) scrollPositions.set(container, container.scrollTop)
    }
    textareas.forEach((element) => { element.style.height = '0px' })
    const heights = textareas.map((element) => element.scrollHeight)
    textareas.forEach((element, index) => { element.style.height = `${heights[index]}px` })
    for (const [container, top] of scrollPositions) container.scrollTop = top
  })
}
