/**
 * RunPanel Component - Run management panel
 * Ported from React to SolidJS
 */

import { Show } from 'solid-js'
import type { WorkflowRun } from '@/types'

interface RunPanelProps {
  run: WorkflowRun
  isStale: boolean
  onArchive: () => void
  onHighlight: () => void
  onClearHighlight: () => void
}

export function RunPanel(props: RunPanelProps) {
  const progress = () => props.run.taskOrder?.length
    ? Math.round((props.run.currentTaskIndex / props.run.taskOrder.length) * 100)
    : 0

  const statusClass = () => props.run.status === 'running' ? 'active' :
                         props.run.status === 'paused' ? 'paused' : ''

  return (
    <div
      class={`run-card ${statusClass()} ${props.isStale ? 'opacity-50' : ''}`}
      data-run-color={props.run.color}
      style={props.run.color ? { '--progress-color': props.run.color } as any : undefined}
    >
      <div class="run-header">
        <span class="run-id">{props.run.displayName || props.run.id.slice(0, 8)}</span>
        <span class={`run-status ${statusClass()}`}>
          {props.run.status}
        </span>
      </div>

      <div class="run-meta">
        <span>{props.run.currentTaskIndex || 0}/{props.run.taskOrder?.length || 0} tasks</span>
        <Show when={props.isStale}>
          <span class="text-accent-warning">(stale)</span>
        </Show>
      </div>

      <div class="run-progress">
        <div class="run-progress-fill" style={{ width: `${progress()}%` }} />
      </div>

      <div class="flex gap-2 mt-2">
        <button
          class="text-[10px] px-2 py-1 bg-dark-bg border border-dark-border rounded hover:border-accent-primary"
          onClick={props.onHighlight}
        >
          Highlight
        </button>
        <button
          class="text-[10px] px-2 py-1 bg-dark-bg border border-dark-border rounded hover:border-accent-primary"
          onClick={props.onClearHighlight}
        >
          Clear
        </button>
        <button
          class="text-[10px] px-2 py-1 bg-dark-bg border border-dark-border rounded hover:border-accent-danger text-accent-danger"
          onClick={props.onArchive}
        >
          Archive
        </button>
      </div>
    </div>
  )
}
