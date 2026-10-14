import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createColdBlockPopup } from '../utils/coldBlockPopup'
import type { createPluginManagementActions, PluginManagementContext, UsePluginManagementParams } from './pluginManagementActions'

type Actions = ReturnType<typeof createPluginManagementActions>
type ActionsModule = Pick<typeof import('./pluginManagementActions'), 'createPluginManagementActions'>
const loadPluginActions = () => import('./pluginManagementActions')
const INVENTORY_ACTION = 'installSystemPluginFromFolder'
const DIRECTORY_ACTION = 'openSystemPluginDirectory'
const RESTART_ACTION = 'restartInSystemPluginSafeMode'
const DOCUMENT_ACTION = 'runPluginDocumentAction'
const REMOVE_PLUGIN_ACTION = 'removePluginV2'
const REMOVE_STARTUP_ACTION = 'removeSystemPluginOsPersistence'
const actionNames: (keyof Actions)[] = [
  INVENTORY_ACTION,
  REMOVE_PLUGIN_ACTION,
  'setPluginV2Enabled',
  'setSystemPluginEnabled',
  'recoverSystemPlugin',
  'uninstallSystemPlugin',
  'rollbackSystemPlugin',
  'startSystemPluginService',
  'stopSystemPluginService',
  'requestSystemPluginOsPersistence',
  'resolveSystemPluginOsPersistence',
  REMOVE_STARTUP_ACTION,
  DIRECTORY_ACTION,
  RESTART_ACTION,
  DOCUMENT_ACTION,
]

export function usePluginManagement(params: UsePluginManagementParams, loadActions: () => Promise<ActionsModule> = loadPluginActions) {
  const [pluginBusyId, setPluginBusyId] = useState<string | null>(null)
  const [pluginActionBusyKey, setPluginActionBusyKey] = useState<string | null>(null)
  const [pluginInventoryBusy, setPluginInventoryBusy] = useState(false)
  const documentSession = useRef({ id: params.selectedDocumentId, revision: 0 })
  if (documentSession.current.id !== params.selectedDocumentId)
    documentSession.current = { id: params.selectedDocumentId, revision: documentSession.current.revision + 1 }
  const latest = useRef(params)
  latest.current = params
  const loader = useRef(loadActions)
  loader.current = loadActions
  const loading = useRef<Promise<ActionsModule> | null>(null)
  const pending = useRef(new Map<string, symbol>())
  const lifecycle = useRef(0)
  const mounted = useRef(false)
  useLayoutEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; lifecycle.current++; pending.current.clear() }
  }, [])

  const invoke = useCallback(async (name: keyof Actions, args: unknown[]) => {
    if (!mounted.current) return
    const snapshot = latest.current, generation = lifecycle.current, session = documentSession.current.revision
    const documentAction = name === DOCUMENT_ACTION
    if (documentAction && !snapshot.selectedDocumentId) return
    const plugin = args[0] as { pluginId: string; id?: string } | undefined
    const inventory = name === INVENTORY_ACTION
    const directory = name === DIRECTORY_ACTION
    const restart = name === RESTART_ACTION
    const slot = documentAction ? 'document' : inventory ? 'inventory' : directory ? `directory:${plugin?.pluginId}:${args[1]}`
      : restart ? 'restart' : 'plugin'
    if (pending.current.has(slot)) return
    const token = Symbol(slot)
    pending.current.set(slot, token)
    if (documentAction) setPluginActionBusyKey(`${plugin!.pluginId}:${plugin!.id}`)
    else if (inventory) setPluginInventoryBusy(true)
    else if (!directory && !restart) setPluginBusyId(plugin!.pluginId)
    const isCurrent = () => mounted.current && lifecycle.current === generation
    const ownsDocument = () => isCurrent() && documentSession.current.revision === session && latest.current.selectedDocumentId === snapshot.selectedDocumentId
    const needsAttention = inventory || directory || restart || name === REMOVE_PLUGIN_ACTION || name === REMOVE_STARTUP_ACTION
    const cold = needsAttention ? createColdBlockPopup(document.activeElement instanceof HTMLElement ? document.activeElement : null) : null
    const guarded = <Args extends unknown[]>(callback: (...values: Args) => void, owns = isCurrent) =>
      (...values: Args): void => { if (owns()) callback(...values) }
    const context: PluginManagementContext = {
      ...snapshot,
      onHomeDataChange: guarded(snapshot.onHomeDataChange),
      onSelectedDocumentChange: guarded(snapshot.onSelectedDocumentChange, ownsDocument),
      onDraftSummaryChange: guarded(snapshot.onDraftSummaryChange, ownsDocument),
      onMessage: guarded(snapshot.onMessage),
      setPluginBusyId: guarded(setPluginBusyId),
      setPluginActionBusyKey: guarded(setPluginActionBusyKey),
      setPluginInventoryBusy: guarded(setPluginInventoryBusy)
    }
    const request = loading.current ??= Promise.resolve().then(() => loader.current())
    let loaded = false
    try {
      const module = await request
      loaded = true
      if (!isCurrent() || documentAction && !ownsDocument() || cold?.vetoed()) return
      cold?.dispose()
      const action = module.createPluginManagementActions(context)[name] as (...values: unknown[]) => Promise<void>
      await action(...args)
    } catch (error) {
      if (!loaded && loading.current === request) loading.current = null
      if (isCurrent()) snapshot.onMessage(error instanceof Error ? error.message : snapshot.ui.pluginActionFailed, 'error')
    } finally {
      cold?.dispose()
      if (pending.current.get(slot) === token) pending.current.delete(slot)
      if (isCurrent()) {
        if (documentAction) setPluginActionBusyKey(null)
        else if (inventory) setPluginInventoryBusy(false)
        else if (!directory && !restart) setPluginBusyId(null)
      }
    }
  }, [])
  const actions = useMemo(() => Object.fromEntries(actionNames.map(name =>
    [name, (...args: unknown[]) => invoke(name, args)])) as Actions, [invoke])
  return { pluginBusyId, pluginActionBusyKey, pluginInventoryBusy, ...actions }
}
