import type { DocumentCatalogEntry, DocumentCatalogTuple } from './contracts'

export function encodeDocumentCatalogEntry(document: DocumentCatalogEntry): DocumentCatalogTuple {
  return [
    document.id,
    document.title,
    document.path,
    document.summary,
    document.parentId,
    document.parentTitle,
    document.updatedAt,
    document.blockCount,
    document.linkCount,
    document.childCount,
    Object.keys(document.fieldValues).length > 0 ? document.fieldValues : null
  ]
}

export function decodeDocumentCatalogEntry(tuple: DocumentCatalogTuple): DocumentCatalogEntry {
  return {
    id: tuple[0],
    title: tuple[1],
    path: tuple[2],
    summary: tuple[3],
    parentId: tuple[4],
    parentTitle: tuple[5],
    updatedAt: tuple[6],
    blockCount: tuple[7],
    linkCount: tuple[8],
    childCount: tuple[9],
    fieldValues: tuple[10] ?? {}
  }
}
