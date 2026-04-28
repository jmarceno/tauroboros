/**
 * SelfHealReportsTab Component - Browse self-heal diagnostic reports
 */

import { createSignal, createMemo, For, Show } from 'solid-js'
import { createQuery, useQueryClient } from '@tanstack/solid-query'
import { selfHealApi, runApiEffect } from '@/api'
import { uiStore } from '@/stores'
import type { SelfHealReport, WorkflowRun } from '@/types'
import { runsApi } from '@/api'

type SelfHealReportEntry = { report: SelfHealReport; run: WorkflowRun }

// ---- helpers ----------------------------------------------------------------

const formatTimestamp = (ts: number): string =>
  new Date(ts * 1000).toLocaleString()

const SOURCE_MODE_LABELS: Record<SelfHealReport['sourceMode'], string> = {
  local: 'Local source',
  github_clone: 'GitHub clone',
  github_metadata_only: 'GitHub metadata',
}

const CONFIDENCE_LABELS: Record<SelfHealReport['confidence'], string> = {
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Low confidence',
}

// ---- sub-components ---------------------------------------------------------

function ReportBadge(props: { label: string; variant: 'success' | 'warning' | 'error' | 'info' }) {
  const colors = {
    success: 'bg-green-500/10 text-green-400 border-green-500/30',
    warning: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30',
    error: 'bg-red-500/10 text-red-400 border-red-500/30',
    info: 'bg-blue-500/10 text-blue-400 border-blue-500/30',
  }
  return (
    <span class={`inline-flex items-center px-2 py-0.5 rounded text-xs border ${colors[props.variant]}`}>
      {props.label}
    </span>
  )
}

