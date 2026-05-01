module.exports.activate = function activate(api) {
  const card = api.contributeDashboardCard({
    id: 'activity-pulse-card',
    title: 'Plugin host online',
    body: 'Workspace plugins can contribute cards and document actions from a sandboxed entry file.'
  })

  api.onWorkspaceEvent(['document.created', 'document.updated'], function handleWorkspaceEvent(event) {
    const documentTitle = event.documentTitle || 'Untitled document'
    card.update({
      title: 'Latest plugin-observed activity',
      body: `Last observed event: ${event.type} on ${documentTitle}.`
    })
  })

  api.contributeDocumentAction(
    {
      id: 'summary-from-first-block',
      label: 'Summary from first block',
      description: 'Use the first non-empty block to refresh the saved summary.'
    },
    function runAction(context) {
      const firstContentBlock = context.document.blocks.find(function findBlock(block) {
        return typeof block.content === 'string' && block.content.trim().length > 0
      })

      if (!firstContentBlock) {
        return {
          message: 'No non-empty block was found for summary generation.',
          refreshDocument: false
        }
      }

      const nextSummary = firstContentBlock.content.trim().replace(/\s+/g, ' ').slice(0, 80)
      api.documents.updateSummary(context.document.id, nextSummary)
      api.log('Summary synced', `Synced summary from the first content block in ${context.document.title}.`, context.document.id)

      return {
        message: 'Summary refreshed from the first non-empty block.',
        refreshDocument: true
      }
    }
  )
}