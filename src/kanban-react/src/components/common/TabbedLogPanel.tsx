import type { LogEntry, WorkflowRun } from '@/types'
import { RunPanel } from '../runs/RunPanel'

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
          ▲
        </button>
      </div>
    )
  }

  return (
    <div className="fixed bottom-0 left-[240px] right-0 h-[180px] bg-dark-surface border-t border-dark-border flex flex-col z-30">
      <div className="flex items-center justify-between px-4 py-2 border-b border-dark-border">
        <div className="flex items-center gap-4">
          <span className="text-sm font-medium">Logs & Runs</span>
          <button
            className="text-xs text-dark-text-muted hover:text-dark-text"
            onClick={onClear}
          >
            Clear Logs
          </button>
          {staleRuns.length > 0 && (
            <button
              className="text-xs text-accent-warning hover:text-accent-warning"
              onClick={onArchiveAllStaleRuns}
            >
              Archive {staleRuns.length} Stale
            </button>
          )}
        </div>
        <button
          className="text-dark-text-muted hover:text-dark-text"
          onClick={() => onCollapsedChange(true)}
        >
          ▼
        </button>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Logs */}
        <div className="flex-1 overflow-y-auto p-2 font-mono text-xs">
          {logs.length === 0 ? (
            <div className="text-dark-text-muted text-center py-8">No logs yet...</div>
          ) : (
            logs.map((log, i) => (
              <div key={i} className={`mb-1 ${
                log.variant === 'error' ? 'text-accent-danger' :
                log.variant === 'success' ? 'text-accent-success' :
                'text-dark-text-secondary'
              }`}>
                <span className="text-dark-text-muted">[{log.ts}]</span> {log.message}
              </div>
            ))
          )}
        </div>

        {/* Runs */}
        <div className="w-[300px] border-l border-dark-border overflow-y-auto p-2">
          {runs.length === 0 ? (
            <div className="text-dark-text-muted text-center py-8 text-xs">No workflow runs</div>
          ) : (
            runs.map(run => (
              <RunPanel
                key={run.id}
                run={run}
                isStale={staleRuns.some(r => r.id === run.id)}
                onArchive={() => onArchiveRun(run.id)}
                onHighlight={() => onHighlightRun(run.id)}
                onClearHighlight={onClearHighlight}
              />
            ))
          )}
        </div>
      </div>
    </div>
  )
}
