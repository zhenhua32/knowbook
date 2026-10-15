import { useCallback, useEffect, useRef, useState } from 'react'
import type { UiLanguage } from '../i18n'
import { slashCommandCatalog, type BlockSlashCommand } from '../utils/slashCommandCatalog'

type CatalogOwner = { key: string | null }
type CatalogState = { owner: CatalogOwner; status: 'pending' | 'ready' | 'error'; commands: BlockSlashCommand[] }

export function useSlashCommandCatalog(language: UiLanguage, contextKey: string | null) {
  const [state, setState] = useState<CatalogState | null>(null)
  const [retry, setRetry] = useState(0)
  const currentOwner = useRef<CatalogOwner>({ key: contextKey })
  if (currentOwner.current.key !== contextKey) currentOwner.current = { key: contextKey }
  const owner = currentOwner.current
  const cached = slashCommandCatalog.cached(language)

  useEffect(() => {
    if (contextKey === null || slashCommandCatalog.cached(language)) return
    let current = true
    setState({ owner, status: 'pending', commands: [] })
    void slashCommandCatalog.load(language).then(commands => {
      if (current && currentOwner.current === owner) setState({ owner, status: 'ready', commands })
    }).catch(() => {
      if (current && currentOwner.current === owner) setState({ owner, status: 'error', commands: [] })
    })
    return () => { current = false }
  }, [contextKey, language, owner, retry])

  const ready = cached ?? (state?.owner === owner && state.status === 'ready' ? state.commands : null)
  const failed = !ready && contextKey !== null && state?.owner === owner && state.status === 'error'
  return {
    commands: ready ?? [],
    loading: contextKey !== null && !ready && !failed,
    error: failed ? (language === 'zh-CN' ? '无法加载命令，请重试。' : 'Could not load commands. Please retry.') : null,
    retry: useCallback(() => { if (contextKey !== null && currentOwner.current === owner) setRetry(value => value + 1) }, [contextKey, owner])
  }
}
