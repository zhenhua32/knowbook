import { expect, test } from '@playwright/test'
import type { DocumentBlockDraft } from '../src/shared/contracts'
import { mkdtempSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { closeElectronApp, launchElectronApp, type ElectronAppContext } from './helpers/electron'

const draftSnapshots = (blocks: Array<DocumentBlockDraft & { sortOrder?: number }>) => JSON.parse(JSON.stringify(
  blocks.map(({ sortOrder: _position, ...block }) => ({ ...block, tags: block.tags ?? [] }))
))
test('block move preload IPC preserves identities and paired history across an isolated host restart @electron', async () => {
  test.setTimeout(120_000)
  const profile = mkdtempSync(join(tmpdir(), 'knowbook-move-api-e2e-'))
  let context: ElectronAppContext | null = null
  try {
    context = await launchElectronApp({}, { editorMode: 'rich', userDataRoot: profile })
    const firstPid = await context.app.evaluate(() => process.pid)
    expect(resolve(await context.app.evaluate(({ app }) => app.getPath('userData')))).toBe(resolve(profile))
    const fixture = await context.page.evaluate(async () => {
      const { id: sourceId } = await window.knowbook.createDocument(null)
      const { id: targetId } = await window.knowbook.createDocument(null)
      const source = (await window.knowbook.getDocumentDetail(sourceId))!
      const target = (await window.knowbook.getDocumentDetail(targetId))!
      await window.knowbook.updateDocument(sourceId, {
        expectedUpdatedAt: source.updatedAt, title: 'API move source', summary: 'Source summary',
        blocks: [
          { id: 'api-task', type: 'todo', content: 'Complete **stable** task', checked: true, depth: 0,
            tags: ['preserve'], highlight: 'blue', markdownFormat: { listMarker: '+', listLoose: true } },
          { id: 'api-child', type: 'todo', content: 'Existing child', checked: false, depth: 1, parentBlockId: 'api-task' },
          { id: 'api-keep', type: 'paragraph', content: 'Keep source', checked: false, depth: 0 }
        ]
      })
      await window.knowbook.updateDocument(targetId, {
        expectedUpdatedAt: target.updatedAt, title: 'API move target', summary: 'Target summary',
        blocks: [
          { id: 'api-start', type: 'paragraph', content: 'Start', checked: false, depth: 0 },
          { id: 'api-tail', type: 'paragraph', content: 'Tail', checked: false, depth: 0 }
        ]
      })
      return { source: (await window.knowbook.getDocumentDetail(sourceId))!,
        target: (await window.knowbook.getDocumentDetail(targetId))! }
    })
    const moved = await context.page.evaluate(async ({ source, target }) => window.knowbook.moveDocumentBlocks({
      fromDocumentId: source.id, toDocumentId: target.id, blockIds: ['api-task'], beforeBlockId: 'api-tail',
      expectedFromUpdatedAt: source.updatedAt, expectedToUpdatedAt: target.updatedAt
    }), fixture)
    expect(moved.state).toBe('applied')
    expect(moved.operationId).toBeTruthy()
    expect(moved.movedBlockIds).toEqual(['api-task', 'api-child'])
    expect(new Set(moved.affectedDocumentIds)).toEqual(new Set([fixture.source.id, fixture.target.id]))
    expect(moved.source.blocks.map(value => value.id)).toEqual(['api-keep'])
    expect(moved.target.blocks.map(value => value.id)).toEqual(['api-start', 'api-task', 'api-child', 'api-tail'])
    expect(moved.target.blocks.find(value => value.id === 'api-task')).toMatchObject({
      checked: true, tags: ['preserve'], highlight: 'blue', markdownFormat: { listMarker: '+', listLoose: true }
    })
    expect(moved.target.blocks.find(value => value.id === 'api-child')).toMatchObject({ depth: 1, parentBlockId: 'api-task' })
    expect(moved.expectedUpdatedAtByDocument).toEqual({
      [fixture.source.id]: moved.source.updatedAt, [fixture.target.id]: moved.target.updatedAt
    })
    const read = () => context!.page.evaluate(async ({ source, target }) => ({
      source: await window.knowbook.getDocumentDetail(source),
      target: await window.knowbook.getDocumentDetail(target)
    }), { source: fixture.source.id, target: fixture.target.id })
    expect(await read()).toEqual({ source: moved.source, target: moved.target })
    await closeElectronApp(context, { preserveUserData: true })
    context = null
    context = await launchElectronApp({}, { editorMode: 'rich', userDataRoot: profile })
    expect(await context.app.evaluate(() => process.pid)).not.toBe(firstPid)
    expect(await read()).toEqual({ source: moved.source, target: moved.target })
    const entries = await context.page.evaluate(async ({sourceId,targetId}) => ({
      source: await window.knowbook.getDocumentBlockMoveHistory(sourceId),
      target: await window.knowbook.getDocumentBlockMoveHistory(targetId)
    }), { sourceId: fixture.source.id, targetId: fixture.target.id })
    expect(entries.source).toMatchObject({ operationId: moved.operationId, state: 'applied' })
    expect(draftSnapshots(entries.source!.beforeBlocks)).toEqual(draftSnapshots(fixture.source.blocks))
    expect(draftSnapshots(entries.source!.afterBlocks)).toEqual(draftSnapshots(moved.source.blocks))
    expect(entries.source!.expectedUpdatedAtByDocument).toEqual(moved.expectedUpdatedAtByDocument)
    expect(entries.target).toMatchObject({ operationId: moved.operationId, state: 'applied' })
    expect(draftSnapshots(entries.target!.beforeBlocks)).toEqual(draftSnapshots(fixture.target.blocks))
    expect(draftSnapshots(entries.target!.afterBlocks)).toEqual(draftSnapshots(moved.target.blocks))
    expect(entries.target!.expectedUpdatedAtByDocument).toEqual(moved.expectedUpdatedAtByDocument)
    const undone = await context.page.evaluate(async input => window.knowbook.undoDocumentBlockMove(input), {
      operationId: moved.operationId, expectedUpdatedAtByDocument: moved.expectedUpdatedAtByDocument
    })
    expect(undone.operationId).toBe(moved.operationId)
    expect(undone.state).toBe('undone')
    expect(undone.source.blocks).toEqual(fixture.source.blocks)
    expect(undone.target.blocks).toEqual(fixture.target.blocks)
    expect(await read()).toEqual({ source: undone.source, target: undone.target })
    const redone = await context.page.evaluate(async input => window.knowbook.redoDocumentBlockMove(input), {
      operationId: moved.operationId, expectedUpdatedAtByDocument: undone.expectedUpdatedAtByDocument
    })
    expect(redone.operationId).toBe(moved.operationId)
    expect(redone.state).toBe('applied')
    expect(redone.source.blocks).toEqual(moved.source.blocks)
    expect(redone.target.blocks).toEqual(moved.target.blocks)
    expect(await read()).toEqual({ source: redone.source, target: redone.target })
    const routes = await context.page.evaluate(async ({ sourcePath, targetPath }) => ({
      old: await window.knowbook.getBlockReference(sourcePath, '^api-task'),
      current: await window.knowbook.getBlockReference(targetPath, 'api-child')
    }), { sourcePath: fixture.source.path, targetPath: fixture.target.path })
    expect(routes.old?.documentId).toBe(fixture.target.id)
    expect(routes.current?.documentId).toBe(fixture.target.id)
  } finally {
    try { await closeElectronApp(context, { preserveUserData: true }) } finally {
      expect(dirname(resolve(profile))).toBe(resolve(tmpdir()))
      expect(basename(profile).startsWith('knowbook-move-api-e2e-')).toBe(true)
      rmSync(profile, { recursive: true, force: true })
    }
  }
})
