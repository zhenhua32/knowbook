'use strict'

/** @typedef {import('../../src/shared/system-plugin-sdk').SystemPluginServiceRpcJson} Json */
/** @typedef {{ summaryPrefix: string, activity: null | { type: string, documentTitle: string } }} State */

/** @param {Json} value @returns {State} */
function readState(value) {
  const state = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const activity = state.activity
  return {
    summaryPrefix: typeof state.summaryPrefix === 'string' ? state.summaryPrefix : '',
    activity: activity && typeof activity === 'object' && !Array.isArray(activity)
      && typeof activity.type === 'string' && typeof activity.documentTitle === 'string'
      ? { type: activity.type, documentTitle: activity.documentTitle } : null
  }
}

/** @param {unknown} error */
const errorMessage = (error) => error instanceof Error ? error.message : String(error)

/** @type {import('../../src/shared/system-plugin-sdk').FullTrustRendererPluginInitializer} */
module.exports = async (api) => {
  const { React } = api
  const knowbook = (/** @type {Window & { knowbook: import('../../src/shared/contracts').ElectronApi }} */ (window)).knowbook
  let state = readState(await api.invokeMain('get-state'))
  /** @type {Set<() => void>} */
  const listeners = new Set()
  let disposed = false
  let request = 0
  async function refresh() {
    const current = ++request
    const next = readState(await api.invokeMain('get-state'))
    if (disposed || current !== request) return
    state = next
    for (const listener of listeners) listener()
  }
  /** @param {() => void} listener */
  function subscribe(listener) {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
  const snapshot = () => state
  function useState() { return React.useSyncExternalStore(subscribe, snapshot, snapshot) }
  api.registerDisposable(knowbook.onWorkspaceMutated(() => {
    void refresh().catch((error) => { if (!disposed) console.error('Activity Pulse refresh failed:', error) })
  }), 'Activity Pulse workspace refresh')
  api.registerDisposable(() => { disposed = true; listeners.clear() }, 'Activity Pulse state')

  function Dashboard() {
    const { activity } = useState()
    return React.createElement('section', { className: 'activity-pulse-panel', 'data-testid': 'activity-pulse-dashboard' },
      React.createElement('h3', null, 'Activity Pulse'),
      React.createElement('p', null, activity
        ? `最近活动：${activity.type === 'document.created' ? '创建' : '保存'}了“${activity.documentTitle}”。`
        : '插件已启动，等待文档创建或保存。'))
  }

  /** @param {import('../../src/shared/system-plugin-sdk').FullTrustPluginSlotProps} props */
  function DocumentAction({ context }) {
    const [busy, setBusy] = React.useState(false)
    const [message, setMessage] = React.useState('')
    const documentId = context?.documentId
    React.useEffect(() => { setMessage('') }, [documentId])
    async function run() {
      if (!documentId || busy) return
      setBusy(true)
      try {
        const result = await api.invokeMain('summary-from-first-block', { documentId })
        setMessage(result && typeof result === 'object' && !Array.isArray(result) && typeof result.message === 'string'
          ? result.message : '摘要已更新。')
      } catch (error) { setMessage(errorMessage(error)) }
      finally { setBusy(false) }
    }
    return React.createElement('div', { className: 'activity-pulse-action', 'data-testid': 'activity-pulse-action' },
      React.createElement('button', { type: 'button', className: 'secondary-button', disabled: !documentId || busy, onClick: run },
        busy ? '正在生成摘要…' : '从首个内容块生成摘要'),
      message ? React.createElement('p', { role: 'status' }, message) : null)
  }

  function Settings() {
    const current = useState()
    const [prefix, setPrefix] = React.useState(current.summaryPrefix)
    const [busy, setBusy] = React.useState(false)
    const [message, setMessage] = React.useState('')
    React.useEffect(() => { setPrefix(current.summaryPrefix) }, [current.summaryPrefix])
    async function save() {
      if (busy) return
      setBusy(true)
      try {
        await api.invokeMain('set-summary-prefix', { prefix })
        await refresh()
        setMessage('摘要前缀已保存。')
      } catch (error) { setMessage(errorMessage(error)) }
      finally { setBusy(false) }
    }
    return React.createElement('section', { className: 'activity-pulse-panel', 'data-testid': 'activity-pulse-settings' },
      React.createElement('h3', null, 'Activity Pulse'),
      React.createElement('label', null, '摘要前缀',
        React.createElement('input', {
          type: 'text', value: prefix, maxLength: 1_000,
          onChange: (/** @type {import('react').ChangeEvent<HTMLInputElement>} */ event) => setPrefix(event.target.value)
        })),
      React.createElement('p', null, '生成摘要时添加此前缀；如需分隔空格，请加在前缀末尾。'),
      React.createElement('button', { type: 'button', className: 'secondary-button', disabled: busy, onClick: save },
        busy ? '正在保存…' : '保存摘要前缀'),
      message ? React.createElement('p', { role: 'status' }, message) : null)
  }

  api.registerSlotContribution({ id: 'activity-pulse-card', slot: 'workspace.dashboard', component: Dashboard })
  api.registerSlotContribution({ id: 'summary-from-first-block', slot: 'documents.header.actions', component: DocumentAction })
  api.registerSlotContribution({ id: 'activity-pulse-settings', slot: 'settings.sections', component: Settings })
  api.injectCss(`
    .activity-pulse-panel { padding: 14px; border: 1px solid var(--border-color, currentColor); border-radius: 10px; }
    .activity-pulse-panel h3 { margin: 0 0 10px; }
    .activity-pulse-panel p, .activity-pulse-action p { margin: 8px 0 0; }
    .activity-pulse-panel label { display: grid; gap: 6px; }
    .activity-pulse-panel input { padding: 8px; color: inherit; background: transparent; border: 1px solid var(--border-color, currentColor); border-radius: 6px; }
    .activity-pulse-panel button { margin-top: 10px; }
  `, { id: 'activity-pulse-style' })
}