function SelfHealReportCard(props: {
  report: SelfHealReport
  taskName: string
}) {
  const [expanded, setExpanded] = createSignal(false)

  return (
    <div class="border border-dark-border rounded-lg bg-dark-surface overflow-hidden">
      {/* Card header */}
      <button
        class="w-full flex items-start gap-3 p-4 text-left hover:bg-white/5 transition-colors"
        onClick={() => setExpanded(v => !v)}
        aria-expanded={expanded()}
      >
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 flex-wrap mb-1">
            <span class="text-sm font-medium text-dark-text-primary truncate">{props.taskName}</span>
            <ReportBadge
              label={props.report.isTauroborosBug ? 'Tauroboros Bug' : 'External Issue'}
              variant={props.report.isTauroborosBug ? 'error' : 'warning'}
            />
            <ReportBadge
              label={CONFIDENCE_LABELS[props.report.confidence]}
              variant={props.report.confidence === 'high' ? 'success' : props.report.confidence === 'medium' ? 'warning' : 'info'}
            />
            <ReportBadge label={SOURCE_MODE_LABELS[props.report.sourceMode]} variant="info" />
          </div>
          <p class="text-xs text-dark-text-secondary line-clamp-2">{props.report.diagnosticsSummary}</p>
          <p class="text-xs text-dark-text-muted mt-1">{formatTimestamp(props.report.createdAt)}</p>
        </div>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          class={`w-4 h-4 text-dark-text-muted flex-shrink-0 mt-0.5 transition-transform ${expanded() ? 'rotate-180' : ''}`}
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {/* Expanded detail */}
      <Show when={expanded()}>
        <div class="border-t border-dark-border divide-y divide-dark-border/50">
          {/* Diagnostics summary */}
          <div class="p-4">
            <h4 class="text-xs font-semibold text-dark-text-secondary uppercase tracking-wide mb-2">Diagnostics Summary</h4>
            <p class="text-sm text-dark-text-primary whitespace-pre-wrap">{props.report.diagnosticsSummary}</p>
          </div>

          {/* Root cause */}
          <div class="p-4">
            <h4 class="text-xs font-semibold text-dark-text-secondary uppercase tracking-wide mb-2">Root Cause</h4>
            <p class="text-sm text-dark-text-primary mb-2">{props.report.rootCause.description}</p>
            <Show when={props.report.rootCause.affectedFiles.length > 0}>
              <div class="mt-2">
                <span class="text-xs text-dark-text-secondary">Affected files:</span>
                <ul class="mt-1 space-y-0.5">
                  <For each={props.report.rootCause.affectedFiles}>
                    {(file) => (
                      <li class="text-xs text-dark-text-primary font-mono bg-dark-bg rounded px-2 py-1">{file}</li>
                    )}
                  </For>
                </ul>
              </div>
            </Show>
            <Show when={props.report.rootCause.codeSnippet}>
              <div class="mt-2">
                <span class="text-xs text-dark-text-secondary">Code snippet:</span>
                <pre class="text-xs text-dark-text-primary bg-dark-bg rounded p-2 mt-1 overflow-auto whitespace-pre-wrap font-mono">{props.report.rootCause.codeSnippet}</pre>
              </div>
            </Show>
          </div>

          {/* Proposed solution */}
          <div class="p-4">
            <h4 class="text-xs font-semibold text-dark-text-secondary uppercase tracking-wide mb-2">Proposed Solution</h4>
            <p class="text-sm text-dark-text-primary whitespace-pre-wrap">{props.report.proposedSolution}</p>
          </div>

          {/* Implementation plan */}
          <Show when={props.report.implementationPlan.length > 0}>
            <div class="p-4">
              <h4 class="text-xs font-semibold text-dark-text-secondary uppercase tracking-wide mb-2">Implementation Plan</h4>
              <ol class="space-y-1 list-decimal list-inside">
                <For each={props.report.implementationPlan}>
                  {(step) => (
                    <li class="text-sm text-dark-text-primary">{step}</li>
                  )}
                </For>
              </ol>
            </div>
          </Show>

          {/* External factors */}
          <Show when={props.report.externalFactors.length > 0}>
            <div class="p-4">
              <h4 class="text-xs font-semibold text-dark-text-secondary uppercase tracking-wide mb-2">External Factors</h4>
              <ul class="space-y-1">
                <For each={props.report.externalFactors}>
                  {(factor) => (
                    <li class="flex items-start gap-2 text-sm text-dark-text-primary">
                      <span class="text-accent-warning mt-0.5 flex-shrink-0">•</span>
                      <span>{factor}</span>
                    </li>
                  )}
                </For>
              </ul>
            </div>
          </Show>

          {/* Error context */}
          <Show when={props.report.errorMessage}>
            <div class="p-4">
              <h4 class="text-xs font-semibold text-dark-text-secondary uppercase tracking-wide mb-2">Original Task Error</h4>
              <pre class="text-xs text-red-400 bg-red-500/10 rounded p-3 overflow-auto whitespace-pre-wrap">{props.report.errorMessage}</pre>
            </div>
          </Show>

          {/* Metadata */}
          <div class="p-4">
            <h4 class="text-xs font-semibold text-dark-text-secondary uppercase tracking-wide mb-2">Report Metadata</h4>
            <div class="grid grid-cols-2 gap-2 text-xs">
              <div>
                <span class="text-dark-text-secondary">Tauroboros Version:</span>
                <span class="text-dark-text-primary ml-1">{props.report.tauroborosVersion}</span>
              </div>
              <div>
                <span class="text-dark-text-secondary">Source Mode:</span>
                <span class="text-dark-text-primary ml-1">{SOURCE_MODE_LABELS[props.report.sourceMode]}</span>
              </div>
              <Show when={props.report.sourcePath}>
                <div class="col-span-2">
                  <span class="text-dark-text-secondary">Source Path:</span>
                  <span class="text-dark-text-primary ml-1 font-mono">{props.report.sourcePath}</span>
                </div>
              </Show>
            </div>
          </div>
        </div>
      </Show>
    </div>
  )
}

// ---- main component ---------------------------------------------------------

