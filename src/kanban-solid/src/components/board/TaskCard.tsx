/**
 * TaskCard Component - Individual task card with all badges and actions
 * Ported from React to SolidJS - Full feature parity
 */

import { Show, For, createMemo, createSignal, createEffect, onMount, onCleanup } from 'solid-js'
import type { Task, BestOfNSummary } from '@/types'
import type { createDragDropStore } from '@/stores'
import type { createSessionUsageStore } from '@/stores/sessionUsageStore'
import type { createTaskLastUpdateStore } from '@/stores/taskLastUpdateStore'
import { formatLocalDateTime, formatRelativeTime } from '@/utils/date'
import { getTaskCardActionVisibility } from './taskCardActions'

interface TaskCardProps {
  task: Task
  bonSummary?: BestOfNSummary
  runColor: string | null
  isLocked: boolean
  canDrag: boolean
  dragDrop: ReturnType<typeof createDragDropStore>
  sessionUsage: ReturnType<typeof createSessionUsageStore>
  taskLastUpdate: ReturnType<typeof createTaskLastUpdateStore>
  isSelected?: boolean
  isMultiSelecting?: boolean
  isHighlighted?: boolean
  group?: { id: string; name: string; color: string }
  showGroupIndicator?: boolean
  tasks: Task[]  // All tasks for dependency lookup
  options?: {
    maxReviews?: number
    maxJsonParseRetries?: number
  }
  onOpen: (e?: MouseEvent) => void
  onDeploy: (e: MouseEvent) => void
  onOpenTaskSessions: () => void
  onApprovePlan: () => void
  onRequestRevision: () => void
  onStartSingle: () => void
  onRepair: (action: string) => void
  onMarkDone: () => void
  onReset: () => void
  onConvertToTemplate: (e: MouseEvent) => void
  onArchive: (e: MouseEvent) => void
  onViewRuns: () => void
  onContinueReviews: () => void
}

function getUpdateAgeClass(timestamp: number): string {
  const diffMs = Date.now() - timestamp * 1000
  const diffMin = Math.floor(diffMs / 60000)

  if (diffMin < 2) return 'recent'
  if (diffMin < 30) return 'medium'
  return 'old'
}

