export function isSameOriginNavigation(currentUrl: string | undefined | null, targetUrl: string): boolean {
  if (!currentUrl) {
    return false
  }

  try {
    const current = new URL(currentUrl)
    const target = new URL(targetUrl)

    if (current.protocol === 'file:' || target.protocol === 'file:') {
      return current.href === target.href
    }

    return current.origin !== 'null' && current.origin === target.origin
  } catch {
    return false
  }
}
