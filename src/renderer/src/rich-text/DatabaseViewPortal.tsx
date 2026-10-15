import { useEffect, useState } from 'react'
import type { ComponentType } from 'react'

type Props = {
  blockId: string
  content: string
  isZh: boolean
  onCommitContent: (expectedContent: string, nextContent: string) => boolean
}
type InlineProps = Omit<Props, 'isZh'> & { mode: 'edit' }

/** The real workspace remains a cold feature. A failed chunk keeps this atom
 * and its source intact, with an explicit retry instead of a blank document. */
export default function DatabaseViewPortal({ isZh, ...props }: Props) {
  const [Component, setComponent] = useState<ComponentType<InlineProps> | null>(null)
  const [error, setError] = useState(false), [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let current = true
    setError(false)
    void Promise.all([import('../features/database/InlineDatabaseView'), import('./database-view.css')]).then(([module]) => {
      if (current) setComponent(() => module.InlineDatabaseView)
    }, () => { if (current) setError(true) })
    return () => { current = false }
  }, [attempt])
  if (Component) return <Component {...props} mode="edit" />
  return <div className="rich-database-view-state" role={error ? 'alert' : 'status'}>
    <p>{isZh ? error ? '数据库视图加载失败。' : '正在加载数据库视图…' : error ? 'Could not load database view.' : 'Loading database view…'}</p>
    {error && <button type="button" onClick={() => setAttempt(value => value + 1)}>{isZh ? '重试' : 'Retry'}</button>}
  </div>
}
