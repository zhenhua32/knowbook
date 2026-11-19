import React, { useId, useRef, useState } from 'react'
import type { ResolveWebDavProtocol5Conflict, WebDavProtocol5ConflictPreview, WebDavSyncMergeChoice, WebDavSyncMergePart } from '@shared/webdav-sync'
import { useAsyncActionFocus } from '../hooks/useAsyncActionFocus'

type Translate = (zh: string, en: string) => string
type Component = WebDavProtocol5ConflictPreview['components'][number]
type Decision = Omit<Extract<ResolveWebDavProtocol5Conflict, { choice: 'merge' }>, 'previewId' | 'previewHash' | 'componentId'>
  | { choice: 'local' | 'remote' | 'both' }
type Resolve = (input: ResolveWebDavProtocol5Conflict, onError: (message: string) => void) => Promise<boolean>
type Feedback = { placement: 'merge' | 'whole'; error: string }
const wholeChoices = [
  ['local', '应用本机整组', 'Apply entire local group'],
  ['remote', '应用远端整组', 'Apply entire remote group'],
  ['both', '同时保留本机和远端', 'Keep both versions']
] as const

function partLabel(part: WebDavSyncMergePart, blocks: readonly string[], t: Translate): string {
  if (part.field === 'title') return t('标题', 'Title')
  if (part.field === 'summary') return t('摘要', 'Summary')
  if (part.field === 'parentId') return t('上级页面', 'Parent page')
  if (part.field === 'sortOrder') return t('排序', 'Sort order')
  if (part.field === 'blocks') return t('正文结构', 'Body structure')
  const position = blocks.indexOf(part.blockId ?? '') + 1
  return part.field === 'block-property' && part.property && part.property !== 'content' ? t(`正文块 ${position} · ${part.property}`, `Block ${position} · ${part.property}`)
    : t(`正文块 ${position}`, `Block ${position}`)
}

function Versions({ part, t }: { part: WebDavSyncMergePart; t: Translate }) {
  return <dl>
    <dt>{t('共同版本', 'Common version')}</dt><dd><pre>{part.basePreview}</pre></dd>
    <dt>{t('本机版本', 'Local version')}</dt><dd><pre>{part.localPreview}</pre></dd>
    <dt>{t('远端版本', 'Remote version')}</dt><dd><pre>{part.remotePreview}</pre></dd>
  </dl>
}

function ActionFeedback({ pending, error, t }: { pending: boolean; error: string; t: Translate }) {
  if (!pending && !error) return null
  return <div className="webdav-action-feedback" role={error ? 'alert' : 'status'}>
    <p>{error || t('正在应用选择…', 'Applying your choice…')}</p>
  </div>
}

