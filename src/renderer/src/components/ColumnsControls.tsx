import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { DocumentBlockDraft } from '@shared/contracts'
import { addColumn, appendColumnParagraph, getColumnGroup, removeColumn, reorderColumn, resizeColumnPair, unwrapColumns } from '../utils/columnOperations'
import { isImeKeyboardEvent } from '../utils/imeKeyboard'
import './document-columns.css'

export type ColumnsControlsProps = {
  blocks: DocumentBlockDraft[]
  groupId: string
  isZh: boolean
  sessionKey?: string
  onApplyBlocks: (next: DocumentBlockDraft[]) => void
  onPreviewWeights?: (weights: number[] | null) => void
  onAddContent?: (columnId: string) => void
}

export default function ColumnsControls(props: ColumnsControlsProps) {
  const root = useRef<HTMLDivElement | null>(null), live = useRef(props)
  live.current = props
  const stop = useRef<(() => void) | null>(null)
  const dragging = useRef<{ id: string; blocks: DocumentBlockDraft[]; session?: string } | null>(null)
  const [preview, setPreview] = useState<number[] | null>(null)
  const group = getColumnGroup(props.blocks, props.groupId)
  const cancel = () => { stop.current?.(); stop.current = null }
  useLayoutEffect(() => { cancel(); dragging.current = null }, [props.blocks, props.groupId, props.sessionKey])
  useEffect(() => cancel, [])
  const publishPreview = (weights: number[] | null) => {
    setPreview(weights)
    live.current.onPreviewWeights?.(weights)
  }
  const apply = (next: DocumentBlockDraft[] | null) => { if (next) props.onApplyBlocks(next) }
  if (!group) return null
  const weights = preview ?? group.columns.map(column => column.weight)
  const tracks = weights.map(weight => `minmax(0,${weight}fr)`).join(' ')
  const startResize = (event: ReactPointerEvent<HTMLDivElement>, position: number) => {
    if (event.button !== 0 || !event.isPrimary) return
    const host = root.current?.closest<HTMLElement>('[data-columns-group]')
    const grid = host?.querySelector<HTMLElement>(':scope > .document-columns-grid, :scope > .rich-text-columns-content, :scope > .columns-grid')
    const width = grid?.getBoundingClientRect().width ?? host?.getBoundingClientRect().width ?? 0
    if (width <= 0) return
    event.preventDefault(); event.stopPropagation(); cancel()
    const before = props.blocks, session = props.sessionKey, handle = event.currentTarget
    const left = group.columns[position], right = group.columns[position + 1], total = left.weight + right.weight
    const owner = handle.ownerDocument, view = owner.defaultView, pointer = event.pointerId, startX = event.clientX
    let latestWeight = left.weight, active = true
    const current = () => active && live.current.blocks === before && live.current.groupId === props.groupId
      && live.current.sessionKey === session && handle.isConnected
    const release = () => {
      active = false
      handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', finish)
      handle.removeEventListener('pointercancel', abort); handle.removeEventListener('lostpointercapture', abort)
      owner.removeEventListener('keydown', escape, true); view?.removeEventListener('blur', abort)
      if (handle.hasPointerCapture(pointer)) handle.releasePointerCapture(pointer)
      stop.current = null; publishPreview(null)
    }
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointer || !current()) return
      latestWeight = Math.max(1, Math.min(total - 1, left.weight + Math.round((next.clientX - startX) / width * 10_000)))
      const nextWeights = group.columns.map(column => column.weight)
      nextWeights[position] = latestWeight; nextWeights[position + 1] = total - latestWeight
      publishPreview(nextWeights)
    }
    const abort = () => { if (active) release() }
    const finish = (next: PointerEvent) => {
      if (next.pointerId !== pointer) return
      const allowed = current()
      release()
      if (allowed) { const result = resizeColumnPair(before, left.block.id!, latestWeight); if (result) live.current.onApplyBlocks(result) }
    }
    const escape = (next: KeyboardEvent) => {
      if (next.key === 'Escape' && !isImeKeyboardEvent(next)) { next.preventDefault(); next.stopPropagation(); abort() }
    }
    stop.current = abort
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', finish)
    handle.addEventListener('pointercancel', abort); handle.addEventListener('lostpointercapture', abort)
    owner.addEventListener('keydown', escape, true); view?.addEventListener('blur', abort)
    handle.setPointerCapture(pointer)
  }
  let offset = 0
  return <div className="columns-controls" ref={root} data-columns-gesture={preview ? 'preview' : undefined}>
    <div className="columns-group-tools" role="group" aria-label={props.isZh ? '分栏操作' : 'Column layout actions'}>
      <span>{props.isZh ? `${group.columns.length} 列` : `${group.columns.length} columns`}</span>
      <button type="button" disabled={group.columns.length >= 6} onClick={() => apply(addColumn(props.blocks, props.groupId))}>{props.isZh ? '添加列' : 'Add column'}</button>
      <button type="button" onClick={() => apply(unwrapColumns(props.blocks, props.groupId))}>{props.isZh ? '取消分栏，保留内容' : 'Unwrap columns, keep content'}</button>
    </div>
    <div className="columns-tool-grid" style={{ gridTemplateColumns: tracks }}>
      {group.columns.map((column, index) => <div className="column-tools" key={column.block.id} onDragOver={event => {
        if (event.dataTransfer.types.includes('application/x-knowbook-column')) { event.preventDefault(); event.stopPropagation() }
      }} onDrop={event => {
        const id = event.dataTransfer.getData('application/x-knowbook-column')
        const lease = dragging.current
        if (!lease || lease.id !== id || lease.blocks !== props.blocks || lease.session !== props.sessionKey || !group.columns.some(candidate => candidate.block.id === id)) return
        event.preventDefault(); event.stopPropagation(); apply(reorderColumn(props.blocks, id, index))
      }}>
        <button type="button" draggable className="column-drag-handle" aria-label={props.isZh ? `拖动第 ${index + 1} 列` : `Drag column ${index + 1}`}
          onDragStart={event => { event.stopPropagation(); dragging.current = { id: column.block.id!, blocks: props.blocks, session: props.sessionKey }; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-knowbook-column', column.block.id!) }}
          onDragEnd={() => { dragging.current = null }}>⠿</button>
        <span>{props.isZh ? `第 ${index + 1} 列` : `Column ${index + 1}`}</span>
        <ColumnRatioInput blocks={props.blocks} groupId={props.groupId} columnId={column.block.id!} weight={column.weight}
          index={index} isZh={props.isZh} sessionKey={props.sessionKey} onApplyBlocks={props.onApplyBlocks} />
        <button type="button" disabled={index === 0} aria-label={props.isZh ? `第 ${index + 1} 列左移` : `Move column ${index + 1} left`}
          onClick={() => apply(reorderColumn(props.blocks, column.block.id!, index - 1))}>←</button>
        <button type="button" disabled={index === group.columns.length - 1} aria-label={props.isZh ? `第 ${index + 1} 列右移` : `Move column ${index + 1} right`}
          onClick={() => apply(reorderColumn(props.blocks, column.block.id!, index + 1))}>→</button>
        <button type="button" aria-label={props.isZh ? `在第 ${index + 1} 列添加内容` : `Add content to column ${index + 1}`}
          disabled={column.block.depth >= 6} onClick={() => props.onAddContent ? props.onAddContent(column.block.id!) : apply(appendColumnParagraph(props.blocks, column.block.id!))}>＋</button>
        <button type="button" disabled={group.columns.length === 1} aria-label={props.isZh ? `移除第 ${index + 1} 列并保留内容` : `Remove column ${index + 1} and keep content`}
          onClick={() => apply(removeColumn(props.blocks, column.block.id!))}>×</button>
      </div>)}
    </div>
    <div className="columns-resizers">{group.columns.slice(0, -1).map((column, index) => {
      offset += weights[index]
      const maximum = column.weight + group.columns[index + 1].weight - 1
      return <div className="column-resizer" role="separator" aria-orientation="vertical" key={column.block.id} tabIndex={0}
        aria-label={props.isZh ? `调整第 ${index + 1} 列宽度` : `Resize column ${index + 1}`} aria-valuemin={0.01}
        aria-valuemax={maximum / 100} aria-valuenow={weights[index] / 100} style={{ left: `${offset / 100}%` }}
        onPointerDown={event => startResize(event, index)} onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || isImeKeyboardEvent(event)) return
          event.preventDefault(); event.stopPropagation()
          const value = event.key === 'Home' ? 1 : event.key === 'End' ? maximum
            : Math.max(1, Math.min(maximum, column.weight + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 1000 : 100)))
          apply(resizeColumnPair(props.blocks, column.block.id!, value))
        }}><span /></div>
    })}</div>
  </div>
}

