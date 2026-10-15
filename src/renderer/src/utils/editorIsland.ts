/** Embedded editors own their inputs independently of the surrounding document.
 * Portaled controls carry the same marker so native DOM capture sees ownership. */
export function getDatabaseEditorIsland(target: EventTarget | null | undefined): HTMLElement | null {
  if (typeof Element === 'undefined' || typeof Node === 'undefined') return null
  const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null
  return element?.closest<HTMLElement>('[data-editor-island="database-view"]') ?? null
}

export function isDatabaseEditorIsland(target: EventTarget | null | undefined): boolean {
  return getDatabaseEditorIsland(target) !== null
}

export function getSyncedEditorIsland(target: EventTarget | null | undefined): HTMLElement | null {
  if (typeof Element === 'undefined' || typeof Node === 'undefined') return null
  const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null
  return element?.closest<HTMLElement>('[data-editor-island="synced-group"]') ?? null
}

/** Host body handlers must leave both kinds of embedded owner to their own editor. */
export function isIndependentEditorIsland(target: EventTarget | null | undefined): boolean {
  return isDatabaseEditorIsland(target) || getSyncedEditorIsland(target) !== null
}
