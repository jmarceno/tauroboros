/**
 * ArchivedTasksTab Component - Archived tasks view
 * Ported from React to SolidJS
 */

import { createSignal, createMemo, onMount, For, Show } from 'solid-js'
import { tasksApi, runApiEffect } from '@/api'
import type { Task, WorkflowRun } from '@/types'
import { formatLocalDateTime } from '@/utils/date'

type ArchivedTask = Omit<Task, 'sessionId' | 'completedAt'> & {
  sessionId: string | null
  completedAt: number | null
}

type StatusColorKey = Task['status'] | WorkflowRun['status']

const STATUS_COLORS: Record<StatusColorKey, string> = {
  // Task statuses
  done: 'text-green-400 bg-green-500/10',
  failed: 'text-red-400 bg-red-500/10',
  stuck: 'text-orange-400 bg-orange-500/10',
  template: 'text-blue-400 bg-blue-500/10',
  backlog: 'text-gray-400 bg-gray-500/10',
  executing: 'text-yellow-400 bg-yellow-500/10',
  review: 'text-purple-400 bg-purple-500/10',
  'code-style': 'text-pink-400 bg-pink-500/10',
  // Workflow run statuses
  running: 'text-yellow-400 bg-yellow-500/10',
  stopping: 'text-orange-400 bg-orange-500/10',
  paused: 'text-blue-400 bg-blue-500/10',
  completed: 'text-green-400 bg-green-500/10',
}

interface ArchivedRun {
  run: WorkflowRun
  tasks: ArchivedTask[]
  taskCount: number
  expanded: boolean
}

interface ArchivedTasksTabProps {
  onOpenTaskSessions: (task: ArchivedTask) => void
}

