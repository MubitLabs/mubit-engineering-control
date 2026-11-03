import dagre from 'dagre'
import { useMemo } from 'react'
import { Link } from 'react-router'
import { taskStatus } from '../../components/ui'

export interface GraphNode {
  key: string
  title: string
  state?: string
  id?: string
  warn?: boolean
}

const STATE_COLOR: Record<string, string> = {
  ready: 'var(--info)',
  active: 'var(--accent)',
  awaiting_review: 'var(--warn)',
  accepted: 'var(--ok)',
  integrated: 'var(--ok)',
  failed: 'var(--err)',
  approved: 'var(--muted)',
}

const W = 168
const H = 46

/** The stored task graph rendered as-is (PDF §25: configuration and execution cannot disagree). */
export function TaskGraph(props: { nodes: GraphNode[]; edges: [string, string][]; projectId?: string }) {
  const layout = useMemo(() => {
    const g = new dagre.graphlib.Graph()
    g.setGraph({ rankdir: 'LR', nodesep: 18, ranksep: 46, marginx: 8, marginy: 8 })
    g.setDefaultEdgeLabel(() => ({}))
    for (const n of props.nodes) g.setNode(n.key, { width: W, height: H })
    for (const [from, to] of props.edges) if (g.hasNode(from) && g.hasNode(to)) g.setEdge(from, to)
    dagre.layout(g)
    return g
  }, [props.nodes, props.edges])

  const graph = layout.graph()
  const width = Math.max(graph.width ?? 0, 200)
  const height = Math.max(graph.height ?? 0, 60)
  return (
    <div className="graph-scroll">
      {width > 620 && (
        <div className="faint small">Wider than the panel: scroll sideways to see all of it.</div>
      )}
      <svg width={width} height={height} role="img" aria-label="Task dependency graph">
        <title>Task dependency graph</title>
        <defs>
          <marker
            id="arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto"
          >
            <path d="M0,0 L10,5 L0,10 z" fill="var(--border-strong)" />
          </marker>
        </defs>
        {layout.edges().map((e) => {
          const pts = layout.edge(e).points
          const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ')
          return (
            <path
              key={`${e.v}-${e.w}`}
              d={d}
              fill="none"
              stroke="var(--border-strong)"
              markerEnd="url(#arrow)"
            />
          )
        })}
        {props.nodes.map((n) => {
          const pos = layout.node(n.key)
          if (!pos) return null
          const color = (n.state && STATE_COLOR[n.state]) || 'var(--border-strong)'
          const box = (
            <g key={`box-${n.key}`} transform={`translate(${pos.x - W / 2},${pos.y - H / 2})`}>
              <rect
                width={W}
                height={H}
                rx={4}
                fill="var(--panel-2)"
                stroke={n.warn ? 'var(--warn)' : color}
              />
              <text x={10} y={18} fill="var(--text)" fontSize={12} fontWeight={600}>
                {n.key}
              </text>
              <text x={10} y={34} fill="var(--muted)" fontSize={11}>
                {n.title.length > 22 ? `${n.title.slice(0, 21)}…` : n.title}
              </text>
              {n.state && (
                <text
                  x={W - 8}
                  y={18}
                  fill={color}
                  fontSize={9}
                  textAnchor="end"
                  style={{ textTransform: 'uppercase' }}
                >
                  {taskStatus(n.state).replace(/_/g, ' ')}
                </text>
              )}
            </g>
          )
          return n.id && props.projectId ? (
            <Link key={n.key} to={`/projects/${props.projectId}/tasks/${n.id}`}>
              {box}
            </Link>
          ) : (
            <g key={n.key}>{box}</g>
          )
        })}
      </svg>
    </div>
  )
}
