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
    model: ''
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

  useEffect(() => {
    let mounted = true

    window.knowbook.getHomeData().then((data) => {
      if (mounted) {
        setHomeData(data)
        setLoading(false)
        setSelectedDocumentId((current) => current ?? data.initialDocumentId)
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
  }

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
            <li>Document creation, rename, and drag-to-reparent flows</li>
            <li>AI provider settings and embeddings pipeline</li>
          </ul>
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

            <DocumentTree
              nodes={homeData.documentTree}
              selectedDocumentId={selectedDocumentId}
              onSelect={setSelectedDocumentId}
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
                {detailLoading ? <span className="pill">Loading...</span> : <span className="pill">Read only</span>}
              </div>
            </div>

            {selectedDocument ? (
              <>
                <div className="document-summary-card">
                  <p className="document-path">{selectedDocument.path}</p>
                  <p className="document-summary">{selectedDocument.summary}</p>
                  <p className="document-updated">Updated {new Date(selectedDocument.updatedAt).toLocaleString()}</p>
                </div>

                <div className="preview-section">
                  <p className="panel-label">Blocks</p>
                  <div className="block-preview-list">
                    {selectedDocument.blocks.map((block) => (
                      <div className="block-preview" key={`${selectedDocument.id}-${block.sortOrder}`}>
                        {renderBlock(block)}
                      </div>
                    ))}
                  </div>
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
  onSelect
}: {
  nodes: DocumentTreeNode[]
  selectedDocumentId: string | null
  onSelect: (documentId: string) => void
}) {
  return (
    <ul className="tree-list">
      {nodes.map((node) => (
        <li className="tree-node" key={node.id}>
          <button
            className={`tree-button${selectedDocumentId === node.id ? ' tree-button-active' : ''}`}
            onClick={() => onSelect(node.id)}
            type="button"
          >
            <span>{node.title}</span>
            <small>{new Date(node.updatedAt).toLocaleDateString()}</small>
          </button>
          <p className="tree-path">{node.path}</p>
          {node.children.length > 0 ? (
            <div className="tree-children">
              <DocumentTree nodes={node.children} selectedDocumentId={selectedDocumentId} onSelect={onSelect} />
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