/**
 * TabbedLogPanel Component - Bottom panel with workflow runs and event logs
 * Ported from React to SolidJS - Full feature parity
 */

import { createSignal, createMemo, createEffect, onMount, onCleanup, For, Show, lazy } from 'solid-js'
import type { LogEntry, WorkflowRun } from '@/types'
import { runApiEffect, runsApi } from '@/api'

// Lazy load Console component for the bottom panel
const ConsolePanel = lazy(() => import('./ConsolePanel'))

type RunQueueStatus = {
  runId: string
  status: WorkflowRun['status']
  totalTasks: number
  queuedTasks: number
  executingTasks: number
  completedTasks: number
}

type RunQueueState = {
  status: RunQueueStatus | null
  error: string | null
}

// Exported for testing
export const MIN_PANEL_HEIGHT = 120
export const DEFAULT_PANEL_HEIGHT = 176
export const STORAGE_KEY = 'logPanelHeight'

// Compute max height dynamically to handle window resize
export const getMaxPanelHeight = (): number => window.innerHeight * 0.7

interface TabbedLogPanelProps {
  collapsed: boolean
  onCollapsedChange: (collapsed: boolean) => void
  logs: LogEntry[]
  runs: WorkflowRun[]
  staleRuns: WorkflowRun[]
  onClear: () => void
  onArchiveRun: (id: string) => void
  onArchiveAllStaleRuns: () => void
  onHighlightRun: (runId: string) => void
  onClearHighlight: () => void
  onCleanRun?: (run: WorkflowRun) => void
}

