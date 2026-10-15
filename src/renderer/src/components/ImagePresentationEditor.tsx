import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'
import { computeImageCropLayout, FULL_IMAGE_CROP, normalizeImageCrop, normalizeImagePresentation,
  type ImageCrop, type ImagePresentation } from '@shared/markdownMedia'
import { toBlockRichMediaPreviewUrl } from '../utils/blockRichMedia'
import { isImeKeyboardEvent } from '../utils/imeKeyboard'
import './image-presentation.css'

export type ImagePresentationEditorProps = {
  value: ImagePresentation
  isZh: boolean
  editable: boolean
  onCommit?: (next: ImagePresentation) => boolean | void
  onBegin?: () => void
}

type DragKind = 'resize' | 'move' | 'nw' | 'ne' | 'sw' | 'se'
type Drag = { kind: DragKind; pointerId: number; target: HTMLElement; startX: number; startY: number;
  bounds: DOMRect; availableWidth: number; aspectRatio: number; original: ImagePresentation; crop: ImageCrop; moved: boolean }
const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value))
const same = (left: ImagePresentation, right: ImagePresentation) => JSON.stringify(left) === JSON.stringify(right)
function copy(value: ImagePresentation): ImagePresentation {
  const normalized = normalizeImagePresentation(value) ?? { src: '', alt: '', caption: '', align: 'center' as const }
  return { ...normalized, ...(normalized.crop ? { crop: { ...normalized.crop } } : {}) }
}
function cropOf(value: ImagePresentation): ImageCrop { return { ...(normalizeImageCrop(value.crop) ?? FULL_IMAGE_CROP) } }
function release(drag: Drag | null) {
  try { if (drag?.target.hasPointerCapture(drag.pointerId)) drag.target.releasePointerCapture(drag.pointerId) } catch { /* A removed image already lost capture. */ }
}

