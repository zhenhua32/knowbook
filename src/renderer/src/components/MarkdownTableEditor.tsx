import { createElement, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { editMarkdownTable, parseEditableMarkdownTable, parseTableClipboard, serializeEditableMarkdownTable, type MarkdownTableEdit, type TableOperation } from '@shared/markdownTableEditing'
import { parseMarkdownTableNode } from '@shared/markdownTable'
import { MarkdownBlockNodesContext } from './MarkdownDocumentContext'
import { MarkdownNodes } from './MarkdownContent'
import { MarkdownFormatToolbar } from './MarkdownFormatToolbar'
import { formatMarkdownSelection, markdownFormatShortcut, type MarkdownFormat } from '../utils/markdownFormatting'
import { isImeKeyboardEvent } from '../utils/imeKeyboard'
import '../styles/markdown-editing.css'

type Cell = { row: number; column: number }
export function MarkdownTableEditor({ content, onChange, onBeginEdit, isZh }: {
  content: string
  onChange: (content: string, transaction: boolean) => void
  onBeginEdit?: () => void
  isZh: boolean
}) {
  const table = useMemo(() => parseEditableMarkdownTable(content), [content])
  const nodes = useContext(MarkdownBlockNodesContext)
  const parsed = useMemo(() => nodes?.find((node) => node.token.type === 'table_open') ?? parseMarkdownTableNode(content), [content, nodes])
  const [selected, setSelected] = useState<Cell>({ row: 0, column: 0 })
  const [editing, setEditing] = useState<(Cell & { value: string }) | null>(null)
  const container = useRef<HTMLDivElement>(null)
  const editor = useRef<HTMLTextAreaElement>(null)
  const pendingFocus = useRef<{ cell: Cell; edit: boolean; selectAll?: boolean; range?: { start: number; end: number } } | null>(null)
  const lastEmitted = useRef<string | undefined>(undefined)
  const composing = useRef(false)
  const cellValue = (model: MarkdownTableEdit, cell: Cell) => (cell.row ? model.rows[cell.row - 1] : model.headers)?.[cell.column] ?? ''
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
      if (pending.range) editor.current.setSelectionRange(pending.range.start, pending.range.end)
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
  if (!table) return <p role="status">{isZh ? '表格源码尚不完整，请展开源码继续编辑。' : 'The table source is incomplete. Expand its source to continue editing.'}</p>
  const head = parsed?.children.find((node) => node.token.type === 'thead_open')?.children ?? []
  const body = parsed?.children.find((node) => node.token.type === 'tbody_open')?.children ?? []
  const rows = [table.headers, ...table.rows]
  const renderCell = (value: string, row: number, column: number) => {
    const cell = { row, column }
    const active = editing?.row === row && editing.column === column
    const isSelected = selected.row === row && selected.column === column
    const label = isZh ? `${row === 0 ? '表头' : '第 ' + row + ' 行'}，第 ${column + 1} 列` : `${row === 0 ? 'Header' : 'Row ' + row}, column ${column + 1}`
    const cellNodes = (row ? body[row - 1] : head[0])?.children[column]?.children
    return createElement(row ? 'td' : 'th', {
      key: column, role: row ? 'gridcell' : 'columnheader', scope: row ? undefined : 'col',
      'data-row': row, 'data-column': column, 'data-selected': isSelected, 'aria-selected': isSelected,
      'aria-rowindex': row + 1, 'aria-colindex': column + 1,
      tabIndex: isSelected && !active ? 0 : -1, 'aria-label': value ? undefined : label + (isZh ? '，空白' : ', empty'),
      style: { textAlign: table.alignments[column] ?? undefined },
      onFocus: () => setSelected(cell),
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
    }, active ? <textarea ref={editor} aria-label={label} rows={1} value={editing.value} spellCheck={false}
      onChange={(event) => updateValue(event.target.value)}
      onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
      onBlur={(event) => { if (!(event.relatedTarget as HTMLElement | null)?.closest('.markdown-format-toolbar')) setEditing(null) }}
      onPaste={(event) => {
        const text = event.clipboardData.getData('text/plain')
        if (!/[\t\r\n]/.test(text)) return
        event.preventDefault()
        const next = apply({ kind: 'paste', ...cell, cells: parseTableClipboard(text) })
        focusCell(cell, true, next)
      }}
      onKeyDown={(event) => {
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
      {editing ? <MarkdownFormatToolbar isZh={isZh} onFormat={format} onReturnToEditor={() => editor.current?.focus()} /> : null}
    </div>
    <div className="markdown-table-grid"><table className="block-markdown-table" role="grid" aria-label={isZh ? '可编辑表格' : 'Editable table'}>
      <thead><tr>{rows[0].map((value, column) => renderCell(value, 0, column))}</tr></thead>
      {table.rows.length ? <tbody>{table.rows.map((row, index) => <tr key={index}>{row.map((value, column) => renderCell(value, index + 1, column))}</tr>)}</tbody> : null}
    </table></div>
    <p className="markdown-table-help">{isZh ? '点击单元格编辑 · Tab 切换，末格新增行 · Enter 下移 · Esc 退出编辑后可用 Tab 离开表格' : 'Click to edit · Tab moves and adds a row at the end · Enter moves down · Esc exits editing, then Tab leaves the table'}</p>
  </div>
}
