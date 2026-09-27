import { useEffect, useId, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { getActiveUiText } from '../i18n'
import { trapFocusWithinDialog } from '../utils/dialogFocus'
import { isImeKeyboardEvent } from '../utils/imeKeyboard'
import { filterShortcuts, shortcutGroups, shortcutKeyLabel, type ShortcutGroup, type ShortcutText } from '../utils/shortcutCatalog'
import './shortcut-help-dialog.css'

export function showShortcutHelp(previous: HTMLElement | null): Promise<void> {
  return new Promise((resolve) => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      queueMicrotask(() => { root.unmount(); container.remove(); resolve() })
    }
    root.render(<ShortcutHelpDialog previous={previous} onClose={close} />)
  })
}

function ShortcutHelpDialog({ previous, onClose }: { previous: HTMLElement | null; onClose: () => void }) {
  const [query, setQuery] = useState(''), [group, setGroup] = useState<ShortcutGroup | ''>('')
  const dialog = useRef<HTMLDialogElement>(null), search = useRef<HTMLInputElement>(null), composing = useRef(false)
  const titleId = useId(), hintId = useId()
  const zh = getActiveUiText().language === 'zh-CN', mac = /Mac|iPhone|iPad/i.test(navigator.platform)
  const text = (value: ShortcutText) => value[zh ? 0 : 1]
  const results = filterShortcuts(query, group)

  useEffect(() => {
    const element = dialog.current!
    element.showModal()
    search.current?.focus()
    const keydown = (event: KeyboardEvent) => {
      if (isImeKeyboardEvent(event, composing.current)) {
        if (event.key === 'Escape') event.preventDefault()
        event.stopPropagation()
        return
      }
      if (event.key === 'Escape' || (event.key === 'F1' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey)) {
        event.preventDefault()
        if (!event.repeat) onClose()
      }
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault(); search.current?.focus(); search.current?.select()
      }
      trapFocusWithinDialog(event, element)
      event.stopPropagation()
    }
    window.addEventListener('keydown', keydown, true)
    return () => {
      window.removeEventListener('keydown', keydown, true)
      element.close()
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [onClose, previous])

  const reset = () => { setQuery(''); setGroup(''); search.current?.focus() }
  return <dialog ref={dialog} className="shortcut-help-dialog" aria-labelledby={titleId} aria-describedby={hintId}
    onCancel={(event) => { event.preventDefault(); if (!composing.current) onClose() }}
    onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}>
    <header><div><h2 id={titleId}>{zh ? '快捷键帮助' : 'Keyboard shortcuts'}</h2>
      <p id={hintId}>{zh ? '按操作名称或组合键搜索，查看它们在哪里生效。' : 'Search actions or key combinations and see where they work.'}</p></div>
      <button type="button" className="secondary-button" aria-label={zh ? '关闭快捷键帮助' : 'Close keyboard shortcuts'} onClick={onClose}>✕</button></header>
    <div className="shortcut-help-filters">
      <input ref={search} type="search" value={query} onChange={(event) => setQuery(event.target.value)} spellCheck={false}
        aria-label={zh ? '搜索快捷键' : 'Search shortcuts'} placeholder={zh ? '例如：加粗、Ctrl+K、复制块' : 'Try bold, Ctrl+K, or duplicate'} />
      <select aria-label={zh ? '快捷键分类' : 'Shortcut category'} value={group} onChange={(event) => setGroup(event.target.value as ShortcutGroup | '')}>
        <option value="">{zh ? '全部分类' : 'All categories'}</option>
        {shortcutGroups.map((item) => <option key={item.id} value={item.id}>{text(item.title)}</option>)}
      </select>
    </div>
    <div className="shortcut-help-results" tabIndex={0} aria-label={zh ? '快捷键列表' : 'Shortcut list'}>
      {shortcutGroups.map((section) => {
        const rows = results.filter((item) => item.group === section.id)
        return rows.length > 0 && <section key={section.id} aria-labelledby={`${titleId}-${section.id}`}>
          <h3 id={`${titleId}-${section.id}`}>{text(section.title)}</h3><p className="shortcut-help-scope">{text(section.scope)}</p>
          <dl>{rows.map((item) => <div key={item.id} data-shortcut-id={item.id} className="shortcut-help-row">
            <dt><strong>{text(item.title)}</strong>{item.note && <span>{text(item.note)}</span>}</dt>
            <dd>{item.keys.map((keys, index) => <span className="shortcut-help-combination" key={index}>
              {index > 0 && <span className="shortcut-help-or">{zh ? '或' : 'or'}</span>}
              {keys.map((key, i) => <kbd key={i}>{shortcutKeyLabel(key, mac)}</kbd>)}
            </span>)}</dd>
          </div>)}</dl>
        </section>
      })}
      {results.length === 0 && <div className="shortcut-help-empty"><h3>{zh ? '没有匹配的快捷键' : 'No matching shortcuts'}</h3>
        <p>{zh ? '试试操作名称、按键名称，或清除筛选。' : 'Try an action, a key name, or clear the filters.'}</p>
        <button type="button" className="secondary-button" onClick={reset}>{zh ? '清除筛选' : 'Clear filters'}</button></div>}
    </div>
    <footer><span role="status" aria-live="polite">{zh ? `${results.length} 项快捷键` : `${results.length} shortcuts`}</span>
      <span>{mac ? (zh ? '⌘ = Command · ⌥ = Option · F1 可能需要 Fn' : '⌘ = Command · ⌥ = Option · F1 may require Fn') : (zh ? 'Windows / Linux' : 'Windows / Linux')}</span>
      <span><kbd>Esc</kbd> {zh ? '关闭' : 'Close'}</span></footer>
  </dialog>
}
