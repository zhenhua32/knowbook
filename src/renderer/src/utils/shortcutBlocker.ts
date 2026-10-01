/** Retained hidden drafts must not block shortcuts on the current surface. */
export function hasVisibleShortcutBlocker(root: ParentNode = document): boolean {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-block-shortcuts]')).some(surface =>
    !surface.closest('[hidden], [inert]') && surface.getClientRects().length > 0)
}
