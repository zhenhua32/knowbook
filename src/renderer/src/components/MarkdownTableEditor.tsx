import { createElement, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { editMarkdownTable, parseEditableMarkdownTable, parseTableClipboard, serializeEditableMarkdownTable, type MarkdownTableEdit, type TableOperation } from '@shared/markdownTableEditing'
import { parseMarkdownTableNode } from '@shared/markdownTable'
import { MarkdownBlockNodesContext } from './MarkdownDocumentContext'
import { MarkdownNodes, MarkdownReferencesContext } from './MarkdownContent'
import { MarkdownFormatToolbar } from './MarkdownFormatToolbar'
import { formatMarkdownSelection, markdownFormatShortcut, type MarkdownFormat } from '../utils/markdownFormatting'
import { isImeKeyboardEvent } from '../utils/imeKeyboard'
import { restoreTableHistoryFocusEvent, withTableHistorySelection, type EditorHistoryBookmark } from '../utils/editorHistoryFocus'
import { DEFAULT_TABLE_COLUMN_WIDTH, MIN_TABLE_COLUMN_WIDTH, MAX_TABLE_COLUMN_WIDTH, validTableColumnWidth } from '@shared/markdownTableLayout'
import { mapTableGestureCell, tableGestureWidth } from '../utils/markdownTableGesture'
import '../styles/markdown-editing.css'
import '../styles/markdown-table-layout.css'

type Cell = { row: number; column: number }
export function MarkdownTableEditor({ content, onChange, onBeginEdit, isZh, sessionKey, onReady }: {
  content: string
  onChange: (content: string, transaction: boolean) => void
  onBeginEdit?: () => void
  isZh: boolean
  sessionKey?: string
  onReady?: (firstCell: HTMLElement | null) => void
}) {
  const table = useMemo(() => parseEditableMarkdownTable(content), [content])
  const [preview, setPreview] = useState<MarkdownTableEdit | null>(null)
  const nodes = useContext(MarkdownBlockNodesContext)
  const references = useContext(MarkdownReferencesContext)
  const parsed = useMemo(() => nodes?.find((node) => node.token.type === 'table_open')
    ?? parseMarkdownTableNode(content, { references: { ...references } }), [content, nodes, references])
  const [selected, setSelected] = useState<Cell>({ row: 0, column: 0 })
  const [editing, setEditing] = useState<(Cell & { value: string }) | null>(null)
  const container = useRef<HTMLDivElement>(null)
  const ready = useRef(onReady)
  ready.current = onReady
  useLayoutEffect(() => { ready.current?.(container.current?.querySelector<HTMLElement>('[data-row="0"][data-column="0"]') ?? null) }, [table, sessionKey])
  const editor = useRef<HTMLTextAreaElement>(null)
  const pendingFocus = useRef<{ cell: Cell; edit: boolean; selectAll?: boolean; range?: { start: number; end: number; direction?: EditorHistoryBookmark['direction'] } } | null>(null)
  const lastEmitted = useRef<string | undefined>(undefined)
  const composing = useRef(false)
  const currentContent = useRef(content)
  currentContent.current = content
  const gesture = useRef<{ pointerId: number; operation: TableOperation | null; source: string; sessionKey?: string; model: MarkdownTableEdit; dispose: () => void } | null>(null)
  const activePreview = preview && gesture.current?.source === content && gesture.current.sessionKey === sessionKey ? preview : null
  const shown = activePreview ?? table
  const previousSession = useRef(sessionKey)
  const cancelGesture = () => {
    const current = gesture.current
    if (!current) return
    gesture.current = null; current.dispose(); setPreview(null)
  }
  useLayoutEffect(() => {
    const changedSession = previousSession.current !== sessionKey
    previousSession.current = sessionKey
    cancelGesture()
    if (changedSession || content !== lastEmitted.current) pendingFocus.current = null
  }, [content, sessionKey])
  useEffect(() => () => { const current = gesture.current; gesture.current = null; current?.dispose() }, [])
  const cellValue = (model: MarkdownTableEdit, cell: Cell) => (cell.row ? model.rows[cell.row - 1] : model.headers)?.[cell.column] ?? ''
  useLayoutEffect(() => {
    const element = container.current
    const restore = (event: Event) => {
      const bookmark = (event as CustomEvent<EditorHistoryBookmark>).detail
      if (!table || !bookmark.cell) return
      const cell = { row: Math.min(bookmark.cell.row, table.rows.length), column: Math.min(bookmark.cell.column, table.headers.length - 1) }
      pendingFocus.current = { cell, edit: bookmark.cell.editing, range: { start: bookmark.start, end: bookmark.end, direction: bookmark.direction } }
      setSelected(cell)
      setEditing(bookmark.cell.editing ? { ...cell, value: cellValue(table, cell) } : null)
    }
    element?.addEventListener(restoreTableHistoryFocusEvent, restore)
    return () => element?.removeEventListener(restoreTableHistoryFocusEvent, restore)
  }, [table])
  useLayoutEffect(() => {
    const pending = pendingFocus.current
    if (!pending) return
    if (pending.edit && (!editing || editing.row !== pending.cell.row || editing.column !== pending.cell.column)) return
    const target = pending.edit ? editor.current
      : container.current?.querySelector<HTMLElement>(`[data-row="${pending.cell.row}"][data-column="${pending.cell.column}"]`)
    if (!target) return
    pendingFocus.current = null
    // Restore focus in the commit that changes the editor. A deferred frame
    // can run after the next Tab/shortcut and steal focus or use a stale range.
    if (document.activeElement !== target) target.focus()
    if (pending.edit && editor.current) {
      if (pending.range) editor.current.setSelectionRange(pending.range.start, pending.range.end, pending.range.direction)
      else if (pending.selectAll) editor.current.select()
    }
  })
  useEffect(() => {
    if (content === lastEmitted.current) return
    lastEmitted.current = undefined
    if (table) {
      setSelected((cell) => ({ row: Math.min(cell.row, table.rows.length), column: Math.min(cell.column, table.headers.length - 1) }))
      setEditing((cell) => cell && cell.row <= table.rows.length && cell.column < table.headers.length ? { ...cell, value: cellValue(table, cell) } : null)
    } else setEditing(null)
  }, [content, table])
  const focusCell = (cell: Cell, edit: boolean, model = table, initial?: string) => {
    if (!model) return
    pendingFocus.current = { cell, edit, selectAll: initial === undefined }
    setSelected(cell)
    if (edit) { onBeginEdit?.(); setEditing({ ...cell, value: initial ?? cellValue(model, cell) }) }
    else setEditing(null)
  }
  const apply = (operation: TableOperation, transaction = true): MarkdownTableEdit | null => {
    if (!table) return null
    const next = editMarkdownTable(table, operation)
    const source = serializeEditableMarkdownTable(next)
    if (next === table || source === content) return next
    lastEmitted.current = source
    onChange(source, transaction)
    return next
  }
  const updateValue = (value: string) => {
    if (!editing) return
    setEditing({ ...editing, value })
    apply({ kind: 'cell', ...editing, value }, false)
  }
  const format = (kind: MarkdownFormat) => {
    const input = editor.current
    if (!editing || !input || composing.current) return
    const result = formatMarkdownSelection(input.value, input.selectionStart, input.selectionEnd, kind, isZh ? '链接文字' : 'Link')
    onBeginEdit?.()
    pendingFocus.current = { cell: editing, edit: true, range: result }
    updateValue(result.content)
  }
  const moveEditing = (row: number, column: number) => {
    if (!table || row < 0 || column < 0 || column >= table.headers.length) return
    const next = row > table.rows.length ? apply({ kind: 'insert-row', row }) : table
    focusCell({ row, column }, true, next)
  }
  const run = (operation: TableOperation, cell = selected) => {
    const next = apply(operation)
    if (next) focusCell({ row: Math.min(cell.row, next.rows.length), column: Math.min(cell.column, next.headers.length - 1) }, false, next)
  }
  const commitGesture = (operation: TableOperation, model = table, originalSource = content, restoreFocus = true) => {
    if (!model || composing.current || currentContent.current !== originalSource) return
    const next = editMarkdownTable(model, operation), source = serializeEditableMarkdownTable(next)
    if (next === model || source === originalSource) return
    const cell = mapTableGestureCell(editing ?? selected, operation)
    const range = editing && editor.current ? { start: editor.current.selectionStart, end: editor.current.selectionEnd, direction: editor.current.selectionDirection } : undefined
    lastEmitted.current = source
    const checkpoint = () => { onBeginEdit?.(); onChange(source, true) }
    if (container.current) withTableHistorySelection(container.current, {
      source: originalSource, nextSource: source,
      before: { start: range?.start ?? 0, end: range?.end ?? 0, direction: range?.direction ?? 'none', cell: { ...(editing ?? selected), editing: Boolean(editing) } },
      after: { start: range?.start ?? 0, end: range?.end ?? 0, direction: range?.direction ?? 'none', cell: { ...cell, editing: Boolean(editing) } }
    }, checkpoint)
    else checkpoint()
    pendingFocus.current = restoreFocus ? { cell, edit: Boolean(editing), range } : null
    setSelected(cell); setEditing(editing ? { ...cell, value: cellValue(next, cell) } : null)
  }
  const beginGesture = (event: React.PointerEvent<HTMLButtonElement>, kind: 'resize' | 'row' | 'column', index: number) => {
    if (!table || composing.current || event.button !== 0 || kind === 'row' && index === 0) return
    event.preventDefault(); event.stopPropagation(); cancelGesture()
    // Reordering a captured row/column detaches its handle in Chromium and loses capture.
    const handle = kind === 'resize' ? event.currentTarget : container.current ?? event.currentTarget
    const owner = handle.ownerDocument, view = owner.defaultView!
    const startX = event.clientX, startY = event.clientY, source = content
    let model = table
    if (kind === 'resize' && !table.widths) {
      for (let column = 0; column < table.headers.length; column++) {
        const measured = container.current?.querySelector<HTMLElement>(`[data-row="0"][data-column="${column}"]`)?.getBoundingClientRect().width
        const width = typeof measured === 'number' && Number.isFinite(measured) && measured > 0 ? tableGestureWidth(measured, 0) : DEFAULT_TABLE_COLUMN_WIDTH
        model = editMarkdownTable(model, { kind: 'column-width', column, width })
      }
    }
    const initialWidth = model.widths?.[index] ?? DEFAULT_TABLE_COLUMN_WIDTH
    const move = (event: PointerEvent) => {
      const current = gesture.current
      if (!current || event.pointerId !== current.pointerId) return
      if (currentContent.current !== source || composing.current) { cancelGesture(); return }
      let operation: TableOperation | null = null
      if (kind === 'resize') {
        const width = tableGestureWidth(initialWidth, event.clientX - startX)
        if (width !== initialWidth) operation = { kind: 'column-width', column: index, width }
      } else if (Math.max(Math.abs(event.clientX - startX), Math.abs(event.clientY - startY)) >= 5) {
        const target = owner.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-row][data-column]')
        if (target && container.current?.contains(target)) {
          const destination = Number(kind === 'row' ? target.dataset.row : target.dataset.column)
          if (kind === 'row' && destination > 0 && destination <= table.rows.length && destination !== index) operation = { kind: 'move-row', row: index, toRow: destination }
          if (kind === 'column' && destination >= 0 && destination < table.headers.length && destination !== index) operation = { kind: 'move-column', column: index, toColumn: destination }
        }
      }
      current.operation = operation
      setPreview(operation ? editMarkdownTable(model, operation) : null)
    }
    const end = (event: PointerEvent) => {
      const current = gesture.current
      if (!current || event.pointerId !== current.pointerId) return
      const operation = current.operation
      cancelGesture()
      if (operation) commitGesture(operation, model, source)
    }
    const cancel = () => cancelGesture()
    const key = (event: KeyboardEvent) => {
      if (isImeKeyboardEvent(event, composing.current)) { cancel(); return }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel() }
      else cancel()
    }
    const focus = (event: FocusEvent) => { if (!(event.target instanceof Node) || !container.current?.contains(event.target)) cancel() }
    const dispose = () => {
      view.removeEventListener('pointermove', move, true); view.removeEventListener('pointerup', end, true)
      view.removeEventListener('pointercancel', cancel, true); view.removeEventListener('blur', cancel)
      owner.removeEventListener('keydown', key, true); owner.removeEventListener('focusin', focus, true); owner.removeEventListener('compositionstart', cancel, true)
      handle.removeEventListener('lostpointercapture', cancel)
      try { if (handle.hasPointerCapture?.(event.pointerId)) handle.releasePointerCapture(event.pointerId) } catch { /* Capture may already be lost. */ }
    }
    gesture.current = { pointerId: event.pointerId, operation: null, source, sessionKey, model, dispose }
    view.addEventListener('pointermove', move, true); view.addEventListener('pointerup', end, true)
    view.addEventListener('pointercancel', cancel, true); view.addEventListener('blur', cancel)
    owner.addEventListener('keydown', key, true); owner.addEventListener('focusin', focus, true); owner.addEventListener('compositionstart', cancel, true)
    handle.addEventListener('lostpointercapture', cancel)
    try { handle.setPointerCapture?.(event.pointerId) } catch { /* Window listeners still finish the gesture. */ }
  }
  if (!table) return <p role="status">{isZh ? '表格源码尚不完整，请展开源码继续编辑。' : 'The table source is incomplete. Expand its source to continue editing.'}</p>
  const head = parsed?.children.find((node) => node.token.type === 'thead_open')?.children ?? []
  const body = parsed?.children.find((node) => node.token.type === 'tbody_open')?.children ?? []
  const display = shown ?? table, rows = [display.headers, ...display.rows]
  const operation = activePreview ? gesture.current?.operation : null
  const columnOrder = table.headers.map((_value, index) => index), rowOrder = rows.map((_value, index) => index)
  if (operation?.kind === 'move-column') columnOrder.splice(operation.toColumn, 0, ...columnOrder.splice(operation.column, 1))
  if (operation?.kind === 'move-row') rowOrder.splice(operation.toRow, 0, ...rowOrder.splice(operation.row, 1))
  const displaySelected = operation ? mapTableGestureCell(selected, operation) : selected
  const displayEditing = editing && operation ? mapTableGestureCell(editing, operation) : editing
  const renderCell = (value: string, row: number, column: number) => {
    const cell = { row, column }
    const active = displayEditing?.row === row && displayEditing.column === column
    const isSelected = displaySelected.row === row && displaySelected.column === column
    const label = isZh ? `${row === 0 ? '表头' : '第 ' + row + ' 行'}，第 ${column + 1} 列` : `${row === 0 ? 'Header' : 'Row ' + row}, column ${column + 1}`
    const originalRow = rowOrder[row], originalColumn = columnOrder[column]
    const cellNodes = (originalRow ? body[originalRow - 1] : head[0])?.children[originalColumn]?.children
    return createElement(row ? 'td' : 'th', {
      key: originalColumn, role: row ? 'gridcell' : 'columnheader', scope: row ? undefined : 'col',
      'data-row': row, 'data-column': column, 'data-selected': isSelected, 'aria-selected': isSelected,
      'aria-rowindex': row + 1, 'aria-colindex': column + 1,
      tabIndex: isSelected && !active ? 0 : -1, 'aria-label': value ? undefined : label + (isZh ? '，空白' : ', empty'),
      style: { textAlign: display.alignments[column] ?? undefined },
      onFocus: () => { if (!gesture.current) setSelected(cell) },
      onClick: (event: React.MouseEvent<HTMLElement>) => { if (!(event.target as HTMLElement).closest('button, a, input, textarea')) focusCell(cell, true) },
      onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
        if (event.target !== event.currentTarget || isImeKeyboardEvent(event.nativeEvent, composing.current)) return
        if (event.key === 'Enter' || event.key === 'F2') { event.preventDefault(); focusCell(cell, true) }
        else if (!event.ctrlKey && !event.metaKey && !event.altKey && /^Arrow/.test(event.key)) {
          event.preventDefault()
          focusCell({ row: Math.max(0, Math.min(table.rows.length, row + (event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0))),
            column: Math.max(0, Math.min(table.headers.length - 1, column + (event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0))) }, false)
        }
      }
    }, row === 0 ? <><button type="button" tabIndex={-1} className="markdown-table-column-handle" aria-label={isZh ? `拖动第 ${column + 1} 列` : `Drag column ${column + 1}`}
      onMouseDown={event => event.preventDefault()} onPointerDown={event => beginGesture(event, 'column', column)} />
      <button type="button" tabIndex={-1} role="separator" aria-orientation="vertical" className="markdown-table-resize-handle"
        aria-label={isZh ? `调整第 ${column + 1} 列宽` : `Resize column ${column + 1}`} aria-valuemin={MIN_TABLE_COLUMN_WIDTH} aria-valuemax={MAX_TABLE_COLUMN_WIDTH}
        aria-valuenow={display.widths?.[column] ?? DEFAULT_TABLE_COLUMN_WIDTH} onMouseDown={event => event.preventDefault()}
        onPointerDown={event => beginGesture(event, 'resize', column)} onKeyDown={event => {
          if (isImeKeyboardEvent(event.nativeEvent, composing.current)) return
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault(); event.stopPropagation()
            commitGesture({ kind: 'column-width', column, width: tableGestureWidth(table.widths?.[column] ?? DEFAULT_TABLE_COLUMN_WIDTH, event.key === 'ArrowLeft' ? -10 : 10) })
          }
        }} /></> : column === 0 ? <button type="button" tabIndex={-1} className="markdown-table-row-handle"
          aria-label={isZh ? `拖动第 ${row} 行` : `Drag row ${row}`} onMouseDown={event => event.preventDefault()} onPointerDown={event => beginGesture(event, 'row', row)} /> : null,
      active ? <textarea ref={editor} aria-label={label} rows={1} value={displayEditing!.value} spellCheck={false}
      onChange={(event) => updateValue(event.target.value)}
      onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
      onBlur={(event) => { if (!gesture.current && !(event.relatedTarget as HTMLElement | null)?.closest('.markdown-format-toolbar')) setEditing(null) }}
      onPaste={(event) => {
        const text = event.clipboardData.getData('text/plain')
        if (!/[\t\r\n]/.test(text)) return
        event.preventDefault()
        const next = apply({ kind: 'paste', ...cell, cells: parseTableClipboard(text) })
        focusCell(cell, true, next)
      }}
      onKeyDown={(event) => {
        if (preview) return
        if (isImeKeyboardEvent(event.nativeEvent, composing.current)) { event.stopPropagation(); return }
        const shortcut = markdownFormatShortcut(event)
        if (shortcut) { event.preventDefault(); event.stopPropagation(); format(shortcut); return }
        if (event.altKey && event.key === 'F10' && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
          event.preventDefault(); event.stopPropagation()
          container.current?.querySelector<HTMLButtonElement>('.markdown-format-toolbar button')?.focus()
          return
        }
        const input = event.currentTarget
        if (event.key === 'Escape' || ((event.ctrlKey || event.metaKey) && event.key === 'Enter')) {
          event.preventDefault(); event.stopPropagation(); focusCell(cell, false); return
        }
        if (event.altKey || event.ctrlKey || event.metaKey) return
        if (event.key === 'Tab') {
          const next = row * table.headers.length + column + (event.shiftKey ? -1 : 1)
          if (next < 0) { setEditing(null); return }
          event.preventDefault(); event.stopPropagation(); moveEditing(Math.floor(next / table.headers.length), next % table.headers.length)
        } else if (event.key === 'Enter') {
          event.preventDefault(); event.stopPropagation(); moveEditing(row + (event.shiftKey ? -1 : 1), column)
        } else if (!event.shiftKey && input.selectionStart === input.selectionEnd) {
          const start = input.selectionStart === 0, end = input.selectionEnd === input.value.length
          if (event.key === 'ArrowUp' && start && row > 0) { event.preventDefault(); moveEditing(row - 1, column) }
          else if (event.key === 'ArrowDown' && end && row < table.rows.length) { event.preventDefault(); moveEditing(row + 1, column) }
          else if (event.key === 'ArrowLeft' && start && column > 0) { event.preventDefault(); moveEditing(row, column - 1) }
          else if (event.key === 'ArrowRight' && end && column < table.headers.length - 1) { event.preventDefault(); moveEditing(row, column + 1) }
        }
      }} /> : cellNodes?.length ? <MarkdownNodes nodes={cellNodes} /> : value || <span aria-hidden="true" className="markdown-table-cell-empty">—</span>)
  }
  return <div className="block-table-content markdown-table-editor" role="region" aria-label={isZh ? '表格预览' : 'Table preview'}
    data-table-gesture={activePreview ? 'preview' : undefined}
    ref={container} onMouseDown={(event) => event.stopPropagation()} onContextMenu={(event) => event.stopPropagation()}>
    <div className="markdown-table-tools" role="toolbar" aria-label={isZh ? '表格操作' : 'Table actions'}>
      <button type="button" onClick={() => run({ kind: 'insert-row', row: Math.max(1, selected.row) })}>{isZh ? '上方插入行' : 'Insert row above'}</button>
      <button type="button" onClick={() => run({ kind: 'insert-row', row: selected.row + 1 }, { ...selected, row: selected.row + 1 })}>{isZh ? '下方插入行' : 'Insert row below'}</button>
      <button type="button" disabled={selected.row === 0} onClick={() => run({ kind: 'delete-row', row: selected.row })}>{isZh ? '删除行' : 'Delete row'}</button>
      <button type="button" onClick={() => run({ kind: 'insert-column', column: selected.column })}>{isZh ? '左侧插入列' : 'Insert column left'}</button>
      <button type="button" onClick={() => run({ kind: 'insert-column', column: selected.column + 1 }, { ...selected, column: selected.column + 1 })}>{isZh ? '右侧插入列' : 'Insert column right'}</button>
      <button type="button" disabled={table.headers.length === 1} onClick={() => run({ kind: 'delete-column', column: selected.column })}>{isZh ? '删除列' : 'Delete column'}</button>
      <select aria-label={isZh ? '列对齐' : 'Column alignment'} value={table.alignments[selected.column] ?? ''}
        onChange={(event) => run({ kind: 'align', column: selected.column, alignment: (event.target.value || null) as MarkdownTableEdit['alignments'][number] })}>
        <option value="">{isZh ? '默认对齐' : 'Default alignment'}</option><option value="left">{isZh ? '左对齐' : 'Align left'}</option>
        <option value="center">{isZh ? '居中' : 'Align center'}</option><option value="right">{isZh ? '右对齐' : 'Align right'}</option>
      </select>
      <button type="button" disabled={selected.row <= 1} onMouseDown={event => event.preventDefault()}
        onClick={() => commitGesture({ kind: 'move-row', row: selected.row, toRow: selected.row - 1 })}>{isZh ? '上移行' : 'Move row up'}</button>
      <button type="button" disabled={selected.row === 0 || selected.row >= table.rows.length} onMouseDown={event => event.preventDefault()}
        onClick={() => commitGesture({ kind: 'move-row', row: selected.row, toRow: selected.row + 1 })}>{isZh ? '下移行' : 'Move row down'}</button>
      <button type="button" disabled={selected.column === 0} onMouseDown={event => event.preventDefault()}
        onClick={() => commitGesture({ kind: 'move-column', column: selected.column, toColumn: selected.column - 1 })}>{isZh ? '左移列' : 'Move column left'}</button>
      <button type="button" disabled={selected.column >= table.headers.length - 1} onMouseDown={event => event.preventDefault()}
        onClick={() => commitGesture({ kind: 'move-column', column: selected.column, toColumn: selected.column + 1 })}>{isZh ? '右移列' : 'Move column right'}</button>
      <label className="markdown-table-width-control">{isZh ? '列宽' : 'Column width'}<input type="number" aria-label={isZh ? '列宽' : 'Column width'}
        key={`${selected.column}:${table.widths?.[selected.column] ?? 'default'}`} defaultValue={table.widths?.[selected.column] ?? DEFAULT_TABLE_COLUMN_WIDTH}
        min={MIN_TABLE_COLUMN_WIDTH} max={MAX_TABLE_COLUMN_WIDTH} step="1" onBlur={event => {
          pendingFocus.current = null
          const width = Number(event.currentTarget.value)
          if (event.currentTarget.value.trim() && validTableColumnWidth(width) && width !== (table.widths?.[selected.column] ?? DEFAULT_TABLE_COLUMN_WIDTH)) commitGesture({ kind: 'column-width', column: selected.column, width }, table, content, false)
        }} /></label>
      <button type="button" disabled={table.widths?.[selected.column] == null} onMouseDown={event => event.preventDefault()}
        onClick={() => commitGesture({ kind: 'column-width', column: selected.column, width: null })}>{isZh ? '恢复默认列宽' : 'Reset column width'}</button>
      {editing ? <MarkdownFormatToolbar isZh={isZh} onFormat={format} onReturnToEditor={() => editor.current?.focus()} /> : null}
    </div>
    <div className="markdown-table-grid"><table className="block-markdown-table" role="grid" aria-label={isZh ? '可编辑表格' : 'Editable table'}
      data-knowbook-table-layout={display.widths ? 'true' : undefined}
      style={display.widths ? { tableLayout: 'fixed', width: display.widths.reduce<number>((total, width) => total + (width ?? DEFAULT_TABLE_COLUMN_WIDTH), 0) } : undefined}>
      {display.widths ? <colgroup>{display.widths.map((width, index) => <col key={index} style={{ width: width ?? DEFAULT_TABLE_COLUMN_WIDTH }} />)}</colgroup> : null}
      <thead><tr>{rows[0].map((value, column) => renderCell(value, 0, column))}</tr></thead>
      {display.rows.length ? <tbody>{display.rows.map((row, index) => <tr key={rowOrder[index + 1]}>{row.map((value, column) => renderCell(value, index + 1, column))}</tr>)}</tbody> : null}
    </table></div>
    <p className="markdown-table-help">{isZh ? '点击单元格编辑 · Tab 切换，末格新增行 · Enter 下移 · Esc 退出编辑后可用 Tab 离开表格' : 'Click to edit · Tab moves and adds a row at the end · Enter moves down · Esc exits editing, then Tab leaves the table'}</p>
  </div>
}
