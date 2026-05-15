import assert from 'node:assert/strict'
import test from 'node:test'
import { WorkspaceEventBus, createWorkspaceEventRecord } from '../src/main/event-bus.ts'

test('WorkspaceEventBus emit calls handlers in subscription order', async () => {
  const bus = new WorkspaceEventBus()
  const trace: string[] = []

  bus.subscribe(async () => {
    trace.push('first:start')
    await Promise.resolve()
    trace.push('first:end')
  })
  bus.subscribe(() => {
    trace.push('second')
  })

  await bus.emit({
    type: 'document.created',
    createdAt: '2026-05-02T00:00:00.000Z',
    documentId: 'doc-1',
    documentTitle: 'Doc 1',
    path: 'Doc 1',
    parentId: null
  })

  assert.deepEqual(trace, ['first:start', 'first:end', 'second'])
})

test('WorkspaceEventBus unsubscribe removes handler', async () => {
  const bus = new WorkspaceEventBus()
  let count = 0

  const unsubscribe = bus.subscribe(() => {
    count += 1
  })

  await bus.emit({
    type: 'document.created',
    createdAt: '2026-05-02T00:00:00.000Z',
    documentId: 'doc-1',
    documentTitle: 'Doc 1',
    path: 'Doc 1',
    parentId: null
  })

  unsubscribe()

  await bus.emit({
    type: 'document.created',
    createdAt: '2026-05-02T00:00:01.000Z',
    documentId: 'doc-1',
    documentTitle: 'Doc 1',
    path: 'Doc 1',
    parentId: null
  })

  assert.equal(count, 1)
})

test('WorkspaceEventBus isolates handler failures and continues', async () => {
  const bus = new WorkspaceEventBus()
  const trace: string[] = []

  const originalError = console.error
  const logged: string[] = []
  console.error = (...args: unknown[]) => {
    logged.push(args.map((arg) => String(arg)).join(' '))
  }

  try {
    bus.subscribe(() => {
      throw new Error('boom')
    })

    bus.subscribe(() => {
      trace.push('survived')
    })

    await bus.emit({
      type: 'document.updated',
      createdAt: '2026-05-02T00:00:00.000Z',
      documentId: 'doc-1',
      documentTitle: 'Doc 1',
      path: 'Doc 1',
      affectedDocumentIds: ['doc-1'],
      pathChanged: false
    })
  } finally {
    console.error = originalError
  }

  assert.deepEqual(trace, ['survived'])
  assert.equal(logged.some((line) => line.includes('Workspace event handler failed for document.updated.')), true)
})

test('createWorkspaceEventRecord maps all event payloads to display records', () => {
  const created = createWorkspaceEventRecord({
    type: 'document.created',
    createdAt: '2026-05-02T00:00:00.000Z',
    documentId: 'doc-1',
    documentTitle: 'Alpha',
    path: 'Root/Alpha',
    parentId: null
  })
  assert.equal(created.title, 'Document created')

  const updatedPathChanged = createWorkspaceEventRecord({
    type: 'document.updated',
    createdAt: '2026-05-02T00:00:00.000Z',
    documentId: 'doc-1',
    documentTitle: 'Alpha',
    path: 'Root/Alpha',
    affectedDocumentIds: ['doc-1', 'doc-2', 'doc-3'],
    pathChanged: true
  })
  assert.equal(updatedPathChanged.description.includes('2 descendant paths'), true)

  const updatedNoPathChange = createWorkspaceEventRecord({
    type: 'document.updated',
    createdAt: '2026-05-02T00:00:00.000Z',
    documentId: 'doc-1',
    documentTitle: 'Alpha',
    path: 'Root/Alpha',
    affectedDocumentIds: ['doc-1'],
    pathChanged: false
  })
  assert.equal(updatedNoPathChange.description, 'Saved changes to "Alpha".')

  const summary = createWorkspaceEventRecord({
    type: 'document.summary.generated',
    createdAt: '2026-05-02T00:00:00.000Z',
    documentId: 'doc-1',
    documentTitle: 'Alpha',
    path: 'Root/Alpha',
    summary: 'Summary text'
  })
  assert.equal(summary.title, 'Summary generated')

  const moved = createWorkspaceEventRecord({
    type: 'document.moved',
    createdAt: '2026-05-02T00:00:00.000Z',
    documentId: 'doc-1',
    documentTitle: 'Alpha',
    oldPath: 'Old/Alpha',
    newPath: 'New/Alpha',
    affectedDocumentIds: ['doc-1']
  })
  assert.equal(moved.description, 'Moved "Alpha" to New/Alpha.')

  const deletedWithoutDescendants = createWorkspaceEventRecord({
    type: 'document.deleted',
    createdAt: '2026-05-02T00:00:00.000Z',
    documentId: 'doc-1',
    documentTitle: 'Alpha',
    oldPath: 'Old/Alpha',
    affectedDocumentIds: []
  })
  assert.equal(deletedWithoutDescendants.description, 'Deleted "Alpha" from Old/Alpha.')

  const deletedWithDescendants = createWorkspaceEventRecord({
    type: 'document.deleted',
    createdAt: '2026-05-02T00:00:00.000Z',
    documentId: 'doc-1',
    documentTitle: 'Alpha',
    oldPath: 'Old/Alpha',
    affectedDocumentIds: ['doc-2']
  })
  assert.equal(deletedWithDescendants.description.includes('reparented 1 descendant document'), true)

  const aiConfigChanged = createWorkspaceEventRecord({
    type: 'ai.config.updated',
    createdAt: '2026-05-02T00:00:00.000Z',
    model: 'gpt-4o-mini',
    embeddingModel: 'text-embedding-3-small',
    previousEmbeddingModel: 'old',
    embeddingModelChanged: true,
    aiEnabled: true
  })
  assert.equal(aiConfigChanged.description.includes('switched the embedding model'), true)

  const aiConfigSameEmbedding = createWorkspaceEventRecord({
    type: 'ai.config.updated',
    createdAt: '2026-05-02T00:00:00.000Z',
    model: 'gpt-4o-mini',
    embeddingModel: 'text-embedding-3-small',
    previousEmbeddingModel: 'text-embedding-3-small',
    embeddingModelChanged: false,
    aiEnabled: true
  })
  assert.equal(aiConfigSameEmbedding.description, 'Saved AI settings for chat model gpt-4o-mini.')
})