export function TabbedLogPanel(props: TabbedLogPanelProps) {
  const [activeTab, setActiveTab] = createSignal<'runs' | 'logs' | 'console'>('runs')
  const [panelHeight, setPanelHeight] = createSignal(DEFAULT_PANEL_HEIGHT)
  const [isResizing, setIsResizing] = createSignal(false)
  const [queueStateByRunId, setQueueStateByRunId] = createSignal<Record<string, RunQueueState>>({})

  let resizeStartY = 0
  let resizeStartHeight = 0

  // Load saved height from localStorage on mount
  onMount(() => {
    const savedHeight = localStorage.getItem(STORAGE_KEY)
    if (savedHeight) {
      const height = parseInt(savedHeight, 10)
      const maxHeight = getMaxPanelHeight()
      if (height >= MIN_PANEL_HEIGHT && height <= maxHeight) {
        setPanelHeight(height)
      }
    }
  })

  // Handle resize mouse events
  createEffect(() => {
    if (!isResizing()) return

    const handleMouseMove = (e: MouseEvent) => {
      const delta = resizeStartY - e.clientY
      const maxHeight = getMaxPanelHeight()
      const newHeight = Math.min(
        maxHeight,
        Math.max(MIN_PANEL_HEIGHT, resizeStartHeight + delta)
      )
      setPanelHeight(newHeight)
    }

    const handleMouseUp = () => {
      setIsResizing(false)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      localStorage.setItem(STORAGE_KEY, panelHeight().toString())
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)

    onCleanup(() => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    })
  })

  const startResize = (e: MouseEvent) => {
    e.preventDefault()
    resizeStartY = e.clientY
    resizeStartHeight = panelHeight()
    setIsResizing(true)
    document.body.style.cursor = 'ns-resize'
    document.body.style.userSelect = 'none'
  }

  const safeStaleRuns = createMemo(() => Array.isArray(props.staleRuns) ? props.staleRuns : [])
  const hasStaleRuns = createMemo(() => safeStaleRuns().length > 0)
  const hasAnyRuns = createMemo(() => props.runs.length > 0)
  const activeRuns = createMemo(() => props.runs.filter(run => isRunActive(run)))

  const isRunStale = (run: WorkflowRun) => {
    return safeStaleRuns().some(sr => sr.id === run.id)
  }

  const canArchiveRun = (run: WorkflowRun) => {
    return run.status === 'completed' || run.status === 'failed'
  }

  const canCleanRun = (run: WorkflowRun) => {
    return run.status === 'completed' || run.status === 'failed'
  }

  const isRunActive = (run: WorkflowRun) => {
    return run.status === 'queued' || run.status === 'running' || run.status === 'stopping' || run.status === 'paused'
  }

  const getRunStatusClass = (status: string, isStale = false) => {
    if (isStale) return 'stale'
    switch (status) {
      case 'queued': return 'active'
      case 'running': return 'active'
      case 'paused': return 'paused'
      default: return ''
    }
  }

  const getRunProgressPercent = (run: WorkflowRun) => {
    const total = run.taskOrder?.length ?? 0
    const completed = Math.min(run.currentTaskIndex ?? 0, total)
    if (total === 0) return 0
    return (completed / total) * 100
  }

  const getQueueState = (runId: string) => queueStateByRunId()[runId]

  createEffect(() => {
    if (activeTab() !== 'runs') return

    const runsToTrack = activeRuns().map((run) => run.id)
    if (runsToTrack.length === 0) {
      setQueueStateByRunId({})
      return
    }

    let disposed = false

    const loadStatuses = async () => {
      const nextEntries = await Promise.all(runsToTrack.map(async (runId) => {
        try {
          const status = await runApiEffect(runsApi.getQueueStatus(runId))
          return [runId, { status, error: null } satisfies RunQueueState] as const
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return [runId, { status: null, error: message } satisfies RunQueueState] as const
        }
      }))

      if (disposed) return

      setQueueStateByRunId(Object.fromEntries(nextEntries))
    }

    void loadStatuses()
    const interval = window.setInterval(() => {
      void loadStatuses()
    }, 2000)

    onCleanup(() => {
      disposed = true
      window.clearInterval(interval)
    })
  })

  // Distribute runs into columns for masonry layout (L→R, T→B)
  const getRunsForColumn = (columnIndex: number): WorkflowRun[] => {
    const col = columnIndex - 1 // 0-based
    const allRuns = Array.isArray(props.runs) ? props.runs : []

    return allRuns.filter((_, index) => {
      const itemCol = index % 4
      return itemCol === col
    })
  }

  return (
    <Show when={!props.collapsed} fallback={
      <div class="h-10 bg-dark-surface border-t border-dark-border flex items-center justify-between px-4 shrink-0">
        <div class="flex items-center gap-2 text-sm text-dark-text-muted">
          <span>{props.logs.length} logs</span>
          <span>•</span>
          <span>{props.runs.length} runs</span>
        </div>
        <button
          class="text-dark-text-muted hover:text-dark-text"
          onClick={() => props.onCollapsedChange(false)}
        >
          <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M19 9l-7 7-7-7"/>
          </svg>
        </button>
      </div>
    }>
      <div
        class="border-t border-dark-border bg-dark-surface flex flex-col shrink-0 relative"
        classList={{ 'resizing': isResizing(), 'transition-all duration-200': !isResizing() }}
        style={{ height: `${panelHeight()}px` }}
      >
        {/* Resize Handle */}
        <div
          class="log-panel-resize-handle"
          onMouseDown={startResize}
          title="Drag to resize"
        />

        {/* Header with Tabs */}
        <div class="px-3.5 py-2 text-xs font-semibold text-dark-text-secondary border-b border-dark-border uppercase tracking-wider flex items-center justify-between select-none">
          <div class="flex items-center gap-1">
            <button
              class="px-3 py-1.5 rounded-md text-[11px] font-semibold uppercase tracking-wider transition-all"
              classList={{
                'bg-dark-surface2 text-accent-primary': activeTab() === 'runs',
                'text-dark-text-secondary hover:text-dark-text hover:bg-dark-surface2/50': activeTab() !== 'runs'
              }}
              onClick={() => setActiveTab('runs')}
            >
              <span class="flex items-center gap-1.5">
                Workflow Runs
                <Show when={props.runs.length > 0}>
                  <span class="px-1.5 py-0 text-[10px] bg-dark-border rounded-full text-dark-text">
                    {props.runs.length}
                  </span>
                </Show>
              </span>
            </button>
            <button
              class="px-3 py-1.5 rounded-md text-[11px] font-semibold uppercase tracking-wider transition-all"
              classList={{
                'bg-dark-surface2 text-accent-primary': activeTab() === 'logs',
                'text-dark-text-secondary hover:text-dark-text hover:bg-dark-surface2/50': activeTab() !== 'logs'
              }}
              onClick={() => setActiveTab('logs')}
            >
              <span class="flex items-center gap-1.5">
                Event Log
                <Show when={props.logs.length > 0}>
                  <span class="px-1.5 py-0 text-[10px] bg-dark-border rounded-full text-dark-text">
                    {props.logs.length}
                  </span>
                </Show>
              </span>
            </button>
            <button
              class="px-3 py-1.5 rounded-md text-[11px] font-semibold uppercase tracking-wider transition-all flex items-center gap-1.5"
              classList={{
                'bg-dark-surface2 text-accent-primary': activeTab() === 'console',
                'text-dark-text-secondary hover:text-dark-text hover:bg-dark-surface2/50': activeTab() !== 'console'
              }}
              onClick={() => setActiveTab('console')}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                class="w-3.5 h-3.5"
              >
                <polyline points="4 17 10 11 4 5" />
                <line x1="12" x2="20" y1="19" y2="19" />
              </svg>
              Console
            </button>
          </div>
          <button
            class="bg-transparent border-0 text-dark-text-secondary cursor-pointer p-1 hover:text-dark-text"
            onClick={() => props.onCollapsedChange(true)}
          >
            <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M5 15l7-7 7 7"/>
            </svg>
          </button>
        </div>

        {/* Tab Content */}
        <div class="flex-1 overflow-hidden flex flex-col">
          {/* Workflow Runs Tab */}
          <Show when={activeTab() === 'runs'}>
            <div class="flex-1 flex flex-col overflow-hidden">
              {/* Archive All Stale button at top */}
              <Show when={hasStaleRuns()}>
                <div class="px-3.5 py-2 border-b border-dark-border bg-dark-surface2/30">
                  <button
                    class="w-auto px-3 py-1.5 bg-dark-surface2 border border-dark-border text-dark-text-secondary rounded-md text-xs flex items-center gap-2 transition-all hover:border-accent-danger hover:text-accent-danger"
                    onClick={props.onArchiveAllStaleRuns}
                  >
                    <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/>
                    </svg>
                    <span>Archive {safeStaleRuns().length} Stale Run{safeStaleRuns().length > 1 ? 's' : ''}</span>
                  </button>
                </div>
              </Show>

              {/* 4-Column Grid */}
              <Show when={hasAnyRuns()} fallback={
                <div class="flex-1 flex flex-col items-center justify-center p-4 text-dark-text-muted">
                  <svg class="w-6 h-6 mb-2 opacity-50" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>
                  </svg>
                  <p class="text-xs font-medium text-dark-text-secondary mb-0.5">No active workflow runs</p>
                  <p class="text-[10px]">Start a workflow to see runs here</p>
                </div>
              }>
                <div class="flex-1 overflow-y-auto p-3">
                  <div class="grid grid-cols-4 gap-2">
                    <For each={[1, 2, 3, 4]}>
                      {(col) => (
                        <div class="flex flex-col gap-2">
                          <For each={getRunsForColumn(col)}>
                            {(run) => {
                              const statusClass = getRunStatusClass(run.status, isRunStale(run))
                              const progressPercent = getRunProgressPercent(run)
                              return (
                                <div
                                  class="p-2.5 bg-dark-surface2 border border-dark-border rounded-md cursor-pointer transition-all"
                                  data-run-id={run.id}
                                  classList={{
                                    'border-accent-success bg-accent-success/5': statusClass === 'active',
                                    'border-dark-border-hover opacity-80': statusClass === 'stale'
                                  }}
                                  onMouseEnter={() => props.onHighlightRun(run.id)}
                                  onMouseLeave={props.onClearHighlight}
                                >
                                  <div class="flex items-center justify-between mb-1.5">
                                    <span class="font-semibold text-xs text-dark-text truncate max-w-[120px]">
                                      {run.displayName || run.kind}
                                    </span>
                                    <div class="flex items-center gap-1.5">
                                      <span
                                        class="px-1.5 py-0.5 rounded-full text-[10px] font-medium uppercase"
                                        classList={{
                                          'bg-accent-success/15 text-accent-success': statusClass === 'active',
                                          'bg-accent-warning/15 text-accent-warning': statusClass === 'paused',
                                          'bg-dark-border text-dark-text-secondary': statusClass === 'stale',
                                          'bg-accent-info/15 text-accent-info': statusClass === ''
                                        }}
                                      >
                                        {isRunStale(run) ? 'stale' : run.status}
                                      </span>
                                      <Show when={canCleanRun(run) && props.onCleanRun}>
                                        <button
                                          class="w-5 h-5 flex items-center justify-center bg-transparent border-0 text-dark-text-secondary cursor-pointer rounded transition-colors hover:text-accent-secondary hover:bg-accent-secondary/10"
                                          title={isRunActive(run) ? "Cannot clean active run" : "Clean this run (reset all tasks)"}
                                          disabled={isRunActive(run)}
                                          onClick={(e) => {
                                            e.stopPropagation()
                                            props.onCleanRun?.(run)
                                          }}
                                        >
                                          <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                            <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
                                          </svg>
                                        </button>
                                      </Show>
                                      <Show when={canArchiveRun(run)}>
                                        <button
                                          class="w-5 h-5 flex items-center justify-center bg-transparent border-0 text-dark-text-secondary cursor-pointer rounded transition-colors hover:text-accent-danger hover:bg-accent-danger/10"
                                          title="Archive this run"
                                          onClick={(e) => {
                                            e.stopPropagation()
                                            props.onArchiveRun(run.id)
                                          }}
                                        >
                                          <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                            <path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/>
                                          </svg>
                                        </button>
                                      </Show>
                                    </div>
                                  </div>
                                  <div class="flex flex-col gap-1">
                                    <span class="text-[10px] text-dark-text-secondary">
                                      {run.currentTaskIndex || 0}/{run.taskOrder?.length || 0} tasks
                                    </span>
                                    <Show when={getQueueState(run.id)?.status}>
                                      {(queueState) => (
                                        <span class="text-[10px] text-dark-text-muted" data-run-queue-status={run.id}>
                                          q {queueState().queuedTasks} · x {queueState().executingTasks} · d {queueState().completedTasks}
                                        </span>
                                      )}
                                    </Show>
                                    <Show when={getQueueState(run.id)?.error}>
                                      {(queueError) => (
                                        <span class="text-[10px] text-accent-danger" data-run-queue-error={run.id}>
                                          queue error: {queueError()}
                                        </span>
                                      )}
                                    </Show>
                                    <div class="h-0.5 bg-dark-border rounded-sm overflow-hidden">
                                      <div
                                        class="h-full rounded-sm transition-all"
                                        classList={{ 'opacity-50 bg-dark-border-hover': isRunStale(run) }}
                                        data-progress-width={progressPercent}
                                        data-run-color={isRunStale(run) ? undefined : (run.color || '#00ff88')}
                                        style={{ width: `${progressPercent}%` }}
                                      />
                                    </div>
                                  </div>
                                </div>
                              )
                            }}
                          </For>
                        </div>
                      )}
                    </For>
                  </div>
                </div>
              </Show>
            </div>
          </Show>

          {/* Event Log Tab */}
          <Show when={activeTab() === 'logs'}>
            <div class="flex-1 flex flex-col overflow-hidden">
              <div class="px-3.5 py-1.5 border-b border-dark-border bg-dark-surface2/30 flex justify-end">
                <button
                  class="px-2 py-1 bg-dark-surface2 border border-dark-border text-dark-text-secondary rounded text-[10px] transition-all hover:text-dark-text hover:border-dark-border-hover"
                  onClick={props.onClear}
                >
                  Clear
                </button>
              </div>
              <div class="flex-1 overflow-y-auto px-3.5 py-2 font-mono text-xs leading-relaxed">
                <Show when={props.logs.length === 0} fallback={
                  <For each={props.logs}>
                    {(log) => (
                      <div
                        class="mb-1"
                        classList={{
                          'text-dark-text-secondary': log.variant === 'info',
                          'text-accent-success': log.variant === 'success',
                          'text-accent-danger': log.variant === 'error'
                        }}
                      >
                        <span class="text-dark-text-muted">[{log.ts}]</span> {log.message}
                      </div>
                    )}
                  </For>
                }>
                  <div class="text-dark-text-muted italic text-center py-4">No events yet...</div>
                </Show>
              </div>
            </div>
          </Show>

          {/* Console Tab */}
          <Show when={activeTab() === 'console'}>
            <div class="flex-1 flex flex-col overflow-hidden bg-[#0d1117]">
              <ConsolePanel />
            </div>
          </Show>
        </div>
      </div>
    </Show>
  )
}