export function SelfHealReportsTab() {
  const queryClient = useQueryClient()
  const [selectedRunId, setSelectedRunId] = createSignal<string | 'all'>('all')

  const runsQuery = createQuery(() => ({
    queryKey: ['runs'],
    queryFn: () => runApiEffect(runsApi.getAll()),
    staleTime: 10000,
    refetchOnMount: 'always' as const,
    refetchOnWindowFocus: false,
  }))

  // Fetch reports for all runs that have any self-heal data
  const allReportsQuery = createQuery(() => ({
    queryKey: ['self-heal-reports', 'all'],
    queryFn: async (): Promise<SelfHealReportEntry[]> => {
      const runs = runsQuery.data ?? []
      const entries = await Promise.all(
        runs.map(async (run: WorkflowRun): Promise<SelfHealReportEntry[]> => {
          const reports = await runApiEffect(selfHealApi.getReportsForRun(run.id))
          return reports.map((report) => ({ report, run }))
        }),
      )
      return entries.flat().sort((a: SelfHealReportEntry, b: SelfHealReportEntry) => b.report.createdAt - a.report.createdAt)
    },
    enabled: !!runsQuery.data,
    staleTime: 15000,
    refetchOnMount: 'always' as const,
    refetchOnWindowFocus: false,
  }))

  const runsWithReports = createMemo<WorkflowRun[]>(() => {
    const entries = allReportsQuery.data ?? []
    const seen = new Set<string>()
    const result: WorkflowRun[] = []
    for (const { run } of entries) {
      if (!seen.has(run.id)) {
        seen.add(run.id)
        result.push(run)
      }
    }
    return result
  })

  const filteredEntries = createMemo<SelfHealReportEntry[]>(() => {
    const entries = allReportsQuery.data ?? []
    if (selectedRunId() === 'all') return entries
    return entries.filter((entry: SelfHealReportEntry) => entry.run.id === selectedRunId())
  })

  // Build a task-name lookup from all tasks in the fetched runs
  const taskNameMap = createMemo<Record<string, string>>(() => {
    const entries = allReportsQuery.data ?? []
    const map: Record<string, string> = {}
    for (const { report } of entries) {
      if (!map[report.taskId]) {
        map[report.taskId] = report.taskId.slice(0, 8)
      }
    }
    return map
  })

  const isLoading = () => runsQuery.isLoading || allReportsQuery.isLoading
  const isEmpty = () => !isLoading() && filteredEntries().length === 0

  return (
    <div class="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div class="flex items-center justify-between px-6 py-4 border-b border-dark-border flex-shrink-0">
        <div>
          <h2 class="text-base font-semibold text-dark-text-primary">Self-Heal Reports</h2>
          <p class="text-xs text-dark-text-muted mt-0.5">Tauroboros bug investigation reports generated when tasks fail</p>
        </div>
        <div class="flex items-center gap-3">
          {/* Run filter */}
          <select
            class="text-xs bg-dark-bg border border-dark-border rounded px-2 py-1.5 text-dark-text-primary focus:outline-none focus:border-accent-primary"
            value={selectedRunId()}
            onChange={(e) => setSelectedRunId(e.currentTarget.value as string | 'all')}
          >
            <option value="all">All runs</option>
            <For each={runsWithReports()}>
              {(run) => (
                <option value={run.id}>
                  {run.displayName || run.id.slice(0, 8)}
                </option>
              )}
            </For>
          </select>
          <button
            class="text-xs px-3 py-1.5 bg-dark-bg border border-dark-border rounded hover:border-accent-primary text-dark-text-secondary transition-colors"
            onClick={() => queryClient.invalidateQueries({ queryKey: ['self-heal-reports'] })}
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Content */}
      <div class="flex-1 overflow-y-auto px-6 py-4">
        <Show when={isLoading()}>
          <div class="flex items-center justify-center py-12">
            <span class="text-sm text-dark-text-muted">Loading reports…</span>
          </div>
        </Show>

        <Show when={!isLoading() && allReportsQuery.isError}>
          <div class="flex items-center justify-center py-12">
            <span class="text-sm text-red-400">Failed to load reports</span>
          </div>
        </Show>

        <Show when={isEmpty()}>
          <div class="flex flex-col items-center justify-center py-12 gap-3">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
              class="w-10 h-10 text-dark-text-muted"
              aria-hidden="true"
            >
              <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10Z" />
              <path d="M12 16v-4" />
              <path d="M12 8h.01" />
            </svg>
            <p class="text-sm text-dark-text-muted">No self-heal reports found</p>
            <p class="text-xs text-dark-text-muted">Reports are generated automatically when tasks fail and self-healing investigates</p>
          </div>
        </Show>

        <Show when={!isLoading() && filteredEntries().length > 0}>
          <div class="space-y-3">
            <For each={filteredEntries()}>
              {({ report, run }) => (
                <SelfHealReportCard
                  report={report}
                  taskName={`${taskNameMap()[report.taskId] ?? report.taskId.slice(0, 8)} — ${run.displayName || run.id.slice(0, 8)}`}
                />
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  )
}
