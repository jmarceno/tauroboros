import type { WorkflowRun } from '@/types'

interface RunPanelProps {
  run: WorkflowRun
  isStale: boolean
  onArchive: () => void
  onHighlight: () => void
  onClearHighlight: () => void
}

export function RunPanel({ run, isStale, onArchive, onHighlight, onClearHighlight }: RunPanelProps) {
  const progress = run.taskOrder?.length 
    ? Math.round((run.currentTaskIndex / run.taskOrder.length) * 100) 
    : 0

  const statusClass = run.status === 'running' ? 'active' : 
                     run.status === 'paused' ? 'paused' : ''

  return (
    <div 
      className={`run-card ${statusClass} ${isStale ? 'opacity-50' : ''}`}
      style={run.color ? { '--progress-color': run.color } as React.CSSProperties : undefined}
    >
      <div className="run-header">
        <span className="run-id">{run.displayName || run.id.slice(0, 8)}</span>
        <span className={`run-status ${statusClass}`}>
          {run.status}
        </span>
      </div>
      
      <div className="run-meta">
        <span>{run.currentTaskIndex || 0}/{run.taskOrder?.length || 0} tasks</span>
        {isStale && <span className="text-accent-warning">(stale)</span>}
      </div>
      
      <div className="run-progress">
        <div className="run-progress-fill" style={{ width: `${progress}%` }} />
      </div>

      <div className="flex gap-2 mt-2">
        <button
          className="text-[10px] px-2 py-1 bg-dark-bg border border-dark-border rounded hover:border-accent-primary"
          onClick={onHighlight}
        >
          Highlight
        </button>
        <button
          className="text-[10px] px-2 py-1 bg-dark-bg border border-dark-border rounded hover:border-accent-primary"
          onClick={onClearHighlight}
        >
          Clear
        </button>
        <button
          className="text-[10px] px-2 py-1 bg-dark-bg border border-dark-border rounded hover:border-accent-danger text-accent-danger"
          onClick={onArchive}
        >
          Archive
        </button>
      </div>
    </div>
  )
}
