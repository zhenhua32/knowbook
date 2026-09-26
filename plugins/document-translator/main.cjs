'use strict'

const { randomUUID } = require('node:crypto')
const { prepareTranslation, translationMessages, readTranslations, buildDocument, contentSnapshot } = require('./translation.cjs')

/** @typedef {import('../../src/shared/system-plugin-sdk').FullTrustPluginContext} Context */
/** @typedef {import('../../src/shared/system-plugin-sdk').SystemPluginServiceRpcJson} Json */
/** @typedef {import('./translation.cjs').Mode} Mode */
/** @typedef {{ id: string, documentId: string, sourceTitle: string, mode: Mode, status: 'running' | 'saving' | 'completed' | 'cancelled' | 'failed', completed: number, total: number, skippedBlocks: number, resultId: string | null, resultTitle: string | null, resultPath: string | null, error: string | null }} Job */

/** @param {Json} input @param {string} key */
function requireString(input, key) {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input[key] : null
  if (typeof value !== 'string' || !value.trim()) throw new Error(`缺少有效的 ${key}。`)
  return value
}

/** @type {import('../../src/shared/system-plugin-sdk').SystemPluginLifecycle<Context>} */
module.exports = {
  activate(api) {
    /** @type {Job | null} */
    let job = null
    /** @type {AbortController | null} */
    let controller = null
    let disposed = false
    function state() {
      const config = api.ai.getConfig()
      return {
        aiReady: Boolean(config.enabled && config.apiKey && config.model.trim() && config.baseUrl.trim()),
        model: config.model,
        job: job ? { ...job } : null
      }
    }
    /** @param {Job} current @param {import('../../src/shared/contracts').DocumentDetail} source
     * @param {import('./translation.cjs').Plan} plan @param {AbortController} abort */
    async function translate(current, source, plan, abort) {
      try {
        const translations = new Map()
        for (const batch of plan.batches) {
          abort.signal.throwIfAborted()
          // A background job keeps every Renderer bridge call below its 15 s budget.
          const response = await api.ai.complete({
            messages: translationMessages(batch),
            signal: AbortSignal.any([abort.signal, AbortSignal.timeout(120_000)])
          })
          abort.signal.throwIfAborted()
          for (const [id, text] of readTranslations(response, batch)) translations.set(id, text)
          current.completed++
        }
        abort.signal.throwIfAborted()
        if (disposed) return
        const latest = api.documents.get(source.id)
        if (!latest) throw new Error('原文已被删除，未创建翻译文档。')
        if (contentSnapshot(latest) !== contentSnapshot(source)) throw new Error('原文在翻译期间发生了修改，请重新翻译。')
        const entry = api.documents.list().find((item) => item.id === source.id)
        if (!entry) throw new Error('原文已被删除，未创建翻译文档。')
        current.status = 'saving'
        // Save beside the source so relative Markdown links keep the same base.
        const result = await api.documents.create({ parentId: entry.parentId, ...buildDocument(source, plan, translations, current.mode) })
        current.resultId = result.id
        current.resultTitle = result.title
        current.resultPath = result.path
        current.status = 'completed'
      } catch (error) {
        if (abort.signal.aborted || disposed) current.status = 'cancelled'
        else {
          current.status = 'failed'
          // Do not forward provider error bodies (which can echo credentials or content).
          const message = error instanceof Error ? error.message : ''
          current.error = error instanceof Error && error.name === 'TimeoutError'
            ? 'AI 请求超过 120 秒，请稍后重试或更换模型。'
            : /^(AI |原文|译文)/.test(message) && !message.startsWith('AI request failed')
              ? message.slice(0, 300) : '翻译失败，请检查 AI 配置、网络和模型额度后重试。'
        }
      }
    }
    api.renderer.handle('get-state', state)
    api.renderer.handle('start-translation', (input) => {
      if (disposed) throw new Error('翻译插件已停用。')
      const documentId = requireString(input, 'documentId')
      const mode = requireString(input, 'mode')
      if (mode !== 'chinese' && mode !== 'bilingual') throw new Error('请选择中文翻译或双语对照。')
      if (job?.status === 'running' || job?.status === 'saving') throw new Error('已有翻译任务正在进行，请等待完成或先取消。')
      if (!state().aiReady) throw new Error('请先在 KnowBook 设置中启用 AI，并填写接口地址、模型和 API Key。')
      const document = api.documents.get(documentId)
      if (!document) throw new Error('文档不存在或已被删除。')
      const plan = prepareTranslation(document)
      controller = new AbortController()
      job = { id: randomUUID(), documentId, sourceTitle: document.title, mode, status: 'running',
        completed: 0, total: plan.batches.length, skippedBlocks: plan.skippedBlocks,
        resultId: null, resultTitle: null, resultPath: null, error: null }
      void translate(job, document, plan, controller)
      return state()
    })
    api.renderer.handle('cancel-translation', (input) => {
      const id = requireString(input, 'jobId')
      if (job?.id === id && job.status === 'running') {
        controller?.abort()
        job.status = 'cancelled'
      }
      return state()
    })
    api.registerDisposable(() => { disposed = true; controller?.abort() }, 'Cancel document translation')
  }
}
