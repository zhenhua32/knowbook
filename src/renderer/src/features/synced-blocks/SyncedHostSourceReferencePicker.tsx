import { useEffect, useRef, useState } from 'react'
import type { SyncedGroupIdentityListResult, SyncedReferenceIdentity } from '@shared/synced-blocks'
import { SyncedStructureDialog } from './SyncedStructureDialog'
import type { StructureCommandView } from './structureCommands'

type Choice = SyncedGroupIdentityListResult['items'][number]
export interface SyncedSourcePickerPort {
  list: (query: string, offset: number) => Promise<SyncedGroupIdentityListResult>
  resolve: (choice: Choice) => Promise<SyncedReferenceIdentity | null>
}

/** Lists the current Main choices and resolves the selected creation before
 * handing any reference identity to the original local Source opening. */
export function SyncedHostSourceReferencePicker({ documentId, opener, isZh, isCurrent, port, cancel, insert }: {
  documentId: string; opener: HTMLButtonElement; isZh: boolean; isCurrent: () => boolean
  port: SyncedSourcePickerPort; cancel: () => void; insert: (identity: SyncedReferenceIdentity) => boolean
}) {
  const id = useRef({}).current, serial = useRef(0), busy = useRef(false)
  const [page, setPage] = useState({ query: '', offset: 0, total: 0, items: [] as Choice[] })
  const [loading, setLoading] = useState(true), [resolving, setResolving] = useState(false)
  const [error, setError] = useState(''), [selected, setSelected] = useState<Choice | null>(null)
  const changed = isZh ? '原宿主或所选同步块已变化，源码已保留。' : 'The original host or selected synced block changed. Your source is retained.'
  const failed = isZh ? '无法读取同步块，源码已保留。' : 'Could not read the synced blocks. Your source is retained.'

  const query = async (query: string, offset = 0) => {
    if (busy.current) return
    const latest = ++serial.current
    setPage({ query, offset, total: 0, items: [] }); setSelected(null); setLoading(true); setError('')
    try {
      const result = await port.list(query, offset)
      if (serial.current !== latest) return
      if (!isCurrent()) { setError(changed); return }
      setPage({ query, offset, ...result })
    } catch { if (serial.current === latest) setError(failed) }
    finally { if (serial.current === latest) setLoading(false) }
  }
  useEffect(() => { void query(''); return () => { serial.current++ } }, [])

  const view: StructureCommandView = { id, kind: 'insert', documentId, blockCount: 0, opener,
    busy: resolving, loading, error, uncertain: false, hasRequest: false,
    ...page, selectedGroupId: selected?.groupId ?? null, canReturnFocus: isCurrent }
  return <SyncedStructureDialog isZh={isZh} view={view} parent={opener.closest('dialog')} commands={{
    query, cancel: () => {
      if (busy.current) return false
      serial.current++; cancel(); return true
    }, choose: groupId => {
      const item = page.items.find(item => item.groupId === groupId)
      if (loading || busy.current || !item) return false
      setSelected(item); setError(''); return true
    }, apply: async () => {
      if (loading || busy.current || !selected) return false
      if (!isCurrent()) { setError(changed); return false }
      const latest = ++serial.current
      busy.current = true; setResolving(true); setError('')
      try {
        const identity = await port.resolve(selected)
        if (serial.current !== latest) return false
        if (identity && isCurrent() && insert(identity)) return true
        setError(changed); return false
      } catch (cause) {
        if (serial.current === latest) setError(cause instanceof Error ? cause.message : failed)
        return false
      } finally {
        busy.current = false
        if (serial.current === latest) setResolving(false)
      }
    }
  }} />
}
