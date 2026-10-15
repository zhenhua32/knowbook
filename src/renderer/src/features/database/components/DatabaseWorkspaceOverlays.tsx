import { useLayoutEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export function DatabaseWorkspaceOverlays({ embedded, active, hostRef, children }: {
  embedded: boolean; active: boolean; hostRef: { current: HTMLElement | null }; children: ReactNode
}) {
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    if (!embedded) return
    const node = document.createElement('div')
    node.className = 'dbw-shell inline-database-overlays'
    node.dataset.editorIsland = 'database-view'
    document.body.append(node); hostRef.current = node; setHost(node)
    return () => { hostRef.current = null; node.remove() }
  }, [embedded, hostRef])
  useLayoutEffect(() => {
    if (!host) return
    if (active) host.setAttribute('data-block-shortcuts', '')
    else host.removeAttribute('data-block-shortcuts')
  }, [active, host])
  return embedded ? host ? createPortal(children, host) : null : children
}
