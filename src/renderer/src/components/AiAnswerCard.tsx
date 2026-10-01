import { useLayoutEffect, useRef, useState } from 'react'
import { AiAnswerContent } from './AiAnswerContent'

type AiAnswerCardProps = {
  content: string
  prompt: string
  isZh: boolean
  className?: string
}

export function AiAnswerCard({ content, prompt, isZh, className = '' }: AiAnswerCardProps) {
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'error'>('idle')
  const copyRequest = useRef(0)
  const copying = useRef(false)

  useLayoutEffect(() => {
    copyRequest.current += 1
    copying.current = false
    setCopyState('idle')
    return () => { copyRequest.current += 1 }
  }, [content, prompt])

  const copyAnswer = async () => {
    if (copying.current) return
    copying.current = true
    const request = ++copyRequest.current
    setCopyState('copying')
    try {
      await window.knowbook.writeClipboardText(content)
      if (copyRequest.current === request) setCopyState('copied')
    } catch {
      if (copyRequest.current === request) setCopyState('error')
    } finally {
      if (copyRequest.current === request) copying.current = false
    }
  }

  return <section className={`ai-answer ${className}`.trim()} aria-label={isZh ? 'AI 回答' : 'AI answer'}>
    {prompt ? <div className="ai-answer-question">
      <span>{isZh ? '问题' : 'Question'}</span><p>{prompt}</p>
    </div> : null}
    <div className="ai-answer-header">
      <p className="ai-answer-label">{isZh ? 'AI 回答' : 'AI answer'}</p>
      <div className="ai-answer-tools">
        <span className={`ai-answer-copy-status${copyState === 'error' ? ' is-error' : ''}`} role="status">
          {copyState === 'copying' ? (isZh ? '正在复制…' : 'Copying…')
            : copyState === 'copied' ? (isZh ? '已复制' : 'Copied')
            : copyState === 'error' ? (isZh ? '复制失败，请重试' : 'Could not copy. Try again.') : ''}
        </span>
        <button className="secondary-button ai-answer-copy" type="button" disabled={copyState === 'copying'} aria-busy={copyState === 'copying'}
          onClick={() => { void copyAnswer() }}>
          {isZh ? '复制回答' : 'Copy answer'}
        </button>
      </div>
    </div>
    <AiAnswerContent content={content} />
  </section>
}
