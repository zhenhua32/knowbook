import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { KnowbookStore } from '../src/main/database/store.ts'

function withStore(run: (store: KnowbookStore, backupRoot: string) => void): void {
  const tempRoot = mkdtempSync(join(tmpdir(), 'knowbook-block-ref-test-'))
  const databasePath = join(tempRoot, 'knowbook.sqlite')
  const backupRoot = join(tempRoot, 'backup')

  const store = new KnowbookStore(databasePath)

  try {
    run(store, backupRoot)
  } finally {
    store.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

test('getBlockReference returns null for non-existent document path', () => {
  withStore((store) => {
    const result = store.getBlockReference('non-existent', 'block-1')
    assert.equal(result, null)
  })
})

test('getBlockReference returns null for non-existent block id', () => {
  withStore((store) => {
    // Get the seed document
    const homeData = store.getHomeData('')
    const homeDoc = homeData.recentDocuments[0]
    assert.ok(homeDoc, 'expected seed document to exist')

    const result = store.getBlockReference(homeDoc.path, 'non-existent-block')
    assert.equal(result, null)
  })
})

test('getBlockReference returns block when found in same document', () => {
  withStore((store) => {
    const homeData = store.getHomeData('')
    const homeDoc = homeData.recentDocuments.find(d => d.path === 'Home')
    assert.ok(homeDoc, 'expected Home document')

    const detail = store.getDocumentDetail(homeDoc.id)
    assert.ok(detail, 'expected document detail')
    assert.ok(detail.blocks.length > 0, 'expected blocks')

    const firstBlock = detail.blocks[0]
    const result = store.getBlockReference(homeDoc.path, firstBlock.id)

    assert.ok(result, 'expected to find block reference')
    assert.equal(result?.block.id, firstBlock.id)
    assert.equal(result?.documentId, homeDoc.id)
    assert.equal(result?.documentPath, homeDoc.path)
  })
})

test('getBlockReference supports cross-document references', () => {
  withStore((store) => {
    // Get Home document
    const homeData = store.getHomeData('')
    const homeDoc = homeData.recentDocuments.find(d => d.path === 'Home')
    assert.ok(homeDoc, 'expected Home document')

    // Get Product document
    const productDoc = homeData.recentDocuments.find(d => d.path === 'Home/Product')
    assert.ok(productDoc, 'expected Product document')

    // Get a block from Product document
    const productDetail = store.getDocumentDetail(productDoc.id)
    assert.ok(productDetail, 'expected Product document detail')
    assert.ok(productDetail.blocks.length > 0, 'expected blocks in Product document')

    const blockInProduct = productDetail.blocks[0]

    // Try to reference Product block from Home document context
    const result = store.getBlockReference(productDoc.path, blockInProduct.id)

    assert.ok(result, 'expected to find cross-document block reference')
    assert.equal(result?.block.id, blockInProduct.id)
    assert.equal(result?.documentId, productDoc.id)
    assert.equal(result?.documentPath, productDoc.path)
  })
})
