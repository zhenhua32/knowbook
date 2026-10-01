import { useId, useRef, useState, type ReactNode } from 'react'

export function AiTaskSwitcher({ isZh, documentContent, extensionContent }: {
  isZh: boolean
  documentContent: ReactNode
  extensionContent: ReactNode
}) {
  const [task, setTask] = useState<'document' | 'extension'>('document')
  const id = useId()
  const buttons = useRef<Array<HTMLButtonElement | null>>([])
  const tasks = ['document', 'extension'] as const
  return <div className="ai-workspace">
    <div className="ai-task-switcher" role="tablist" aria-label={isZh ? 'AI 任务' : 'AI task'}
      onKeyDown={event => {
        const current = tasks.indexOf(task)
        const next = event.key === 'ArrowRight' ? (current + 1) % 2 : event.key === 'ArrowLeft' ? (current + 1) % 2
          : event.key === 'Home' ? 0 : event.key === 'End' ? 1 : null
        if (next === null) return
        event.preventDefault()
        setTask(tasks[next])
        buttons.current[next]?.focus()
      }}>
      {tasks.map((value, index) => <button key={value} type="button" role="tab" id={`${id}-${value}-tab`}
        ref={button => { buttons.current[index] = button }} aria-selected={task === value} aria-controls={`${id}-${value}-panel`}
        tabIndex={task === value ? 0 : -1} onClick={() => setTask(value)}>
        {value === 'document' ? (isZh ? '文档智能助手' : 'Document AI assistant') : (isZh ? '应用扩展助手' : 'App extension assistant')}
      </button>)}
    </div>
    <div className="ai-task-panel" role="tabpanel" id={`${id}-document-panel`} aria-labelledby={`${id}-document-tab`} hidden={task !== 'document'}>
      {documentContent}
    </div>
    <div className="ai-task-panel" role="tabpanel" id={`${id}-extension-panel`} aria-labelledby={`${id}-extension-tab`} hidden={task !== 'extension'}>
      {extensionContent}
    </div>
  </div>
}