function ConflictGroup({ component, disabled, decide, runAction, fallback, feedback, onFeedback, t }: {
  component: Component; disabled: boolean; t: Translate
  decide: (decision: Decision, onError: (message: string) => void) => Promise<boolean>
  runAction: ReturnType<typeof useAsyncActionFocus>; fallback: () => HTMLButtonElement | null
  feedback: Feedback | null; onFeedback: (feedback: Feedback | null) => void
}) {
  const prefix = useId()
  const [merging, setMerging] = useState(false), [composing, setComposing] = useState(false)
  const [choices, setChoices] = useState(() => new Map<string, WebDavSyncMergeChoice>())
  const [pending, setPending] = useState<Decision['choice'] | null>(null)
  const required = component.records.map(record => ({ ...record,
    parts: record.parts.filter(part => record.unresolvedPartIds.includes(part.id)) })).filter(record => record.parts.length)
  const choiceKey = (key: string, partId: string) => JSON.stringify([key, partId])
  const complete = required.every(record => record.parts.every(part => choices.has(choiceKey(record.key, part.id))))
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0

  const choose = (id: string, value: WebDavSyncMergeChoice) => setChoices(previous => new Map(previous).set(id, value))
  const submit = (button: HTMLButtonElement, decision: Decision) => runAction(button, async () => {
    const placement = decision.choice === 'merge' ? 'merge' : 'whole'
    let failed = false
    setPending(decision.choice)
    onFeedback({ placement, error: '' })
    try {
      const result = await decide(decision, error => { failed = true; onFeedback({ placement, error }) })
      if (!failed) onFeedback(result ? null : { placement, error: t('操作暂不可用，请重试。', 'Action is unavailable. Retry.') })
    } finally { setPending(null) }
  }, fallback)

  return <details open className="webdav-conflict-card">
    <summary>{t('同步冲突', 'Sync conflict')}</summary>
    <div className="webdav-conflict-body">
      {component.records.map(record => <div key={record.key}>
        <p className="mini-hint">{record.key}</p>
        {!merging && record.parts.map(part => <Versions key={part.id} part={part} t={t} />)}
      </div>)}
      {component.choices.length ? <>
        {feedback?.placement === 'whole' && <ActionFeedback pending={pending !== null} error={feedback.error} t={t} />}
        <div className="settings-actions">
          {wholeChoices.map(([choice, zh, en]) => component.choices.includes(choice) &&
            <button key={choice} className="secondary-button" type="button" disabled={disabled}
              aria-busy={pending === choice} onClick={event => submit(event.currentTarget, { choice })}>{t(zh, en)}</button>)}
          {component.choices.includes('merge') && <button className="secondary-button" type="button" disabled={disabled}
            aria-expanded={merging} aria-controls={`${prefix}-merge`} onClick={() => setMerging(value => !value)}>{t('逐项合并', 'Merge changes')}</button>}
        </div>
        {component.copies && <div className="mini-hint">
          {t('保留双方会在原位置应用远端版本，并为本机改动建立副本。', 'Keeping both applies the remote version to the original and copies local changes.')}
          {component.copies.documentPaths.length > 0 && <ul>{component.copies.documentPaths.map(path => <li key={path}>{path}</li>)}</ul>}
          {component.copies.groupCount > 0 && <p>{t(`同步块副本：${component.copies.groupCount}`, `Synced block copies: ${component.copies.groupCount}`)}</p>}
        </div>}
      </> : <p className="mini-hint">{t('该组需要进一步处理，双方版本已保留。', 'Both versions are retained while this group needs further review.')}</p>}
      {merging && <div id={`${prefix}-merge`} className="webdav-conflict-merge" data-block-shortcuts
        onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} onBlur={() => setComposing(false)}>
        {required.map(record => {
          const blocks = [...new Set(record.parts.flatMap(part => part.blockId ? [part.blockId] : []))]
          return record.parts.map(part => {
            const key = choiceKey(record.key, part.id), name = `${prefix}-${key}`, choice = choices.get(key)
            const label = partLabel(part, blocks, t)
            return <fieldset key={key} disabled={disabled}>
              <legend>{label}</legend>
              <Versions part={part} t={t} />
              <div className="webdav-conflict-options">
                <label><input type="radio" name={name} checked={choice?.choice === 'local'} onChange={() => choose(key, { choice: 'local' })} />{t('保留本地改动', 'Keep local change')}</label>
                <label><input type="radio" name={name} checked={choice?.choice === 'remote'} onChange={() => choose(key, { choice: 'remote' })} />{t('保留远端改动', 'Keep remote change')}</label>
                {part.canEditText && <label><input type="radio" name={name} checked={choice?.choice === 'custom'}
                  onChange={() => choose(key, { choice: 'custom', text: part.localPreview })} />{t('自定义合并内容', 'Custom merged text')}</label>}
              </div>
              {choice?.choice === 'custom' && <label className="editor-label">{t(`${label}合并内容`, `${label} merged content`)}
                {part.field === 'title' ? <input className="editor-input" value={choice.text}
                  onChange={event => choose(key, { choice: 'custom', text: event.target.value })} />
                  : <textarea className="editor-textarea" rows={5} value={choice.text}
                    onChange={event => choose(key, { choice: 'custom', text: event.target.value })} />}
              </label>}
            </fieldset>
          })
        })}
        {feedback?.placement === 'merge' && <ActionFeedback pending={pending !== null} error={feedback.error} t={t} />}
        <div className="settings-actions">
          <button className="primary-button" type="button" disabled={disabled || composing || !complete} aria-busy={pending === 'merge'}
            onClick={event => submit(event.currentTarget, { choice: 'merge', records: required.map(record => ({ key: record.key,
              parts: record.parts.map(part => ({ id: part.id, value: choices.get(choiceKey(record.key, part.id))! }))
                .sort((a, b) => compare(a.id, b.id)) })).sort((a, b) => compare(a.key, b.key)) })}>
            {t('应用逐项合并', 'Apply merged changes')}
          </button>
        </div>
      </div>}
    </div>
  </details>
}

export default function WebDavProtocol5ConflictReview({ preview, disabled, isZh, onPreview, onResolve }: {
  preview?: WebDavProtocol5ConflictPreview; disabled: boolean; isZh: boolean
  onPreview: () => Promise<boolean>; onResolve: Resolve
}) {
  const sectionRef = useRef<HTMLElement>(null), previewRef = useRef<HTMLButtonElement>(null)
  const runAction = useAsyncActionFocus(sectionRef)
  const [feedback, setFeedback] = useState<{ previewId: string; componentId: string; value: Feedback } | null>(null)
  const t: Translate = (zh, en) => isZh ? zh : en
  return <section ref={sectionRef} aria-label={t('同步块冲突', 'Synced block conflicts')}>
    <h4>{t('同步块冲突', 'Synced block conflicts')}</h4>
    <button ref={previewRef} className="secondary-button" type="button" disabled={disabled}
      onClick={event => runAction(event.currentTarget, onPreview)}>{t('读取最新冲突', 'Read latest conflicts')}</button>
    {preview?.components.map(component => <ConflictGroup key={preview.previewId + '/' + component.componentId}
      component={component} disabled={disabled} t={t} runAction={runAction} fallback={() => previewRef.current}
      feedback={feedback?.previewId === preview.previewId && feedback.componentId === component.componentId ? feedback.value : null}
      onFeedback={value => setFeedback(value ? { previewId: preview.previewId, componentId: component.componentId, value } : null)}
      decide={(decision, onError) => onResolve({
        previewId: preview.previewId, previewHash: preview.previewHash, componentId: component.componentId, ...decision
      }, onError)} />)}
  </section>
}
