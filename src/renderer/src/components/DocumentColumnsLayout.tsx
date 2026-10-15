import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { DocumentBlockDraft } from '@shared/contracts'
import { isColumnBlockType, isColumnsBlockType } from '@shared/blockTypes'
import { appendColumnParagraph, getColumnGroup, moveBlockToColumn } from '../utils/columnOperations'
import ColumnsControls from './ColumnsControls'
import './document-columns.css'

type Props = {
  blocks: DocumentBlockDraft[]
  visibleIndices: number[]
  isZh: boolean
  reading: boolean
  sessionKey: string
  onApplyBlocks?: (next: DocumentBlockDraft[]) => void
  onAddContent?: (columnId: string) => void
  renderBlock: (index: number, visualDepth: number) => ReactNode
}

/** Only structural wrappers change; ordinary rows keep their existing editors. */
export default function DocumentColumnsLayout(props: Props) {
  const visible = new Set(props.visibleIndices)
  const renderRange = (start: number, end: number, baseDepth: number, ownerColumnId?: string): ReactNode[] => {
    const nodes: ReactNode[] = []
    for (let index = start; index <= end; index++) {
      const block = props.blocks[index]
      if (isColumnsBlockType(block.type) && block.id) {
        const group = getColumnGroup(props.blocks, block.id)
        if (group) {
          const hasVisible = props.blocks.slice(index, group.end + 1).some((_, offset) => visible.has(index + offset))
          if (hasVisible) nodes.push(<ColumnLayout key={block.id} {...props} groupId={block.id} groupIndex={index}
            renderChildren={column => renderRange(column.index + 1, column.end, column.block.depth + 1, column.block.id)} />)
          index = group.end
          continue
        }
      }
      if (!visible.has(index) || isColumnBlockType(block.type)) continue
      nodes.push(props.renderBlock(index, Math.max(0, block.depth - baseDepth)))
      if (!props.reading && ownerColumnId && block.parentBlockId === ownerColumnId && block.id && props.onApplyBlocks) {
        const owner = props.blocks.find(candidate => candidate.id === ownerColumnId)
        const group = owner?.parentBlockId ? getColumnGroup(props.blocks, owner.parentBlockId) : null
        if (group && group.columns.length > 1) nodes.push(<label className="column-content-move" key={`move:${block.id}`}>
          <span>{props.isZh ? '移动到列' : 'Move to column'}</span>
          <select aria-label={props.isZh ? `移动内容：${block.content.slice(0, 40) || '空段落'}` : `Move content: ${block.content.slice(0, 40) || 'Empty paragraph'}`}
            value="" onChange={event => {
              const next = moveBlockToColumn(props.blocks, block.id!, event.target.value)
              if (next) props.onApplyBlocks?.(next)
            }}><option value="">{props.isZh ? '选择目标列…' : 'Choose a column…'}</option>
            {group.columns.map((column, position) => column.block.id !== ownerColumnId
              ? <option key={column.block.id} value={column.block.id}>{props.isZh ? `第 ${position + 1} 列` : `Column ${position + 1}`}</option> : null)}
          </select>
        </label>)
      }
    }
    return nodes
  }
  return <>{renderRange(0, props.blocks.length - 1, 0)}</>
}

function ColumnLayout(props: Props & { groupId: string; groupIndex: number;
  renderChildren: (column: NonNullable<ReturnType<typeof getColumnGroup>>['columns'][number]) => ReactNode }) {
  const [preview, setPreview] = useState<number[] | null>(null)
  const root = useRef<HTMLDivElement | null>(null)
  const pendingFocus = useRef<{ id: string; opener: Element | null; session: string } | null>(null)
  useLayoutEffect(() => setPreview(null), [props.blocks, props.sessionKey])
  useLayoutEffect(() => {
    const pending = pendingFocus.current
    if (!pending) return
    pendingFocus.current = null
    const owner = root.current?.ownerDocument
    if (!owner || pending.session !== props.sessionKey || !owner.hasFocus()
      || owner.activeElement !== pending.opener && owner.activeElement !== owner.body) return
    const row = Array.from(root.current?.querySelectorAll<HTMLElement>('[data-block-id]') ?? []).find(element => element.dataset.blockId === pending.id)
    const textarea = row?.querySelector<HTMLTextAreaElement>('.block-inline-textarea')
    if (textarea && !textarea.closest('[hidden],[inert]')) { textarea.focus({ preventScroll: true }); textarea.setSelectionRange(0, 0) }
  }, [props.blocks, props.sessionKey])
  const group = getColumnGroup(props.blocks, props.groupId)
  if (!group) return null
  const weights = preview ?? group.columns.map(column => column.weight)
  return <div ref={root} className={`document-columns${props.reading ? ' document-columns-readonly' : ''}`} data-columns-group={props.groupId}
    data-block-id={props.groupId} data-block-index={props.groupIndex}>
    {!props.reading && props.onApplyBlocks ? <ColumnsControls blocks={props.blocks} groupId={props.groupId} isZh={props.isZh}
      sessionKey={props.sessionKey} onApplyBlocks={props.onApplyBlocks} onPreviewWeights={setPreview} onAddContent={columnId => {
        if (props.onAddContent) { props.onAddContent(columnId); return }
        const next = appendColumnParagraph(props.blocks, columnId)
        const added = next?.find(block => !props.blocks.some(previous => previous.id === block.id))
        if (!next || !added?.id) return
        pendingFocus.current = { id: added.id, opener: root.current?.ownerDocument.activeElement ?? null, session: props.sessionKey }
        props.onApplyBlocks?.(next)
      }} /> : null}
    <div className="document-columns-grid" style={{ gridTemplateColumns: weights.map(weight => `minmax(0,${weight}fr)`).join(' ') }}>
      {group.columns.map(column => <div className="document-column" key={column.block.id} data-block-id={column.block.id}
        data-block-index={column.index} data-column-id={column.block.id}>{props.renderChildren(column)}</div>)}
    </div>
  </div>
}
