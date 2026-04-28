import { useEffect, useState } from 'react'
import type { BackupResult, DocumentBlock, DocumentDetail, DocumentTreeNode, HomeData, LinkedDocument } from '@shared/contracts'

const emptyState: HomeData = {
  summary: {
    databasePath: '',
    backupRoot: '',
    documents: 0,
    blocks: 0,
    links: 0,
    lastBackupAt: null
  },
  recentDocuments: [],
  aiConfig: {
    enabled: false,
    baseUrl: '',
    model: '',
    hasApiKey: false
  },
  documentTree: [],
  initialDocumentId: null
}

export function App() {
  const [homeData, setHomeData] = useState<HomeData>(emptyState)
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [backupMessage, setBackupMessage] = useState<string | null>(null)
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null)
  const [selectedDocument, setSelectedDocument] = useState<DocumentDetail | null>(null)
  const [isEditing, setIsEditing] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftSummary, setDraftSummary] = useState('')
  const [draftBlocks, setDraftBlocks] = useState<Array<{ type: string; content: string }>>([])
  const [moveTargetId, setMoveTargetId] = useState('')
  const [draggingDocumentId, setDraggingDocumentId] = useState<string | null>(null)
  const [dragOverDocumentId, setDragOverDocumentId] = useState<string | null>(null)
  const [dragOverRoot, setDragOverRoot] = useState(false)
  const [aiEnabledDraft, setAiEnabledDraft] = useState(false)
  const [aiBaseUrlDraft, setAiBaseUrlDraft] = useState('')
  const [aiModelDraft, setAiModelDraft] = useState('')
  const [aiApiKeyDraft, setAiApiKeyDraft] = useState('')
  const [aiSaving, setAiSaving] = useState(false)
  const [aiPromptDraft, setAiPromptDraft] = useState('')
  const [aiAnswer, setAiAnswer] = useState('')
  const [aiAsking, setAiAsking] = useState(false)

  useEffect(() => {
    let mounted = true

    window.knowbook.getHomeData().then((data) => {
      if (mounted) {
        setHomeData(data)
        setLoading(false)
        setSelectedDocumentId((current) => current ?? data.initialDocumentId)
        setAiEnabledDraft(data.aiConfig.enabled)
        setAiBaseUrlDraft(data.aiConfig.baseUrl)
        setAiModelDraft(data.aiConfig.model)
        setAiApiKeyDraft('')
      }
    })

    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    if (!selectedDocumentId) {
      setSelectedDocument(null)
      return
    }

    let mounted = true
    setDetailLoading(true)

    window.knowbook.getDocumentDetail(selectedDocumentId).then((detail) => {
      if (mounted) {
        setSelectedDocument(detail)
        setMoveTargetId('')
        setIsEditing(false)
        setDraftTitle(detail?.title ?? '')
        setDraftSummary(detail?.summary ?? '')
        setDraftBlocks(
          detail?.blocks.map((block) => ({
            type: block.type,
            content: block.content
          })) ?? []
        )
        setDetailLoading(false)
      }
    })

    return () => {
      mounted = false
    }
  }, [selectedDocumentId])

  async function handleBackup() {
    const result: BackupResult = await window.knowbook.triggerBackup()
    const refreshed = await window.knowbook.getHomeData()
    setHomeData(refreshed)
    const nextDocumentId = selectedDocumentId ?? refreshed.initialDocumentId
    if (!selectedDocumentId && nextDocumentId) {
      setSelectedDocumentId(nextDocumentId)
    }
    if (selectedDocumentId) {
      const detail = await window.knowbook.getDocumentDetail(selectedDocumentId)
      setSelectedDocument(detail)
    }
    setBackupMessage(`Exported ${result.exported} markdown files at ${new Date(result.at).toLocaleString()}.`)
  }

  async function handleCreateDocument(parentId: string | null) {
    const created = await window.knowbook.createDocument(parentId)
    const refreshed = await window.knowbook.getHomeData()
    setHomeData(refreshed)
    setSelectedDocumentId(created.id)
    const detail = await window.knowbook.getDocumentDetail(created.id)
    setSelectedDocument(detail)
    setIsEditing(true)
    setDraftTitle(detail?.title ?? '')
    setDraftSummary(detail?.summary ?? '')
    setDraftBlocks(
      detail?.blocks.map((block) => ({
        type: block.type,
        content: block.content
      })) ?? []
    )
  }

  function startEdit() {
    if (!selectedDocument) {
      return
    }

    setDraftTitle(selectedDocument.title)
    setDraftSummary(selectedDocument.summary)
    setDraftBlocks(
      selectedDocument.blocks.map((block) => ({
        type: block.type,
        content: block.content
      }))
    )
    setIsEditing(true)
  }

  function cancelEdit() {
    if (!selectedDocument) {
      setIsEditing(false)
      return
    }

    setDraftTitle(selectedDocument.title)
    setDraftSummary(selectedDocument.summary)
    setDraftBlocks(
      selectedDocument.blocks.map((block) => ({
        type: block.type,
        content: block.content
      }))
    )
    setIsEditing(false)
  }

  async function saveDocument() {
    if (!selectedDocumentId || !selectedDocument) {
      return
    }

    setIsSaving(true)
    await window.knowbook.updateDocument(selectedDocumentId, {
      title: draftTitle,
      summary: draftSummary,
      blocks: draftBlocks
    })

    const [refreshedHome, refreshedDetail] = await Promise.all([
      window.knowbook.getHomeData(),
      window.knowbook.getDocumentDetail(selectedDocumentId)
    ])
    setHomeData(refreshedHome)
    setSelectedDocument(refreshedDetail)
    setIsEditing(false)
    setIsSaving(false)
  }

  async function deleteSelectedDocument() {
    if (!selectedDocument) {
      return
    }

    const accepted = window.confirm(`Delete "${selectedDocument.title}"? Child documents will be kept and reparented.`)
    if (!accepted) {
      return
    }

    await window.knowbook.deleteDocument(selectedDocument.id)
    const refreshed = await window.knowbook.getHomeData()
    setHomeData(refreshed)

    const nextId = refreshed.initialDocumentId
    setSelectedDocumentId(nextId)
    setIsEditing(false)

    if (nextId) {
      const detail = await window.knowbook.getDocumentDetail(nextId)
      setSelectedDocument(detail)
    } else {
      setSelectedDocument(null)
    }
  }

  async function moveSelectedDocument() {
    if (!selectedDocument || !moveTargetId) {
      return
    }

    const newParentId = moveTargetId === '__root__' ? null : moveTargetId
    await handleMoveDocument(selectedDocument.id, newParentId, `Moved "${selectedDocument.title}" successfully.`)
  }

  async function handleMoveDocument(documentId: string, newParentId: string | null, successMessage?: string) {
    try {
      await window.knowbook.moveDocument(documentId, newParentId)
      const refreshedHome = await window.knowbook.getHomeData()
      setHomeData(refreshedHome)

      if (selectedDocumentId) {
        const refreshedDetail = await window.knowbook.getDocumentDetail(selectedDocumentId)
        setSelectedDocument(refreshedDetail)
      }

      setMoveTargetId('')
      if (successMessage) {
        setBackupMessage(successMessage)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Move failed.'
      setBackupMessage(message)
    } finally {
      setDraggingDocumentId(null)
      setDragOverDocumentId(null)
      setDragOverRoot(false)
    }
  }

  function beginDrag(documentId: string) {
    setDraggingDocumentId(documentId)
  }

  function endDrag() {
    setDraggingDocumentId(null)
    setDragOverDocumentId(null)
    setDragOverRoot(false)
  }

  async function dropOnDocument(targetId: string) {
    if (!draggingDocumentId || draggingDocumentId === targetId) {
      endDrag()
      return
    }

    await handleMoveDocument(draggingDocumentId, targetId)
  }

  async function dropToRoot() {
    if (!draggingDocumentId) {
      endDrag()
      return
    }

    await handleMoveDocument(draggingDocumentId, null)
  }

  async function saveAiConfig() {
    setAiSaving(true)
    await window.knowbook.updateAiConfig({
      enabled: aiEnabledDraft,
      baseUrl: aiBaseUrlDraft,
      model: aiModelDraft,
      apiKey: aiApiKeyDraft
    })
    const refreshed = await window.knowbook.getHomeData()
    setHomeData(refreshed)
    setAiEnabledDraft(refreshed.aiConfig.enabled)
    setAiBaseUrlDraft(refreshed.aiConfig.baseUrl)
    setAiModelDraft(refreshed.aiConfig.model)
    setAiApiKeyDraft('')
    setAiSaving(false)
    setBackupMessage('AI settings saved.')
  }

  async function askAiOnSelectedDocument() {
    if (!selectedDocumentId || !aiPromptDraft.trim()) {
      return
    }

    setAiAsking(true)
    try {
      const result = await window.knowbook.askAiAboutDocument({
        documentId: selectedDocumentId,
        prompt: aiPromptDraft.trim()
      })
      setAiAnswer(result.answer)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'AI request failed.'
      setAiAnswer(message)
    } finally {
      setAiAsking(false)
    }
  }

  function updateDraftBlock(index: number, patch: Partial<{ type: string; content: string }>) {
    setDraftBlocks((previous) =>
      previous.map((block, currentIndex) =>
        currentIndex === index
          ? {
              ...block,
              ...patch
            }
          : block
      )
    )
  }

  function addDraftBlock() {
    setDraftBlocks((previous) => [
      ...previous,
      {
        type: 'paragraph',
        content: ''
      }
    ])
  }

  function removeDraftBlock(index: number) {
    setDraftBlocks((previous) => previous.filter((_, currentIndex) => currentIndex !== index))
  }

  const moveOptions = flattenTree(homeData.documentTree)
    .filter((option) => option.id !== selectedDocumentId)
    .map((option) => ({
      ...option,
      label: `${'  '.repeat(option.depth)}${option.title}`
    }))

  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand">
          <span className="brand-mark">KB</span>
          <div>
            <p className="eyebrow">Local-first knowledge OS</p>
            <h1>KnowBook</h1>
          </div>
        </div>

        <div className="panel panel-accent">
          <p className="panel-label">Implementation Slice</p>
          <h2>Phase 1.5 workspace shell</h2>
          <p>
            The desktop shell now exposes a real document tree, detail preview, scheduled markdown exports, and API-driven AI configuration from the same SQLite source.
          </p>
        </div>

        <div className="panel">
          <p className="panel-label">Next up</p>
          <ul className="panel-list">
            <li>Editable block canvas backed by the existing document detail API</li>
            <li>Document drag-to-reparent flow</li>
            <li>AI provider settings and embeddings pipeline</li>
          </ul>
        </div>

        <div className="panel">
          <p className="panel-label">AI settings</p>
          <h3>Cloud API configuration</h3>
          <div className="editor-fields">
            <label className="toggle-row">
              <input checked={aiEnabledDraft} onChange={(event) => setAiEnabledDraft(event.target.checked)} type="checkbox" />
              <span>Enable AI features</span>
            </label>
            <label className="editor-label">
              Base URL
              <input className="editor-input" onChange={(event) => setAiBaseUrlDraft(event.target.value)} type="text" value={aiBaseUrlDraft} />
            </label>
            <label className="editor-label">
              Model
              <input className="editor-input" onChange={(event) => setAiModelDraft(event.target.value)} type="text" value={aiModelDraft} />
            </label>
            <label className="editor-label">
              API Key (leave blank to keep current)
              <input className="editor-input" onChange={(event) => setAiApiKeyDraft(event.target.value)} type="password" value={aiApiKeyDraft} />
            </label>
            <p className="mini-hint">Current key: {homeData.aiConfig.hasApiKey ? 'configured' : 'missing'}</p>
            <button className="secondary-button" disabled={aiSaving} onClick={saveAiConfig} type="button">
              {aiSaving ? 'Saving...' : 'Save AI settings'}
            </button>
          </div>
        </div>
      </aside>

      <main className="content">
        <section className="hero">
          <div>
            <p className="eyebrow">Workspace status</p>
            <h2>Workspace navigation is alive</h2>
            <p className="hero-copy">
              SQLite remains the source of truth, markdown backups export into a nested tree, and the renderer can now browse document hierarchy and inspect document relationships over the preload bridge.
            </p>
          </div>
          <button className="primary-button" onClick={handleBackup} type="button">
            Run backup now
          </button>
        </section>

        {backupMessage ? <p className="flash-message">{backupMessage}</p> : null}

        <section className="stats-grid">
          <article className="stat-card">
            <span className="stat-label">Documents</span>
            <strong>{homeData.summary.documents}</strong>
          </article>
          <article className="stat-card">
            <span className="stat-label">Blocks</span>
            <strong>{homeData.summary.blocks}</strong>
          </article>
          <article className="stat-card">
            <span className="stat-label">Links</span>
            <strong>{homeData.summary.links}</strong>
          </article>
          <article className="stat-card">
            <span className="stat-label">AI</span>
            <strong>{homeData.aiConfig.enabled ? 'API ready' : 'Disabled'}</strong>
          </article>
        </section>

        <section className="workspace-grid">
          <article className="panel tree-panel">
            <div className="panel-head compact-head">
              <div>
                <p className="panel-label">Workspace tree</p>
                <h3>Seeded documents</h3>
              </div>
              <div className="toolbar-inline">
                <span className="pill">{homeData.documentTree.length} roots</span>
                <button className="secondary-button" onClick={() => handleCreateDocument(null)} type="button">
                  New root
                </button>
              </div>
            </div>

            <div
              className={`root-drop-zone${dragOverRoot ? ' root-drop-zone-active' : ''}`}
              onDragOver={(event) => {
                event.preventDefault()
                if (draggingDocumentId) {
                  setDragOverRoot(true)
                  setDragOverDocumentId(null)
                }
              }}
              onDragLeave={() => setDragOverRoot(false)}
              onDrop={async (event) => {
                event.preventDefault()
                await dropToRoot()
              }}
            >
              Drop here to move document to root
            </div>

            <DocumentTree
              nodes={homeData.documentTree}
              selectedDocumentId={selectedDocumentId}
              onSelect={setSelectedDocumentId}
              draggingDocumentId={draggingDocumentId}
              dragOverDocumentId={dragOverDocumentId}
              onDragStart={beginDrag}
              onDragEnd={endDrag}
              onDragOverNode={(documentId) => {
                if (draggingDocumentId && draggingDocumentId !== documentId) {
                  setDragOverDocumentId(documentId)
                  setDragOverRoot(false)
                }
              }}
              onDropOnNode={dropOnDocument}
            />
          </article>

          <article className="panel preview-panel">
            <div className="panel-head">
              <div>
                <p className="panel-label">Document preview</p>
                <h3>{selectedDocument?.title ?? 'Select a document'}</h3>
              </div>
              <div className="toolbar-inline">
                {selectedDocument ? (
                  <button className="secondary-button" onClick={() => handleCreateDocument(selectedDocument.id)} type="button">
                    Add child
                  </button>
                ) : null}
                {selectedDocument && !isEditing ? (
                  <button className="secondary-button" onClick={startEdit} type="button">
                    Edit
                  </button>
                ) : null}
                {selectedDocument && isEditing ? (
                  <>
                    <button className="secondary-button" disabled={isSaving} onClick={cancelEdit} type="button">
                      Cancel
                    </button>
                    <button className="secondary-button" disabled={isSaving} onClick={saveDocument} type="button">
                      {isSaving ? 'Saving...' : 'Save'}
                    </button>
                  </>
                ) : null}
                {selectedDocument && !isEditing ? (
                  <button className="danger-button" onClick={deleteSelectedDocument} type="button">
                    Delete
                  </button>
                ) : null}
                {selectedDocument && !isEditing ? (
                  <>
                    <select className="editor-select compact-select" onChange={(event) => setMoveTargetId(event.target.value)} value={moveTargetId}>
                      <option value="">Move to...</option>
                      <option value="__root__">(Root)</option>
                      {moveOptions.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <button className="secondary-button" disabled={!moveTargetId} onClick={moveSelectedDocument} type="button">
                      Move
                    </button>
                  </>
                ) : null}
                {detailLoading ? <span className="pill">Loading...</span> : <span className="pill">{isEditing ? 'Editing' : 'Read only'}</span>}
              </div>
            </div>

            {selectedDocument ? (
              <>
                <div className="document-summary-card">
                  <p className="document-path">{selectedDocument.path}</p>
                  {isEditing ? (
                    <div className="editor-fields">
                      <label className="editor-label">
                        Title
                        <input className="editor-input" onChange={(event) => setDraftTitle(event.target.value)} type="text" value={draftTitle} />
                      </label>
                      <label className="editor-label">
                        Summary
                        <textarea
                          className="editor-textarea"
                          onChange={(event) => setDraftSummary(event.target.value)}
                          rows={3}
                          value={draftSummary}
                        />
                      </label>
                    </div>
                  ) : (
                    <p className="document-summary">{selectedDocument.summary}</p>
                  )}
                  <p className="document-updated">Updated {new Date(selectedDocument.updatedAt).toLocaleString()}</p>
                </div>

                <div className="preview-section">
                  <p className="panel-label">Blocks</p>
                  {isEditing ? (
                    <div className="block-editor-list">
                      {draftBlocks.map((block, index) => (
                        <div className="block-editor-row" key={`${selectedDocument.id}-draft-${index}`}>
                          <select
                            className="editor-select"
                            onChange={(event) => updateDraftBlock(index, { type: event.target.value })}
                            value={block.type}
                          >
                            <option value="paragraph">Paragraph</option>
                            <option value="heading-1">Heading 1</option>
                            <option value="heading-2">Heading 2</option>
                            <option value="todo">Todo</option>
                            <option value="code">Code</option>
                          </select>
                          <textarea
                            className="editor-textarea block-editor-textarea"
                            onChange={(event) => updateDraftBlock(index, { content: event.target.value })}
                            rows={block.type === 'code' ? 5 : 2}
                            value={block.content}
                          />
                          <button className="danger-button" onClick={() => removeDraftBlock(index)} type="button">
                            Remove
                          </button>
                        </div>
                      ))}
                      <button className="secondary-button" onClick={addDraftBlock} type="button">
                        Add block
                      </button>
                    </div>
                  ) : (
                    <div className="block-preview-list">
                      {selectedDocument.blocks.map((block) => (
                        <div className="block-preview" key={`${selectedDocument.id}-${block.sortOrder}`}>
                          {renderBlock(block)}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="relation-grid">
                  <RelationList
                    title="Children"
                    emptyText="No child documents yet"
                    links={selectedDocument.children.map((child) => ({
                      id: child.id,
                      title: child.title,
                      path: child.path,
                      label: 'child'
                    }))}
                    onSelect={setSelectedDocumentId}
                  />
                  <RelationList
                    title="Outgoing links"
                    emptyText="No outgoing links yet"
                    links={selectedDocument.outgoingLinks}
                    onSelect={setSelectedDocumentId}
                  />
                  <RelationList
                    title="Backlinks"
                    emptyText="No backlinks yet"
                    links={selectedDocument.backlinks}
                    onSelect={setSelectedDocumentId}
                  />
                </div>

                <div className="preview-section">
                  <p className="panel-label">Ask AI</p>
                  <div className="ai-panel">
                    <textarea
                      className="editor-textarea"
                      onChange={(event) => setAiPromptDraft(event.target.value)}
                      placeholder="例如：基于当前文档，给我 3 条结构优化建议"
                      rows={3}
                      value={aiPromptDraft}
                    />
                    <button className="secondary-button" disabled={aiAsking || !aiPromptDraft.trim()} onClick={askAiOnSelectedDocument} type="button">
                      {aiAsking ? 'Thinking...' : 'Ask AI'}
                    </button>
                    {aiAnswer ? <pre className="ai-answer">{aiAnswer}</pre> : null}
                  </div>
                </div>
              </>
            ) : (
              <div className="empty-preview">
                <p>Select a document from the tree or recent list to inspect its blocks and relationships.</p>
              </div>
            )}
          </article>
        </section>

        <section className="detail-grid">
          <article className="panel large-panel">
            <div className="panel-head">
              <div>
                <p className="panel-label">Storage</p>
                <h3>SQLite and nested markdown backup</h3>
              </div>
              {loading ? <span className="pill">Loading...</span> : <span className="pill">Ready</span>}
            </div>
            <dl className="meta-grid">
              <div>
                <dt>Database path</dt>
                <dd>{homeData.summary.databasePath || 'Initializing...'}</dd>
              </div>
              <div>
                <dt>Backup root</dt>
                <dd>{homeData.summary.backupRoot || 'Initializing...'}</dd>
              </div>
              <div>
                <dt>Last backup</dt>
                <dd>{homeData.summary.lastBackupAt ? new Date(homeData.summary.lastBackupAt).toLocaleString() : 'Not yet exported'}</dd>
              </div>
              <div>
                <dt>AI endpoint</dt>
                <dd>{homeData.aiConfig.baseUrl}</dd>
              </div>
            </dl>
          </article>

          <article className="panel large-panel">
            <div className="panel-head">
              <div>
                <p className="panel-label">Recent documents</p>
                <h3>Seeded from the bootstrap store</h3>
              </div>
            </div>

            <div className="document-list">
              {homeData.recentDocuments.map((document) => (
                <button className="document-row document-button" key={document.id} onClick={() => setSelectedDocumentId(document.id)} type="button">
                  <div>
                    <strong>{document.title}</strong>
                    <p>{document.path}</p>
                  </div>
                  <div className="document-meta">
                    <span>{document.blockCount} blocks</span>
                    <span>{new Date(document.updatedAt).toLocaleDateString()}</span>
                  </div>
                </button>
              ))}
            </div>
          </article>
        </section>
      </main>
    </div>
  )
}

function DocumentTree({
  nodes,
  selectedDocumentId,
  onSelect,
  draggingDocumentId,
  dragOverDocumentId,
  onDragStart,
  onDragEnd,
  onDragOverNode,
  onDropOnNode
}: {
  nodes: DocumentTreeNode[]
  selectedDocumentId: string | null
  onSelect: (documentId: string) => void
  draggingDocumentId: string | null
  dragOverDocumentId: string | null
  onDragStart: (documentId: string) => void
  onDragEnd: () => void
  onDragOverNode: (documentId: string) => void
  onDropOnNode: (documentId: string) => Promise<void>
}) {
  return (
    <ul className="tree-list">
      {nodes.map((node) => (
        <li className="tree-node" key={node.id}>
          <button
            className={`tree-button${selectedDocumentId === node.id ? ' tree-button-active' : ''}${dragOverDocumentId === node.id ? ' tree-button-drag-over' : ''}`}
            onClick={() => onSelect(node.id)}
            type="button"
            draggable
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = 'move'
              event.dataTransfer.setData('text/plain', node.id)
              onDragStart(node.id)
            }}
            onDragEnd={onDragEnd}
            onDragOver={(event) => {
              event.preventDefault()
              if (draggingDocumentId !== node.id) {
                onDragOverNode(node.id)
              }
            }}
            onDrop={async (event) => {
              event.preventDefault()
              await onDropOnNode(node.id)
            }}
          >
            <span>{node.title}</span>
            <small>{new Date(node.updatedAt).toLocaleDateString()}</small>
          </button>
          <p className="tree-path">{node.path}</p>
          {node.children.length > 0 ? (
            <div className="tree-children">
              <DocumentTree
                nodes={node.children}
                selectedDocumentId={selectedDocumentId}
                onSelect={onSelect}
                draggingDocumentId={draggingDocumentId}
                dragOverDocumentId={dragOverDocumentId}
                onDragStart={onDragStart}
                onDragEnd={onDragEnd}
                onDragOverNode={onDragOverNode}
                onDropOnNode={onDropOnNode}
              />
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

function RelationList({
  title,
  links,
  emptyText,
  onSelect
}: {
  title: string
  links: LinkedDocument[]
  emptyText: string
  onSelect: (documentId: string) => void
}) {
  return (
    <section className="relation-panel">
      <p className="panel-label">{title}</p>
      {links.length > 0 ? (
        <div className="relation-list">
          {links.map((link) => (
            <button className="relation-chip" key={`${title}-${link.id}`} onClick={() => onSelect(link.id)} type="button">
              <strong>{link.title}</strong>
              <span>{link.path}</span>
              <small>{link.label}</small>
            </button>
          ))}
        </div>
      ) : (
        <p className="empty-text">{emptyText}</p>
      )}
    </section>
  )
}

function renderBlock(block: DocumentBlock) {
  if (block.type === 'heading-1') {
    return <h4 className="block-heading"># {block.content}</h4>
  }

  if (block.type === 'heading-2') {
    return <h5 className="block-heading">## {block.content}</h5>
  }

  if (block.type === 'todo') {
    return <p className="block-todo">- [ ] {block.content}</p>
  }

  if (block.type === 'code') {
    return <pre className="block-code">{block.content}</pre>
  }

  return <p className="block-paragraph">{block.content}</p>
}

function flattenTree(nodes: DocumentTreeNode[], depth = 0): Array<{ id: string; title: string; depth: number }> {
  const flattened: Array<{ id: string; title: string; depth: number }> = []

  for (const node of nodes) {
    flattened.push({
      id: node.id,
      title: node.title,
      depth
    })
    flattened.push(...flattenTree(node.children, depth + 1))
  }

  return flattened
}