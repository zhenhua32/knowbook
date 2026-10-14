import { useState } from 'react'
import { INLINE_TEXT_COLORS } from '@shared/inlineTextPresentation'
import type { SourceInlinePresentationAction } from '../utils/sourceInlinePresentation'
export { formatSourceInlinePresentation } from '../utils/sourceInlinePresentation'
export type { SourceInlinePresentationAction } from '../utils/sourceInlinePresentation'
import '../styles/inline-text-presentation.css'

export function SourceInlinePresentationToolbar({ isZh, disabled = false, onApply, onReturnToEditor }: {
  isZh: boolean; disabled?: boolean; onApply: (action: SourceInlinePresentationAction) => void; onReturnToEditor: () => void
}) {
  const [palette, setPalette] = useState<'textColor' | 'backgroundColor' | null>(null)
  const colorNames = isZh ? ['灰色', '棕色', '橙色', '黄色', '绿色', '蓝色', '紫色', '粉色', '红色'] : ['Gray', 'Brown', 'Orange', 'Yellow', 'Green', 'Blue', 'Purple', 'Pink', 'Red']
  return <div className="source-inline-presentation-toolbar" onMouseDown={event => event.preventDefault()} onKeyDown={event => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setPalette(null); onReturnToEditor() }
  }}>
    <div role="toolbar" aria-label={isZh ? '文字颜色与下划线' : 'Text colors and underline'}>
      <button type="button" disabled={disabled} aria-label={isZh ? '下划线' : 'Underline'} onClick={() => onApply({ kind: 'underline' })}>U</button>
      {(['textColor', 'backgroundColor'] as const).map(kind => <button key={kind} type="button" disabled={disabled} aria-haspopup="dialog" aria-expanded={palette === kind}
        aria-label={isZh ? kind === 'textColor' ? '文字颜色' : '背景颜色' : kind === 'textColor' ? 'Text color' : 'Background color'}
        title={isZh ? kind === 'textColor' ? '文字颜色' : '背景颜色' : kind === 'textColor' ? 'Text color' : 'Background color'}
        onClick={() => setPalette(value => value === kind ? null : kind)}><span aria-hidden="true" data-source-color-control={kind}>A</span></button>)}
    </div>
    {palette && <div className="rich-text-color-palette" role="dialog" aria-label={isZh ? palette === 'textColor' ? '选择文字颜色' : '选择背景颜色' : palette === 'textColor' ? 'Choose text color' : 'Choose background color'}>
      <button type="button" disabled={disabled} onClick={() => { onApply({ kind: palette }); setPalette(null) }}>{isZh ? '恢复默认' : 'Default'}</button>
      {INLINE_TEXT_COLORS.map((color, index) => <button key={color} type="button" disabled={disabled} data-palette-color={color} aria-label={colorNames[index]}
        onClick={() => { onApply({ kind: palette, color }); setPalette(null) }}><span aria-hidden="true" data-palette-swatch={palette}>A</span>{colorNames[index]}</button>)}
    </div>}
  </div>
}
