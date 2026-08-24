import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DatabaseField, DatabaseSavedView, DatabaseViewConfigV1 } from '@shared/contracts'
import {
  areDatabaseViewConfigsEqual,
  createDefaultDatabaseViewConfig,
  repairDatabaseViewConfig
} from '@shared/database-workspace'

type UseDatabaseViewDraftInput = {
  databaseId: string
  fields: DatabaseField[]
  savedViews: DatabaseSavedView[]
  activeViewId: string
  onActiveViewIdChange: (viewId: string) => void
}

export function useDatabaseViewDraft({
  databaseId,
  fields,
  savedViews,
  activeViewId,
  onActiveViewIdChange
}: UseDatabaseViewDraftInput) {
  const draftCache = useRef(new Map<string, DatabaseViewConfigV1>())
  const defaultConfig = useMemo(() => {
    const visibleFields = fields.filter((field) => field.role === 'title' || field.role === 'property' || field.id === '__document__' || field.id === '__path__' || field.id === '__updated_at__')
    return repairDatabaseViewConfig(
      createDefaultDatabaseViewConfig('table', visibleFields.map((field) => field.id)),
      fields
    )
  }, [fields])
  const activeView = savedViews.find((view) => view.id === activeViewId) ?? null
  const [draft, setDraft] = useState<DatabaseViewConfigV1>(defaultConfig)

  const getCacheKey = useCallback((viewId: string) => `${databaseId}:${viewId || '__default__'}`, [databaseId])

  useEffect(() => {
    if (!databaseId) {
      return
    }
    const rememberedId = window.localStorage.getItem(`knowbook.database.last-view.${databaseId}`) ?? ''
    const nextViewId = savedViews.some((view) => view.id === activeViewId)
      ? activeViewId
      : savedViews.some((view) => view.id === rememberedId)
        ? rememberedId
        : savedViews[0]?.id ?? ''
    if (nextViewId !== activeViewId) {
      onActiveViewIdChange(nextViewId)
    }
  }, [activeViewId, databaseId, onActiveViewIdChange, savedViews])

  useEffect(() => {
    const view = savedViews.find((candidate) => candidate.id === activeViewId) ?? null
    const cacheKey = getCacheKey(activeViewId)
    const cached = draftCache.current.get(cacheKey)
    const sourceConfig = cached ?? view?.config ?? defaultConfig
    const hydratedConfig = sourceConfig.visibleFieldIds.length === 0
      ? { ...sourceConfig, visibleFieldIds: defaultConfig.visibleFieldIds, fieldOrder: defaultConfig.fieldOrder, cardFieldIds: defaultConfig.cardFieldIds }
      : sourceConfig
    const nextDraft = repairDatabaseViewConfig(hydratedConfig, fields)
    draftCache.current.set(cacheKey, nextDraft)
    setDraft(nextDraft)
    if (databaseId) {
      window.localStorage.setItem(`knowbook.database.last-view.${databaseId}`, activeViewId)
    }
  }, [activeViewId, databaseId, defaultConfig, fields, getCacheKey, savedViews])

  const updateDraft = useCallback((updater: (current: DatabaseViewConfigV1) => DatabaseViewConfigV1) => {
    setDraft((current) => {
      const next = repairDatabaseViewConfig(updater(current), fields)
      draftCache.current.set(getCacheKey(activeViewId), next)
      return next
    })
  }, [activeViewId, fields, getCacheKey])

  const replaceDraft = useCallback((config: DatabaseViewConfigV1) => {
    const next = repairDatabaseViewConfig(config, fields)
    draftCache.current.set(getCacheKey(activeViewId), next)
    setDraft(next)
  }, [activeViewId, fields, getCacheKey])

  const markSaved = useCallback((view: DatabaseSavedView) => {
    const next = repairDatabaseViewConfig(view.config, fields)
    draftCache.current.set(getCacheKey(view.id), next)
    onActiveViewIdChange(view.id)
    setDraft(next)
  }, [fields, getCacheKey, onActiveViewIdChange])

  const activeViewConfig = activeView?.config
  const baseConfig = activeViewConfig
    ? repairDatabaseViewConfig(activeViewConfig.visibleFieldIds.length === 0
        ? { ...activeViewConfig, visibleFieldIds: defaultConfig.visibleFieldIds, fieldOrder: defaultConfig.fieldOrder, cardFieldIds: defaultConfig.cardFieldIds }
        : activeViewConfig, fields)
    : defaultConfig

  return {
    activeView,
    baseConfig,
    draft,
    dirty: !areDatabaseViewConfigsEqual(draft, baseConfig),
    markSaved,
    replaceDraft,
    updateDraft
  }
}
