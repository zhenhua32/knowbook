export type ColdBlockPopup = {
  claim: (popupScope?: HTMLElement | null) => boolean
  vetoed: () => boolean
  canRestore: () => boolean
  dispose: () => void
}

/** Later activity permanently cancels a pending lazy popup. After claim, an
 * exact popup owns attention; losing it also vetoes its eventual return focus. */
export function createColdBlockPopup(opener: HTMLElement | null, handoffScope: HTMLElement | null = null): ColdBlockPopup {
  const owner = opener?.ownerDocument ?? document, view = owner.defaultView
  let veto = false, restoreVeto = false, claimed = false, disposed = false, expired = false
  let popupScope: HTMLElement | null = null
  const belongs = (target: EventTarget | null) => target === opener || !!(target instanceof HTMLElement
    && (handoffScope?.contains(target) || popupScope?.contains(target)
      || popupScope?.previousElementSibling?.matches('.context-menu-overlay') && popupScope.previousElementSibling.contains(target)))
  const cleanup = () => {
    if (disposed) return
    disposed = true
    owner.removeEventListener('pointerdown', activity, true)
    owner.removeEventListener('keydown', activity, true)
    owner.removeEventListener('compositionstart', activity, true)
    owner.removeEventListener('focusin', focusChanged, true)
    view?.removeEventListener('blur', blurred)
  }
  const abandon = () => { restoreVeto = true; if (!claimed) { veto = true; cleanup() } }
  const activity = (event: Event) => { if (!claimed || !belongs(event.target)) abandon() }
  const focusChanged = (event: FocusEvent) => { if (!belongs(event.target)) abandon() }
  const blurred = () => abandon()
  owner.addEventListener('pointerdown', activity, true)
  owner.addEventListener('keydown', activity, true)
  owner.addEventListener('compositionstart', activity, true)
  owner.addEventListener('focusin', focusChanged, true)
  view?.addEventListener('blur', blurred)
  return {
    claim: scope => {
      if (veto || expired) return false
      if (scope) popupScope = scope
      claimed = true
      return true
    },
    vetoed: () => veto,
    canRestore: () => !restoreVeto,
    dispose: () => { expired = true; cleanup() }
  }
}
