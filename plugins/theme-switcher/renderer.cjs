'use strict'

/** @typedef {import('../../src/shared/system-plugin-sdk').SystemPluginServiceRpcJson} Json */
/** @typedef {import('./themes.cjs').Theme} Theme */
/** @typedef {{ themes: Theme[], css: string }} Catalog */
/** @typedef {{ selectedThemeId: string, busy: boolean, message: string, error: boolean }} State */

/** @type {import('../../src/shared/system-plugin-sdk').FullTrustRendererPluginInitializer} */
module.exports = async (api) => {
  const { React } = api
  const h = React.createElement
  const knowbook = (/** @type {Window & { knowbook: import('../../src/shared/contracts').ElectronApi }} */ (window)).knowbook
  const catalog = /** @type {Catalog} */ (/** @type {unknown} */ (await api.invokeMain('get-catalog')))
  const themes = catalog.themes
  const validIds = new Set(['default', ...themes.map((theme) => theme.id)])
  /** @param {Json} value */
  function selectedId(value) {
    const id = value && typeof value === 'object' && !Array.isArray(value) ? value.selectedThemeId : null
    return typeof id === 'string' && validIds.has(id) ? id : 'default'
  }
  /** @type {State} */
  let state = { selectedThemeId: selectedId(await api.invokeMain('get-state')), busy: false, message: '', error: false }
  const root = document.documentElement
  const attribute = 'data-knowbook-theme-switcher'
  const ownerAttribute = `${attribute}-owner`
  const owner = `${api.plugin.revisionHash}:${Math.random().toString(36).slice(2)}`
  /** @type {Set<() => void>} */
  const listeners = new Set()
  let disposed = false
  let committed = false
  let request = 0

  function applyTheme() {
    if (disposed || !committed) return
    root.setAttribute(ownerAttribute, owner)
    if (state.selectedThemeId === 'default') root.removeAttribute(attribute)
    else root.setAttribute(attribute, state.selectedThemeId)
  }
  /** @param {Partial<State>} next */
  function publish(next) {
    if (disposed) return
    state = { ...state, ...next }
    applyTheme()
    for (const listener of listeners) listener()
  }
  /** @param {() => void} listener */
  function subscribe(listener) {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
  const snapshot = () => state
  async function refresh() {
    const current = ++request
    const next = await api.invokeMain('get-state')
    if (current === request) publish({ selectedThemeId: selectedId(next) })
  }
  /** @param {string} id */
  async function selectTheme(id) {
    if (disposed || state.busy || id === state.selectedThemeId) return
    ++request
    publish({ busy: true, message: '', error: false })
    try {
      const next = await api.invokeMain('set-theme', { themeId: id })
      ++request // Invalidate reads started by the save's workspace notification.
      publish({ selectedThemeId: selectedId(next), message: id === 'default'
        ? '已恢复 KnowBook 默认外观。'
        : `已应用「${themes.find((theme) => theme.id === id)?.name}」，下次启动自动恢复。` })
    } catch (error) {
      publish({ message: `主题保存失败：${error instanceof Error ? error.message : String(error)}`, error: true })
    } finally { publish({ busy: false }) }
  }

  api.registerDisposable(() => {
    disposed = true
    ++request
    listeners.clear()
    // A retiring revision must not remove the replacement revision's theme.
    if (root.getAttribute(ownerAttribute) === owner) {
      root.removeAttribute(attribute)
      root.removeAttribute(ownerAttribute)
    }
  }, 'Theme Switcher state and appearance')
  api.injectCss(catalog.css, { id: 'theme-switcher-themes' })
  api.injectCss(`
    :root[data-theme='dark']:not([data-knowbook-theme-switcher]) .theme-switcher-settings {
      --kb-canvas: #202630; --kb-text: #eef3f8; --kb-text-soft: #c7d0dc;
      --kb-line: #3d4858; --kb-line-strong: #53637f;
      --kb-accent: #aeb4ff; --kb-accent-strong: #c7cbff; --kb-accent-soft: #303755; --kb-danger: #ff9aaa;
    }
    .theme-switcher-settings { padding: 24px; border: 1px solid var(--kb-line, #d9dee8); border-radius: 16px; background: var(--kb-canvas, #fff); color: var(--kb-text, #1a2030); }
    .theme-switcher-settings .theme-switcher-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
    .theme-switcher-settings h3 { margin: 0; font-size: 20px; letter-spacing: -.4px; }
    .theme-switcher-settings p { margin: 8px 0 0; color: var(--kb-text-soft, #596174); font-size: 13px; line-height: 1.6; }
    .theme-switcher-settings .theme-switcher-kicker { display: block; margin-bottom: 8px; color: var(--kb-accent, #5b63e8); font-size: 12px; font-weight: 700; letter-spacing: 1.6px; }
    .theme-switcher-settings .theme-switcher-current { padding: 6px 10px; border-radius: 20px; color: var(--kb-accent-strong, #444bc7); background: var(--kb-accent-soft, #eef0ff); font-size: 12px; white-space: nowrap; }
    .theme-switcher-settings .theme-switcher-group { margin-top: 24px; }
    .theme-switcher-settings h4 { margin: 0 0 12px; font-size: 12px; color: var(--kb-text-soft, #596174); font-weight: 600; }
    .theme-switcher-settings .theme-switcher-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
    .theme-switcher-settings button.theme-switcher-option { min-width: 0; display: block; padding: 8px; border: 1px solid var(--kb-line, #d9dee8); border-radius: 12px; background: var(--kb-canvas, #fff); color: var(--kb-text, #1a2030); text-align: left; cursor: pointer; transition: border-color .15s ease, box-shadow .15s ease; }
    .theme-switcher-settings button.theme-switcher-option:hover { border-color: var(--kb-accent, #5b63e8); }
    .theme-switcher-settings button.theme-switcher-option[aria-pressed='true'] { border-color: var(--kb-accent, #5b63e8); box-shadow: 0 0 0 2px var(--kb-accent, #5b63e8); }
    .theme-switcher-settings button:focus-visible { outline: 3px solid var(--kb-accent, #5b63e8); outline-offset: 4px; }
    .theme-switcher-settings button:disabled { cursor: wait; opacity: .7; }
    .theme-switcher-settings .theme-switcher-preview { display: flex; height: 90px; overflow: hidden; border-radius: 7px; border: 1px solid var(--preview-line); background: var(--preview-bg); }
    .theme-switcher-settings .theme-switcher-preview-sidebar { display: grid; align-content: start; gap: 7px; width: 26%; padding: 13px 8px; background: var(--preview-sidebar); }
    .theme-switcher-settings .theme-switcher-preview-sidebar i { display: block; height: 4px; border-radius: 4px; background: var(--preview-sidebar-text); opacity: .55; }
    .theme-switcher-settings .theme-switcher-preview-sidebar i:first-child { width: 60%; background: var(--preview-accent); opacity: 1; }
    .theme-switcher-settings .theme-switcher-preview-body { display: grid; align-content: start; flex: 1; gap: 8px; padding: 12px; }
    .theme-switcher-settings .theme-switcher-preview-body i { display: block; height: 4px; width: 70%; border-radius: 4px; background: var(--preview-text); opacity: .3; }
    .theme-switcher-settings .theme-switcher-preview-body i:first-child { width: 45%; height: 6px; opacity: .85; }
    .theme-switcher-settings .theme-switcher-preview-card { height: 24px; border-radius: 4px; border: 1px solid var(--preview-line); background: var(--preview-surface); padding: 7px; }
    .theme-switcher-settings .theme-switcher-preview-card b { display: block; height: 8px; width: 25px; border-radius: 3px; background: var(--preview-accent); }
    .theme-switcher-settings .theme-switcher-option-title { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin: 11px 4px 4px; font-size: 14px; font-weight: 600; }
    .theme-switcher-settings .theme-switcher-selected { font-size: 12px; color: var(--kb-accent, #5b63e8); }
    .theme-switcher-settings .theme-switcher-description { display: block; margin: 0 4px 5px; color: var(--kb-text-soft, #596174); font-size: 12px; line-height: 1.5; }
    .theme-switcher-settings .theme-switcher-footer { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding-top: 20px; margin-top: 20px; border-top: 1px solid var(--kb-line, #d9dee8); }
    .theme-switcher-settings button.theme-switcher-default { padding: 8px 12px; border: 1px solid var(--kb-line-strong, #d9dee8); border-radius: 8px; color: inherit; background: transparent; cursor: pointer; font-size: 12px; }
    .theme-switcher-settings button.theme-switcher-default[aria-pressed='true'] { color: var(--kb-accent-strong, #444bc7); background: var(--kb-accent-soft, #eef0ff); }
    .theme-switcher-settings .theme-switcher-footer p { margin: 0; font-size: 12px; }
    .theme-switcher-settings .theme-switcher-feedback { min-height: 20px; }
    .theme-switcher-settings .theme-switcher-feedback[role='alert'] { color: var(--kb-danger, #d1455b); }
    @media (prefers-reduced-motion: reduce) { .theme-switcher-settings button.theme-switcher-option { transition: none; } }
    @media (max-width: 620px) { .theme-switcher-settings { padding: 16px; } .theme-switcher-settings .theme-switcher-heading { flex-direction: column; } }
  `, { id: 'theme-switcher-controls' })
  // The initial theme callback runs when this revision commits, after its CSS is installed.
  api.subscribeToTheme(() => { committed = true; applyTheme() })
  api.registerDisposable(knowbook.onWorkspaceMutated(() => {
    void refresh().catch((error) => { if (!disposed) console.error('Theme Switcher refresh failed:', error) })
  }), 'Theme Switcher settings refresh')

  /** @param {Theme} theme @param {State} current */
  function themeOption(theme, current) {
    const c = theme.colors
    const selected = current.selectedThemeId === theme.id
    const style = /** @type {import('react').CSSProperties} */ ({
      '--preview-bg': c.background, '--preview-surface': c.surface,
      '--preview-sidebar': c.sidebar, '--preview-sidebar-text': c.sidebarText,
      '--preview-line': c.line, '--preview-text': c.text, '--preview-accent': c.accent
    })
    return h('button', {
      key: theme.id, type: 'button', className: 'theme-switcher-option',
      'data-testid': `theme-option-${theme.id}`, 'aria-pressed': selected,
      'aria-label': `${theme.name}，${theme.mode === 'dark' ? '深色' : '浅色'}主题`,
      disabled: current.busy, onClick: () => { void selectTheme(theme.id) }
    },
    h('span', { className: 'theme-switcher-preview', style, 'aria-hidden': true },
      h('span', { className: 'theme-switcher-preview-sidebar' }, h('i'), h('i'), h('i'), h('i')),
      h('span', { className: 'theme-switcher-preview-body' }, h('i'), h('i'), h('span', { className: 'theme-switcher-preview-card' }, h('b')))),
    h('span', { className: 'theme-switcher-option-title' }, theme.name,
      h('span', { className: 'theme-switcher-selected', 'aria-hidden': true }, selected ? '✓ 已选' : '')),
    h('span', { className: 'theme-switcher-description' }, theme.description))
  }
  function Settings() {
    const current = React.useSyncExternalStore(subscribe, snapshot, snapshot)
    const currentName = themes.find((theme) => theme.id === current.selectedThemeId)?.name ?? '跟随 KnowBook'
    return h('section', { className: 'theme-switcher-settings', 'data-testid': 'theme-switcher-settings', 'aria-label': '主题切换', 'aria-busy': current.busy },
      h('div', { className: 'theme-switcher-heading' },
        h('div', null, h('span', { className: 'theme-switcher-kicker' }, 'THEME COLLECTION'),
          h('h3', null, '为知识，换一种氛围'), h('p', null, '六款精选配色，点击即刻应用并自动保存。')),
        h('span', { className: 'theme-switcher-current' }, currentName)),
      ...(['light', 'dark'].map((mode) => h('div', { key: mode, className: 'theme-switcher-group' },
        h('h4', null, mode === 'light' ? '浅色 · 清晰轻盈' : '深色 · 沉静专注'),
        h('div', { className: 'theme-switcher-grid' }, ...themes.filter((theme) => theme.mode === mode).map((theme) => themeOption(theme, current)))))),
      h('div', { className: 'theme-switcher-footer' },
        h('button', { type: 'button', className: 'theme-switcher-default', 'data-testid': 'theme-option-default',
          'aria-pressed': current.selectedThemeId === 'default', disabled: current.busy,
          onClick: () => { void selectTheme('default') } }, '跟随 KnowBook'),
        h('p', null, '跟随应用的浅色 / 深色设置；停用插件也会恢复原有外观。')),
      h('p', { className: 'theme-switcher-feedback', role: current.error ? 'alert' : 'status' }, current.busy ? '正在保存主题…' : current.message))
  }
  api.registerSlotContribution({ id: 'theme-switcher-settings', slot: 'settings.sections', component: Settings })
}
