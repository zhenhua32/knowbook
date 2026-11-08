import { useRef, useState } from 'react'
import type { ResolveWebDavProtocol5Deletion, WebDavProtocol5DeletionPreview, WebDavProtocol5DeletionSide } from '@shared/webdav-sync'
import { useAsyncActionFocus } from '../hooks/useAsyncActionFocus'

type Translate = (zh: string, en: string) => string
const reasons: Record<string, readonly [string, string]> = {
  'history-pin': ['仍有引用或历史记录引用同步块。', 'References or history still require the synced block.'],
  'baseline-missing': ['缺少可核对的共同记录。', 'The exact common record is unavailable.'],
  'incarnation': ['记录属于不同的创建身份。', 'The records have different creation identities.'],
  'tombstone': ['仍有须保留的已确认删除。', 'A confirmed deletion must be retained.'],
  'dependency': ['关联记录发生变化或无法一起应用。', 'Related records changed or cannot be applied together.']
}

function Side({ title, side, t }: { title: string; side: WebDavProtocol5DeletionSide; t: Translate }) {
  const state = side.kind === 'deleted' ? t('已删除', 'Deleted')
    : side.kind === 'missing' ? t('无记录', 'No record')
    : side.kind === 'unavailable' ? t('原记录暂不可查看', 'Original record unavailable')
    : t('存活', 'Live')
  return <>
    <dt>{title} · {state}</dt>
    <dd>
      {side.hash && <code title={side.hash}>{side.hash.slice(0, 12)}</code>}
      {side.kind === 'deleted' && side.deletedAt && <p>{new Date(side.deletedAt).toLocaleString()}</p>}
      {side.kind === 'live' && <>
        {side.title && <h5>{side.title}</h5>}
        {side.text && <pre>{side.text}</pre>}
        {side.truncated && <p className="mini-hint">{t('正文过长，预览只显示开头。', 'This preview shows only the start of the body.')}</p>}
      </>}
    </dd>
  </>
}

function ChoiceGroup({ component, disabled, onChoose, t }: {
  component: WebDavProtocol5DeletionPreview['components'][number]; disabled: boolean; t: Translate
  onChoose: (choice: ResolveWebDavProtocol5Deletion['choice'], button: HTMLButtonElement) => void
}) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const explain = (reason: string) => {
    const text = reasons[reason]
    return text ? t(...text) : t('该选择不满足当前记录的完整性要求。', 'This choice is unavailable for the current related records.')
  }
  return <details open className="webdav-conflict-card">
    <summary>{t('待处理的删除记录', 'Deletion conflict to review')}</summary>
    <div className="webdav-conflict-body">
      {component.records.map(record => <div key={record.key}>
        <p className="mini-hint">{record.key}</p>
        <dl>
          <Side title={t('共同版本', 'Common version')} side={record.base} t={t} />
          <Side title={t('本机版本', 'Local version')} side={record.local} t={t} />
          <Side title={t('远端版本', 'Remote version')} side={record.remote} t={t} />
        </dl>
      </div>)}
      {!component.completeText && <p className="mini-hint">{t('关联记录无法完整预览，当前保留双方。', 'Both versions are retained because the full related content cannot be previewed.')}</p>}
      {component.keepLiveReason && <p className="mini-hint">{t('无法保留存活版本。', 'Keeping the live version is unavailable.')} {explain(component.keepLiveReason)}</p>}
      {component.keepDeleteReason && <p className="mini-hint">{t('无法保留删除。', 'Keeping the deletion is unavailable.')} {explain(component.keepDeleteReason)}</p>}
      {component.choices.length > 0 && <p className="mini-hint">{t('选择应用于整组关联记录。已接受永久删除的其他设备会保留其删除记录。', 'Your choice applies to the full group. Other devices that already accepted a permanent deletion retain it.')}</p>}
      <div className="settings-actions">
        {component.choices.includes('keep-live') && <button type="button" className="secondary-button" disabled={disabled}
          onClick={event => onChoose('keep-live', event.currentTarget)}>{t('保留存活版本', 'Keep live version')}</button>}
        {component.choices.includes('keep-delete') && <button type="button" className="secondary-button" disabled={disabled}
          onClick={event => confirmDelete ? onChoose('keep-delete', event.currentTarget) : setConfirmDelete(true)}>
          {confirmDelete ? t('确认保留永久删除', 'Confirm permanent deletion') : t('保留删除', 'Keep deletion')}
        </button>}
      </div>
      {confirmDelete && <p role="status">{t('确认后，本机将接受此组的永久删除。', 'Confirm to accept the permanent deletion for this group on this device.')}</p>}
    </div>
  </details>
}

export default function WebDavProtocol5DeletionReview({ preview, disabled, onPreview, onResolve, isZh }: {
  preview?: WebDavProtocol5DeletionPreview; disabled: boolean; isZh: boolean
  onPreview: () => Promise<boolean>; onResolve: (input: ResolveWebDavProtocol5Deletion) => Promise<boolean>
}) {
  const rootRef = useRef<HTMLElement>(null), previewRef = useRef<HTMLButtonElement>(null)
  const runAction = useAsyncActionFocus(rootRef)
  const t: Translate = (zh, en) => isZh ? zh : en
  return <section ref={rootRef} aria-label={t('同步块删除冲突', 'Synced block deletion conflicts')}>
    <h4>{t('同步块删除冲突', 'Synced block deletion conflicts')}</h4>
    <button ref={previewRef} type="button" className="secondary-button" disabled={disabled}
      onClick={event => runAction(event.currentTarget, onPreview)}>{t('读取删除冲突', 'Read deletion conflicts')}</button>
    {preview?.components.map(component => <ChoiceGroup key={preview.previewId + '/' + component.componentId}
      component={component} disabled={disabled} t={t} onChoose={(choice, button) => runAction(button, () => onResolve({
        previewId: preview.previewId, previewHash: preview.previewHash, componentId: component.componentId, choice
      }), () => previewRef.current)} />)}
  </section>
}
