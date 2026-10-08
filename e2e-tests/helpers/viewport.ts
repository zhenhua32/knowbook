import { expect, type Locator, type Page } from '@playwright/test'

async function fieldGeometry(field: Locator) {
  return field.evaluate(element => {
    const content = element.closest<HTMLElement>('.content')
    if (!content) throw new Error('The field must belong to the real content scroll region.')
    const rect = element.getBoundingClientRect(), bounds = content.getBoundingClientRect()
    const style = getComputedStyle(content)
    const borderTop = parseFloat(style.borderTopWidth) || 0
    const borderBottom = parseFloat(style.borderBottomWidth) || 0
    const borderLeft = parseFloat(style.borderLeftWidth) || 0
    const borderRight = parseFloat(style.borderRightWidth) || 0
    return {
      field: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
      clip: {
        top: Math.max(0, bounds.top + borderTop),
        bottom: Math.min(innerHeight, bounds.bottom - borderBottom, bounds.top + borderTop + content.clientHeight),
        left: Math.max(0, bounds.left + borderLeft),
        right: Math.min(innerWidth, bounds.right - borderRight, bounds.left + borderLeft + content.clientWidth)
      },
      scrollTop: content.scrollTop,
      maximumScrollTop: Math.max(0, content.scrollHeight - content.clientHeight)
    }
  })
}

/** Reveal a complete input/action/feedback group through the real scroll region. */
export async function revealWholeField(page: Page, field: Locator): Promise<void> {
  await field.scrollIntoViewIfNeeded()
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = await fieldGeometry(field)
    const direction = before.field.bottom > before.clip.bottom - 8 ? 1
      : before.field.top < before.clip.top + 8 ? -1 : 0
    if (!direction || (direction > 0 ? before.scrollTop >= before.maximumScrollTop : before.scrollTop <= 0)) break
    const x = Math.min(before.clip.left + 8, before.clip.right - 8)
    const y = (before.clip.top + before.clip.bottom) / 2
    await page.mouse.move(x, y)
    await page.mouse.wheel(0, direction * 120)
    await expect.poll(() => field.evaluate(element => element.closest<HTMLElement>('.content')!.scrollTop)).not.toBe(before.scrollTop)
    const after = await fieldGeometry(field)
    console.log(`[whole-field-reveal] ${JSON.stringify({ before, after })}`)
  }
  await expect(field).toBeInViewport({ ratio: 1 })
}
