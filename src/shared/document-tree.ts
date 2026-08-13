import type { DocumentIndexEntry, DocumentTreeNode } from './contracts'

interface TreeBuilderEntry {
  node: DocumentTreeNode
  parentId: string | null
}

export function buildDocumentTreeFromCatalog(catalog: DocumentIndexEntry[]): DocumentTreeNode[] {
  const entries = new Map<string, TreeBuilderEntry>()
  const roots: DocumentTreeNode[] = []

  for (const document of catalog) {
    entries.set(document.id, {
      node: {
        id: document.id,
        title: document.title,
        path: document.path,
        updatedAt: document.updatedAt,
        children: []
      },
      parentId: document.parentId
    })
  }

  for (const entry of entries.values()) {
    const parent = entry.parentId ? entries.get(entry.parentId) : undefined
    if (parent) {
      parent.node.children.push(entry.node)
    } else {
      roots.push(entry.node)
    }
  }

  return roots
}
