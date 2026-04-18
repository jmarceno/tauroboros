import { useState, useEffect, useCallback, useMemo } from 'react'
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

type TimeRange = '24h' | '7d' | '30d' | 'lifetime'

interface UsageStats {
  totalTokens: number
  totalCost: number
  tokenChange: number
  costChange: number
}

interface TaskStats {
  completed: number
  failed: number
  averageReviews: number
}

interface ModelUsage {
  model: string
  count: number
}

interface ModelUsageStats {
  plan: ModelUsage[]
  execution: ModelUsage[]
  review: ModelUsage[]
}

interface TimeSeriesData {
  date: string
  tokens: number
  cost: number
}

interface HourlyUsage {
  hour: string
  tokens: number
  cost: number
}

interface StatsData {
  usage: Record<TimeRange, UsageStats>
  taskStats: TaskStats
  modelUsage: ModelUsageStats
  averageDuration: number
  hourlyUsage: HourlyUsage[]
  dailyUsage7d: TimeSeriesData[]
  dailyUsage30d: TimeSeriesData[]
}

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
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [timeRange, setTimeRange] = useState<TimeRange>('7d')
  const [stats, setStats] = useState<StatsData | null>(null)

  const loadStats = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      // Fetch stats from API
      const [usageRes, tasksRes, modelsRes, durationRes, hourlyRes, dailyRes] = await Promise.all([
        fetch('/api/stats/usage?range=24h'),
        fetch('/api/stats/tasks'),
        fetch('/api/stats/models'),
        fetch('/api/stats/duration'),
        fetch('/api/stats/timeseries/hourly'),
        fetch('/api/stats/timeseries/daily?days=30'),
      ])

      // Parse responses
      const [usage24h, usage7d, usage30d, usageLifetime] = await Promise.all([
        usageRes.ok ? usageRes.json() : { totalTokens: 0, totalCost: 0, tokenChange: 0, costChange: 0 },
        fetch('/api/stats/usage?range=7d').then(r => r.ok ? r.json() : { totalTokens: 0, totalCost: 0, tokenChange: 0, costChange: 0 }),
        fetch('/api/stats/usage?range=30d').then(r => r.ok ? r.json() : { totalTokens: 0, totalCost: 0, tokenChange: 0, costChange: 0 }),
        fetch('/api/stats/usage?range=lifetime').then(r => r.ok ? r.json() : { totalTokens: 0, totalCost: 0, tokenChange: 0, costChange: 0 }),
      ])

      const taskStats = tasksRes.ok ? await tasksRes.json() : { completed: 0, failed: 0, averageReviews: 0 }
      const modelUsage = modelsRes.ok ? await modelsRes.json() : { plan: [], execution: [], review: [] }
      const duration = durationRes.ok ? await durationRes.json() : { averageDuration: 0 }
      const hourlyData = hourlyRes.ok ? await hourlyRes.json() : { data: [] }
      const dailyData = dailyRes.ok ? await dailyRes.json() : { data: [] }

      // Process daily data for 7d and 30d views
      const allDaily = dailyData.data || []
      const daily7d = allDaily.slice(-7)
      const daily30d = allDaily.slice(-30)

      setStats({
        usage: {
          '24h': usage24h,
          '7d': usage7d,
          '30d': usage30d,
          lifetime: usageLifetime,
        },
        taskStats: taskStats,
        modelUsage: modelUsage,
        averageDuration: duration.averageDuration || 0,
        hourlyUsage: hourlyData.data || [],
        dailyUsage7d: daily7d,
        dailyUsage30d: daily30d,
      })
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : 'Failed to load statistics'
      setError(errorMessage)
      throw new Error(`Statistics loading failed: ${errorMessage}`)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    loadStats()
  }, [])

  const currentUsage = stats?.usage[timeRange]
  
  const timeSeriesData = useMemo(() => {
    if (!stats) return []
    if (timeRange === '24h') {
      return stats.hourlyUsage.map(d => ({
        label: d.hour,
        tokens: d.tokens,
        cost: d.cost,
      }))
    }
    if (timeRange === '7d') {
      return stats.dailyUsage7d.map(d => ({
        label: d.date,
        tokens: d.tokens,
        cost: d.cost,
      }))
    }
    if (timeRange === '30d') {
      return stats.dailyUsage30d.map(d => ({
        label: d.date,
        tokens: d.tokens,
        cost: d.cost,
      }))
    }
    return stats.dailyUsage30d.slice(-30).map(d => ({
      label: d.date,
      tokens: d.tokens,
      cost: d.cost,
    }))
  }, [stats, timeRange])

  if (isLoading) {
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

  if (error && !stats) {
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
          <button className="btn btn-primary" onClick={loadStats}>
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
          <button className="btn btn-primary btn-sm" onClick={loadStats}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Refresh
          </button>
        </div>

        {/* Token & Cost Overview */}
        <div>
          <h3 className="text-sm font-medium text-dark-text-muted uppercase mb-3">Token & Cost Overview</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {(['24h', '7d', '30d', 'lifetime'] as TimeRange[]).map((range) => {
              const usage = stats?.usage[range]
              return (
                <div 
                  key={range}
                  className={`p-4 rounded-lg border transition-colors ${
                    timeRange === range 
                      ? 'bg-dark-surface border-accent-primary' 
                      : 'bg-dark-surface border-dark-surface3 hover:border-dark-text-muted'
                  }`}
                >
                  <button 
                    className="w-full text-left"
                    onClick={() => setTimeRange(range)}
                  >
                    <div className="text-xs text-dark-text-muted uppercase mb-1">
                      {range === 'lifetime' ? 'Lifetime' : `Last ${range}`}
                    </div>
                    <div className="text-2xl font-semibold text-dark-text">
                      {formatNumber(usage?.totalTokens || 0)}
                    </div>
                    <div className="text-sm text-dark-text-muted">
                      {formatCurrency(usage?.totalCost || 0)}
                    </div>
                    {range !== 'lifetime' && usage && (
                      <div className={`text-xs mt-1 ${usage.tokenChange >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        {usage.tokenChange >= 0 ? '↑' : '↓'} {Math.abs(usage.tokenChange)}%
                      </div>
                    )}
                  </button>
                </div>
              )
            })}
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
              <div className="text-3xl font-semibold text-green-400">
                {stats?.taskStats.completed || 0}
              </div>
            </div>
            <div className="p-4 bg-dark-surface border border-dark-surface3 rounded-lg">
              <div className="flex items-center gap-2 mb-2">
                <svg className="w-5 h-5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
                <span className="text-sm text-dark-text-muted">Failed</span>
              </div>
              <div className="text-3xl font-semibold text-red-400">
                {stats?.taskStats.failed || 0}
              </div>
            </div>
            <div className="p-4 bg-dark-surface border border-dark-surface3 rounded-lg">
              <div className="flex items-center gap-2 mb-2">
                <svg className="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                </svg>
                <span className="text-sm text-dark-text-muted">Avg Reviews</span>
              </div>
              <div className="text-3xl font-semibold text-blue-400">
                {stats?.taskStats.averageReviews.toFixed(1) || '0.0'}
              </div>
            </div>
          </div>
        </div>

        {/* Usage Over Time Chart */}
        <div className="bg-dark-surface border border-dark-surface3 rounded-lg p-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-medium text-dark-text-muted uppercase">Token & Cost Over Time</h3>
            <div className="flex gap-1">
              {(['24h', '7d', '30d'] as TimeRange[]).map((range) => (
                <button
                  key={range}
                  className={`px-3 py-1 text-xs rounded transition-colors ${
                    timeRange === range 
                      ? 'bg-accent-primary text-white' 
                      : 'bg-dark-surface3 text-dark-text-muted hover:text-dark-text'
                  }`}
                  onClick={() => setTimeRange(range)}
                >
                  {range === '24h' ? '24h' : range}
                </button>
              ))}
            </div>
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
          <p className="text-xs text-dark-text-muted mt-2 text-center">
            {timeRange === '24h' ? 'Hourly data for last 24 hours' : `Daily data for last ${timeRange}`}
          </p>
        </div>

        {/* Model Usage */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {(['plan', 'execution', 'review'] as const).map((phase) => {
            const data = stats?.modelUsage[phase] || []
            const title = phase.charAt(0).toUpperCase() + phase.slice(1)
            
            return (
              <div key={phase} className="bg-dark-surface border border-dark-surface3 rounded-lg p-4">
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
              <div className="text-3xl font-semibold text-dark-text">
                {formatDuration(stats?.averageDuration || 0)}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
