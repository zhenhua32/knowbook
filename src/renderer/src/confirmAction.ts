import type { ConfirmationOptions } from './components/ConfirmationDialog'

let pending = false

/** Only one confirmation may own an action at a time, including while loading. */
export async function confirmAction(options: ConfirmationOptions): Promise<boolean> {
  if (pending) return false
  pending = true
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  try {
    const { showConfirmation } = await import('./components/showConfirmation')
    return await showConfirmation(options, returnFocus)
  } finally { pending = false }
}