export function ImagePresentationEditor(props: ImagePresentationEditorProps) {
  const latest = useRef(props); latest.current = props
  const [draft, setDraft] = useState(() => copy(props.value)), draftRef = useRef(draft)
  const [rejected, setRejected] = useState(false), rejectedRef = useRef(false)
  const rejectedCommit = useRef<ImagePresentationEditorProps['onCommit']>(undefined)
  const [selected, setSelected] = useState(false), [cropping, setCropping] = useState(false)
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null)
  const [failed, setFailed] = useState(false)
  const container = useRef<HTMLSpanElement>(null), frame = useRef<HTMLSpanElement>(null), cropStage = useRef<HTMLSpanElement>(null)
  const drag = useRef<Drag | null>(null), composing = useRef(false), pendingBlur = useRef(false)
  const keyboardCrop = useRef<ImagePresentation | null>(null)
  const incoming = JSON.stringify(copy(props.value))
  const presentation = rejected ? copy(props.value) : draft
  const update = (next: ImagePresentation) => { draftRef.current = next; setDraft(next) }
  const clearRejection = () => { rejectedRef.current = false; rejectedCommit.current = undefined; setRejected(false) }
  const commit = (next: ImagePresentation) => {
    const normalized = copy(next)
    // Retrying a retained draft must keep the source/occurrence lease that
    // rejected it, rather than acquire a newer callback for unrelated content.
    const callback = rejectedRef.current ? rejectedCommit.current : latest.current.onCommit
    if (!same(normalized, copy(latest.current.value)) && callback?.(normalized) === false) {
      rejectedRef.current = true; rejectedCommit.current = callback; setRejected(true)
      update(normalized)
      return false
    }
    clearRejection()
    update(normalized)
    return true
  }
  const cancelDrag = () => {
    const active = drag.current
    if (active) { drag.current = null; release(active); update(copy(active.original)) }
    keyboardCrop.current = null
  }
  useEffect(() => {
    if (drag.current) { release(drag.current); drag.current = null }
    keyboardCrop.current = null
    if (rejectedRef.current) return
    const next = copy(latest.current.value)
    draftRef.current = next; setDraft(next)
  }, [incoming])
  useEffect(() => { setNatural(null); setFailed(false) }, [presentation.src])
  useEffect(() => () => { release(drag.current); drag.current = null }, [])
  useEffect(() => {
    if (!props.editable || !selected) return
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || isImeKeyboardEvent(event, composing.current)) return
      if (event.target instanceof HTMLElement && event.target.closest('.attachment-image-dialog')) return
      event.preventDefault(); event.stopPropagation()
      if (drag.current) cancelDrag()
      else if (keyboardCrop.current) { update(copy(keyboardCrop.current)); keyboardCrop.current = null }
      else if (cropping) { clearRejection(); update(copy(latest.current.value)); setCropping(false) }
      else { clearRejection(); update(copy(latest.current.value)); setSelected(false) }
    }
    document.addEventListener('keydown', escape, true)
    return () => document.removeEventListener('keydown', escape, true)
  }, [props.editable, selected, cropping])

  const layout = natural ? computeImageCropLayout(presentation, natural.width, natural.height) : null
  const previewUrl = toBlockRichMediaPreviewUrl(presentation.src)
  const text = (zh: string, en: string) => props.isZh ? zh : en
  const availableWidth = () => Math.max(24, Math.min(10000, container.current?.clientWidth || frame.current?.getBoundingClientRect().width || 10000))
  const resized = (value: ImagePresentation, width: number, ratio: number) => {
    const bounded = Math.round(clamp(width, 24, availableWidth()))
    return { ...value, width: bounded, height: Math.round(clamp(bounded / ratio, 1, 10000)) }
  }
  const beginDrag = (event: PointerEvent<HTMLElement>, kind: DragKind) => {
    if (!props.editable || event.button !== 0 || !natural || !layout || drag.current) return
    const bounds = (kind === 'resize' ? frame.current : cropStage.current)?.getBoundingClientRect()
    if (!bounds || !bounds.width || !bounds.height) return
    event.preventDefault(); event.stopPropagation(); setSelected(true)
    latest.current.onBegin?.()
    drag.current = { kind, pointerId: event.pointerId, target: event.currentTarget, startX: event.clientX, startY: event.clientY,
      bounds, availableWidth: availableWidth(), aspectRatio: layout.aspectRatio, original: copy(draftRef.current), crop: cropOf(draftRef.current), moved: false }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const moveDrag = (event: PointerEvent<HTMLElement>) => {
    const active = drag.current
    if (!active || active.pointerId !== event.pointerId) return
    event.preventDefault(); event.stopPropagation()
    const dx = event.clientX - active.startX, dy = event.clientY - active.startY
    active.moved ||= Math.abs(dx) + Math.abs(dy) > .5
    if (active.kind === 'resize') {
      const width = Math.round(clamp(active.bounds.width + dx, 24, active.availableWidth))
      update({ ...active.original, width, height: Math.round(clamp(width / active.aspectRatio, 1, 10000)) })
      return
    }
    const original = active.crop, minimumX = Math.min(.02, 24 / natural!.width), minimumY = Math.min(.02, 24 / natural!.height)
    const x = dx / active.bounds.width, y = dy / active.bounds.height
    let left = original.x, top = original.y, right = left + original.width, bottom = top + original.height
    if (active.kind === 'move') { left = clamp(left + x, 0, 1 - original.width); top = clamp(top + y, 0, 1 - original.height); right = left + original.width; bottom = top + original.height }
    else {
      if (active.kind.includes('w')) left = clamp(left + x, 0, right - minimumX)
      if (active.kind.includes('e')) right = clamp(right + x, left + minimumX, 1)
      if (active.kind.includes('n')) top = clamp(top + y, 0, bottom - minimumY)
      if (active.kind.includes('s')) bottom = clamp(bottom + y, top + minimumY, 1)
    }
    update({ ...active.original, crop: { x: left, y: top, width: right - left, height: bottom - top } })
  }
  const endDrag = (event: PointerEvent<HTMLElement>, cancel = false) => {
    const active = drag.current
    if (!active || active.pointerId !== event.pointerId) return
    event.preventDefault(); event.stopPropagation(); drag.current = null; release(active)
    if (cancel) update(copy(active.original))
    else if (active.moved) commit(draftRef.current)
  }
  const pointerEvents = { onPointerMove: moveDrag, onPointerUp: (event: PointerEvent<HTMLElement>) => endDrag(event),
    onPointerCancel: (event: PointerEvent<HTMLElement>) => endDrag(event, true),
    onLostPointerCapture: (event: PointerEvent<HTMLElement>) => { if (drag.current?.pointerId === event.pointerId) cancelDrag() } }
  const crop = cropOf(presentation)
  const cropKeyboard = (event: KeyboardEvent<HTMLElement>, kind: DragKind) => {
    if (!event.key.startsWith('Arrow') || isImeKeyboardEvent(event.nativeEvent, composing.current)) return
    event.preventDefault(); event.stopPropagation()
    if (!keyboardCrop.current) { keyboardCrop.current = copy(draftRef.current); latest.current.onBegin?.() }
    const current = cropOf(draftRef.current), amount = event.shiftKey ? .05 : .01
    let left = current.x, top = current.y, right = left + current.width, bottom = top + current.height
    const dx = event.key === 'ArrowLeft' ? -amount : event.key === 'ArrowRight' ? amount : 0
    const dy = event.key === 'ArrowUp' ? -amount : event.key === 'ArrowDown' ? amount : 0
    if (kind === 'move') { left = clamp(left + dx, 0, 1 - current.width); top = clamp(top + dy, 0, 1 - current.height); right = left + current.width; bottom = top + current.height }
    else {
      if (kind.includes('w')) left = clamp(left + dx, 0, right - .01)
      if (kind.includes('e')) right = clamp(right + dx, left + .01, 1)
      if (kind.includes('n')) top = clamp(top + dy, 0, bottom - .01)
      if (kind.includes('s')) bottom = clamp(bottom + dy, top + .01, 1)
    }
    update({ ...draftRef.current, crop: { x: left, y: top, width: right - left, height: bottom - top } })
  }
  const finishKeyboardCrop = () => { if (keyboardCrop.current) { keyboardCrop.current = null; commit(draftRef.current) } }
  const editField = (field: 'alt' | 'caption', value: string) => update({ ...draftRef.current, [field]: value })
  const blurField = () => { if (composing.current) pendingBlur.current = true; else commit(draftRef.current) }
  const frameStyle: CSSProperties = layout?.frameStyle ?? { width: presentation.width ? `${presentation.width}px` : undefined,
    maxWidth: '100%', ...(presentation.width && presentation.height ? { aspectRatio: `${presentation.width}/${presentation.height}` } : {}),
    marginLeft: presentation.align === 'left' ? '0' : 'auto', marginRight: presentation.align === 'right' ? '0' : 'auto' }

  return <span className={`image-presentation${selected && props.editable ? ' is-selected' : ''}`} data-image-presentation
    data-image-align={presentation.align} contentEditable={false} ref={container}>
    <span className="image-presentation-frame block-rich-media-image-card" style={{ ...frameStyle, overflow: 'visible' }} ref={frame}
      {...(props.editable ? { role: 'button', tabIndex: 0, 'aria-label': text('选择图片', 'Select image'),
        onClick: (event: React.MouseEvent<HTMLSpanElement>) => { event.stopPropagation(); setSelected(true) },
        onKeyDown: (event: KeyboardEvent<HTMLSpanElement>) => { if (event.target === event.currentTarget && ['Enter', ' '].includes(event.key)) { event.preventDefault(); setSelected(true) } } } : {})}>
      <span className="image-presentation-viewport" style={layout ? { position: 'absolute', inset: 0 } : undefined}>
      {failed || !presentation.src ? <span className="image-presentation-unavailable" role="status">{text('无法显示图片', 'Image unavailable')}</span>
        : <img className={`image-presentation-image block-rich-media-image${props.editable ? '' : ' markdown-inline-image'}`} alt={presentation.alt} title={presentation.title}
          src={previewUrl} loading="lazy" decoding="async" style={layout?.imageStyle}
          onLoad={event => { if (event.currentTarget.naturalWidth && event.currentTarget.naturalHeight) setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }) }}
          onError={() => setFailed(true)} />}
      </span>
      {selected && props.editable && <button type="button" className="image-presentation-resize" data-image-resize
        aria-label={text('调整图片大小', 'Resize image')} title={text('拖动调整大小，方向键微调', 'Drag to resize; use arrow keys to fine tune')}
        disabled={!layout || failed} onPointerDown={event => beginDrag(event, 'resize')} {...pointerEvents}
        onKeyDown={event => {
          if (!layout || !event.key.startsWith('Arrow')) return
          event.preventDefault(); event.stopPropagation()
          if (!keyboardCrop.current) { keyboardCrop.current = copy(draftRef.current); latest.current.onBegin?.() }
          const step = event.shiftKey ? 50 : 10, delta = ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -step : step
          update(resized(draftRef.current, (frame.current?.getBoundingClientRect().width ?? layout.width) + delta, layout.aspectRatio))
        }} onKeyUp={event => { if (event.key.startsWith('Arrow')) finishKeyboardCrop() }} onBlur={finishKeyboardCrop} />}
    </span>
    {presentation.caption && <span className="image-presentation-caption" data-image-caption style={{ width: frameStyle.width,
      maxWidth: '100%', marginLeft: frameStyle.marginLeft, marginRight: frameStyle.marginRight }}>{presentation.caption}</span>}
    {rejected && <span className="image-presentation-help" role="alert" data-image-commit-error>
      {text('修改未保存，草稿已保留。', 'Changes were not saved. Your draft is retained.')}
      <span className="image-presentation-toolbar">
      <button type="button" data-image-commit-retry onClick={() => { latest.current.onBegin?.(); commit(draftRef.current) }}>{text('重试保存', 'Retry saving')}</button>
      <button type="button" data-image-commit-discard onClick={() => { clearRejection(); update(copy(latest.current.value)) }}>{text('放弃修改', 'Discard changes')}</button>
      </span>
    </span>}
    {selected && props.editable && <span className="image-presentation-controls" data-image-controls>
      <span className="image-presentation-toolbar" role="toolbar" aria-label={text('图片编辑', 'Image editing')}>
        {(['left', 'center', 'right'] as const).map((align, index) => <button type="button" key={align} data-image-align-button={align}
          aria-label={(props.isZh ? ['左对齐', '居中', '右对齐'] : ['Align left', 'Align center', 'Align right'])[index]}
          aria-pressed={presentation.align === align} onClick={() => { latest.current.onBegin?.(); commit({ ...draftRef.current, align }) }}>
          {(props.isZh ? ['左', '中', '右'] : ['Left', 'Center', 'Right'])[index]}</button>)}
        <button type="button" data-image-crop-toggle aria-pressed={cropping} disabled={!natural || failed}
          onClick={() => setCropping(value => !value)}>{text('裁剪', 'Crop')}</button>
        <button type="button" data-image-crop-reset disabled={!draft.crop} onClick={() => { latest.current.onBegin?.(); commit({ ...draftRef.current, crop: undefined }) }}>{text('重置裁剪', 'Reset crop')}</button>
        <button type="button" data-image-open-original disabled={!draft.src} onClick={() => {
          const { src, alt } = draftRef.current
          void import('./AttachmentPreview').then(module => module.showImagePreview(src, alt))
        }}>{text('查看原图', 'Open original image')}</button>
        <button type="button" data-image-editor-close onClick={() => { cancelDrag(); setCropping(false); setSelected(false) }}>{text('完成', 'Done')}</button>
      </span>
      {cropping && natural && <span className="image-presentation-crop-stage" data-image-crop-stage ref={cropStage}
        style={{ width: `${Math.min(natural.width, availableWidth())}px`, aspectRatio: `${natural.width}/${natural.height}` }}>
        <img alt="" aria-hidden="true" src={previewUrl} draggable={false} />
        <button type="button" className="image-presentation-crop-area" data-image-crop-area aria-label={text('移动裁剪区域', 'Move crop area')}
          style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.width * 100}%`, height: `${crop.height * 100}%` }}
          onPointerDown={event => beginDrag(event, 'move')} {...pointerEvents} onKeyDown={event => cropKeyboard(event, 'move')}
          onKeyUp={event => { if (event.key.startsWith('Arrow')) finishKeyboardCrop() }} onBlur={finishKeyboardCrop} />
        {(['nw', 'ne', 'sw', 'se'] as const).map((corner, index) => <button type="button" key={corner} data-image-crop-handle={corner}
          className="image-presentation-crop-handle" aria-label={(props.isZh ? ['裁剪左上角', '裁剪右上角', '裁剪左下角', '裁剪右下角'] : ['Crop top left', 'Crop top right', 'Crop bottom left', 'Crop bottom right'])[index]}
          style={{ left: `${(crop.x + (corner.includes('e') ? crop.width : 0)) * 100}%`, top: `${(crop.y + (corner.includes('s') ? crop.height : 0)) * 100}%` }}
          onPointerDown={event => beginDrag(event, corner)} {...pointerEvents} onKeyDown={event => cropKeyboard(event, corner)}
          onKeyUp={event => { if (event.key.startsWith('Arrow')) finishKeyboardCrop() }} onBlur={finishKeyboardCrop} />)}
      </span>}
      <label className="image-presentation-field"><span>{text('图片说明', 'Caption')}</span>
        <textarea data-image-caption-input aria-label={text('图片说明', 'Image caption')} value={draft.caption} rows={2}
          onFocus={() => latest.current.onBegin?.()} onChange={event => editField('caption', event.currentTarget.value)} onBlur={blurField}
          onCompositionStart={() => { composing.current = true }} onCompositionEnd={event => { composing.current = false; editField('caption', event.currentTarget.value); if (pendingBlur.current) { pendingBlur.current = false; commit(draftRef.current) } }}
          onKeyDown={event => { event.stopPropagation(); if (!isImeKeyboardEvent(event.nativeEvent, composing.current) && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); commit(draftRef.current) } }} />
      </label>
      <label className="image-presentation-field"><span>{text('替代文本', 'Alt text')}</span>
        <input data-image-alt-input aria-label={text('图片替代文本', 'Image alt text')} value={draft.alt}
          onFocus={() => latest.current.onBegin?.()} onChange={event => editField('alt', event.currentTarget.value)} onBlur={blurField}
          onCompositionStart={() => { composing.current = true }} onCompositionEnd={event => { composing.current = false; editField('alt', event.currentTarget.value); if (pendingBlur.current) { pendingBlur.current = false; commit(draftRef.current) } }}
          onKeyDown={event => { event.stopPropagation(); if (!isImeKeyboardEvent(event.nativeEvent, composing.current) && event.key === 'Enter') { event.preventDefault(); commit(draftRef.current) } }} />
      </label>
      <span className="image-presentation-help">{text('拖动完成后保存 · Esc 取消当前操作 · 替代文本用于无障碍阅读', 'Release to save · Esc cancels the current action · Alt text is used by screen readers')}</span>
    </span>}
  </span>
}
