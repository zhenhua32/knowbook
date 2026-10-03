import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'
import type { DatabaseSavedView, DatabaseSavedViewLayoutMode } from '@shared/contracts'
import type { DatabaseWorkspaceText } from '../databaseText'
import { useViewportMenuPosition } from '../../../hooks/useViewportMenuPosition'
import { isImeKeyboardEvent } from '../../../utils/imeKeyboard'

type ViewMenu = { viewId: string; databaseId: string; trigger: HTMLButtonElement; x: number; y: number }

function visible(element: HTMLElement): boolean {
  if (!element.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]') || !element.getClientRects().length) return false
  const style = element.ownerDocument.defaultView?.getComputedStyle(element)
  return Boolean(style && style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse')
}

function canFocus(trigger: HTMLButtonElement, menu: HTMLElement | null): boolean {
  const owner = trigger.ownerDocument
  return owner.hasFocus() && visible(trigger) && !trigger.matches(':disabled, [aria-disabled="true"]')
    && !Array.from(owner.querySelectorAll<HTMLElement>('dialog[open], [aria-modal="true"], [role="alertdialog"]'))
      .some(modal => modal !== menu && !modal.contains(trigger) && visible(modal))
}

export function DatabaseViewTabs({
  activeViewId,
  dirty,
  newViewTriggerRef,
  savedViews,
  sourceSessionKey,
  text,
  onCreateView,
  onDeleteView,
  onMoveView,
  onRenameView,
  onSelectView
}: {
  activeViewId: string
  dirty: boolean
  newViewTriggerRef?: RefObject<HTMLElement | null>
  savedViews: DatabaseSavedView[]
  sourceSessionKey?: unknown
  text: DatabaseWorkspaceText
  onCreateView: (layout: DatabaseSavedViewLayoutMode, returnTarget: HTMLElement | null) => void
  onDeleteView: (view: DatabaseSavedView, returnTarget: HTMLElement) => void | boolean
  onMoveView: (viewId: string, targetViewId: string) => void
  onRenameView: (view: DatabaseSavedView, returnTarget: HTMLElement) => void
  onSelectView: (viewId: string) => void
}) {
  const [draggingViewId, setDraggingViewId] = useState<string | null>(null)
  const localTriggerRef = useRef<HTMLElement | null>(null)
  const triggerRef = newViewTriggerRef ?? localTriggerRef
  const [menu, setMenu] = useState<ViewMenu | null>(null)
  const menuId = useId()
  const composingTarget = useRef<EventTarget | null>(null)
  const menuView = menu ? savedViews.find(view => view.id === menu.viewId && view.databaseId === menu.databaseId) : undefined
  useLayoutEffect(() => { setMenu(null); composingTarget.current = null }, [activeViewId, sourceSessionKey])
  useLayoutEffect(() => {
    if (menu && (!menuView || !visible(menu.trigger))) setMenu(null)
  }, [menu, menuView])
  return (
    <nav aria-label={text.newView} className="dbw-view-tabs"
      onCompositionStartCapture={event => { composingTarget.current = event.target }}
      onCompositionEndCapture={() => { composingTarget.current = null }}
      onBlurCapture={event => { if (composingTarget.current === event.target) composingTarget.current = null }}>
      <div className="dbw-view-tab-list">
        {savedViews.length === 0 ? (
          <button aria-current="page" className="dbw-view-tab is-active" type="button">
            <LayoutIcon layout="table" />
            {text.all}
            {dirty ? <span aria-label="unsaved" className="dbw-unsaved-dot" /> : null}
          </button>
        ) : savedViews.map((view) => (
          <div
            className={`dbw-view-tab-wrap${activeViewId === view.id ? ' is-active' : ''}${draggingViewId === view.id ? ' is-dragging' : ''}`}
            draggable
            key={view.id}
            onDragEnd={() => setDraggingViewId(null)}
            onDragOver={(event) => event.preventDefault()}
            onDragStart={() => setDraggingViewId(view.id)}
            onDrop={(event) => {
              event.preventDefault()
              if (draggingViewId && draggingViewId !== view.id) onMoveView(draggingViewId, view.id)
              setDraggingViewId(null)
            }}
          >
            <button
              aria-current={activeViewId === view.id ? 'page' : undefined}
              className="dbw-view-tab"
              onClick={() => onSelectView(view.id)}
              onDoubleClick={(event) => onRenameView(view, event.currentTarget)}
              title={view.name}
              type="button"
            >
              <LayoutIcon layout={view.config.layout} />
              <span>{view.name}</span>
              {activeViewId === view.id && dirty ? <span aria-label="unsaved" className="dbw-unsaved-dot" /> : null}
            </button>
            <button
              aria-label={`${text.viewMenu}: ${view.name}`}
              aria-expanded={menu?.viewId === view.id}
              aria-haspopup="dialog"
              aria-controls={menu?.viewId === view.id ? menuId : undefined}
              className="dbw-view-tab-menu"
              onClick={event => {
                if (menu?.viewId === view.id) { setMenu(null); return }
                const trigger = event.currentTarget, bounds = trigger.getBoundingClientRect()
                setMenu({ viewId: view.id, databaseId: view.databaseId, trigger, x: bounds.left, y: bounds.bottom + 4 })
              }}
              onKeyDown={event => {
                if (menu?.viewId !== view.id) return
                // The open actions own their keys instead of the record canvas.
                event.stopPropagation()
                if (event.defaultPrevented || event.key !== 'Escape'
                  || isImeKeyboardEvent(event.nativeEvent, composingTarget.current === event.target)) return
                event.preventDefault()
                setMenu(null)
                composingTarget.current = null
              }}
              title={`${text.viewMenu}: ${view.name}`}
              type="button"
            ><span aria-hidden="true">•••</span></button>
          </div>
        ))}
      </div>

      <details className="dbw-new-view-menu">
        <summary ref={triggerRef}><span aria-hidden="true">＋</span>{text.newView}</summary>
        <div className="dbw-popover dbw-layout-menu">
          <button onClick={(event) => { const target = triggerRef.current; event.currentTarget.closest('details')?.removeAttribute('open'); onCreateView('table', target) }} type="button"><LayoutIcon layout="table" />{text.table}</button>
          <button onClick={(event) => { const target = triggerRef.current; event.currentTarget.closest('details')?.removeAttribute('open'); onCreateView('board', target) }} type="button"><LayoutIcon layout="board" />{text.board}</button>
          <button onClick={(event) => { const target = triggerRef.current; event.currentTarget.closest('details')?.removeAttribute('open'); onCreateView('cards', target) }} type="button"><LayoutIcon layout="cards" />{text.cards}</button>
        </div>
      </details>
      {menu && menuView ? <ViewActionsMenu id={menuId} anchor={menu} view={menuView} text={text}
        onClose={() => setMenu(null)} onRename={() => { setMenu(null); onRenameView(menuView, menu.trigger) }}
        onDelete={() => { if (onDeleteView(menuView, menu.trigger) !== false) setMenu(null) }} /> : null}
    </nav>
  )
}

function ViewActionsMenu({ id, anchor, view, text, onClose, onRename, onDelete }: {
  id: string; anchor: ViewMenu; view: DatabaseSavedView; text: DatabaseWorkspaceText
  onClose: () => void; onRename: () => void; onDelete: () => void
}) {
  const { menuRef, menuStyle } = useViewportMenuPosition<HTMLDivElement>(anchor.x, anchor.y)
  const close = useRef(onClose), composingTarget = useRef<EventTarget | null>(null)
  close.current = onClose
  useLayoutEffect(() => {
    const menu = menuRef.current
    if (menu && menu.ownerDocument.activeElement === anchor.trigger && visible(menu) && canFocus(anchor.trigger, menu)) {
      menu.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
    }
  }, [anchor, menuRef])
  useEffect(() => {
    const menu = menuRef.current, owner = anchor.trigger.ownerDocument, window = owner.defaultView
    if (!menu || !window) return
    const outside = (event: Event) => {
      const target = event.target as Node | null
      if (!menu.contains(target) && !anchor.trigger.contains(target)) close.current()
    }
    const dismiss = () => close.current()
    owner.addEventListener('pointerdown', outside, true)
    owner.addEventListener('focusin', outside, true)
    owner.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    window.addEventListener('blur', dismiss)
    return () => {
      owner.removeEventListener('pointerdown', outside, true)
      owner.removeEventListener('focusin', outside, true)
      owner.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('blur', dismiss)
    }
  }, [anchor, menuRef])
  const keydown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || isImeKeyboardEvent(event.nativeEvent, composingTarget.current === event.target)) return
    const menu = event.currentTarget, owner = menu.ownerDocument
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      const ownsFocus = menu.contains(owner.activeElement)
      close.current()
      composingTarget.current = null
      if (ownsFocus && canFocus(anchor.trigger, menu)) anchor.trigger.focus({ preventScroll: true })
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !menu.contains(owner.activeElement)) return
    const buttons = Array.from(menu.querySelectorAll<HTMLButtonElement>('button')).filter(button => !button.disabled && visible(button))
    if (!buttons.length) return
    event.preventDefault()
    event.stopPropagation()
    const index = buttons.indexOf(owner.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
    buttons[next]?.focus({ preventScroll: true })
  }
  return <div id={id} role="dialog" aria-label={`${text.viewMenu}: ${view.name}`}
    className="dbw-popover dbw-action-menu dbw-view-actions-menu" ref={menuRef} style={menuStyle} onKeyDown={keydown}
    onCompositionStartCapture={event => { composingTarget.current = event.target }}
    onCompositionEndCapture={() => { composingTarget.current = null }}
    onBlurCapture={event => { if (composingTarget.current === event.target) composingTarget.current = null }}>
    <button onClick={onRename} type="button">{text.rename}</button>
    <button className="dbw-danger-text" onClick={onDelete} type="button">{text.deleteView}</button>
  </div>
}

export function LayoutIcon({ layout }: { layout: DatabaseSavedViewLayoutMode }) {
  return <span aria-hidden="true" className={`dbw-layout-icon dbw-layout-icon-${layout}`} />
}
