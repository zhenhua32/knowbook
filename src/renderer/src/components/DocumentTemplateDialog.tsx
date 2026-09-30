import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CreateDocumentFromTemplateInput, DocumentTemplate, DocumentTreeNode } from '@shared/contracts'
import { serializeBlocksToMarkdown } from '@shared/markdown'
import { documentTemplateDate, expandDocumentTemplateVariables } from '@shared/documentTemplates'
import { confirmAction } from '../confirmAction'
import { trapFocusWithinDialog } from '../utils/dialogFocus'
import { getErrorMessage } from '../utils/errorMessage'
import { isImeKeyboardEvent } from '../utils/imeKeyboard'
import { MarkdownContent } from './MarkdownContent'
import './document-capture.css'

type Props = {
  isZh: boolean
  documentTree: DocumentTreeNode[]
  initialParentId?: string | null
  onClose: () => void
  onCreate: (input: CreateDocumentFromTemplateInput) => Promise<void>
}

function flattenTree(nodes: DocumentTreeNode[]): DocumentTreeNode[] {
  const result: DocumentTreeNode[] = [], pending = [...nodes].reverse()
  while (pending.length) {
    const node = pending.pop()!
    result.push(node)
    for (let index = node.children.length - 1; index >= 0; index--) pending.push(node.children[index])
  }
  return result
}