export function TaskCard(props: TaskCardProps) {
  let cardRef: HTMLDivElement | undefined
  const [hasBeenVisible, setHasBeenVisible] = createSignal(false)
  const [isDragging, setIsDragging] = createSignal(false)

  // Badges MUST always show for non-backlog, non-template tasks
  const shouldShowBadges = createMemo(() => 
    props.task.status !== 'backlog' && props.task.status !== 'template'
  )

  // hasLocalSession used for interaction purposes
  const hasLocalSession = createMemo(() => shouldShowBadges() && !!props.task.sessionId)

  // Intersection observer for lazy loading
  onMount(() => {
    if (!cardRef || !shouldShowBadges()) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setHasBeenVisible(true)
          // Start watching task for usage updates
          props.sessionUsage.startWatchingTask(props.task.id)
          // Load last update from backend
          props.taskLastUpdate.loadLastUpdate(props.task.id)
        }
      },
      { threshold: 0.1, rootMargin: '100px' }
    )

    observer.observe(cardRef)

    onCleanup(() => {
      observer.disconnect()
      props.sessionUsage.stopWatchingTask(props.task.id)
    })
  })

  // Get real-time last update from store
  const lastUpdate = createMemo(() => props.taskLastUpdate.getLastUpdate(props.task.id))

  // Format last update
  const lastUpdateFormatted = createMemo(() => {
    const update = lastUpdate()
    return update ? formatRelativeTime(update) : null
  })
  
  const lastUpdateAgeClass = createMemo(() => {
    const update = lastUpdate()
    return update ? getUpdateAgeClass(update) : null
  })

  // Get aggregated usage data from store
  const usageData = createMemo(() => {
    if (!shouldShowBadges()) return null
    return props.sessionUsage.getTaskUsage(props.task.id)
  })

  // Always show formatted values when badges should be visible
  const formattedTokens = createMemo(() => {
    const data = usageData()
    return data ? props.sessionUsage.formatTokenCount(data.totalTokens) : '0'
  })

  const formattedCost = createMemo(() => {
    const data = usageData()
    return data ? props.sessionUsage.formatCost(data.totalCost) : '$0'
  })

  // Computed values
  const isAnomalousReviewTask = createMemo(() =>
    props.task.status === 'review' &&
    !props.task.awaitingPlanApproval &&
    props.task.executionStrategy !== 'best_of_n'
  )

  const isOrphanExecutingTask = createMemo(() => 
    !props.isLocked && props.task.status === 'executing'
  )

  const hasPlanOutput = createMemo(() => 
    props.task.executionPhase === 'plan_complete_waiting_approval'
  )

  const canSendToExecution = createMemo(() =>
    props.task.planmode === true &&
    hasPlanOutput() &&
    props.task.executionPhase !== 'implementation_done' &&
    (props.task.status === 'review' || props.task.status === 'executing' || props.task.status === 'failed' || props.task.status === 'stuck')
  )

  const canRepairToDone = createMemo(() =>
    props.task.status !== 'done' &&
    props.task.executionStrategy !== 'best_of_n' &&
    props.task.awaitingPlanApproval !== true &&
    (props.task.errorMessage !== null || props.task.reviewCount > 0)
  )

  const actionVisibility = createMemo(() =>
    getTaskCardActionVisibility({
      task: props.task,
      isLocked: props.isLocked,
      isAnomalousReviewTask: isAnomalousReviewTask(),
    })
  )

  const showInlineActionBar = createMemo(() => actionVisibility().showInlineActionBar)

  const effectiveMaxReviews = createMemo(() => 
    props.task.maxReviewRunsOverride ?? props.options?.maxReviews ?? 2
  )
  
  const effectiveMaxJsonParseRetries = createMemo(() => 
    props.options?.maxJsonParseRetries ?? 5
  )
  
  const isNearReviewLimit = createMemo(() => props.task.reviewCount >= effectiveMaxReviews() - 1)
  const isAtReviewLimit = createMemo(() => props.task.reviewCount >= effectiveMaxReviews())
  const hasJsonParseRetries = createMemo(() => props.task.jsonParseRetryCount > 0 && props.task.status === 'review')
  const isNearJsonParseLimit = createMemo(() => props.task.jsonParseRetryCount >= effectiveMaxJsonParseRetries() - 1)

  // Dependency IDs
  const depIds = createMemo(() => {
    return (props.task.requirements || [])
      .map(id => props.tasks.find(t => t.id === id))
      .filter((dep): dep is Task => dep !== undefined && typeof dep.idx === 'number')
      .map(dep => `#${dep.idx + 1}`)
  })

  const hasNonDefaultThinkingLevel = createMemo(() =>
    props.task.thinkingLevel !== 'default' ||
    props.task.planThinkingLevel !== 'default' ||
    props.task.executionThinkingLevel !== 'default'
  )

  const thinkingLevelSummary = createMemo(() => {
    const levels: string[] = []
    if (props.task.thinkingLevel !== 'default') levels.push(props.task.thinkingLevel)
    if (props.task.planThinkingLevel !== 'default') levels.push(`plan:${props.task.planThinkingLevel}`)
    if (props.task.executionThinkingLevel !== 'default') levels.push(`exec:${props.task.executionThinkingLevel}`)
    return levels.join(', ') || 'default'
  })

  const thinkingLevelTooltip = createMemo(() => {
    const parts: string[] = []
    parts.push(`Global: ${props.task.thinkingLevel}`)
    parts.push(`Plan: ${props.task.planThinkingLevel}`)
    parts.push(`Execution: ${props.task.executionThinkingLevel}`)
    return parts.join('\n')
  })

  // Status color for the task indicator
  const statusColor = createMemo(() => {
    switch (props.task.status) {
      case 'stuck':
      case 'failed':
        return 'high'
      case 'review':
        return 'medium'
      default:
        return 'low'
    }
  })

  const handleDragStart = (e: DragEvent) => {
    if (!props.canDrag) return

    const context = props.group ? 'group' : 'column'

    props.dragDrop.handleDragStart(props.task.id, props.task.status, context)
    setIsDragging(true)
    ;(e.currentTarget as HTMLDivElement).classList.add('dragging')

    // Set data transfer with context for external handling
    e.dataTransfer!.effectAllowed = 'move'
    e.dataTransfer!.setData('text/plain', props.task.id)
    e.dataTransfer!.setData('application/json', JSON.stringify({
      taskId: props.task.id,
      source: {
        source: context,
        ...(props.group ? { groupId: props.group.id } : { status: props.task.status }),
      },
    }))
  }

  const handleDragEnd = (e: DragEvent) => {
    props.dragDrop.handleDragEnd()
    setIsDragging(false)
    ;(e.currentTarget as HTMLDivElement).classList.remove('dragging')
  }

  const getStatusIcon = () => {
    switch (props.task.status) {
      case 'executing':
        return (
          <svg class="task-icon animate-spin text-accent-success" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10" stroke-dasharray="60" stroke-dashoffset="20" />
          </svg>
        )
      case 'template':
        return (
          <svg class="task-icon text-column-template" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
          </svg>
        )
      case 'backlog':
        return (
          <svg class="task-icon text-column-backlog" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>
          </svg>
        )
      case 'review':
        return (
          <svg class="task-icon text-column-review" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
            <path d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/>
          </svg>
        )
      case 'done':
        return (
          <svg class="task-icon text-column-done" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
          </svg>
        )
      case 'stuck':
      case 'failed':
        return (
          <svg class="task-icon text-accent-danger" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <path d="M12 8v4M12 16h.01"/>
          </svg>
        )
      default:
        return null
    }
  }

  return (
    <div
      ref={cardRef}
      class="task-card"
      classList={{
        'dragging': isDragging(),
        'selected': Boolean(props.isSelected),
        'highlighted': props.isHighlighted,
      }}
      data-task-id={props.task.id}
      data-task-status={props.task.status}
      data-run-color={props.runColor || undefined}
      draggable={props.canDrag && !props.isMultiSelecting}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onClick={(e) => props.onOpen(e)}
    >
      {/* Header */}
      <div class="task-header">
        {/* Task ID badge */}
        <span class="task-id-badge">#{props.task.idx + 1}</span>

        {getStatusIcon()}

        <span
          class={`task-title ${hasLocalSession() ? 'cursor-pointer hover:text-accent-primary' : ''}`}
          title={props.task.name}
          onClick={(e) => {
            if (hasLocalSession()) {
              e.stopPropagation()
              props.onOpenTaskSessions()
            }
          }}
        >
          {props.task.name}
        </span>
      </div>

      {/* Tags */}
      <div class="task-tags mb-2">
        <Show when={props.task.planmode}>
          <span class="task-tag border-accent-secondary/30 text-accent-secondary">
            plan
          </span>
        </Show>

        <Show when={props.task.status === 'review' && props.task.awaitingPlanApproval}>
          <span class="task-tag border-accent-warning/30 text-accent-warning">
            plan approval
          </span>
        </Show>

        <Show when={props.task.review}>
          <span class={`task-tag ${
            (props.task.status === 'stuck' || isAtReviewLimit()) ? 'border-accent-danger/30 text-accent-danger' :
            isNearReviewLimit() ? 'border-accent-warning/30 text-accent-warning' :
            'border-accent-warning/30 text-accent-warning'
          }`}>
            review {props.task.reviewCount}/{effectiveMaxReviews()}
          </span>
        </Show>

        <Show when={hasJsonParseRetries()}>
          <span
            class={`task-tag ${isNearJsonParseLimit() ? 'border-accent-danger/30 text-accent-danger' : 'border-accent-warning/30 text-accent-warning'}`}
            title={`JSON parse failures: ${props.task.jsonParseRetryCount}/${effectiveMaxJsonParseRetries()}`}
          >
            json retry {props.task.jsonParseRetryCount}/{effectiveMaxJsonParseRetries()}
          </span>
        </Show>

        <Show when={props.task.executionStrategy === 'best_of_n'}>
          <span class="task-tag border-accent-info/30 text-accent-info">
            best-of-n
          </span>
        </Show>

        <Show when={depIds().length > 0}>
          <span class="task-tag">
            deps: {depIds().join(', ')}
          </span>
        </Show>

        <Show when={hasNonDefaultThinkingLevel()}>
          <span class="task-tag" title={thinkingLevelTooltip()}>
            {thinkingLevelSummary()}
          </span>
        </Show>

        <Show when={props.task.branch}>
          <span class="task-tag">
            {props.task.branch}
          </span>
        </Show>

        <Show when={props.task.containerImage}>
          <span
            class="task-tag border-accent-info/30 text-accent-info"
            title={`Container Image: ${props.task.containerImage}`}
          >
            🐳 {props.task.containerImage}
          </span>
        </Show>

        <Show when={props.task.errorMessage}>
          <span class="task-tag border-accent-danger/30 text-accent-danger">
            error
          </span>
        </Show>

        <Show when={props.task.selfHealStatus !== 'idle'}>
          <span
            class={`task-tag ${props.task.selfHealStatus === 'investigating'
              ? 'border-accent-info/30 text-accent-info animate-pulse'
              : 'border-accent-warning/30 text-accent-warning'}`}
            title={props.task.selfHealMessage || 'Self-healing in progress'}
          >
            self-healing: {props.task.selfHealStatus}
          </span>
        </Show>

        <Show when={props.group && props.showGroupIndicator}>
          <span
            class="task-tag flex items-center gap-1"
            data-group-tag-color={props.group!.color}
            title={`Member of group: ${props.group!.name}`}
          >
            <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
            </svg>
            {props.group!.name}
          </span>
        </Show>
      </div>

      {/* Actions */}
      <div class="task-footer">
        <div class="flex items-center gap-1">
          {/* Edit button */}
          <button
            class="p-1 rounded hover:bg-dark-surface2 text-dark-text-secondary hover:text-dark-text transition-colors"
            title={props.task.status === 'template' ? 'Edit Template' : 'Edit Task'}
            onClick={(e) => { e.stopPropagation(); props.onOpen(); }}
          >
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
            </svg>
          </button>

          {/* Deploy button (template only) */}
          <Show when={props.task.status === 'template'}>
            <button
              class="p-1 rounded hover:bg-dark-surface2 text-dark-text-secondary hover:text-accent-primary transition-colors"
              title="Deploy to Backlog (Ctrl+click for instant, Ctrl+Shift+click to delete after)"
              onClick={(e) => { e.stopPropagation(); props.onDeploy(e); }}
            >
              <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M5 10l7-7m0 0l7 7m-7-7v18"/>
              </svg>
            </button>
          </Show>

          {/* Reset button */}
          <Show when={actionVisibility().showResetButton}>
            <button
              class="p-1 rounded hover:bg-dark-surface2 text-dark-text-secondary hover:text-accent-warning transition-colors"
              title="Reset to Backlog"
              onClick={(e) => { e.stopPropagation(); props.onReset(); }}
            >
              <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
              </svg>
            </button>
          </Show>

          {/* Archive/Delete button */}
          <Show when={!showInlineActionBar() && (((!props.isLocked && props.task.status !== 'executing')) || props.task.status === 'done')}>
            <button
              class="p-1 rounded hover:bg-dark-surface2 text-dark-text-secondary hover:text-accent-danger transition-colors"
              title={props.task.status === 'backlog' ? 'Delete Task (Ctrl+click to skip confirmation)' : 'Archive Task (Ctrl+click to skip confirmation)'}
              onClick={(e) => { e.stopPropagation(); props.onArchive(e); }}
            >
              <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
              </svg>
            </button>
          </Show>

          {/* Mark Done button (for stuck or anomalous review tasks) */}
          <Show when={actionVisibility().showMarkDoneIcon}>
            <button
              class="p-1 rounded hover:bg-dark-surface2 text-dark-text-secondary hover:text-accent-success transition-colors"
              title="Mark as Done"
              onClick={(e) => { e.stopPropagation(); props.onMarkDone(); }}
            >
              <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M5 13l4 4L19 7"/>
              </svg>
            </button>
          </Show>

          {/* Start Single button (backlog only) */}
          <Show when={props.task.status === 'backlog' && !props.isLocked}>
            <button
              class="p-1 rounded hover:bg-dark-surface2 text-dark-text-secondary hover:text-accent-success transition-colors"
              title="Start this task"
              onClick={(e) => { e.stopPropagation(); props.onStartSingle(); }}
            >
              <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/>
                <path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
              </svg>
            </button>
          </Show>

          {/* Convert to Template button (backlog only) */}
          <Show when={props.task.status === 'backlog' && !props.isLocked}>
            <button
              class="p-1 rounded hover:bg-dark-surface2 text-dark-text-secondary hover:text-accent-primary transition-colors"
              title="Convert to Template (Ctrl+click to skip confirmation)"
              onClick={(e) => { e.stopPropagation(); props.onConvertToTemplate(e); }}
            >
              <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
              </svg>
            </button>
          </Show>
        </div>

        {/* Status Indicator */}
        <div class={`task-indicator ${statusColor()}`} />
      </div>

      {/* Inline Action Bar */}
      <Show when={showInlineActionBar()}>
        <div class="flex flex-wrap gap-1.5 mt-2 pt-2 border-t border-dark-border">
          <Show when={props.task.status === 'review' && props.task.awaitingPlanApproval && props.task.executionPhase === 'plan_complete_waiting_approval' && hasPlanOutput()}>
            <>
              <button class="btn btn-primary btn-xs" onClick={(e) => { e.stopPropagation(); props.onApprovePlan(); }}>
                Approve Plan
              </button>
              <button class="btn btn-xs border-accent-warning/50 text-accent-warning" onClick={(e) => { e.stopPropagation(); props.onRequestRevision(); }}>
                Request Changes
              </button>
            </>
          </Show>

          <Show when={actionVisibility().showInlineMarkDoneButton}>
            <button class="btn btn-primary btn-xs" onClick={(e) => { e.stopPropagation(); props.onMarkDone(); }}>
              Mark Done
            </button>
          </Show>

          <Show when={canSendToExecution()}>
            <button class="btn btn-primary btn-xs" onClick={(e) => { e.stopPropagation(); props.onRepair('queue_implementation'); }}>
              Send to Execution
            </button>
          </Show>

          <Show when={canRepairToDone() && props.task.status !== 'stuck'}>
            <button class="btn btn-xs" onClick={(e) => { e.stopPropagation(); props.onRepair('mark_done'); }}>
              Repair Done
            </button>
          </Show>

          <button class="btn btn-xs" onClick={(e) => { e.stopPropagation(); props.onRepair('smart'); }}>
            Smart Repair
          </button>

          <Show when={props.task.status === 'stuck'}>
            <button class="btn btn-primary btn-xs" onClick={(e) => { e.stopPropagation(); props.onContinueReviews(); }}>
              Continue Reviews
            </button>
          </Show>
        </div>
      </Show>

      {/* View Runs button for best-of-n */}
      <Show when={props.task.executionStrategy === 'best_of_n' && props.task.status !== 'template' && props.task.status !== 'backlog'}>
        <button class="btn btn-xs mt-2" onClick={(e) => { e.stopPropagation(); props.onViewRuns(); }}>
          View Runs
        </button>
      </Show>

      {/* Cost and tokens badge - ALWAYS shown for non-backlog tasks */}
      <Show when={shouldShowBadges()}>
        <div class="flex items-center gap-2 mt-1 text-xs">
          <span
            class="px-2 py-0.5 bg-dark-surface2 border border-dark-border rounded-full text-dark-text-secondary flex items-center gap-1"
            title={`${formattedTokens()} tokens across all sessions`}
          >
            💰 {formattedCost()}
          </span>
          <span
            class="px-2 py-0.5 bg-dark-surface2 border border-dark-border rounded-full text-dark-text-muted"
            title="Total tokens across all sessions"
          >
            🪙 {formattedTokens()}
          </span>
        </div>
      </Show>

      {/* Last Update badge - ALWAYS shown for non-backlog tasks when available */}
      <Show when={lastUpdate() !== null && lastUpdateFormatted() && shouldShowBadges()}>
        <div class="flex items-center gap-2 mt-1 text-xs">
          <span
            class={`px-2 py-0.5 bg-dark-surface2 border border-dark-border rounded-full flex items-center gap-1 task-last-update-badge ${lastUpdateAgeClass()}`}
            title={`Last message received at ${formatLocalDateTime(lastUpdate()!)}`}
          >
            🕐 {lastUpdateFormatted()}
          </span>
        </div>
      </Show>

      {/* Completed date */}
      <Show when={props.task.completedAt}>
        <div class="text-xs text-dark-text-muted mt-1">
          Completed: {formatLocalDateTime(props.task.completedAt!)}
        </div>
      </Show>

      {/* Warnings */}
      <Show when={props.task.status === 'review' && props.task.awaitingPlanApproval && props.task.executionPhase === 'plan_complete_waiting_approval' && !hasPlanOutput()}>
        <div class="text-xs text-accent-danger mt-2">
          Plan approval is unavailable - no [plan] block exists
        </div>
      </Show>

      <Show when={isOrphanExecutingTask()}>
        <div class="text-xs text-accent-danger mt-2">
          Session may have dropped - click title to verify
        </div>
      </Show>
    </div>
  )
}
