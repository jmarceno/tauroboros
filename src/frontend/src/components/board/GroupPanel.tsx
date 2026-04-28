/**
 * GroupPanel Component - Slide-out group panel with full feature parity
 * Ported from React to SolidJS - Line-by-line comparison maintained
 */

import { For, Show, createMemo, createSignal, createEffect, onMount, onCleanup } from 'solid-js'
import type { TaskGroup, Task, BestOfNSummary } from '@/types'
import { TaskCard } from './TaskCard'
import type { createDragDropStore } from '@/stores'
import type { createSessionUsageStore } from '@/stores/sessionUsageStore'
import type { createTaskLastUpdateStore } from '@/stores/taskLastUpdateStore'
import type { Options } from '@/types'

interface GroupPanelProps {
  group: TaskGroup
  tasks: Task[]
  bonSummaries: Record<string, BestOfNSummary>
  getTaskRunColor: (taskId: string) => string | null
  isTaskMutationLocked: (taskId: string) => boolean
  isOpen: boolean
  onClose: () => void
  onStartGroup: () => void
  onOpenTask: (id: string, e?: MouseEvent) => void
  onDeployTemplate: (id: string, e: MouseEvent) => void
  onOpenTaskSessions: (id: string) => void
  onApprovePlan: (id: string) => void
  onRequestRevision: (id: string) => void
  onStartSingle: (id: string) => void
  onRepairTask: (id: string, action: string) => void
  onMarkDone: (id: string) => void
  onResetTask: (id: string) => void
  onConvertToTemplate: (id: string, event?: MouseEvent) => void
  onArchiveTask: (id: string, event?: MouseEvent) => void
  onViewRuns: (id: string) => void
  onContinueReviews: (id: string) => void
  onDeleteGroup: () => void
  onRenameGroup?: (groupId: string, newName: string) => Promise<void>
  dragDrop: ReturnType<typeof createDragDropStore>
  sessionUsage: ReturnType<typeof createSessionUsageStore>
  taskLastUpdate: ReturnType<typeof createTaskLastUpdateStore>
  isMultiSelecting?: boolean
  getIsSelected?: (taskId: string) => boolean
  allTasks: Task[]
  options?: Options | null
}

/**
 * Focus trap primitive for SolidJS
 * Traps focus within a container when active, cycles with Tab key
 */
function createFocusTrap(
  containerRef: () => HTMLElement | undefined,
  isActive: () => boolean,
  onEscape?: () => void
) {
  let previousFocus: HTMLElement | null = null

  createEffect(() => {
    if (!isActive()) return

    const container = containerRef()
    if (!container) return

    // Store current focus element
    previousFocus = document.activeElement as HTMLElement

    // Find focusable elements
    const focusableSelectors = [
      'button:not([disabled])',
      '[href]',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])',
    ].join(', ')

    const focusableElements = Array.from(
      container.querySelectorAll<HTMLElement>(focusableSelectors)
    ).filter(el => !el.hasAttribute('disabled') && el.offsetParent !== null)

    if (focusableElements.length === 0) return

    const firstElement = focusableElements[0]
    const lastElement = focusableElements[focusableElements.length - 1]

    // Focus first element
    firstElement.focus()

    // Handle tab key to cycle focus within container
    const handleTabKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return

      if (e.shiftKey) {
        // Shift+Tab: go to previous element
        if (document.activeElement === firstElement) {
          e.preventDefault()
          lastElement.focus()
        }
      } else {
        // Tab: go to next element
        if (document.activeElement === lastElement) {
          e.preventDefault()
          firstElement.focus()
        }
      }
    }

    // Handle Escape key
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isActive()) {
        e.preventDefault()
        onEscape?.()
      }
    }

    container.addEventListener('keydown', handleTabKey)
    document.addEventListener('keydown', handleEscape)

    onCleanup(() => {
      container.removeEventListener('keydown', handleTabKey)
      document.removeEventListener('keydown', handleEscape)

      // Restore focus to previous element
      if (previousFocus && document.contains(previousFocus)) {
        previousFocus.focus()
      }
    })
  })
}

