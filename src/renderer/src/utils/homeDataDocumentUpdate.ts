import type {
  DocumentTreeNode,
  HomeData,
  UpdateDocumentResult
} from '@shared/contracts'

type IncrementalDocumentUpdate = Extract<UpdateDocumentResult, { requiresFullRefresh: false }>

function updateDocumentTreeNode(
  nodes: DocumentTreeNode[],
  update: IncrementalDocumentUpdate
): DocumentTreeNode[] {
  let changed = false
  const updatedNodes = nodes.map((node) => {
    const children = updateDocumentTreeNode(node.children, update)
    if (node.id !== update.document.id) {
      if (children === node.children) {
        return node
      }
      changed = true
      return { ...node, children }
    }

    changed = true
    return {
      ...node,
      title: update.catalogEntry.title,
      path: update.catalogEntry.path,
      updatedAt: update.catalogEntry.updatedAt,
      children
    }
  })

  return changed ? updatedNodes : nodes
}

export function applyIncrementalDocumentUpdate(
  homeData: HomeData,
  update: IncrementalDocumentUpdate
): HomeData {
  const existingIndex = homeData.documentCatalog.findIndex((entry) => entry.id === update.catalogEntry.id)
  const documentCatalog = existingIndex === -1
    ? [...homeData.documentCatalog, update.catalogEntry].sort((left, right) => left.path.localeCompare(right.path))
    : homeData.documentCatalog.map((entry) => (
        entry.id === update.catalogEntry.id ? update.catalogEntry : entry
      ))

  return {
    ...homeData,
    summary: update.summary,
    recentDocuments: update.recentDocuments,
    recentEvents: update.recentEvents,
    documentCatalog,
    documentTree: updateDocumentTreeNode(homeData.documentTree, update)
  }
}
