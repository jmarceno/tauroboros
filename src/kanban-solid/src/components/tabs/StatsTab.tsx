/**
 * StatsTab Component - Statistics dashboard with Chart.js
 * Ported from React to SolidJS with full chart support
 */

import { createSignal, createMemo, createEffect, onCleanup, For, Show } from 'solid-js'
import { createQuery, useQueryClient } from '@tanstack/solid-query'
import Chart from 'chart.js/auto'
import { statsApi } from '@/api'
import type { HourlyUsage, DailyUsage } from '@/types'

// Only 7d data is currently supported by the API
type TimeRange = '7d'

const EMPTY_USAGE = { totalTokens: 0, totalCost: 0, tokenChange: 0, costChange: 0 }
const EMPTY_TASK_STATS = { completed: 0, failed: 0, averageReviews: 0 }
const EMPTY_MODEL_USAGE = { plan: [], execution: [], review: [] }
const EMPTY_DAILY_USAGE: DailyUsage[] = []

const formatNumber = (num: number): string => {
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`
  return num.toString()
}

const formatCurrency = (cost: number): string => {
  return `$${cost.toFixed(2)}`
}

const formatDuration = (minutes: number): string => {
  if (minutes < 60) return `${Math.round(minutes)}m`
  const hours = Math.floor(minutes / 60)
  const mins = Math.round(minutes % 60)
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`
}

const isHourlyUsage = (d: HourlyUsage | DailyUsage): d is HourlyUsage => 'hour' in d
const isDailyUsage = (d: HourlyUsage | DailyUsage): d is DailyUsage => 'date' in d