export function GroupPanel(props: GroupPanelProps) {
  // Use default color if group color is missing
  const groupColor = () => props.group.color || '#6366f1'

  // Refs
  let containerRef: HTMLDivElement | undefined
  let closeButtonRef: HTMLButtonElement | undefined
  let editInputRef: HTMLInputElement | undefined

  // State signals
  const [isExiting, setIsExiting] = createSignal(false)
  const [isEditingName, setIsEditingName] = createSignal(false)
  const [editNameValue, setEditNameValue] = createSignal('')
  const [isRenaming, setIsRenaming] = createSignal(false)
  const [renameError, setRenameError] = createSignal<string | null>(null)

  // Computed values
  const taskCount = createMemo(() => props.tasks.length)
  const taskWord = createMemo(() => taskCount() === 1 ? 'task' : 'tasks')
  
  // Check if drag is over this group
  const isDragOver = createMemo(() => {
    const target = props.dragDrop.dragOverTarget()
    return target === `group:${props.group.id}`
  })

  // Focus trap when panel is open
  createFocusTrap(
    () => containerRef,
    () => props.isOpen && !isExiting(),
    () => handleClose()
  )

  // Close handler with exit animation
  const handleClose = () => {
    setIsExiting(true)
  }

  // Handle animation end
  const handleAnimationEnd = () => {
    if (isExiting()) {
      setIsExiting(false)
      props.onClose()
    }
  }

  // Drag handlers - matching React implementation
  const handleDragOver = (e: DragEvent) => {
    e.preventDefault()
    props.dragDrop.handleDragOver(`group:${props.group.id}`)
  }

  const handleDragLeave = (e: DragEvent) => {
    const relatedTarget = e.relatedTarget as Node | null
    if (!relatedTarget) {
      props.dragDrop.handleDragLeave()
      return
    }
    const currentTarget = e.currentTarget as Node
    if (!currentTarget.contains(relatedTarget)) {
      props.dragDrop.handleDragLeave()
    }
  }

  const handleDrop = (e: DragEvent) => {
    e.preventDefault()
    props.dragDrop.handleDrop(`group:${props.group.id}`, 'add-to-group')
  }

  // Start group handler
  const handleStartClick = () => {
    props.onStartGroup()
  }

  // Delete handler
  const handleDeleteClick = (e: MouseEvent) => {
    e.stopPropagation()
    props.onDeleteGroup()
  }

  // Group name edit handlers
  const handleEditNameClick = (e: MouseEvent) => {
    e.stopPropagation()
    setIsEditingName(true)
    setEditNameValue(props.group.name)
    setRenameError(null)
    // Focus input after render
    setTimeout(() => editInputRef?.focus(), 0)
  }

  const handleCancelEdit = () => {
    setIsEditingName(false)
    setEditNameValue('')
    setRenameError(null)
  }

  const handleSaveName = async () => {
    const trimmedName = editNameValue().trim()
    
    // Validation: non-empty
    if (!trimmedName) {
      setRenameError('Name cannot be empty')
      editInputRef?.focus()
      return
    }
    
    // Validation: max 100 characters
    if (trimmedName.length > 100) {
      setRenameError('Name must be 100 characters or less')
      editInputRef?.focus()
      return
    }
    
    // No change needed
    if (trimmedName === props.group.name) {
      setIsEditingName(false)
      setEditNameValue('')
      return
    }
    
    if (!props.onRenameGroup) {
      setIsEditingName(false)
      setEditNameValue('')
      return
    }
    
    setIsRenaming(true)
    setRenameError(null)
    
    try {
      await props.onRenameGroup(props.group.id, trimmedName)
      setIsEditingName(false)
      setEditNameValue('')
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setRenameError(message || 'Failed to rename group')
    } finally {
      setIsRenaming(false)
    }
  }

  const handleEditKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSaveName()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      handleCancelEdit()
    }
  }

  const handleEditBlur = () => {
    // Allow click events on buttons to fire before handling blur
    setTimeout(() => {
      if (isEditingName() && !isRenaming()) {
        handleCancelEdit()
      }
    }, 150)
  }

  // Don't render if not open and not exiting
  if (!props.isOpen && !isExiting()) {
    return null
  }

  return (
    <>
      {/* Floating Group Panel - positioned beside Backlog column */}
      <div
        ref={containerRef}
        class={`group-panel ${isExiting() ? 'group-panel-exit' : 'group-panel-enter'}`}
        data-group-color={groupColor()}
        style={{ '--group-color': `${groupColor()}66` }}
        role="complementary"
        aria-label={`Group panel: ${props.group.name}`}
        aria-expanded={props.isOpen}
        onAnimationEnd={handleAnimationEnd}
      >
        {/* Header */}
        <div class="flex items-center justify-between p-3 bg-dark-surface2 border-b border-dark-border flex-shrink-0">
          <div class="flex items-center gap-3 min-w-0">
            {/* Color indicator */}
            <div
              class="group-color-indicator"
              data-indicator-color={groupColor()}
              aria-hidden="true"
            />
            {/* Group name and count */}
            <div class="min-w-0 flex-1">
              <Show
                when={isEditingName()}
                fallback={
                  <>
                    <h3
                      class="text-sm font-semibold text-dark-text truncate"
                      title={props.group.name}
                    >
                      {props.group.name}
                    </h3>
                    <span class="text-xs text-dark-text-secondary">
                      {taskCount()} {taskWord()}
                    </span>
                  </>
                }
              >
                <div class="flex flex-col gap-1">
                  <input
                    ref={editInputRef}
                    type="text"
                    class={`w-full px-2 py-1 text-sm font-semibold bg-dark-surface3 border rounded text-dark-text truncate focus:outline-none focus:ring-1 ${renameError() ? 'border-accent-danger' : 'border-dark-border focus:border-accent-primary focus:ring-accent-primary'}`}
                    value={editNameValue()}
                    onInput={(e) => {
                      setEditNameValue(e.currentTarget.value)
                      if (renameError()) setRenameError(null)
                    }}
                    onKeyDown={handleEditKeyDown}
                    onBlur={handleEditBlur}
                    disabled={isRenaming()}
                    maxLength={100}
                    aria-label="Edit group name"
                  />
                  <Show when={renameError()}>
                    <span class="text-xs text-accent-danger" role="alert">
                      {renameError()}
                    </span>
                  </Show>
                </div>
              </Show>
            </div>
          </div>
          <div class="flex items-center gap-1 flex-shrink-0">
            {/* Rename group button */}
            <Show when={!isEditingName() && props.onRenameGroup}>
              <button
                class="w-7 h-7 flex items-center justify-center rounded hover:bg-dark-surface3 text-dark-text-secondary hover:text-accent-primary transition-colors"
                title="Rename group"
                onClick={handleEditNameClick}
                aria-label="Rename group"
                disabled={isRenaming()}
              >
                <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                  <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                </svg>
              </button>
            </Show>
            {/* Delete group button */}
            <button
              class="w-7 h-7 flex items-center justify-center rounded hover:bg-dark-surface3 text-dark-text-secondary hover:text-accent-danger transition-colors"
              title="Delete group"
              onClick={handleDeleteClick}
              aria-label="Delete group"
            >
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
            {/* Close button */}
            <button
              ref={closeButtonRef}
              class="w-7 h-7 flex items-center justify-center rounded hover:bg-dark-surface3 text-dark-text-secondary hover:text-dark-text transition-colors"
              onClick={handleClose}
              aria-label="Close group panel (Escape)"
            >
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Drag-drop zone */}
        <div
          class={`group-drop-zone ${isDragOver() ? 'drag-over bg-accent-primary/10' : ''}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          role="region"
          aria-label={`Drop zone for ${props.group.name}`}
        >
          <div
            class={`border-2 border-dashed rounded-lg p-3 text-center transition-colors duration-200 ${
              isDragOver()
                ? 'border-accent-primary'
                : 'border-dark-border'
            }`}
          >
            <svg
              class={`w-5 h-5 mx-auto mb-1 transition-colors duration-200 ${
                isDragOver() ? 'text-accent-primary' : 'text-dark-text-muted'
              }`}
              viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            >
              <path d="M19 14l-7 7m0 0l-7-7m7 7V3" />
            </svg>
            <span
              class={`text-xs transition-colors duration-200 ${
                isDragOver() ? 'text-accent-primary' : 'text-dark-text-muted'
              }`}
            >
              {isDragOver() ? 'Drop to add' : 'Drag tasks here to add'}
            </span>
          </div>
        </div>

        {/* Task list - using TaskCard directly */}
        <div
          class="flex-1 overflow-y-auto p-3 space-y-2"
          role="list"
          aria-label={`Tasks in ${props.group.name}`}
        >
          <Show
            when={props.tasks.length > 0}
            fallback={
              /* Empty state */
              <div class="group-empty-state">
                <svg
                  class="group-empty-icon"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                  aria-hidden="true"
                >
                  <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                  <path d="M12 12v4m0-4l-2 2m2-2l2 2" />
                </svg>
                <p class="text-sm text-dark-text-muted">No tasks in this group</p>
                <p class="group-hint-text">
                  Drag tasks from the board or use Ctrl+G with 2+ selected tasks to add them
                </p>
              </div>
            }
          >
            {/* Task cards - using TaskCard component directly */}
            <For each={props.tasks}>
              {(task) => (
                <TaskCard
                  task={task}
                  bonSummary={props.bonSummaries[task.id]}
                  runColor={props.getTaskRunColor(task.id)}
                  isLocked={props.isTaskMutationLocked(task.id)}
                  canDrag={!props.isTaskMutationLocked(task.id)}
                  dragDrop={props.dragDrop}
                  sessionUsage={props.sessionUsage}
                  taskLastUpdate={props.taskLastUpdate}
                  tasks={props.allTasks}
                  options={props.options ?? undefined}
                  isSelected={props.getIsSelected?.(task.id)}
                  isMultiSelecting={props.isMultiSelecting}
                  isHighlighted={false}
                  group={{ id: props.group.id, name: props.group.name, color: groupColor() }}
                  showGroupIndicator={true}
                  onOpen={(e) => props.onOpenTask(task.id, e)}
                  onDeploy={(e) => props.onDeployTemplate(task.id, e)}
                  onOpenTaskSessions={() => props.onOpenTaskSessions(task.id)}
                  onApprovePlan={() => props.onApprovePlan(task.id)}
                  onRequestRevision={() => props.onRequestRevision(task.id)}
                  onStartSingle={() => props.onStartSingle(task.id)}
                  onRepair={(action) => props.onRepairTask(task.id, action)}
                  onMarkDone={() => props.onMarkDone(task.id)}
                  onReset={() => props.onResetTask(task.id)}
                  onConvertToTemplate={(e) => props.onConvertToTemplate(task.id, e)}
                  onArchive={(e) => props.onArchiveTask(task.id, e)}
                  onViewRuns={() => props.onViewRuns(task.id)}
                  onContinueReviews={() => props.onContinueReviews(task.id)}
                />
              )}
            </For>
          </Show>
        </div>

        {/* Footer */}
        <div class="flex-shrink-0 p-3 bg-dark-surface2 border-t border-dark-border">
          <button
            class="btn btn-primary w-full flex items-center justify-center gap-2"
            disabled={props.tasks.length === 0}
            onClick={handleStartClick}
            aria-label={props.tasks.length === 0 ? 'Start group workflow (no tasks available)' : 'Start group workflow'}
          >
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
              <path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Start Group Workflow
          </button>
        </div>
      </div>
    </>
  )
}
