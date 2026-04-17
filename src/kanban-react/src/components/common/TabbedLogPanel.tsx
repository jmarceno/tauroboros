import { useState, useCallback, useMemo } from 'react'
import type { LogEntry, WorkflowRun } from '@/types'

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

export function TabbedLogPanel({
  collapsed,
  onCollapsedChange,
  logs,
  runs,
  staleRuns,
  onClear,
  onArchiveRun,
  onArchiveAllStaleRuns,
  onHighlightRun,
  onClearHighlight,
}: TabbedLogPanelProps) {
  const [activeTab, setActiveTab] = useState<'runs' | 'logs'>('runs')

  const safeStaleRuns = useMemo(() => Array.isArray(staleRuns) ? staleRuns : [], [staleRuns])
  const hasStaleRuns = useMemo(() => safeStaleRuns.length > 0, [safeStaleRuns])
  const hasAnyRuns = useMemo(() => runs.length > 0, [runs])

  const isRunStale = useCallback((run: WorkflowRun) => {
    return safeStaleRuns.some(sr => sr.id === run.id)
  }, [safeStaleRuns])

  const canArchiveRun = useCallback((run: WorkflowRun) => {
    return run.status === 'completed' || run.status === 'failed'
  }, [])

  const getRunStatusClass = useCallback((status: string, isStale = false) => {
    if (isStale) return 'stale'
    switch (status) {
      case 'running': return 'active'
      case 'paused': return 'paused'
      default: return ''
    }
  }, [])

  const getRunProgressPercent = useCallback((run: WorkflowRun) => {
    const total = run.taskOrder?.length ?? 0
    const completed = Math.min(run.currentTaskIndex ?? 0, total)
    if (total === 0) return 0
    return (completed / total) * 100
  }, [])

  // Distribute runs into columns for masonry layout (L→R, T→B)
  const getRunsForColumn = useCallback((columnIndex: number): WorkflowRun[] => {
    const col = columnIndex - 1 // 0-based
    const allRuns = Array.isArray(runs) ? runs : []

    return allRuns.filter((_, index) => {
      const itemCol = index % 4
      return itemCol === col
    })
  }, [runs])

  if (collapsed) {
    return (
      <div className="fixed bottom-0 left-[240px] right-0 h-10 bg-dark-surface border-t border-dark-border flex items-center justify-between px-4 z-30">
        <div className="flex items-center gap-2 text-sm text-dark-text-muted">
          <span>{logs.length} logs</span>
          <span>•</span>
          <span>{runs.length} runs</span>
        </div>
        <button
          className="text-dark-text-muted hover:text-dark-text"
          onClick={() => onCollapsedChange(false)}
        >
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M19 9l-7 7-7-7"/>
          </svg>
        </button>
      </div>
    )
  }

  return (
    <div
      className="border-t border-dark-border bg-dark-surface flex flex-col transition-all duration-200 shrink-0"
      style={{ height: collapsed ? 'auto' : '176px', minHeight: collapsed ? 'auto' : '120px' }}
    >
      {/* Header with Tabs */}
      <div
        className="px-3.5 py-2 text-xs font-semibold text-dark-text-secondary border-b border-dark-border uppercase tracking-wider flex items-center justify-between select-none"
      >
        <div className="flex items-center gap-1">
          <button
            className={`px-3 py-1.5 rounded-md text-[11px] font-semibold uppercase tracking-wider transition-all ${
              activeTab === 'runs'
                ? 'bg-dark-surface2 text-accent-primary'
                : 'text-dark-text-secondary hover:text-dark-text hover:bg-dark-surface2/50'
            }`}
            onClick={() => setActiveTab('runs')}
          >
            <span className="flex items-center gap-1.5">
              Workflow Runs
              {runs.length > 0 && (
                <span className="px-1.5 py-0 text-[10px] bg-dark-border rounded-full text-dark-text">
                  {runs.length}
                </span>
              )}
            </span>
          </button>
          <button
            className={`px-3 py-1.5 rounded-md text-[11px] font-semibold uppercase tracking-wider transition-all ${
              activeTab === 'logs'
                ? 'bg-dark-surface2 text-accent-primary'
                : 'text-dark-text-secondary hover:text-dark-text hover:bg-dark-surface2/50'
            }`}
            onClick={() => setActiveTab('logs')}
          >
            <span className="flex items-center gap-1.5">
              Event Log
              {logs.length > 0 && (
                <span className="px-1.5 py-0 text-[10px] bg-dark-border rounded-full text-dark-text">
                  {logs.length}
                </span>
              )}
            </span>
          </button>
        </div>
        <button
          className="bg-transparent border-0 text-dark-text-secondary cursor-pointer p-1 hover:text-dark-text"
          onClick={() => onCollapsedChange(true)}
        >
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M5 15l7-7 7 7"/>
          </svg>
        </button>
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {/* Workflow Runs Tab */}
        {activeTab === 'runs' && (
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Archive All Stale button at top */}
            {hasStaleRuns && (
              <div className="px-3.5 py-2 border-b border-dark-border bg-dark-surface2/30">
                <button
                  className="w-auto px-3 py-1.5 bg-dark-surface2 border border-dark-border text-dark-text-secondary rounded-md text-xs flex items-center gap-2 transition-all hover:border-accent-danger hover:text-accent-danger"
                  onClick={onArchiveAllStaleRuns}
                >
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/>
                  </svg>
                  <span>Archive {safeStaleRuns.length} Stale Run{safeStaleRuns.length > 1 ? 's' : ''}</span>
                </button>
              </div>
            )}

            {/* 4-Column Grid */}
            {hasAnyRuns ? (
              <div className="flex-1 overflow-y-auto p-3">
                <div className="grid grid-cols-4 gap-2">
                  {[1, 2, 3, 4].map(col => (
                    <div key={col} className="flex flex-col gap-2">
                      {getRunsForColumn(col).map(run => (
                        <div
                          key={run.id}
                          className={`p-2.5 bg-dark-surface2 border border-dark-border rounded-md cursor-pointer transition-all ${
                            getRunStatusClass(run.status, isRunStale(run)) === 'active' ? 'border-accent-success bg-accent-success/5' : ''
                          } ${getRunStatusClass(run.status, isRunStale(run)) === 'stale' ? 'border-dark-border-hover opacity-80' : ''}`}
                          style={{
                            borderColor: getRunStatusClass(run.status, isRunStale(run)) === 'active'
                              ? undefined
                              : getRunStatusClass(run.status, isRunStale(run)) === 'stale'
                                ? undefined
                                : undefined
                          }}
                          onMouseEnter={() => onHighlightRun(run.id)}
                          onMouseLeave={onClearHighlight}
                        >
                          <div className="flex items-center justify-between mb-1.5">
                            <span className="font-semibold text-xs text-dark-text truncate max-w-[120px]">
                              {run.displayName || run.kind}
                            </span>
                            <div className="flex items-center gap-1.5">
                              <span
                                className={`px-1.5 py-0.5 rounded-full text-[10px] font-medium uppercase ${
                                  getRunStatusClass(run.status, isRunStale(run)) === 'active' ? 'bg-accent-success/15 text-accent-success' :
                                  getRunStatusClass(run.status, isRunStale(run)) === 'paused' ? 'bg-accent-warning/15 text-accent-warning' :
                                  getRunStatusClass(run.status, isRunStale(run)) === 'stale' ? 'bg-dark-border text-dark-text-secondary' :
                                  'bg-accent-info/15 text-accent-info'
                                }`}
                              >
                                {isRunStale(run) ? 'stale' : run.status}
                              </span>
                              {canArchiveRun(run) && (
                                <button
                                  className="w-5 h-5 flex items-center justify-center bg-transparent border-0 text-dark-text-secondary cursor-pointer rounded transition-colors hover:text-accent-danger hover:bg-accent-danger/10"
                                  title="Archive this run"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    onArchiveRun(run.id)
                                  }}
                                >
                                  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/>
                                  </svg>
                                </button>
                              )}
                            </div>
                          </div>
                          <div className="flex flex-col gap-1">
                            <span className="text-[10px] text-dark-text-secondary">
                              {run.currentTaskIndex || 0}/{run.taskOrder?.length || 0} tasks
                            </span>
                            <div className="h-0.5 bg-dark-border rounded-sm overflow-hidden">
                              <div
                                className={`h-full rounded-sm transition-all ${isRunStale(run) ? 'opacity-50 bg-dark-border-hover' : ''}`}
                                style={{
                                  width: `${getRunProgressPercent(run)}%`,
                                  backgroundColor: isRunStale(run) ? undefined : (run.color || '#00ff88')
                                }}
                              />
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center p-4 text-dark-text-muted">
                <svg className="w-6 h-6 mb-2 opacity-50" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>
                </svg>
                <p className="text-xs font-medium text-dark-text-secondary mb-0.5">No active workflow runs</p>
                <p className="text-[10px]">Start a workflow to see runs here</p>
              </div>
            )}
          </div>
        )}

        {/* Event Log Tab */}
        {activeTab === 'logs' && (
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="px-3.5 py-1.5 border-b border-dark-border bg-dark-surface2/30 flex justify-end">
              <button
                className="px-2 py-1 bg-dark-surface2 border border-dark-border text-dark-text-secondary rounded text-[10px] transition-all hover:text-dark-text hover:border-dark-border-hover"
                onClick={onClear}
              >
                Clear
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-3.5 py-2 font-mono text-xs leading-relaxed">
              {logs.length === 0 ? (
                <div className="text-dark-text-muted italic text-center py-4">No events yet...</div>
              ) : (
                logs.map((log, idx) => (
                  <div
                    key={idx}
                    className={`mb-1 ${
                      log.variant === 'info' ? 'text-dark-text-secondary' :
                      log.variant === 'success' ? 'text-accent-success' :
                      'text-accent-danger'
                    }`}
                  >
                    <span className="text-dark-text-muted">[{log.ts}]</span> {log.message}
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}