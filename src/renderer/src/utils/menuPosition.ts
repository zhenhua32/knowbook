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

const SLASH_PANEL_MARGIN_PX = 10

function parsePixelValue(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback
  }
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function estimateTextWidth(text: string, fontSize: number): number {
  let width = 0
  for (const char of text) {
    width += /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(char) ? fontSize : fontSize * 0.55
  }
  return width
}

export function computeSlashPanelPosition(
  rect: Pick<DOMRect, 'left' | 'top' | 'width'>,
  lineHeightStyle: string,
  fontSizeStyle: string,
  textBeforeCursor: string
): MenuPoint {
  const fontSize = parsePixelValue(fontSizeStyle, 16)
  const lineHeight = parsePixelValue(lineHeightStyle, Math.round(fontSize * 1.5))

  const rawX = rect.left + estimateTextWidth(textBeforeCursor, fontSize)
  const maxX = rect.left + rect.width - SLASH_PANEL_MARGIN_PX
  const x = Math.max(rect.left, Math.min(rawX, maxX))
  const y = rect.top + lineHeight + SLASH_PANEL_MARGIN_PX

  return { x, y }
}