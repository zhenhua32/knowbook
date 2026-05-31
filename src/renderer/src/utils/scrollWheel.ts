export function forwardWheelToClosestContentScroller(element: HTMLElement, deltaX: number, deltaY: number): boolean {
  if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) {
    return false
  }

  const contentScroller = element.closest('.content')
  if (!(contentScroller instanceof HTMLElement)) {
    return false
  }

  contentScroller.scrollBy({
    left: deltaX,
    top: deltaY,
    behavior: 'auto'
  })

  return true
}