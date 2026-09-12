'use strict'

/** @typedef {import('../../src/shared/system-plugin-sdk').FullTrustPluginContext} Context */
const { themes } = require('./themes.cjs')
const { buildThemeCss } = require('./theme-css.cjs')
const THEME_KEY = 'theme-switcher.selected-theme'
const validIds = new Set(['default', ...themes.map((theme) => theme.id)])

/** @param {Context} api */
function readState(api) {
  const stored = api.settings.get(THEME_KEY)
  return { selectedThemeId: stored && validIds.has(stored) ? stored : 'default' }
}

/** @type {import('../../src/shared/system-plugin-sdk').SystemPluginLifecycle<Context>} */
module.exports = {
  activate(api) {
    const css = buildThemeCss(themes)
    api.renderer.handle('get-catalog', () => ({ themes, css }))
    api.renderer.handle('get-state', () => readState(api))
    api.renderer.handle('set-theme', (input) => {
      const id = input && typeof input === 'object' && !Array.isArray(input) ? input.themeId : undefined
      if (typeof id !== 'string' || !validIds.has(id)) throw new Error('请选择有效的内置主题。')
      if (readState(api).selectedThemeId !== id) api.settings.set(THEME_KEY, id)
      return readState(api)
    })
  }
}