export default function DocumentTemplateDialog({ isZh, documentTree, initialParentId = null, onClose, onCreate }: Props) {
  const dialog = useRef<HTMLDialogElement>(null), search = useRef<HTMLInputElement>(null)
  const mounted = useRef(false), lock = useRef(false), composing = useRef(false), loadSequence = useRef(0)
  const automaticTitle = useRef('')
  const [templates, setTemplates] = useState<DocumentTemplate[]>([]), [selectedId, setSelectedId] = useState('')
  const [category, setCategory] = useState<'all' | 'builtIn' | 'custom'>('all'), [query, setQuery] = useState('')
  const [title, setTitle] = useState(''), [parentId, setParentId] = useState(initialParentId ?? '')
  const [loading, setLoading] = useState(true), [loadError, setLoadError] = useState(''), [error, setError] = useState('')
  const [busy, setBusy] = useState<'create' | 'delete' | null>(null)
  const labelId = useId(), hintId = useId(), previewId = useId(), formId = useId()
  const parents = useMemo(() => flattenTree(documentTree), [documentTree])
  const selected = templates.find(template => template.id === selectedId)
  const visible = templates.filter(template => (category === 'all' || (category === 'builtIn') === template.builtIn)
    && `${template.name} ${template.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const date = documentTemplateDate()
  const previewTitle = selected ? expandDocumentTemplateVariables(title.trim() || selected.title, selected.name, date) : ''
  const preview = useMemo(() => selected ? expandDocumentTemplateVariables(serializeBlocksToMarkdown(selected.blocks, { includeBlockMetadata: false }), previewTitle, date) : '',
    [selected, previewTitle, date])

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current
    setLoading(true)
    setLoadError('')
    try {
      const result = await window.knowbook.listDocumentTemplates(isZh ? 'zh-CN' : 'en-US')
      if (!mounted.current || sequence !== loadSequence.current) return
      setTemplates(result)
      setSelectedId(previous => result.some(template => template.id === previous) ? previous : result[0]?.id ?? '')
    } catch (cause) {
      if (mounted.current && sequence === loadSequence.current) setLoadError(getErrorMessage(cause,
        isZh ? '模板加载失败，请重试。' : 'Could not load templates. Please retry.'))
    } finally {
      if (mounted.current && sequence === loadSequence.current) setLoading(false)
    }
  }, [isZh])

  useEffect(() => {
    mounted.current = true
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const element = dialog.current!
    element.showModal()
    search.current?.focus()
    return () => {
      mounted.current = false
      loadSequence.current++
      element.close()
      const restore = () => { if (previous?.isConnected && !previous.matches(':disabled')) previous.focus({ preventScroll: true }) }
      restore()
      if (previous?.matches(':disabled')) window.requestAnimationFrame(restore)
    }
  }, [])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const next = selected ? expandDocumentTemplateVariables(selected.title, selected.name, date) : ''
    const previousAutomaticTitle = automaticTitle.current
    setTitle(previous => previous === previousAutomaticTitle ? next : previous)
    automaticTitle.current = next
  }, [selected, date])
  useEffect(() => {
    if (parentId && !parents.some(parent => parent.id === parentId)) setParentId('')
  }, [parentId, parents])

  const close = () => { if (!lock.current && !composing.current) onClose() }
  const create = async () => {
    if (!selected || loading || loadError || lock.current || composing.current) return
    lock.current = true
    setBusy('create')
    setError('')
    dialog.current?.focus()
    try {
      await onCreate({ templateId: selected.id, title: title.trim() || undefined, parentId: parentId || null, language: isZh ? 'zh-CN' : 'en-US' })
      if (mounted.current) onClose()
    } catch (cause) {
      if (mounted.current) setError(getErrorMessage(cause, isZh ? '创建失败，已保留标题和位置，请重试。' : 'Could not create the document. Your title and location are preserved. Please retry.'))
    } finally {
      lock.current = false
      if (mounted.current) {
        setBusy(null)
        window.requestAnimationFrame(() => { if (mounted.current) dialog.current?.querySelector<HTMLInputElement>('[name="document-title"]')?.focus() })
      }
    }
  }

  const remove = async () => {
    if (!selected || selected.builtIn || lock.current || composing.current) return
    const target = selected
    lock.current = true
    setBusy('delete')
    setError('')
    try {
      await confirmAction({ title: isZh ? `删除模板“${target.name}”` : `Delete template “${target.name}”`,
        description: isZh ? '删除后无法恢复。使用这个模板创建的文档会保留。' : 'This template cannot be recovered after deletion. Documents created from it will remain.',
        confirmLabel: isZh ? '删除模板' : 'Delete template',
        onConfirm: async () => {
          await window.knowbook.deleteDocumentTemplate(target.id)
          if (!mounted.current) return
          const next = templates.filter(template => template.id !== target.id)
          setTemplates(next)
          setSelectedId(next.find(template => category === 'all' || (category === 'builtIn') === template.builtIn)?.id ?? '')
        }
      })
    } catch (cause) {
      if (mounted.current) setError(getErrorMessage(cause, isZh ? '无法删除模板，请重试。' : 'Could not delete the template. Please retry.'))
    } finally {
      lock.current = false
      if (mounted.current) {
        setBusy(null)
        window.requestAnimationFrame(() => { if (mounted.current) search.current?.focus() })
      }
    }
  }

  return createPortal(<dialog ref={dialog} data-block-shortcuts className="document-capture-dialog document-template-dialog"
    aria-labelledby={labelId} aria-describedby={hintId} aria-busy={Boolean(busy)} tabIndex={-1}
    onCancel={event => { event.preventDefault(); close() }}
    onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
    onKeyDown={event => {
      event.stopPropagation()
      if (isImeKeyboardEvent(event.nativeEvent, composing.current)) { if (event.key === 'Escape') event.preventDefault(); return }
      if (event.key === 'Escape') { event.preventDefault(); close() }
      if (lock.current && event.key === 'Tab') { event.preventDefault(); event.currentTarget.focus(); return }
      trapFocusWithinDialog(event.nativeEvent, event.currentTarget)
    }}>
    <header className="document-capture-header"><div><h2 id={labelId}>{isZh ? '从模板新建' : 'From template'}</h2>
      <p id={hintId}>{isZh ? '选择模板，预览内容，再设置文档标题和父目录。' : 'Choose a template, preview its content, then set the document title and parent folder.'}</p></div>
      <button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={close}>{isZh ? '取消' : 'Cancel'}</button></header>
    <div className="document-template-workspace">
      <section className="document-template-browser" aria-label={isZh ? '模板' : 'Templates'}>
        <label className="document-capture-field">{isZh ? '搜索模板' : 'Search templates'}
          <input ref={search} type="search" value={query} disabled={Boolean(busy)} onChange={event => setQuery(event.target.value)}
            placeholder={isZh ? '名称或说明' : 'Name or description'} /></label>
        <div className="document-template-filters" role="group" aria-label={isZh ? '模板分类' : 'Template categories'}>
          {([['all', isZh ? '全部' : 'All'], ['builtIn', isZh ? '内置模板' : 'Built-in'], ['custom', isZh ? '自定义模板' : 'Custom']] as const).map(([value, label]) =>
            <button type="button" key={value} disabled={Boolean(busy)} aria-pressed={category === value} onClick={() => {
              setCategory(value)
              if (selected && value !== 'all' && (value === 'builtIn') !== selected.builtIn) setSelectedId(templates.find(template => (value === 'builtIn') === template.builtIn)?.id ?? '')
            }}>{label}</button>)}
        </div>
        {loading ? <p className="document-capture-hint" role="status">{isZh ? '正在加载模板…' : 'Loading templates…'}</p>
          : loadError ? <div className="document-capture-empty"><p role="alert">{loadError}</p>
            <button type="button" className="secondary-button" onClick={() => { void load() }}>{isZh ? '重试' : 'Retry'}</button></div>
          : visible.length ? <div className="document-template-list">{visible.map(template => <button type="button" key={template.id}
            className="document-template-item" aria-pressed={selectedId === template.id} disabled={Boolean(busy)} onClick={() => { setSelectedId(template.id); setError('') }}>
            <span className="document-template-item-heading"><strong>{template.name}</strong><small>{template.builtIn ? (isZh ? '内置' : 'Built-in') : (isZh ? '自定义' : 'Custom')}</small></span>
            {template.description && <span className="document-template-description">{template.description}</span>}</button>)}</div>
          : <div className="document-capture-empty"><strong>{query.trim() ? (isZh ? '没有匹配的模板' : 'No matching templates') : category === 'custom' ? (isZh ? '还没有自定义模板' : 'No custom templates yet') : (isZh ? '暂无模板' : 'No templates available')}</strong>
            <p>{category === 'custom' && !query.trim() ? (isZh ? '打开文档，在更多操作中选择“保存为模板”。' : 'Open a document and choose “Save as template” from its actions.') : (isZh ? '试试其他分类或搜索词。' : 'Try another category or search term.')}</p></div>}
      </section>
      <section className="document-template-details" aria-label={isZh ? '模板预览与创建' : 'Template preview and creation'}>
        {selected && !loading && !loadError ? <>
          <div className="document-template-preview-heading"><h3 id={previewId}>{isZh ? '内容预览' : 'Content preview'}</h3>
            {!selected.builtIn && <button type="button" className="document-template-delete" disabled={Boolean(busy)} onClick={() => { void remove() }}>{isZh ? '删除模板' : 'Delete template'}</button>}</div>
          <article className="document-template-preview" aria-labelledby={previewId} tabIndex={0}>
            {!selected.blocks[0]?.type.startsWith('heading') && <h4>{previewTitle}</h4>}
            {selected.summary && <p className="document-template-summary">{expandDocumentTemplateVariables(selected.summary, previewTitle, date)}</p>}
            {preview ? <MarkdownContent content={preview} hideImages /> : <p className="document-capture-hint">{isZh ? '此模板没有正文内容。' : 'This template has no body content.'}</p>}</article>
          <p className="document-capture-hint">{isZh ? '创建时会替换 {{date}}（当天日期）和 {{title}}（文档标题）。' : '{{date}} (today’s date) and {{title}} (document title) are filled when the document is created.'}</p>
          <form id={formId} onSubmit={event => { event.preventDefault(); void create() }}><fieldset disabled={Boolean(busy)}>
            <label className="document-capture-field">{isZh ? '文档标题' : 'Document title'}<input name="document-title" value={title}
              onChange={event => { setTitle(event.target.value); setError('') }} placeholder={isZh ? '留空使用模板标题' : 'Leave blank to use the template title'} /></label>
            <label className="document-capture-field">{isZh ? '父目录' : 'Parent folder'}<select value={parentId} onChange={event => { setParentId(event.target.value); setError('') }}>
              <option value="">{isZh ? '根目录' : 'Workspace root'}</option>{parents.map(parent => <option value={parent.id} key={parent.id}>{parent.path}</option>)}</select></label>
          </fieldset></form>
        </> : <div className="document-capture-empty"><p>{isZh ? '选择模板以查看预览。' : 'Choose a template to view its preview.'}</p></div>}
      </section>
    </div>
    {error && <p className="document-capture-error" role="alert">{error}</p>}
    <footer className="document-capture-footer"><span role="status">{busy === 'create' ? (isZh ? '正在创建文档…' : 'Creating document…') : busy === 'delete' ? (isZh ? '正在处理模板删除…' : 'Deleting template…') : ''}</span>
      <button type="submit" form={formId} className="primary-button" disabled={Boolean(busy) || loading || Boolean(loadError) || !selected}>{isZh ? '创建文档' : 'Create document'}</button></footer>
  </dialog>, document.body)
}
