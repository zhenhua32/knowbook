import assert from 'node:assert/strict'
import test from 'node:test'
import type { DocumentCatalogEntry, DocumentCatalogPageInput } from '../src/shared/contracts.ts'
import { collectDocumentCatalogPages } from '../src/renderer/src/utils/documentCatalogPagination.ts'

function catalogEntry(index: number): DocumentCatalogEntry {
  return {
    id: `document-${index}`,
    title: `Document ${index}`,
    path: `Root/Document ${index}`,
    summary: '',
    parentId: 'root',
    parentTitle: 'Root',
    updatedAt: `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
    blockCount: 1,
    linkCount: 0,
    childCount: 0,
    fieldValues: {}
  }
}

test('collectDocumentCatalogPages returns an ordered atomic catalog', async () => {
  const entries = Array.from({ length: 5 }, (_, index) => catalogEntry(index))
  const requestedOffsets: number[] = []
  const result = await collectDocumentCatalogPages(async (input: DocumentCatalogPageInput) => {
    requestedOffsets.push(input.offset)
    const pageEntries = entries.slice(input.offset, input.offset + input.limit)
    const nextOffset = input.offset + pageEntries.length
    return {
      entries: pageEntries,
      total: entries.length,
      nextOffset: nextOffset < entries.length ? nextOffset : null
    }
  }, null, 2)

  assert.deepEqual(requestedOffsets, [0, 2, 4])
  assert.deepEqual(result, entries)
})

test('collectDocumentCatalogPages rejects inconsistent page sequences', async () => {
  await assert.rejects(
    collectDocumentCatalogPages(async (input) => ({
      entries: [catalogEntry(input.offset)],
      total: input.offset === 0 ? 2 : 3,
      nextOffset: input.offset === 0 ? 1 : null
    }), null, 1),
    /changed while pages were loading/
  )

  await assert.rejects(
    collectDocumentCatalogPages(async () => ({
      entries: [catalogEntry(0)],
      total: 2,
      nextOffset: 0
    }), null, 1),
    /did not advance/
  )
})
