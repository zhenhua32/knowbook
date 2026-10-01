import { useId } from 'react'

type AiRequestErrorProps = {
  isZh: boolean
  error: string
  failedPrompt: string
  busy: boolean
  canRetry: boolean
  onRetry: () => void
}

export function AiRequestError({ isZh, error, failedPrompt, busy, canRetry, onRetry }: AiRequestErrorProps) {
  const titleId = useId()
  if (!error.trim()) return null
  const message = error.replace(/^Error invoking remote method '[^']+':\s*/i, '').replace(/^Error:\s*/i, '').trim()
    || (isZh ? '请求暂时没有完成，请重试。' : 'The request could not be completed. Please try again.')
  return <section className="ai-request-error" role="alert" aria-labelledby={titleId}>
    <strong id={titleId} className="ai-request-error-title">{isZh ? 'AI 请求失败' : 'AI request failed'}</strong>
    <p className="ai-request-error-message">{message}</p>
    {failedPrompt ? <div className="ai-request-failed-prompt">
      <span>{isZh ? '上次问题' : 'Last question'}</span><p>{failedPrompt}</p>
    </div> : null}
    <button className="secondary-button" type="button" disabled={busy || !canRetry || !failedPrompt.trim()} onClick={onRetry}>
      {busy ? (isZh ? '重试中…' : 'Retrying…') : (isZh ? '重试上次问题' : 'Retry last question')}
    </button>
  </section>
}
