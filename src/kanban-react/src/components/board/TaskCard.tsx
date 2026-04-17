import { useEffect, useMemo, useCallback, memo } from 'react'
import type { Task, BestOfNSummary } from '@/types'
import type { useDragDrop } from '@/hooks/useDragDrop'
import { useOptionsContext, useTasksContext, useSessionUsageContext } from '@/contexts/AppContext'
import { useTaskSessionUsage } from '@/hooks/useTaskSessionUsage'

interface TaskCardProps {
  task: Task
  bonSummary?: BestOfNSummary
  runColor: string | null
  isLocked: boolean
  canDrag: boolean
  dragDrop: ReturnType<typeof useDragDrop>
  isSelected?: boolean
  isMultiSelecting?: boolean
  isHighlighted?: boolean
  onOpen: (e?: React.MouseEvent) => void
  onDeploy: (e: React.MouseEvent) => void
  onOpenTaskSessions: () => void
  onApprovePlan: () => void
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

export const TaskCard = memo(function TaskCard({
  task,
  bonSummary,
  runColor,
  isLocked,
  canDrag,
  dragDrop,
  isSelected,
  isMultiSelecting,
  isHighlighted,
  onOpen,
  onDeploy,
  onOpenTaskSessions,
  onApprovePlan,
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
  const { options } = useOptionsContext()
  const { tasks } = useTasksContext()
  const sessionUsage = useSessionUsageContext()

  // Get aggregated usage across all task sessions
  const taskUsage = useTaskSessionUsage(task.id)

  // Start/stop watching current session usage (for real-time updates)
  useEffect(() => {
    if (task.sessionId) {
      sessionUsage.startWatching(task.sessionId)
      sessionUsage.loadSessionUsage(task.sessionId)
    }
    return () => {
      if (task.sessionId) {
        sessionUsage.stopWatching(task.sessionId)
      }
    }
  }, [task.sessionId, sessionUsage])

  const hasLocalSession = useMemo(() =>
    !!task.sessionId &&
    task.status !== 'backlog' &&
    task.status !== 'template'
  , [task.sessionId, task.status])

  const isAnomalousReviewTask = useMemo(() =>
    task.status === 'review' &&
    !task.awaitingPlanApproval &&
    task.executionStrategy !== 'best_of_n'
  , [task.status, task.awaitingPlanApproval, task.executionStrategy])

  const isOrphanExecutingTask = useMemo(() =>
    !isLocked && task.status === 'executing'
  , [isLocked, task.status])

  const hasPlanOutput = useMemo(() =>
    task.executionPhase === 'plan_complete_waiting_approval'
  , [task.executionPhase])

  const canSendToExecution = useMemo(() =>
    task.planmode === true &&
    hasPlanOutput &&
    task.executionPhase !== 'implementation_done' &&
    (task.status === 'review' || task.status === 'executing' || task.status === 'failed' || task.status === 'stuck')
  , [task.planmode, hasPlanOutput, task.executionPhase, task.status])

  const canRepairToDone = useMemo(() =>
    task.status !== 'done' &&
    task.executionStrategy !== 'best_of_n' &&
    task.awaitingPlanApproval !== true &&
    (task.errorMessage !== null || task.reviewCount > 0)
  , [task.status, task.executionStrategy, task.awaitingPlanApproval, task.errorMessage, task.reviewCount])

  const showInlineActionBar = useMemo(() =>
    !isLocked &&
    (task.status === 'review' || task.status === 'executing' || task.status === 'failed' || task.status === 'stuck')
  , [isLocked, task.status])

  const effectiveMaxReviews = useMemo(() =>
    task.maxReviewRunsOverride ?? options?.maxReviews ?? 2
  , [task.maxReviewRunsOverride, options?.maxReviews])

  const effectiveMaxJsonParseRetries = useMemo(() =>
    options?.maxJsonParseRetries ?? 5
  , [options?.maxJsonParseRetries])

  const isNearReviewLimit = useMemo(() =>
    task.reviewCount >= effectiveMaxReviews - 1
  , [task.reviewCount, effectiveMaxReviews])

  const isAtReviewLimit = useMemo(() =>
    task.reviewCount >= effectiveMaxReviews
  , [task.reviewCount, effectiveMaxReviews])

  const hasJsonParseRetries = useMemo(() =>
    task.jsonParseRetryCount > 0 && task.status === 'review'
  , [task.jsonParseRetryCount, task.status])

  const isNearJsonParseLimit = useMemo(() =>
    task.jsonParseRetryCount >= effectiveMaxJsonParseRetries - 1
  , [task.jsonParseRetryCount, effectiveMaxJsonParseRetries])

  const depIds = useMemo(() => {
    return (task.requirements || [])
      .map(id => tasks.find(t => t.id === id))
      .filter((dep): dep is Task => dep !== undefined && typeof dep.idx === 'number')
      .map(dep => `#${dep.idx + 1}`)
  }, [task.requirements, tasks])

  const hasNonDefaultThinkingLevel = useMemo(() => {
    return task.thinkingLevel !== 'default' ||
      task.planThinkingLevel !== 'default' ||
      task.executionThinkingLevel !== 'default'
  }, [task.thinkingLevel, task.planThinkingLevel, task.executionThinkingLevel])

  const thinkingLevelSummary = useMemo(() => {
    const levels: string[] = []
    if (task.thinkingLevel !== 'default') levels.push(task.thinkingLevel)
    if (task.planThinkingLevel !== 'default') levels.push(`plan:${task.planThinkingLevel}`)
    if (task.executionThinkingLevel !== 'default') levels.push(`exec:${task.executionThinkingLevel}`)
    return levels.join(', ') || 'default'
  }, [task.thinkingLevel, task.planThinkingLevel, task.executionThinkingLevel])

  const thinkingLevelTooltip = useMemo(() => {
    const parts: string[] = []
    parts.push(`Global: ${task.thinkingLevel}`)
    parts.push(`Plan: ${task.planThinkingLevel}`)
    parts.push(`Execution: ${task.executionThinkingLevel}`)
    return parts.join('\n')
  }, [task.thinkingLevel, task.planThinkingLevel, task.executionThinkingLevel])

  // Status color for the task indicator
  const statusColor = useMemo(() => {
    switch (task.status) {
      case 'stuck':
      case 'failed':
        return 'high'
      case 'review':
        return 'medium'
      default:
        return 'low'
    }
  }, [task.status])

  // Determine if we have usage data to display
  const hasUsageData = taskUsage.totalCost > 0 || taskUsage.totalTokens > 0

  const handleDragStart = useCallback((e: React.DragEvent) => {
    if (!canDrag) return
    dragDrop.handleDragStart(task.id)
    ;(e.target as HTMLElement).classList.add('dragging')
    e.dataTransfer.effectAllowed = 'move'
  }, [canDrag, dragDrop, task.id])

  const handleDragEnd = useCallback((e: React.DragEvent) => {
    dragDrop.handleDragEnd()
    ;(e.target as HTMLElement).classList.remove('dragging')
  }, [dragDrop])

  const getStatusIcon = useCallback(() => {
    switch (task.status) {
      case 'executing':
        return (
          <svg className="task-icon animate-spin text-accent-success" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" strokeDasharray="60" strokeDashoffset="20" />
          </svg>
        )
      case 'template':
        return (
          <svg className="task-icon text-column-template" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
          </svg>
        )
      case 'backlog':
        return (
          <svg className="task-icon text-column-backlog" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>
          </svg>
        )
      case 'review':
        return (
          <svg className="task-icon text-column-review" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
            <path d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/>
          </svg>
        )
      case 'done':
        return (
          <svg className="task-icon text-column-done" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
          </svg>
        )
      case 'stuck':
      case 'failed':
        return (
          <svg className="task-icon text-accent-danger" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10"/>
            <path d="M12 8v4M12 16h.01"/>
          </svg>
        )
      default:
        return null
    }
  }, [task.status])

  return (
    <div
      className={`task-card ${isSelected ? 'dragging' : ''} ${isHighlighted ? 'highlighted' : ''}`}
      data-task-id={task.id}
      data-task-status={task.status}
      style={runColor ? { borderLeft: `3px solid ${runColor}` } : undefined}
      draggable={canDrag && !isMultiSelecting}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onClick={(e) => onOpen(e)}
    >
      {/* Header */}
      <div className="task-header">
        {/* Task ID badge */}
        <span className="task-id-badge">#{task.idx + 1}</span>

        {getStatusIcon()}

        <span
          className={`task-title ${hasLocalSession ? 'cursor-pointer hover:text-accent-primary' : ''}`}
          title={task.name}
          onClick={(e) => {
            if (hasLocalSession) {
              e.stopPropagation()
              onOpenTaskSessions()
            }
          }}
        >
          {task.name}
        </span>
      </div>

      {/* Tags */}
      <div className="task-tags mb-2">
        {task.planmode && (
          <span className="task-tag border-accent-secondary/30 text-accent-secondary">
            plan
          </span>
        )}
        {task.status === 'review' && task.awaitingPlanApproval && (
          <span className="task-tag border-accent-warning/30 text-accent-warning">
            plan approval
          </span>
        )}
        {task.review && (
          <span className={`task-tag ${
            (task.status === 'stuck' || isAtReviewLimit) ? 'border-accent-danger/30 text-accent-danger' :
            isNearReviewLimit ? 'border-accent-warning/30 text-accent-warning' :
            'border-accent-warning/30 text-accent-warning'
          }`}>
            review {task.reviewCount}/{effectiveMaxReviews}
          </span>
        )}
        {hasJsonParseRetries && (
          <span
            className={`task-tag ${isNearJsonParseLimit ? 'border-accent-danger/30 text-accent-danger' : 'border-accent-warning/30 text-accent-warning'}`}
            title={`JSON parse failures: ${task.jsonParseRetryCount}/${effectiveMaxJsonParseRetries}`}
          >
            json retry {task.jsonParseRetryCount}/{effectiveMaxJsonParseRetries}
          </span>
        )}
        {task.executionStrategy === 'best_of_n' && (
          <span className="task-tag border-accent-info/30 text-accent-info">
            best-of-n
          </span>
        )}
        {depIds.length > 0 && (
          <span className="task-tag">
            deps: {depIds.join(', ')}
          </span>
        )}
        {hasNonDefaultThinkingLevel && (
          <span className="task-tag" title={thinkingLevelTooltip}>
            {thinkingLevelSummary}
          </span>
        )}
        {task.branch && (
          <span className="task-tag">
            {task.branch}
          </span>
        )}
        {task.containerImage && (
          <span
            className="task-tag border-accent-info/30 text-accent-info"
            title={`Container Image: ${task.containerImage}`}
          >
            🐳 {task.containerImage}
          </span>
        )}
        {task.errorMessage && (
          <span className="task-tag border-accent-danger/30 text-accent-danger">
            error
          </span>
        )}
      </div>

      {/* Actions */}
      <div className="task-footer">
        <div className="flex items-center gap-1">
          {/* Edit button */}
          <button
            className="p-1 rounded hover:bg-dark-surface2 text-dark-text-secondary hover:text-dark-text transition-colors"
            title={task.status === 'template' ? 'Edit Template' : 'Edit Task'}
            onClick={(e) => { e.stopPropagation(); onOpen(); }}
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
            </svg>
          </button>

          {/* Deploy button (template only) */}
          {task.status === 'template' && (
            <button
              className="p-1 rounded hover:bg-dark-surface2 text-dark-text-secondary hover:text-accent-primary transition-colors"
              title="Deploy to Backlog (Ctrl+click for instant, Ctrl+Shift+click to delete after)"
              onClick={(e) => { e.stopPropagation(); onDeploy(e); }}
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M5 10l7-7m0 0l7 7m-7-7v18"/>
              </svg>
            </button>
          )}

          {/* Reset button */}
          {!showInlineActionBar && !isLocked && (task.status === 'stuck' || task.status === 'failed' || task.status === 'done' || task.status === 'review') && (
            <button
              className="p-1 rounded hover:bg-dark-surface2 text-dark-text-secondary hover:text-accent-warning transition-colors"
              title="Reset to Backlog"
              onClick={(e) => { e.stopPropagation(); onReset(); }}
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
              </svg>
            </button>
          )}

          {/* Archive button */}
          {!showInlineActionBar && (((!isLocked && task.status !== 'executing')) || task.status === 'done') && (
            <button
              className="p-1 rounded hover:bg-dark-surface2 text-dark-text-secondary hover:text-accent-danger transition-colors"
              title="Archive Task (Ctrl+click to skip confirmation)"
              onClick={(e) => { e.stopPropagation(); onArchive(e); }}
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
              </svg>
            </button>
          )}

          {/* Mark Done button (for stuck or anomalous review tasks) */}
          {(task.status === 'stuck' || (!isLocked && isAnomalousReviewTask)) && (
            <button
              className="p-1 rounded hover:bg-dark-surface2 text-dark-text-secondary hover:text-accent-success transition-colors"
              title="Mark as Done"
              onClick={(e) => { e.stopPropagation(); onMarkDone(); }}
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M5 13l4 4L19 7"/>
              </svg>
            </button>
          )}

          {/* Start Single button (backlog only) */}
          {task.status === 'backlog' && !isLocked && (
            <button
              className="p-1 rounded hover:bg-dark-surface2 text-dark-text-secondary hover:text-accent-success transition-colors"
              title="Start this task"
              onClick={(e) => { e.stopPropagation(); onStartSingle(); }}
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/>
                <path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
              </svg>
            </button>
          )}

          {/* Convert to Template button (backlog only) */}
          {task.status === 'backlog' && !isLocked && (
            <button
              className="p-1 rounded hover:bg-dark-surface2 text-dark-text-secondary hover:text-accent-primary transition-colors"
              title="Convert to Template (Ctrl+click to skip confirmation)"
              onClick={(e) => { e.stopPropagation(); onConvertToTemplate(e); }}
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
              </svg>
            </button>
          )}
        </div>

        {/* Status Indicator */}
        <div className={`task-indicator ${statusColor}`} />
      </div>

      {/* Inline Action Bar */}
      {showInlineActionBar && (
        <div className="flex flex-wrap gap-1.5 mt-2 pt-2 border-t border-dark-border">
          {task.status === 'review' && task.awaitingPlanApproval && task.executionPhase === 'plan_complete_waiting_approval' && hasPlanOutput && (
            <>
              <button className="btn btn-primary btn-xs" onClick={(e) => { e.stopPropagation(); onApprovePlan(); }}>
                Approve Plan
              </button>
              <button className="btn btn-xs border-accent-warning/50 text-accent-warning" onClick={(e) => { e.stopPropagation(); onRequestRevision(); }}>
                Request Changes
              </button>
            </>
          )}

          {task.status === 'review' && isAnomalousReviewTask && (
            <button className="btn btn-primary btn-xs" onClick={(e) => { e.stopPropagation(); onMarkDone(); }}>
              Mark Done
            </button>
          )}

          {canSendToExecution && (
            <button className="btn btn-primary btn-xs" onClick={(e) => { e.stopPropagation(); onRepair('queue_implementation'); }}>
              Send to Execution
            </button>
          )}

          {canRepairToDone && task.status !== 'stuck' && (
            <button className="btn btn-xs" onClick={(e) => { e.stopPropagation(); onRepair('mark_done'); }}>
              Repair Done
            </button>
          )}

          <button className="btn btn-xs" onClick={(e) => { e.stopPropagation(); onRepair('smart'); }}>
            Smart Repair
          </button>

          {task.status === 'stuck' && (
            <button className="btn btn-primary btn-xs" onClick={(e) => { e.stopPropagation(); onContinueReviews(); }}>
              Continue Reviews
            </button>
          )}
        </div>
      )}

      {/* View Runs button for best-of-n */}
      {task.executionStrategy === 'best_of_n' && task.status !== 'template' && task.status !== 'backlog' && (
        <button className="btn btn-xs mt-2" onClick={(e) => { e.stopPropagation(); onViewRuns(); }}>
          View Runs
        </button>
      )}

      {/* Cost and tokens badge - aggregated across all sessions */}
      {hasUsageData && (
        <div className="flex items-center gap-2 mt-1 text-xs">
          <span
            className="px-2 py-0.5 bg-dark-surface2 border border-dark-border rounded-full text-dark-text-secondary flex items-center gap-1"
            title={`${taskUsage.formattedTokens} tokens across all sessions`}
          >
            💰 {taskUsage.formattedCost}
          </span>
          <span
            className="px-2 py-0.5 bg-dark-surface2 border border-dark-border rounded-full text-dark-text-muted"
            title="Total tokens across all sessions"
          >
            🪙 {taskUsage.formattedTokens}
          </span>
        </div>
      )}

      {/* Completed date */}
      {task.completedAt && (
        <div className="text-xs text-dark-text-muted mt-1">
          Completed: {new Date(task.completedAt * 1000).toLocaleString()}
        </div>
      )}

      {/* Warnings */}
      {task.status === 'review' && task.awaitingPlanApproval && task.executionPhase === 'plan_complete_waiting_approval' && !hasPlanOutput && (
        <div className="text-xs text-accent-danger mt-2">
          Plan approval is unavailable - no [plan] block exists
        </div>
      )}

      {isOrphanExecutingTask && (
        <div className="text-xs text-accent-danger mt-2">
          Session may have dropped - click title to verify
        </div>
      )}
    </div>
  )
})
