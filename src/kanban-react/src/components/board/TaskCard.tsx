import type { Task, BestOfNSummary } from '@/types'

interface TaskCardProps {
  task: Task
  bonSummary?: BestOfNSummary
  runColor: string | null
  isLocked: boolean
  isDragging: boolean
  isMultiSelecting?: boolean
  isSelected?: boolean
  isHighlighted?: boolean
  onDragStart: () => void
  onDragEnd: () => void
  onClick: () => void
  onDeploy: () => void
  onOpenSessions: () => void
  onApprove: () => void
  onRequestRevision: () => void
  onStartSingle: () => void
  onRepair: (action: string) => void
  onMarkDone: () => void
  onReset: () => void
  onConvertToTemplate: (e: React.MouseEvent) => void
  onArchive: (e: React.MouseEvent) => void
  onViewRuns: () => void
  onContinueReviews: () => void
}

export function TaskCard({
  task,
  bonSummary,
  runColor,
  isLocked,
  isDragging,
  isSelected,
  isHighlighted,
  onDragStart,
  onDragEnd,
  onClick,
  onDeploy,
  onOpenSessions,
  onApprove,
  onRequestRevision,
  onStartSingle,
  onRepair,
  onMarkDone,
  onReset,
  onConvertToTemplate,
  onArchive,
  onViewRuns,
  onContinueReviews,
}: TaskCardProps) {
  const getStatusColor = () => {
    if (task.status === 'failed' || task.status === 'stuck') return 'text-accent-danger'
    if (task.status === 'executing') return 'text-column-executing'
    if (task.status === 'review') return 'text-column-review'
    if (task.status === 'done') return 'text-column-done'
    if (task.status === 'template') return 'text-column-template'
    return 'text-dark-text'
  }

  const getThinkingIndicator = () => {
    switch (task.thinkingLevel) {
      case 'high': return <span className="task-indicator high" title="High thinking level" />
      case 'medium': return <span className="task-indicator medium" title="Medium thinking level" />
      case 'low': return <span className="task-indicator low" title="Low thinking level" />
      default: return null
    }
  }

  const getBestOfNIndicator = () => {
    if (task.executionStrategy !== 'best_of_n' || !bonSummary) return null

    const { workersDone, workersTotal, reviewersDone, reviewersTotal, substage } = bonSummary
    const isComplete = substage === 'completed'
    const isBlocked = substage === 'blocked_for_manual_review'

    return (
      <div className={`text-[10px] px-1.5 py-0.5 rounded border ${
        isComplete ? 'bg-accent-success/20 border-accent-success text-accent-success' :
        isBlocked ? 'bg-accent-warning/20 border-accent-warning text-accent-warning' :
        'bg-accent-info/20 border-accent-info text-accent-info'
      }`}>
        {isComplete ? '✓' : isBlocked ? '⏸' : `${workersDone}/${workersTotal}`}
        {reviewersTotal > 0 && ` • ${reviewersDone}/${reviewersTotal}`}
      </div>
    )
  }

  const getPlanModeIndicator = () => {
    if (!task.planmode) return null
    if (task.awaitingPlanApproval) {
      return (
        <span className="text-[10px] px-1.5 py-0.5 bg-accent-warning/20 border border-accent-warning rounded text-accent-warning">
          ⏸ Plan Approval
        </span>
      )
    }
    return (
      <span className="text-[10px] px-1.5 py-0.5 bg-accent-info/20 border border-accent-info rounded text-accent-info">
        Plan Mode
      </span>
    )
  }

  const getReviewIndicator = () => {
    if (!task.review) return null
    return (
      <span className="text-[10px] px-1.5 py-0.5 bg-accent-secondary/20 border border-accent-secondary rounded text-accent-secondary">
        Review
      </span>
    )
  }

  return (
    <div
      className={`task-card ${isDragging ? 'dragging' : ''} ${isSelected ? 'ring-2 ring-accent-primary' : ''} ${isHighlighted ? 'highlighted' : ''}`}
      draggable={!isLocked}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onClick}
      style={runColor ? { borderLeft: `3px solid ${runColor}` } : undefined}
    >
      <div className="task-header">
        <div className={`task-id-badge ${getStatusColor()}`}>
          #{task.idx}
        </div>
        <div className="task-title truncate">{task.name}</div>
      </div>

      <div className="flex flex-wrap gap-1 mb-2">
        {getPlanModeIndicator()}
        {getReviewIndicator()}
        {getBestOfNIndicator()}
        {getThinkingIndicator()}
      </div>

      <div className="task-footer">
        <div className="flex gap-1">
          {task.status === 'template' && (
            <button
              className="text-[10px] px-2 py-0.5 bg-dark-surface2 border border-dark-border rounded hover:border-accent-primary"
              onClick={(e) => { e.stopPropagation(); onDeploy(); }}
            >
              Deploy
            </button>
          )}
          {task.status === 'backlog' && (
            <button
              className="text-[10px] px-2 py-0.5 bg-dark-surface2 border border-dark-border rounded hover:border-accent-primary"
              onClick={(e) => { e.stopPropagation(); onStartSingle(); }}
            >
              Start
            </button>
          )}
          {task.awaitingPlanApproval && (
            <button
              className="text-[10px] px-2 py-0.5 bg-accent-warning/20 border border-accent-warning rounded hover:bg-accent-warning/30"
              onClick={(e) => { e.stopPropagation(); onApprove(); }}
            >
              Approve
            </button>
          )}
          {(task.status === 'failed' || task.status === 'stuck') && (
            <>
              <button
                className="text-[10px] px-2 py-0.5 bg-dark-surface2 border border-dark-border rounded hover:border-accent-primary"
                onClick={(e) => { e.stopPropagation(); onRepair('retry'); }}
              >
                Retry
              </button>
              <button
                className="text-[10px] px-2 py-0.5 bg-dark-surface2 border border-dark-border rounded hover:border-accent-primary"
                onClick={(e) => { e.stopPropagation(); onReset(); }}
              >
                Reset
              </button>
            </>
          )}
          {task.status === 'review' && task.review && (
            <button
              className="text-[10px] px-2 py-0.5 bg-dark-surface2 border border-dark-border rounded hover:border-accent-primary"
              onClick={(e) => { e.stopPropagation(); onMarkDone(); }}
            >
              Mark Done
            </button>
          )}
          {task.sessionId && (
            <button
              className="text-[10px] px-2 py-0.5 bg-dark-surface2 border border-dark-border rounded hover:border-accent-primary"
              onClick={(e) => { e.stopPropagation(); onOpenSessions(); }}
            >
              Sessions
            </button>
          )}
          {task.executionStrategy === 'best_of_n' && bonSummary && (
            <button
              className="text-[10px] px-2 py-0.5 bg-dark-surface2 border border-dark-border rounded hover:border-accent-primary"
              onClick={(e) => { e.stopPropagation(); onViewRuns(); }}
            >
              View Runs
            </button>
          )}
        </div>

        <div className="flex gap-1">
          {task.status !== 'template' && task.status !== 'done' && (
            <button
              className="text-[10px] px-2 py-0.5 bg-dark-surface2 border border-dark-border rounded hover:border-accent-primary"
              onClick={(e) => { e.stopPropagation(); onConvertToTemplate(e); }}
              title="Convert to template (Ctrl+Click to skip confirmation)"
            >
              → Template
            </button>
          )}
          <button
            className="text-[10px] px-2 py-0.5 bg-accent-danger/20 border border-accent-danger rounded hover:bg-accent-danger/30 text-accent-danger"
            onClick={(e) => { e.stopPropagation(); onArchive(e); }}
            title="Delete task (Ctrl+Click to skip confirmation)"
          >
            ×
          </button>
        </div>
      </div>
    </div>
  )
}
