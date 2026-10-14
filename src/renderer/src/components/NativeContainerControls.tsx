import { useState } from 'react'
import { NATIVE_CALLOUT_ICONS, NATIVE_CALLOUT_KINDS, NATIVE_CONTAINER_TONES, type MarkdownBlockFormat } from '@shared/markdownFormat'
import { BLOCK_CONVERSION_TYPES } from '../utils/blockConversionTypes'
import { isImeKeyboardEvent } from '../utils/imeKeyboard'
import '../styles/native-containers.css'

type Props = {
  type: 'callout' | 'toggle'
  format?: MarkdownBlockFormat
  isZh: boolean
  typeOptions: Record<string, string>
  disabled?: boolean
  onChange: (format: MarkdownBlockFormat) => void
  onAddChild?: (type: typeof BLOCK_CONVERSION_TYPES[number]) => void
  onReturnToTitle?: () => void
}

const kindZh = ['笔记', '信息', '技巧', '警告', '危险']
const iconZh = [...kindZh, '书籍', '图钉', '勾选', '问题']
const toneZh = ['灰色', '棕色', '橙色', '黄色', '绿色', '蓝色', '紫色', '粉色', '红色']

export function NativeContainerControls({ type, format = {}, isZh, typeOptions, disabled = false,
  onChange, onAddChild, onReturnToTitle }: Props) {
  const [childType, setChildType] = useState<typeof BLOCK_CONVERSION_TYPES[number]>('paragraph')
  return <details className="native-container-controls" onKeyDown={event => {
    if (isImeKeyboardEvent(event.nativeEvent)) return
    if (event.key === 'Escape' && onReturnToTitle) { event.preventDefault(); event.stopPropagation(); onReturnToTitle() }
  }}>
    <summary>{type === 'callout' ? (isZh ? '提示块设置' : 'Callout settings') : (isZh ? '折叠块设置' : 'Toggle settings')}</summary>
    <div className="native-container-control-fields">
      {type === 'callout' ? <>
        <label>{isZh ? '提示类型' : 'Callout kind'}<select aria-label={isZh ? '提示类型' : 'Callout kind'} disabled={disabled}
          value={format.calloutKind ?? 'note'} onChange={event => onChange({ ...format, calloutKind: event.target.value as MarkdownBlockFormat['calloutKind'] })}>
          {NATIVE_CALLOUT_KINDS.map((kind, index) => <option key={kind} value={kind}>{isZh ? kindZh[index] : kind}</option>)}
        </select></label>
        <label>{isZh ? '提示图标' : 'Callout icon'}<select aria-label={isZh ? '提示图标' : 'Callout icon'} disabled={disabled}
          value={format.calloutIcon ?? ''} onChange={event => onChange({ ...format, calloutIcon: event.target.value as MarkdownBlockFormat['calloutIcon'] || undefined })}>
          <option value="">{isZh ? '随提示类型' : 'Follow kind'}</option>
          {NATIVE_CALLOUT_ICONS.map((icon, index) => <option key={icon} value={icon}>{isZh ? iconZh[index] : icon}</option>)}
        </select></label>
        <label>{isZh ? '提示颜色' : 'Callout tone'}<select aria-label={isZh ? '提示颜色' : 'Callout tone'} disabled={disabled}
          value={format.calloutTone ?? ''} onChange={event => onChange({ ...format, calloutTone: event.target.value as MarkdownBlockFormat['calloutTone'] || undefined })}>
          <option value="">{isZh ? '随提示类型' : 'Follow kind'}</option>
          {NATIVE_CONTAINER_TONES.map((tone, index) => <option key={tone} value={tone}>{isZh ? toneZh[index] : tone}</option>)}
        </select></label>
      </> : <label><input type="checkbox" checked={format.toggleDefaultOpen ?? true} disabled={disabled}
        onChange={event => onChange({ ...format, toggleDefaultOpen: event.target.checked })} />{isZh ? '默认展开' : 'Open by default'}</label>}
      {onAddChild ? <div className="native-container-child-controls">
        <label>{isZh ? '子块类型' : 'Child block type'}<select aria-label={isZh ? '子块类型' : 'Child block type'} disabled={disabled}
          value={childType} onChange={event => setChildType(event.target.value as typeof childType)}>
          {BLOCK_CONVERSION_TYPES.map(value => <option key={value} value={value}>{typeOptions[value] ?? value}</option>)}
        </select></label>
        <button type="button" disabled={disabled} onClick={() => onAddChild(childType)}>{isZh ? '添加子块' : 'Add child block'}</button>
      </div> : null}
    </div>
  </details>
}