export function ArchivedTasksTab(props: ArchivedTasksTabProps) {
  const [archivedRuns, setArchivedRuns] = createSignal<ArchivedRun[]>([])
  const [isLoading, setIsLoading] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)
  const [searchQuery, setSearchQuery] = createSignal('')
  const [selectedTask, setSelectedTask] = createSignal<ArchivedTask | null>(null)

  const loadArchivedTasks = async () => {
    setIsLoading(true)
    setError(null)
    try {
      const data = await runApiEffect(tasksApi.getArchived())

      if (!data || !Array.isArray(data.runs)) {
        setError('Invalid response: runs must be an array')
        return
      }

      const runs: ArchivedRun[] = data.runs
        .map((runData: { run: WorkflowRun; tasks: ArchivedTask[] }) => {
          if (!runData.run || !Array.isArray(runData.tasks)) {
            // Skip invalid run data
            return null
          }
          return {
            run: runData.run,
            tasks: runData.tasks
              .map((task): ArchivedTask | null => {
                if (!task.id || !task.name) {
                  // Skip invalid task data
                  return null
                }
                return {
                  ...task,
                  sessionId: task.sessionId ?? null,
                  completedAt: task.completedAt ?? null,
                }
              })
              .filter((t): t is ArchivedTask => t !== null),
            taskCount: runData.tasks.length,
            expanded: false,
          }
        })
        .filter((r): r is ArchivedRun => r !== null)

      setArchivedRuns(runs)
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : 'Failed to load archived tasks'
      setError(errorMessage)
    } finally {
      setIsLoading(false)
    }
  }

  onMount(() => {
    loadArchivedTasks()
  })

  const toggleRunExpanded = (runId: string) => {
    setArchivedRuns(prev => prev.map(run =>
      run.run.id === runId ? { ...run, expanded: !run.expanded } : run
    ))
  }

  const expandAll = () => {
    setArchivedRuns(prev => prev.map(run => ({ ...run, expanded: true })))
  }

  const collapseAll = () => {
    setArchivedRuns(prev => prev.map(run => ({ ...run, expanded: false })))
  }

  const filteredRuns = createMemo(() => {
    if (!searchQuery().trim()) return archivedRuns()

    const query = searchQuery().toLowerCase()
    return archivedRuns().map(run => ({
      ...run,
      tasks: run.tasks.filter(task =>
        task.name.toLowerCase().includes(query) ||
        task.id.toLowerCase().includes(query) ||
        task.prompt.toLowerCase().includes(query)
      ),
    })).filter(run => run.tasks.length > 0)
  })

  const totalArchivedTasks = createMemo(() =>
    archivedRuns().reduce((sum, run) => sum + run.tasks.length, 0)
  )

  const openTaskDetail = (task: ArchivedTask) => {
    setSelectedTask(task)
  }

  const closeTaskDetail = () => {
    setSelectedTask(null)
  }

  const getStatusColor = (status: string): string => {
    if (status in STATUS_COLORS) {
      return STATUS_COLORS[status as StatusColorKey]
    }
    return 'text-gray-400 bg-gray-500/10'
  }

  return (
    <Show when={!isLoading()} fallback={
      <div class="flex-1 flex items-center justify-center p-8">
        <div class="flex items-center gap-3 text-dark-text-muted">
          <svg class="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          Loading archived tasks...
        </div>
      </div>
    }>
    <Show when={!error()} fallback={
      <div class="flex-1 flex items-center justify-center p-8">
        <div class="text-center">
          <div class="text-red-400 mb-2">
            <svg class="w-12 h-12 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h3 class="text-lg font-medium text-dark-text mb-2">Failed to Load Archived Tasks</h3>
          <p class="text-dark-text-muted mb-4">{error()}</p>
          <button class="btn btn-primary" onClick={loadArchivedTasks}>
            Retry
          </button>
        </div>
      </div>
    }>
    <div class="flex-1 overflow-y-auto p-6">
      <div class="max-w-5xl mx-auto space-y-6">
        {/* Header */}
        <div class="flex items-center justify-between pb-4 border-b border-dark-surface3">
          <div>
            <h2 class="text-xl font-semibold text-dark-text flex items-center gap-2">
              <svg class="w-5 h-5 text-accent-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
              </svg>
              Archived Tasks
            </h2>
            <p class="text-sm text-dark-text-muted mt-1">
              {totalArchivedTasks()} archived tasks across {archivedRuns().length} workflow runs
            </p>
          </div>
          <div class="flex items-center gap-2">
            <button class="btn btn-sm" onClick={expandAll}>
              Expand All
            </button>
            <button class="btn btn-sm" onClick={collapseAll}>
              Collapse All
            </button>
            <button class="btn btn-primary btn-sm" onClick={loadArchivedTasks}>
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Refresh
            </button>
          </div>
        </div>

        {/* Search */}
        <div class="form-group">
          <div class="relative">
            <input
              type="text"
              class="form-input pl-10"
              placeholder="Search archived tasks by name, ID, or prompt..."
              value={searchQuery()}
              onChange={(e) => setSearchQuery(e.currentTarget.value)}
            />
            <svg
              class="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-dark-text-muted"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
        </div>

        {/* No Results */}
        <Show when={filteredRuns().length === 0}>
          <div class="text-center py-12">
            <svg class="w-16 h-16 mx-auto mb-4 text-dark-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
            </svg>
            <h3 class="text-lg font-medium text-dark-text mb-2">
              {searchQuery() ? 'No matching archived tasks' : 'No archived tasks'}
            </h3>
            <p class="text-dark-text-muted">
              {searchQuery()
                ? 'Try adjusting your search query'
                : 'Tasks that are archived will appear here grouped by workflow run'}
            </p>
          </div>
        </Show>

        {/* Archived Runs List */}
        <div class="space-y-3">
          <For each={filteredRuns()}>
            {(run) => (
              <div class="border border-dark-surface3 rounded-lg overflow-hidden">
                {/* Run Header */}
                <button
                  class="w-full flex items-center justify-between p-4 bg-dark-surface hover:bg-dark-surface2 transition-colors text-left"
                  onClick={() => toggleRunExpanded(run.run.id)}
                >
                  <div class="flex items-center gap-3">
                    <svg
                      class={`w-5 h-5 text-dark-text-muted transition-transform ${run.expanded ? 'rotate-90' : ''}`}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M9 5l7 7-7 7" />
                    </svg>
                    <div>
                      <div class="font-medium text-dark-text flex items-center gap-2">
                        {run.run.displayName || run.run.id.slice(0, 8)}
                        <span class={`text-xs px-2 py-0.5 rounded ${getStatusColor(run.run.status)}`}>
                          {run.run.status}
                        </span>
                      </div>
                      <div class="text-xs text-dark-text-muted mt-1">
                        {formatLocalDateTime(run.run.createdAt)} • {run.taskCount} task{run.taskCount === 1 ? '' : 's'}
                      </div>
                    </div>
                  </div>
                  <div class="flex items-center gap-2">
                    <span class="text-sm text-dark-text-muted">
                      {run.tasks.length} archived
                    </span>
                  </div>
                </button>

                {/* Tasks List */}
                <Show when={run.expanded}>
                  <div class="border-t border-dark-surface3">
                    <Show
                      when={run.tasks.length > 0}
                      fallback={
                        <div class="p-4 text-sm text-dark-text-muted text-center">
                          No archived tasks in this run
                        </div>
                      }
                    >
                      <div class="divide-y divide-dark-surface3">
                        <For each={run.tasks}>
                          {(task) => (
                            <div class="p-4 hover:bg-dark-surface/50 transition-colors">
                              <div class="flex items-start justify-between gap-4">
                                <div class="flex-1 min-w-0">
                                  <div class="flex items-center gap-2 mb-1">
                                    <span class="text-xs text-dark-text-muted">#{task.id}</span>
                                    <span class={`text-xs px-2 py-0.5 rounded ${getStatusColor(task.status)}`}>
                                      {task.status}
                                    </span>
                                    <Show when={task.reviewCount > 0}>
                                      <span class="text-xs px-2 py-0.5 rounded text-purple-400 bg-purple-500/10 flex items-center gap-1">
                                        <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                                        </svg>
                                        {task.reviewCount} {task.reviewCount === 1 ? 'review' : 'reviews'}
                                      </span>
                                    </Show>
                                    <Show when={task.sessionId}>
                                      <button
                                        class="text-xs text-accent-info hover:text-accent-primary flex items-center gap-1"
                                        onClick={() => props.onOpenTaskSessions(task)}
                                      >
                                        <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
                                        </svg>
                                        View Sessions
                                      </button>
                                    </Show>
                                  </div>
                                  <h4
                                    class={`font-medium text-dark-text truncate ${task.sessionId ? 'cursor-pointer hover:text-accent-primary' : ''}`}
                                    onClick={() => task.sessionId ? props.onOpenTaskSessions(task) : openTaskDetail(task)}
                                    title={task.sessionId ? 'Click to view all sessions' : 'Click to view task details'}
                                  >
                                    {task.name}
                                  </h4>
                                  <p class="text-sm text-dark-text-muted line-clamp-2 mt-1">
                                    {task.prompt}
                                  </p>
                                  <div class="flex items-center gap-4 mt-2 text-xs text-dark-text-muted">
                                    <Show when={task.completedAt}>
                                      <span>Completed: {formatLocalDateTime(task.completedAt!)}</span>
                                    </Show>
                                    <Show when={task.archivedAt}>
                                      <span>Archived: {formatLocalDateTime(task.archivedAt!)}</span>
                                    </Show>
                                  </div>
                                </div>
                              </div>
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                </Show>
              </div>
            )}
          </For>
        </div>
      </div>

      {/* Task Detail Modal */}
      <Show when={selectedTask()}>
        <div
          class="fixed inset-0 z-[1001] flex items-center justify-center bg-black/50 p-4"
          onClick={closeTaskDetail}
        >
          <div
            class="bg-dark-surface2 rounded-lg shadow-xl w-[min(600px,calc(100vw-40px))] max-h-[80vh] flex flex-col border border-dark-surface3"
            onClick={(e) => e.stopPropagation()}
          >
            <div class="flex items-center justify-between px-4 py-3 border-b border-dark-surface3">
              <div class="flex items-center gap-2">
                <span class="text-xs text-dark-text-muted">#{selectedTask()!.id}</span>
                <span class={`text-xs px-2 py-0.5 rounded ${getStatusColor(selectedTask()!.status)}`}>
                  {selectedTask()!.status}
                </span>
              </div>
              <button
                class="text-2xl leading-none text-dark-text-muted hover:text-dark-text"
                onClick={closeTaskDetail}
              >
                ×
              </button>
            </div>
            <div class="flex-1 overflow-y-auto p-4 space-y-4">
              <div>
                <h3 class="text-lg font-medium text-dark-text mb-2">{selectedTask()!.name}</h3>
                <div class="bg-dark-surface rounded-lg p-3">
                  <h4 class="text-xs font-medium text-dark-text-muted uppercase mb-2">Prompt</h4>
                  <p class="text-sm text-dark-text whitespace-pre-wrap">{selectedTask()!.prompt}</p>
                </div>
              </div>

              <div class="grid grid-cols-2 gap-4">
                <div class="bg-dark-surface rounded-lg p-3">
                  <h4 class="text-xs font-medium text-dark-text-muted uppercase mb-2">Models</h4>
                  <div class="space-y-1 text-sm">
                    <div><span class="text-dark-text-muted">Plan:</span> <span class="text-dark-text">{selectedTask()!.planModel || 'Default'}</span></div>
                    <div><span class="text-dark-text-muted">Execution:</span> <span class="text-dark-text">{selectedTask()!.executionModel || 'Default'}</span></div>
                  </div>
                </div>
                <div class="bg-dark-surface rounded-lg p-3">
                  <h4 class="text-xs font-medium text-dark-text-muted uppercase mb-2">Execution</h4>
                  <div class="space-y-1 text-sm">
                    <div><span class="text-dark-text-muted">Branch:</span> <span class="text-dark-text">{selectedTask()!.branch || 'Default'}</span></div>
                    <div><span class="text-dark-text-muted">Strategy:</span> <span class="text-dark-text">{selectedTask()!.executionStrategy}</span></div>
                  </div>
                </div>
              </div>

              <div class="bg-dark-surface rounded-lg p-3">
                <h4 class="text-xs font-medium text-dark-text-muted uppercase mb-2">Timeline</h4>
                <div class="space-y-1 text-sm">
                  <div><span class="text-dark-text-muted">Created:</span> <span class="text-dark-text">{formatLocalDateTime(selectedTask()!.createdAt)}</span></div>
                  <Show when={selectedTask()!.completedAt}>
                    <div><span class="text-dark-text-muted">Completed:</span> <span class="text-dark-text">{formatLocalDateTime(selectedTask()!.completedAt!)}</span></div>
                  </Show>
                  <Show when={selectedTask()!.archivedAt}>
                    <div><span class="text-dark-text-muted">Archived:</span> <span class="text-dark-text">{formatLocalDateTime(selectedTask()!.archivedAt!)}</span></div>
                  </Show>
                </div>
              </div>

              <Show when={selectedTask()!.agentOutput}>
                <div class="bg-dark-surface rounded-lg p-3">
                  <h4 class="text-xs font-medium text-dark-text-muted uppercase mb-2">Agent Output</h4>
                  <p class="text-sm text-dark-text whitespace-pre-wrap">{selectedTask()!.agentOutput}</p>
                </div>
              </Show>

              <Show when={selectedTask()!.errorMessage}>
                <div class="bg-red-500/10 border border-red-500/30 rounded-lg p-3">
                  <h4 class="text-xs font-medium text-red-400 uppercase mb-2">Error</h4>
                  <p class="text-sm text-red-300">{selectedTask()!.errorMessage}</p>
                </div>
              </Show>
            </div>
            <div class="flex justify-end gap-2 px-4 py-3 border-t border-dark-surface3">
              <Show when={selectedTask()!.sessionId}>
                <button
                  class="btn btn-primary"
                  onClick={() => {
                    closeTaskDetail()
                    props.onOpenTaskSessions(selectedTask()!)
                  }}
                >
                  View Sessions
                </button>
              </Show>
              <button class="btn" onClick={closeTaskDetail}>
                Close
              </button>
            </div>
          </div>
        </div>
      </Show>

    </div>
    </Show>
    </Show>
  )
}
