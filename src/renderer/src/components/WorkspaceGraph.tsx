import { useEffect, useRef, useState } from 'react'
import { WorkspaceGraphNode, WorkspaceGraphEdge } from '@shared/contracts'
import { getActiveUiText } from '../i18n'

function buildGraphLayout(nodes: WorkspaceGraphNode[], width: number, height: number) {
  if (nodes.length === 0) {
    return [] as Array<WorkspaceGraphNode & { x: number; y: number }>
  }

  const nodeCount = nodes.length
  const centerX = width / 2
  const centerY = height / 2
  const maxRadius = Math.min(width, height) * 0.35

  return nodes.map((node, index) => {
    if (nodeCount === 1) {
      return { ...node, x: centerX, y: centerY }
    }

    const angle = (2 * Math.PI * index) / nodeCount - Math.PI / 2
    const radius = maxRadius * (0.3 + 0.7 * Math.random())

    return {
      ...node,
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius
    }
  })
}

type WorkspaceGraphProps = {
  nodes: WorkspaceGraphNode[]
  edges: WorkspaceGraphEdge[]
  selectedDocumentId: string | null
  onSelect: (documentId: string) => void
  isCompact?: boolean
}

export function WorkspaceGraph({
  nodes,
  edges,
  selectedDocumentId,
  onSelect,
  isCompact = false
}: WorkspaceGraphProps) {
  const ui = getActiveUiText()
  const width = isCompact ? 200 : 920
  const height = isCompact ? 100 : 320
  const [layout, setLayout] = useState<Array<WorkspaceGraphNode & { x: number; y: number }>>([])

  useEffect(() => {
    setLayout(buildGraphLayout(nodes, width, height))
  }, [nodes, width, height])

  const positionMap = new Map(layout.map((node) => [node.id, node]))

  return (
    <div className="graph-surface">
      <svg className="graph-svg" viewBox={`0 0 ${width} ${height}`}>
        {edges.map((edge, index) => {
          const source = positionMap.get(edge.sourceId)
          const target = positionMap.get(edge.targetId)
          if (!source || !target) {
            return null
          }

          return (
            <line
              className={`graph-edge graph-edge-${edge.kind}`}
              key={`edge-${edge.kind}-${index}`}
              x1={source.x}
              x2={target.x}
              y1={source.y}
              y2={target.y}
            />
          )
        })}

        {layout.map((node) => (
          <g className="graph-node-group" key={node.id} onClick={() => onSelect(node.id)}>
            <circle
              className={`graph-node${selectedDocumentId === node.id ? ' graph-node-active' : ''}`}
              cx={node.x}
              cy={node.y}
              r={selectedDocumentId === node.id ? 12 : 9}
            />
            <text className="graph-node-label" textAnchor="middle" x={node.x} y={node.y + 24}>
              {node.title}
            </text>
          </g>
        ))}
      </svg>
      {!isCompact && (
        <div className="graph-legend">
          <span><i className="legend-swatch legend-swatch-tree" /> {ui.graphLegendTree}</span>
          <span><i className="legend-swatch legend-swatch-link" /> {ui.graphLegendLink}</span>
        </div>
      )}
    </div>
  )
}
