'use strict'

/** @type {import('../../src/shared/system-plugin-sdk').FullTrustRendererPluginInitializer} */
module.exports = (api) => {
  const { React } = api
  api.registerSlotContribution({
    id: 'starter-card', slot: 'workspace.dashboard', order: 10,
    component: ({ plugin }) => React.createElement('section', { 'data-system-plugin-starter': plugin.id },
      React.createElement('strong', null, '系统插件开发示例已启动'),
      React.createElement('p', null, `版本 ${plugin.version}；文档区可找到“系统插件示例”。`))
  })
  api.injectCss('[data-system-plugin-starter] { padding: 12px; border: 1px solid currentColor; border-radius: 8px; }', { id: 'starter-style' })
}
