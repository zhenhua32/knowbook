import type { WorkspaceGraphEdge, WorkspaceGraphNode } from '@shared/contracts'
import type { UiText } from '../i18n'
import { WorkspaceGraph } from '../components/WorkspaceGraph'

type WorkspaceGraphSectionProps = {
  edges: WorkspaceGraphEdge[]
  nodes: WorkspaceGraphNode[]
  onSelectDocument: (documentId: string) => void
  selectedDocumentId: string | null
  ui: UiText
}

export function WorkspaceGraphSection({
  edges,
  nodes,
  onSelectDocument,
  selectedDocumentId,
  ui
}: WorkspaceGraphSectionProps) {
  return (
    <section className="graph-grid" data-testid="graph-grid">
      <article className="panel graph-panel">
        <div className="panel-head compact-head">
          <div>
            <p className="panel-label">{ui.knowledgeGraphLabel}</p>
            <h3>{ui.knowledgeGraphTitle}</h3>
          </div>
          <div className="toolbar-inline">
            <span className="pill">{nodes.length} nodes</span>
            <span className="pill">{edges.length} edges</span>
          </div>
        </div>

        <WorkspaceGraph
          edges={edges}
          nodes={nodes}
          selectedDocumentId={selectedDocumentId}
          onSelect={onSelectDocument}
        />
      </article>
    </section>
  )
}