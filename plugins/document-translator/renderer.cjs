'use strict'

/** @typedef {import('../../src/shared/system-plugin-sdk').SystemPluginServiceRpcJson} Json */
/** @typedef {import('./main.cjs').Job} Job */
/** @typedef {{ aiReady: boolean, model: string, job: Job | null }} State */
/** @typedef {State & { pending: boolean, error: string }} ViewState */
/** @typedef {import('../../src/shared/system-plugin-sdk').AppNotificationHandle} Notice */
/** @typedef {import('../../src/shared/system-plugin-sdk').AppNotificationInput} NoticeInput */

/** @param {Json} value @returns {State} */
function readState(value) {
  return /** @type {State} */ (/** @type {unknown} */ (value))
}

/** @type {import('../../src/shared/system-plugin-sdk').FullTrustRendererPluginInitializer} */
module.exports = async (api) => {
  const { React } = api
  const h = React.createElement
  const knowbook = (/** @type {Window & { knowbook: import('../../src/shared/contracts').ElectronApi }} */ (window)).knowbook
  /** @type {ViewState} */
  let state = { ...readState(await api.invokeMain('get-state')), pending: false, error: '' }
  /** @type {Set<() => void>} */
  const listeners = new Set()
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer
  let disposed = false
  let request = 0
  let refreshFailed = false
  /** @type {Notice | undefined} */
  let notice
  /** @type {Notice | undefined} */
  let startNotice
  let notifiedJobId = ''
  let notificationSignature = ''

  function syncNotification() {
    const { job, pending, error } = state
    if (!job) return
    const signature = JSON.stringify({ job, pending, error })
    if (signature === notificationSignature) return
    /** @type {NoticeInput} */
    let input
    if (job.status === 'running' || job.status === 'saving') {
      input = {
        title: job.status === 'saving' ? '正在保存译文' : job.mode === 'bilingual' ? '正在生成双语对照' : '正在翻译成中文',
        message: `「${job.sourceTitle}」${error ? `\n${error}` : ''}`,
        level: 'progress',
        progress: job.completed / Math.max(1, job.total) * 100,
        progressLabel: job.status === 'saving' ? '翻译完成，正在保存…' : `${job.completed} / ${job.total} 批`,
        actions: [{ label: '取消翻译', disabled: pending || job.status === 'saving',
          run: () => run('cancel-translation', { jobId: job.id }) }]
      }
    } else if (job.status === 'completed') {
      input = {
        title: job.mode === 'bilingual' ? '双语对照已生成' : '翻译完成',
        message: `已生成「${job.resultTitle}」\n${job.resultPath ?? ''}`,
        level: 'success', persistent: true,
        actions: job.resultId ? [{ label: '打开译文', documentId: job.resultId }] : []
      }
    } else if (job.status === 'failed') {
      input = { title: '翻译失败', message: `「${job.sourceTitle}」\n${job.error}`, level: 'error' }
    } else {
      input = { title: '翻译已取消', message: `「${job.sourceTitle}」未创建译文。`, level: 'info' }
    }
    if (notifiedJobId !== job.id || !notice) {
      notice = startNotice ?? api.showNotification(input)
      startNotice = undefined
      notifiedJobId = job.id
    }
    notice.update(input)
    notificationSignature = signature
  }
  /** @param {Partial<ViewState>} next */
  function publish(next) {
    if (disposed) return
    state = { ...state, ...next }
    syncNotification()
    for (const listener of listeners) listener()
  }
  function schedule() {
    clearTimeout(timer)
    if (!disposed && (refreshFailed || state.job?.status === 'running' || state.job?.status === 'saving')) {
      timer = setTimeout(() => { void refresh() }, state.error ? 3_000 : 1_000)
    }
  }
  async function refresh() {
    const current = ++request
    try {
      const next = readState(await api.invokeMain('get-state'))
      if (current !== request || disposed) return
      publish({ ...next, error: refreshFailed ? '' : state.error })
      refreshFailed = false
    } catch {
      if (current !== request || disposed) return
      refreshFailed = true
      publish({ error: '暂时无法读取翻译进度，正在重试。' })
    }
    schedule()
  }
  /** @param {string} method @param {Json} input */
  async function run(method, input) {
    if (state.pending || disposed) return
    ++request
    clearTimeout(timer)
    if (method === 'start-translation') {
      startNotice = api.showNotification({ title: '正在启动翻译', message: '正在读取已保存的文档…', level: 'progress' })
    }
    publish({ pending: true, error: '' })
    try {
      const next = readState(await api.invokeMain(method, input))
      ++request
      publish({ ...next, error: '' })
    } catch (error) {
      const message = error instanceof Error ? error.message : '操作失败，请重试。'
      if (!disposed && method === 'start-translation') {
        startNotice?.update({ title: '无法启动翻译', message, level: 'error' })
      }
      publish({ error: message })
      // The job may have started even if delivery of its acknowledgement failed.
      void refresh()
    } finally {
      publish({ pending: false })
      schedule()
    }
  }
  /** @param {() => void} listener */
  function subscribe(listener) {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
  const snapshot = () => state
  api.registerDisposable(knowbook.onWorkspaceMutated(() => { void refresh() }), 'Translation workspace refresh')
  api.registerDisposable(() => {
    disposed = true
    ++request
    clearTimeout(timer)
    listeners.clear()
  }, 'Translation progress polling')
  syncNotification()
  schedule()

  /** @param {import('../../src/shared/system-plugin-sdk').FullTrustPluginSlotProps} props */
  function TranslationActions({ context }) {
    const current = React.useSyncExternalStore(subscribe, snapshot, snapshot)
    React.useEffect(() => { void refresh() }, [])
    const { job, aiReady, pending } = current
    const documentId = context?.documentId
    const active = job?.status === 'running' || job?.status === 'saving'
    const disabled = !documentId || !aiReady || active || pending
    /** @param {'chinese' | 'bilingual'} mode */
    const start = (mode) => {
      if (!disabled && documentId) void run('start-translation', { documentId, mode })
    }
    const hint = aiReady
      ? `使用 ${current.model} 翻译已保存的内容，请先保存编辑。待译内容会发送到已配置的 AI 服务，结果保存为同级副本。`
      : '请先在 KnowBook 设置中启用 AI，并填写接口地址、模型和 API Key。'
    return h('section', { className: 'document-translator context-menu-section', 'aria-label': '文档翻译', 'data-testid': 'document-translator' },
      h('p', { className: 'context-menu-label', title: hint }, '文档翻译'),
      h('div', { className: 'context-menu-group' },
        h('button', { type: 'button', className: 'context-menu-item', title: hint, disabled, onClick: () => start('chinese') }, '翻译成中文'),
        h('button', { type: 'button', className: 'context-menu-item', title: hint, disabled, onClick: () => start('bilingual') }, '生成双语对照')))
  }
  api.registerSlotContribution({ id: 'translate-document', slot: 'documents.header.menu', component: TranslationActions })
}