function ColumnRatioInput({ blocks, groupId, columnId, weight, index, isZh, sessionKey, onApplyBlocks }: {
  blocks: DocumentBlockDraft[]; groupId: string; columnId: string; weight: number; index: number; isZh: boolean;
  sessionKey?: string; onApplyBlocks: (next: DocumentBlockDraft[]) => void
}) {
  const [value, setValue] = useState(String(weight / 100)), editing = useRef<{ blocks: DocumentBlockDraft[]; session?: string } | null>(null)
  useLayoutEffect(() => { setValue(String(weight / 100)); editing.current = null }, [blocks, weight, sessionKey])
  const commit = () => {
    const lease = editing.current; editing.current = null
    const nextWeight = Math.round(Number(value) * 100), group = getColumnGroup(blocks, groupId)
    if (!lease || lease.blocks !== blocks || lease.session !== sessionKey || !group || !value.trim() || !Number.isFinite(nextWeight)) { setValue(String(weight / 100)); return }
    const last = index === group.columns.length - 1
    const left = group.columns[last ? index - 1 : index]
    if (!left) { setValue(String(weight / 100)); return }
    const total = last ? left.weight + weight : left.weight + group.columns[index + 1].weight
    const next = resizeColumnPair(blocks, left.block.id!, last ? total - nextWeight : nextWeight)
    if (next) onApplyBlocks(next)
    else setValue(String(weight / 100))
  }
  return <label className="column-ratio"><input type="number" min="0.01" max="100" step="0.01" value={value}
    aria-label={isZh ? `第 ${index + 1} 列宽度百分比` : `Column ${index + 1} width percent`}
    onFocus={() => { editing.current = { blocks, session: sessionKey } }} onChange={event => {
      editing.current ??= { blocks, session: sessionKey }; setValue(event.target.value)
    }} onBlur={commit}
    onKeyDown={event => {
      if (isImeKeyboardEvent(event)) return
      if (event.key === 'Enter') { event.preventDefault(); commit() }
      if (event.key === 'Escape') { event.preventDefault(); editing.current = null; setValue(String(weight / 100)) }
    }} /><span aria-hidden="true">%</span></label>
}

export { ColumnsControls }
