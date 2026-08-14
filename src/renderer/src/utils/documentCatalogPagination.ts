import type {
  DocumentCatalogEntry,
  DocumentCatalogPage,
  DocumentCatalogPageInput
} from '@shared/contracts'

export const DOCUMENT_CATALOG_PAGE_SIZE = 1_000

type FetchDocumentCatalogPage = (input: DocumentCatalogPageInput) => Promise<DocumentCatalogPage>

export async function collectDocumentCatalogPages(
  fetchPage: FetchDocumentCatalogPage,
  databaseId: string | null = null,
  pageSize = DOCUMENT_CATALOG_PAGE_SIZE
): Promise<DocumentCatalogEntry[]> {
  const limit = Math.min(DOCUMENT_CATALOG_PAGE_SIZE, Math.max(1, Math.trunc(pageSize)))
  const entries: DocumentCatalogEntry[] = []
  let expectedTotal: number | null = null
  let offset = 0

  while (true) {
    const page = await fetchPage({ databaseId, limit, offset })
    if (expectedTotal === null) {
      expectedTotal = page.total
    } else if (page.total !== expectedTotal) {
      throw new Error('Document catalog changed while pages were loading.')
    }

    entries.push(...page.entries)
    if (page.nextOffset === null) {
      if (entries.length !== expectedTotal) {
        throw new Error('Document catalog pagination returned an incomplete result.')
      }
      return entries
    }

    if (page.nextOffset <= offset) {
      throw new Error('Document catalog pagination did not advance.')
    }
    offset = page.nextOffset
  }
}
