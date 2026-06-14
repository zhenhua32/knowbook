export const VIEWPORT_MENU_MARGIN = 12

type MenuPoint = {
  x: number
  y: number
}

type MenuSize = {
  width: number
  height: number
}

type ViewportSize = {
  width: number
  height: number
}

export function constrainViewportMenuPosition(
  anchor: MenuPoint,
  menuSize: MenuSize,
  viewportSize: ViewportSize,
  margin = VIEWPORT_MENU_MARGIN
): MenuPoint {
  const maxX = Math.max(margin, viewportSize.width - menuSize.width - margin)
  const maxY = Math.max(margin, viewportSize.height - menuSize.height - margin)

  return {
    x: Math.min(Math.max(margin, anchor.x), maxX),
    y: Math.min(Math.max(margin, anchor.y), maxY)
  }
}