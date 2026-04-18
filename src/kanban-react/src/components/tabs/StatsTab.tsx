import { useState, useMemo, useCallback } from 'react'
import { 
  LineChart, 
  Line, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer,
  BarChart,
  Bar,
  Legend,
} from 'recharts'
import { useStats } from '@/hooks/useStats'
import type { HourlyUsage, DailyUsage } from '@/types'

// Only 7d data is currently supported by the API
// Do not add more ranges until the backend supports them
type TimeRange = '7d'

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

export function StatsTab() {
  // Time range state - only '7d' is currently supported by the API
  // Keep as state to allow future expansion when backend supports additional ranges
  const [timeRange] = useState<TimeRange>('7d')
  
  const {
    usageStats,
    taskStats,
    modelUsage,
    averageDuration,
    hourlyUsage,
    dailyUsage7d,
    dailyUsage30d,
    isLoading,
    error,
    loadAllStats,
  } = useStats()

  const currentUsage = usageStats
  
  // hourlyUsage and dailyUsage30d are not currently used in charts
  // (API only provides 7d daily data). Kept in hasData check for freshness detection.
  void hourlyUsage
  void dailyUsage30d
  
  const isHourlyUsage = (d: HourlyUsage | DailyUsage): d is HourlyUsage => 'hour' in d
  const isDailyUsage = (d: HourlyUsage | DailyUsage): d is DailyUsage => 'date' in d

  const formatTimeSeriesData = useCallback((data: HourlyUsage[] | DailyUsage[]) => {
    return data.map(d => {
      if (isHourlyUsage(d)) {
        return { label: d.hour, tokens: d.tokens, cost: d.cost }
      }
      if (isDailyUsage(d)) {
        return { label: d.date, tokens: d.tokens, cost: d.cost }
      }
      throw new Error('Invalid usage data: expected HourlyUsage or DailyUsage')
    })
  }, [])

  const timeSeriesData = useMemo(() => {
    if (timeRange === '7d') {
      return formatTimeSeriesData(dailyUsage7d)
    }
    throw new Error(`Unsupported timeRange: ${timeRange}. Only '7d' is currently supported.`)
  }, [timeRange, dailyUsage7d, formatTimeSeriesData])

  // Check if we have any meaningful data yet
  const hasData = usageStats.totalTokens > 0 || taskStats.completed > 0 || hourlyUsage.length > 0

  // Show loading spinner only when loading AND no data yet (initial load)
  if (isLoading && !hasData) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="flex items-center gap-3 text-dark-text-muted">
          <svg className="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          Loading statistics...
        </div>
      </div>
    )
  }

  // Show error state when error AND no data (complete failure on initial load)
  if (error && !hasData) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="text-center">
          <div className="text-red-400 mb-2">
            <svg className="w-12 h-12 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h3 className="text-lg font-medium text-dark-text mb-2">Failed to Load Statistics</h3>
          <p className="text-dark-text-muted mb-4">{error}</p>
          <button className="btn btn-primary" onClick={loadAllStats}>
            Retry
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-dark-surface3">
          <h2 className="text-xl font-semibold text-dark-text flex items-center gap-2">
            <svg className="w-5 h-5 text-accent-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
            System Statistics
          </h2>
          <button className="btn btn-primary btn-sm" onClick={loadAllStats}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Refresh
          </button>
        </div>

        {/* Token & Cost Overview */}
        <div>
          <h3 className="text-sm font-medium text-dark-text-muted uppercase mb-3">Token & Cost Overview</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="p-4 rounded-lg border bg-dark-surface border-accent-primary">
              <div className="text-xs text-dark-text-muted uppercase mb-1">Last 7 Days</div>
              <div className="text-2xl font-semibold text-dark-text" data-testid="tokens-7d">
                {formatNumber(currentUsage.totalTokens)}
              </div>
              <div className="text-sm text-dark-text-muted" data-testid="cost-7d">
                {formatCurrency(currentUsage.totalCost)}
              </div>
              <div className={`text-xs mt-1 ${currentUsage.tokenChange >= 0 ? 'text-green-400' : 'text-red-400'}`} data-testid="change-7d">
                {currentUsage.tokenChange >= 0 ? '↑' : '↓'} {Math.abs(currentUsage.tokenChange)}%
              </div>
            </div>
          </div>
        </div>

        {/* Task Statistics */}
        <div>
          <h3 className="text-sm font-medium text-dark-text-muted uppercase mb-3">Task Statistics</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="p-4 bg-dark-surface border border-dark-surface3 rounded-lg">
              <div className="flex items-center gap-2 mb-2">
                <svg className="w-5 h-5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                <span className="text-sm text-dark-text-muted">Completed</span>
              </div>
              <div className="text-3xl font-semibold text-green-400" data-testid="completed-count">
                {taskStats.completed}
              </div>
            </div>
            <div className="p-4 bg-dark-surface border border-dark-surface3 rounded-lg">
              <div className="flex items-center gap-2 mb-2">
                <svg className="w-5 h-5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
                <span className="text-sm text-dark-text-muted">Failed</span>
              </div>
              <div className="text-3xl font-semibold text-red-400" data-testid="failed-count">
                {taskStats.failed}
              </div>
            </div>
            <div className="p-4 bg-dark-surface border border-dark-surface3 rounded-lg">
              <div className="flex items-center gap-2 mb-2">
                <svg className="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                </svg>
                <span className="text-sm text-dark-text-muted">Avg Reviews</span>
              </div>
              <div className="text-3xl font-semibold text-blue-400" data-testid="avg-reviews">
                {taskStats.averageReviews.toFixed(1)}
              </div>
            </div>
          </div>
        </div>

        {/* Usage Over Time Chart */}
        <div className="bg-dark-surface border border-dark-surface3 rounded-lg p-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-medium text-dark-text-muted uppercase">Token & Cost Over Time (7 Days)</h3>
          </div>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={timeSeriesData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis 
                  dataKey="label" 
                  stroke="#64748b" 
                  fontSize={12}
                  tickLine={false}
                />
                <YAxis 
                  yAxisId="tokens" 
                  stroke="#64748b" 
                  fontSize={12}
                  tickLine={false}
                  tickFormatter={(value) => formatNumber(value)}
                />
                <YAxis 
                  yAxisId="cost" 
                  orientation="right" 
                  stroke="#64748b" 
                  fontSize={12}
                  tickLine={false}
                  tickFormatter={(value) => `$${value.toFixed(0)}`}
                />
                <Tooltip 
                  contentStyle={{ 
                    backgroundColor: '#1e293b', 
                    border: '1px solid #334155',
                    borderRadius: '6px',
                  }}
                  labelStyle={{ color: '#94a3b8' }}
                />
                <Legend />
                <Line 
                  yAxisId="tokens"
                  type="monotone" 
                  dataKey="tokens" 
                  stroke="#6366f1" 
                  strokeWidth={2}
                  dot={false}
                  name="Tokens"
                />
                <Line 
                  yAxisId="cost"
                  type="monotone" 
                  dataKey="cost" 
                  stroke="#10b981" 
                  strokeWidth={2}
                  dot={false}
                  name="Cost ($)"
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <p className="text-xs text-dark-text-muted mt-2 text-center">Daily data for last 7 days</p>
        </div>

        {/* Model Usage */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {(['plan', 'execution', 'review'] as const).map((phase) => {
            const data = modelUsage[phase]
            const title = phase.charAt(0).toUpperCase() + phase.slice(1)
            
            return (
              <div key={phase} className="bg-dark-surface border border-dark-surface3 rounded-lg p-4" data-testid={`model-chart-${phase}`}>
                <h3 className="text-sm font-medium text-dark-text-muted uppercase mb-4">{title} Models</h3>
                <div className="h-48">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data} layout="vertical">
                      <CartesianGrid strokeDasharray="3 3" stroke="#334155" horizontal={false} />
                      <XAxis 
                        type="number" 
                        stroke="#64748b" 
                        fontSize={10}
                        tickLine={false}
                      />
                      <YAxis 
                        type="category" 
                        dataKey="model" 
                        stroke="#64748b" 
                        fontSize={10}
                        tickLine={false}
                        width={80}
                      />
                      <Tooltip 
                        contentStyle={{ 
                          backgroundColor: '#1e293b', 
                          border: '1px solid #334155',
                          borderRadius: '6px',
                        }}
                        labelStyle={{ color: '#94a3b8' }}
                      />
                      <Bar 
                        dataKey="count" 
                        fill="#6366f1" 
                        radius={[0, 4, 4, 0]}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )
          })}
        </div>

        {/* Average Task Duration */}
        <div className="bg-dark-surface border border-dark-surface3 rounded-lg p-4">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-accent-primary/10 rounded-lg">
              <svg className="w-8 h-8 text-accent-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div>
              <div className="text-sm text-dark-text-muted">Average Task Duration</div>
              <div className="text-3xl font-semibold text-dark-text" data-testid="avg-duration">
                {formatDuration(averageDuration)}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
