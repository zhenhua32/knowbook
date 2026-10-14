export type RichTextDomPoint = { blockId: string; offset: number }

/** Run as one browser task: native focus repairs must observe the requested
 * selection, never a caret installed by a later automation RPC. */
export function setRichTextDomSelection(root: Element, { from, to = from, backward = false }: {
  from: RichTextDomPoint; to?: RichTextDomPoint; backward?: boolean
}): void {
  const owner = root.ownerDocument, view = owner.defaultView!
  ;(root as HTMLElement).focus()
  const resolve = (point: RichTextDomPoint) => {
    const block = [...root.querySelectorAll<HTMLElement>('[data-block-id]')].find(node => node.dataset.blockId === point.blockId)
    if (!block) throw new Error(`Missing selection block: ${point.blockId}`)
    const walker = owner.createTreeWalker(block, view.NodeFilter.SHOW_TEXT, {
      acceptNode: node => node.parentElement?.closest('[contenteditable="false"]') ? view.NodeFilter.FILTER_REJECT : view.NodeFilter.FILTER_ACCEPT
    })
    let remaining = point.offset, last: Node | null = null
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      last = node
      const length = node.textContent?.length ?? 0
      if (remaining <= length) return { node, offset: remaining }
      remaining -= length
    }
    if (remaining) throw new Error(`Selection offset outside block: ${point.blockId}:${point.offset}`)
    return last ? { node: last, offset: last.textContent?.length ?? 0 } : { node: block, offset: 0 }
  }
  const start = resolve(from), end = resolve(to), range = owner.createRange()
  range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset)
  const selection = view.getSelection()!
  selection.removeAllRanges(); selection.addRange(range)
  if (backward) selection.setBaseAndExtent(end.node, end.offset, start.node, start.offset)
}
