const DIALOG_FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  'iframe',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

export function getDialogFocusableElements(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE_SELECTOR)]
    .filter((element) => element.getAttribute('aria-hidden') !== 'true')
}

export function trapFocusWithinDialog(event: KeyboardEvent, dialog: HTMLElement): boolean {
  if (event.key !== 'Tab') return false
  const focusable = getDialogFocusableElements(dialog)
  if (focusable.length === 0) {
    event.preventDefault()
    dialog.focus()
    return true
  }

  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  const active = dialog.ownerDocument.activeElement
  if (!dialog.contains(active)) {
    event.preventDefault()
    ;(event.shiftKey ? last : first).focus()
    return true
  }
  if (event.shiftKey && active === first) {
    event.preventDefault()
    last.focus()
    return true
  }
  if (!event.shiftKey && active === last) {
    event.preventDefault()
    first.focus()
    return true
  }
  return false
}