export function StatsTab() {
  const queryClient = useQueryClient()
  const [timeRange] = createSignal<TimeRange>('7d')
  
  let timeSeriesChartRef: HTMLCanvasElement | undefined
  let planChartRef: HTMLCanvasElement | undefined
  let executionChartRef: HTMLCanvasElement | undefined
  let reviewChartRef: HTMLCanvasElement | undefined
  
  let timeSeriesChart: Chart | null = null
  let planChart: Chart | null = null
  let executionChart: Chart | null = null
  let reviewChart: Chart | null = null

  const usageQuery = createQuery(() => ({
    queryKey: ['stats', 'usage', timeRange()],
    queryFn: () => statsApi.getUsage(timeRange()),
    staleTime: 30000,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    retry: 2,
  }))

  const taskStatsQuery = createQuery(() => ({
    queryKey: ['stats', 'tasks'],
    queryFn: () => statsApi.getTaskStats(),
    staleTime: 30000,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    retry: 2,
  }))

  const modelUsageQuery = createQuery(() => ({
    queryKey: ['stats', 'models'],
    queryFn: () => statsApi.getModelUsage(),
    staleTime: 30000,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    retry: 2,
  }))

  const durationQuery = createQuery(() => ({
    queryKey: ['stats', 'duration'],
    queryFn: () => statsApi.getAverageDuration(),
    staleTime: 30000,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    retry: 2,
  }))

  const dailyUsage7dQuery = createQuery(() => ({
    queryKey: ['stats', 'daily', 7],
    queryFn: () => statsApi.getDailyUsage(7),
    staleTime: 30000,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    retry: 2,
  }))

  const currentUsage = () => usageQuery.data ?? EMPTY_USAGE
  const taskStats = () => taskStatsQuery.data ?? EMPTY_TASK_STATS
  const modelUsage = () => modelUsageQuery.data ?? EMPTY_MODEL_USAGE
  const averageDuration = () => durationQuery.data ?? 0
  const dailyUsage7d = () => dailyUsage7dQuery.data ?? EMPTY_DAILY_USAGE

  const formatTimeSeriesData = (data: HourlyUsage[] | DailyUsage[]) => {
    return data.map(d => {
      if (isHourlyUsage(d)) {
        return { label: d.hour, tokens: d.tokens, cost: d.cost }
      }
      if (isDailyUsage(d)) {
        return { label: d.date, tokens: d.tokens, cost: d.cost }
      }
      throw new Error('Invalid usage data: expected HourlyUsage or DailyUsage')
    })
  }

  const timeSeriesData = createMemo(() => {
    if (timeRange() === '7d') {
      return formatTimeSeriesData(dailyUsage7d())
    }
    return []
  })

  const isQueryLoading = () =>
    usageQuery.isLoading ||
    taskStatsQuery.isLoading ||
    modelUsageQuery.isLoading ||
    durationQuery.isLoading ||
    dailyUsage7dQuery.isLoading

  const error = () => {
    const errors = [
      usageQuery.error,
      taskStatsQuery.error,
      modelUsageQuery.error,
      durationQuery.error,
      dailyUsage7dQuery.error,
    ]
    const firstError = errors.find(e => e !== null && e !== undefined)
    if (!firstError) return null
    if (firstError instanceof Error) return firstError.message
    return String(firstError)
  }

  const hasData = () =>
    (currentUsage().totalTokens > 0) ||
    (taskStats().completed > 0) ||
    (taskStats().failed > 0) ||
    (dailyUsage7d().length > 0) ||
    (modelUsage().plan.length > 0) ||
    (modelUsage().execution.length > 0) ||
    (modelUsage().review.length > 0)

  const loadAllStats = async () => {
    await queryClient.invalidateQueries({ queryKey: ['stats'] })
  }

  // Initialize time series chart
  createEffect(() => {
    const data = timeSeriesData()
    if (!timeSeriesChartRef || data.length === 0) return

    if (timeSeriesChart) {
      timeSeriesChart.destroy()
    }

    timeSeriesChart = new Chart(timeSeriesChartRef, {
      type: 'line',
      data: {
        labels: data.map(d => d.label),
        datasets: [
          {
            label: 'Tokens',
            data: data.map(d => d.tokens),
            borderColor: '#6366f1',
            backgroundColor: 'rgba(99, 102, 241, 0.1)',
            tension: 0.4,
            yAxisID: 'y',
          },
          {
            label: 'Cost ($)',
            data: data.map(d => d.cost),
            borderColor: '#10b981',
            backgroundColor: 'rgba(16, 185, 129, 0.1)',
            tension: 0.4,
            yAxisID: 'y1',
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: 'index',
          intersect: false,
        },
        plugins: {
          legend: {
            display: true,
            labels: {
              color: '#94a3b8',
            },
          },
          tooltip: {
            backgroundColor: '#1e293b',
            borderColor: '#334155',
            borderWidth: 1,
            titleColor: '#94a3b8',
            bodyColor: '#e0e0e0',
          },
        },
        scales: {
          x: {
            grid: {
              color: '#334155',
              borderDash: [3, 3],
            },
            ticks: {
              color: '#64748b',
            },
          },
          y: {
            type: 'linear',
            display: true,
            position: 'left',
            grid: {
              color: '#334155',
              borderDash: [3, 3],
            },
            ticks: {
              color: '#64748b',
              callback: (value) => formatNumber(Number(value)),
            },
          },
          y1: {
            type: 'linear',
            display: true,
            position: 'right',
            grid: {
              drawOnChartArea: false,
            },
            ticks: {
              color: '#64748b',
              callback: (value) => `$${Number(value).toFixed(0)}`,
            },
          },
        },
      },
    })
  })

  // Initialize model usage charts
  const createBarChart = (canvas: HTMLCanvasElement | undefined, data: { model: string; count: number }[], label: string) => {
    if (!canvas || data.length === 0) return null

    return new Chart(canvas, {
      type: 'bar',
      data: {
        labels: data.map(d => d.model),
        datasets: [{
          label,
          data: data.map(d => d.count),
          backgroundColor: '#6366f1',
          borderRadius: 4,
        }],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: false,
          },
          tooltip: {
            backgroundColor: '#1e293b',
            borderColor: '#334155',
            borderWidth: 1,
            titleColor: '#94a3b8',
            bodyColor: '#e0e0e0',
          },
        },
        scales: {
          x: {
            grid: {
              color: '#334155',
              borderDash: [3, 3],
            },
            ticks: {
              color: '#64748b',
            },
          },
          y: {
            grid: {
              display: false,
            },
            ticks: {
              color: '#64748b',
              font: {
                size: 10,
              },
            },
          },
        },
      },
    })
  }

  // Create/Update model usage charts
  createEffect(() => {
    const usage = modelUsage()
    
    if (planChart) planChart.destroy()
    if (executionChart) executionChart.destroy()
    if (reviewChart) reviewChart.destroy()
    
    planChart = createBarChart(planChartRef, usage.plan, 'Plan')
    executionChart = createBarChart(executionChartRef, usage.execution, 'Execution')
    reviewChart = createBarChart(reviewChartRef, usage.review, 'Review')
  })

  // Cleanup charts on unmount
  onCleanup(() => {
    if (timeSeriesChart) timeSeriesChart.destroy()
    if (planChart) planChart.destroy()
    if (executionChart) executionChart.destroy()
    if (reviewChart) reviewChart.destroy()
  })

  const errorMessage = createMemo(() => error())

  return (
    <Show when={!isQueryLoading() || hasData()} fallback={
      <div class="flex-1 flex items-center justify-center p-8">
        <div class="flex flex-col items-center gap-3 text-dark-text-muted">
          <svg class="animate-spin h-6 w-6" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          <div class="text-center">
            <p class="text-sm font-medium">Loading statistics...</p>
            <p class="text-xs text-dark-text-muted mt-1">Fetching usage data, task stats, and model analytics</p>
          </div>
        </div>
      </div>
    }>
    <Show when={!errorMessage() || hasData()} fallback={
      <div class="flex-1 flex items-center justify-center p-8">
        <div class="text-center max-w-md">
          <div class="text-red-400 mb-3">
            <svg class="w-12 h-12 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h3 class="text-lg font-medium text-dark-text mb-2">Failed to Load Statistics</h3>
          <p class="text-dark-text-muted mb-2">{errorMessage()}</p>
          <p class="text-xs text-dark-text-muted/70 mb-4">
            This can happen if the server is busy or if there's a temporary network issue.
          </p>
          <div class="flex items-center justify-center gap-2">
            <button class="btn btn-primary" onClick={loadAllStats}>
              <svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Retry
            </button>
          </div>
        </div>
      </div>
    }>
    <div class="flex-1 overflow-y-auto p-6">
      <div class="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div class="flex items-center justify-between pb-4 border-b border-dark-surface3">
          <h2 class="text-xl font-semibold text-dark-text flex items-center gap-2">
            <svg class="w-5 h-5 text-accent-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
            System Statistics
          </h2>
          <button class="btn btn-primary btn-sm" onClick={loadAllStats}>
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Refresh
          </button>
        </div>

        {/* Token & Cost Overview */}
        <div>
          <h3 class="text-sm font-medium text-dark-text-muted uppercase mb-3">Token & Cost Overview</h3>
          <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div class="p-4 rounded-lg border bg-dark-surface border-accent-primary">
              <div class="text-xs text-dark-text-muted uppercase mb-1">Last 7 Days</div>
              <div class="text-2xl font-semibold text-dark-text" data-testid="tokens-7d">
                {formatNumber(currentUsage().totalTokens)}
              </div>
              <div class="text-sm text-dark-text-muted" data-testid="cost-7d">
                {formatCurrency(currentUsage().totalCost)}
              </div>
              <div class={`text-xs mt-1 ${currentUsage().tokenChange >= 0 ? 'text-green-400' : 'text-red-400'}`} data-testid="change-7d">
                {currentUsage().tokenChange >= 0 ? '↑' : '↓'} {Math.abs(currentUsage().tokenChange)}%
              </div>
            </div>
          </div>
        </div>

        {/* Task Statistics */}
        <div>
          <h3 class="text-sm font-medium text-dark-text-muted uppercase mb-3">Task Statistics</h3>
          <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div class="p-4 bg-dark-surface border border-dark-surface3 rounded-lg">
              <div class="flex items-center gap-2 mb-2">
                <svg class="w-5 h-5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M5 13l4 4L19 7" />
                </svg>
                <span class="text-sm text-dark-text-muted">Completed</span>
              </div>
              <div class="text-3xl font-semibold text-green-400" data-testid="completed-count">
                {taskStats().completed}
              </div>
            </div>
            <div class="p-4 bg-dark-surface border border-dark-surface3 rounded-lg">
              <div class="flex items-center gap-2 mb-2">
                <svg class="w-5 h-5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
                <span class="text-sm text-dark-text-muted">Failed</span>
              </div>
              <div class="text-3xl font-semibold text-red-400" data-testid="failed-count">
                {taskStats().failed}
              </div>
            </div>
            <div class="p-4 bg-dark-surface border border-dark-surface3 rounded-lg">
              <div class="flex items-center gap-2 mb-2">
                <svg class="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                </svg>
                <span class="text-sm text-dark-text-muted">Avg Reviews</span>
              </div>
              <div class="text-3xl font-semibold text-blue-400" data-testid="avg-reviews">
                {taskStats().averageReviews.toFixed(1)}
              </div>
            </div>
          </div>
        </div>

        {/* Usage Over Time Chart */}
        <div class="bg-dark-surface border border-dark-surface3 rounded-lg p-4">
          <div class="flex items-center justify-between mb-4">
            <h3 class="text-sm font-medium text-dark-text-muted uppercase">Token & Cost Over Time (7 Days)</h3>
          </div>
          <div class="h-64">
            <canvas ref={timeSeriesChartRef} />
          </div>
          <p class="text-xs text-dark-text-muted mt-2 text-center">Daily data for last 7 days</p>
        </div>

        {/* Model Usage */}
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div class="bg-dark-surface border border-dark-surface3 rounded-lg p-4" data-testid="model-chart-plan">
            <h3 class="text-sm font-medium text-dark-text-muted uppercase mb-4">Plan Models</h3>
            <div class="h-48">
              <canvas ref={planChartRef} />
            </div>
          </div>
          <div class="bg-dark-surface border border-dark-surface3 rounded-lg p-4" data-testid="model-chart-execution">
            <h3 class="text-sm font-medium text-dark-text-muted uppercase mb-4">Execution Models</h3>
            <div class="h-48">
              <canvas ref={executionChartRef} />
            </div>
          </div>
          <div class="bg-dark-surface border border-dark-surface3 rounded-lg p-4" data-testid="model-chart-review">
            <h3 class="text-sm font-medium text-dark-text-muted uppercase mb-4">Review Models</h3>
            <div class="h-48">
              <canvas ref={reviewChartRef} />
            </div>
          </div>
        </div>

        {/* Average Task Duration */}
        <div class="bg-dark-surface border border-dark-surface3 rounded-lg p-4">
          <div class="flex items-center gap-4">
            <div class="p-3 bg-accent-primary/10 rounded-lg">
              <svg class="w-8 h-8 text-accent-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div>
              <div class="text-sm text-dark-text-muted">Average Task Duration</div>
              <div class="text-3xl font-semibold text-dark-text" data-testid="avg-duration">
                {formatDuration(averageDuration())}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    </Show>
    </Show>
  )
}
