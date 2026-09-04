'use strict'

module.exports = async function activate(api) {
  try {
    api.registerSlotContribution({
      id: 'acceptance-dashboard-card',
      slot: 'workspace.dashboard',
      order: 0,
      component: ({ plugin }) => React.createElement(
        'section',
        {
          'data-testid': 'full-trust-acceptance',
          'data-plugin-revision': plugin.revisionHash
        },
        `System Plugin v3 active: ${plugin.id}`
      )
    })
    api.injectCss('[data-testid="full-trust-frame-host"] { display: block; }', {
      id: 'acceptance-global-style'
    })
    const target = window.__knowbookFullTrustAcceptanceFrameTarget
    if (!target) return
    const container = document.createElement('section')
    container.dataset.testid = 'full-trust-frame-host'
    document.body.appendChild(container)
    api.registerDisposable(() => container.remove(), 'acceptance frame host')
    const handle = await api.createUnsandboxedFrame({
      src: target,
      allowedOrigins: [target],
      allowPopups: true,
      allowNavigation: true,
      allowDownloads: true,
      allowPermissions: true,
      container,
      title: 'Full Trust acceptance frame'
    })
    handle.frame.dataset.testid = 'full-trust-acceptance-frame'
    const framedUrl = new URL(target)
    framedUrl.searchParams.set('popupName', handle.popupName)
    handle.frame.src = framedUrl.href
  } catch (error) {
    document.documentElement.dataset.fullTrustFrameError = error instanceof Error
      ? `${error.name}: ${error.message}\n${error.stack ?? ''}`
      : String(error)
    throw error
  }
}
