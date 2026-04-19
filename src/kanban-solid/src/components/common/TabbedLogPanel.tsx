/**
 * TabbedLogPanel Component - Bottom panel with workflow runs and event logs
 * Ported from React to SolidJS - Full feature parity
 */

import { createSignal, createMemo, createEffect, onMount, onCleanup, For, Show } from 'solid-js'
import type { LogEntry, WorkflowRun } from '@/types'

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
}

export function TabbedLogPanel(props: TabbedLogPanelProps) {
  const [activeTab, setActiveTab] = createSignal<'runs' | 'logs'>('runs')
  const [panelHeight, setPanelHeight] = createSignal(DEFAULT_PANEL_HEIGHT)
  const [isResizing, setIsResizing] = createSignal(false)

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

  const isRunStale = (run: WorkflowRun) => {
    return safeStaleRuns().some(sr => sr.id === run.id)
  }

  const canArchiveRun = (run: WorkflowRun) => {
    return run.status === 'completed' || run.status === 'failed'
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
      <div class="fixed bottom-0 left-[240px] right-0 h-10 bg-dark-surface border-t border-dark-border flex items-center justify-between px-4 z-30">
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
        </div>
      </div>
    </Show>
  )
}
