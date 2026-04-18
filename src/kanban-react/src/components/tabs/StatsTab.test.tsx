import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { StatsTab } from './StatsTab'
import type { UsageStats, TaskStats, ModelUsageStats, HourlyUsage, DailyUsage } from '@/types'

// Mock useStats hook
const mockLoadAllStats = vi.fn()

interface MockStatsReturn {
  usageStats: UsageStats
  taskStats: TaskStats
  modelUsage: ModelUsageStats
  averageDuration: number
  hourlyUsage: HourlyUsage[]
  dailyUsage7d: DailyUsage[]
  dailyUsage30d: DailyUsage[]
  isLoading: boolean
  error: string | null
  loadAllStats: typeof mockLoadAllStats
}

const defaultMockStats: MockStatsReturn = {
  usageStats: {
    totalTokens: 1_000_000,
    totalCost: 5.50,
    tokenChange: 15.5,
    costChange: 12.3,
  },
  taskStats: {
    completed: 42,
    failed: 3,
    averageReviews: 1.8,
  },
  modelUsage: {
    plan: [
      { model: 'claude-3-opus', count: 15 },
      { model: 'claude-3-sonnet', count: 8 },
    ],
    execution: [
      { model: 'claude-3-sonnet', count: 45 },
      { model: 'gpt-4', count: 12 },
    ],
    review: [
      { model: 'claude-3-haiku', count: 28 },
      { model: 'gpt-3.5-turbo', count: 14 },
    ],
  },
  averageDuration: 154, // minutes
  hourlyUsage: [
    { hour: '00:00', tokens: 5000, cost: 0.25 },
    { hour: '01:00', tokens: 3000, cost: 0.15 },
    { hour: '02:00', tokens: 8000, cost: 0.40 },
    { hour: '03:00', tokens: 2000, cost: 0.10 },
    { hour: '04:00', tokens: 6000, cost: 0.30 },
    { hour: '05:00', tokens: 4000, cost: 0.20 },
    { hour: '06:00', tokens: 7000, cost: 0.35 },
  ],
  dailyUsage7d: [
    { date: '2024-01-15', tokens: 120000, cost: 0.60 },
    { date: '2024-01-16', tokens: 150000, cost: 0.75 },
    { date: '2024-01-17', tokens: 100000, cost: 0.50 },
    { date: '2024-01-18', tokens: 180000, cost: 0.90 },
    { date: '2024-01-19', tokens: 140000, cost: 0.70 },
    { date: '2024-01-20', tokens: 160000, cost: 0.80 },
    { date: '2024-01-21', tokens: 150000, cost: 0.75 },
  ],
  dailyUsage30d: Array.from({ length: 30 }, (_, i) => ({
    date: `2024-01-${String(i + 1).padStart(2, '0')}`,
    tokens: 80000 + i * 2000,
    cost: 0.40 + i * 0.01,
  })),
  isLoading: false,
  error: null,
  loadAllStats: mockLoadAllStats,
}

let mockStatsReturn: MockStatsReturn = { ...defaultMockStats }

vi.mock('@/hooks/useStats', () => ({
  useStats: vi.fn(() => mockStatsReturn),
}))

describe('StatsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStatsReturn = { ...defaultMockStats }
  })

  describe('Rendering', () => {
    it('renders the header with title and refresh button', () => {
      render(<StatsTab />)

      expect(screen.getByText('System Statistics')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /refresh/i })).toBeInTheDocument()
    })

    it('renders Token & Cost Overview section with 7d data', () => {
      render(<StatsTab />)

      expect(screen.getByText('Token & Cost Overview')).toBeInTheDocument()
      expect(screen.getByText('Last 7 Days')).toBeInTheDocument()
    })

    it('renders Task Statistics section', () => {
      render(<StatsTab />)

      expect(screen.getByText('Task Statistics')).toBeInTheDocument()
      expect(screen.getByText('Completed')).toBeInTheDocument()
      expect(screen.getByText('Failed')).toBeInTheDocument()
      expect(screen.getByText('Avg Reviews')).toBeInTheDocument()
    })

    it('renders Token & Cost Over Time chart section', () => {
      render(<StatsTab />)

      expect(screen.getByText('Token & Cost Over Time (7 Days)')).toBeInTheDocument()
    })

    it('renders three model usage bar charts', () => {
      render(<StatsTab />)

      expect(screen.getByTestId('model-chart-plan')).toBeInTheDocument()
      expect(screen.getByTestId('model-chart-execution')).toBeInTheDocument()
      expect(screen.getByTestId('model-chart-review')).toBeInTheDocument()
      expect(screen.getByText('Plan Models')).toBeInTheDocument()
      expect(screen.getByText('Execution Models')).toBeInTheDocument()
      expect(screen.getByText('Review Models')).toBeInTheDocument()
    })

    it('renders Average Task Duration card', () => {
      render(<StatsTab />)

      expect(screen.getByText('Average Task Duration')).toBeInTheDocument()
    })
  })

  describe('Loading State', () => {
    it('shows loading spinner when isLoading is true and no data yet', () => {
      mockStatsReturn = {
        ...defaultMockStats,
        isLoading: true,
        usageStats: { totalTokens: 0, totalCost: 0, tokenChange: 0, costChange: 0 },
        taskStats: { completed: 0, failed: 0, averageReviews: 0 },
        hourlyUsage: [],
        dailyUsage7d: [],
        dailyUsage30d: [],
      }

      render(<StatsTab />)

      expect(screen.getByText(/Loading statistics/i)).toBeInTheDocument()
    })

    it('shows content when isLoading is true but data exists (background refresh)', () => {
      mockStatsReturn = {
        ...defaultMockStats,
        isLoading: true,
      }

      render(<StatsTab />)

      // Should still show data while refreshing (background refresh)
      expect(screen.getByTestId('completed-count')).toHaveTextContent('42')
      expect(screen.getByTestId('failed-count')).toHaveTextContent('3')
      // Refresh button should still be available during background refresh
      expect(screen.getByRole('button', { name: /refresh/i })).toBeInTheDocument()
    })
  })

  describe('Error State', () => {
    it('shows error message when error exists and no data', () => {
      mockStatsReturn = {
        ...defaultMockStats,
        isLoading: false,
        error: 'Failed to fetch statistics',
        usageStats: { totalTokens: 0, totalCost: 0, tokenChange: 0, costChange: 0 },
        taskStats: { completed: 0, failed: 0, averageReviews: 0 },
        hourlyUsage: [],
        dailyUsage7d: [],
        dailyUsage30d: [],
      }

      render(<StatsTab />)

      expect(screen.getByText('Failed to Load Statistics')).toBeInTheDocument()
      expect(screen.getByText('Failed to fetch statistics')).toBeInTheDocument()
    })

    it('has retry button in error state', () => {
      mockStatsReturn = {
        ...defaultMockStats,
        isLoading: false,
        error: 'Failed to fetch statistics',
        usageStats: { totalTokens: 0, totalCost: 0, tokenChange: 0, costChange: 0 },
        taskStats: { completed: 0, failed: 0, averageReviews: 0 },
        hourlyUsage: [],
        dailyUsage7d: [],
        dailyUsage30d: [],
      }

      render(<StatsTab />)

      const retryButton = screen.getByRole('button', { name: /retry/i })
      expect(retryButton).toBeInTheDocument()

      retryButton.click()
      expect(mockLoadAllStats).toHaveBeenCalledTimes(1)
    })

    it('shows data when error exists but data is available (partial error)', () => {
      mockStatsReturn = {
        ...defaultMockStats,
        error: 'Some queries failed',
        isLoading: false,
      }

      render(<StatsTab />)

      // Should still show available data
      expect(screen.getByTestId('completed-count')).toHaveTextContent('42')
    })
  })

  describe('Token & Cost Overview', () => {
    it('displays correct token count for 7d', () => {
      render(<StatsTab />)

      // Numbers formatted: 1,000,000 -> 1.0M
      expect(screen.getByTestId('tokens-7d')).toHaveTextContent('1.0M')
    })

    it('displays correct cost for 7d', () => {
      render(<StatsTab />)

      expect(screen.getByTestId('cost-7d')).toHaveTextContent('$5.50')
    })

    it('displays positive change indicators in green', () => {
      render(<StatsTab />)

      const change7d = screen.getByTestId('change-7d')
      expect(change7d).toHaveTextContent('↑ 15.5%')
      expect(change7d).toHaveClass('text-green-400')
    })

    it('displays negative change indicators in red', () => {
      mockStatsReturn = {
        ...defaultMockStats,
        usageStats: {
          ...defaultMockStats.usageStats,
          tokenChange: -8.5,
          costChange: -5.2,
        },
      }

      render(<StatsTab />)

      const change7d = screen.getByTestId('change-7d')
      expect(change7d).toHaveTextContent('↓ 8.5%')
      expect(change7d).toHaveClass('text-red-400')
    })
  })

  describe('Task Statistics', () => {
    it('displays completed count with green color', () => {
      render(<StatsTab />)

      expect(screen.getByTestId('completed-count')).toHaveTextContent('42')
      expect(screen.getByTestId('completed-count')).toHaveClass('text-green-400')
    })

    it('displays failed count with red color', () => {
      render(<StatsTab />)

      expect(screen.getByTestId('failed-count')).toHaveTextContent('3')
      expect(screen.getByTestId('failed-count')).toHaveClass('text-red-400')
    })

    it('displays average reviews with blue color', () => {
      render(<StatsTab />)

      expect(screen.getByTestId('avg-reviews')).toHaveTextContent('1.8')
      expect(screen.getByTestId('avg-reviews')).toHaveClass('text-blue-400')
    })

    it('displays zero values when task stats are empty', () => {
      mockStatsReturn = {
        ...defaultMockStats,
        taskStats: { completed: 0, failed: 0, averageReviews: 0 },
      }

      render(<StatsTab />)

      expect(screen.getByTestId('completed-count')).toHaveTextContent('0')
      expect(screen.getByTestId('failed-count')).toHaveTextContent('0')
      expect(screen.getByTestId('avg-reviews')).toHaveTextContent('0.0')
    })
  })

  describe('Time Series Chart', () => {
    it('displays 7d time series data', () => {
      render(<StatsTab />)

      expect(screen.getByText('Daily data for last 7 days')).toBeInTheDocument()
    })
  })

  describe('Model Usage Bar Charts', () => {
    it('renders plan model chart with correct data', () => {
      render(<StatsTab />)

      const planChart = screen.getByTestId('model-chart-plan')
      expect(planChart).toBeInTheDocument()
      expect(screen.getByText('Plan Models')).toBeInTheDocument()
    })

    it('renders execution model chart with correct data', () => {
      render(<StatsTab />)

      const execChart = screen.getByTestId('model-chart-execution')
      expect(execChart).toBeInTheDocument()
      expect(screen.getByText('Execution Models')).toBeInTheDocument()
    })

    it('renders review model chart with correct data', () => {
      render(<StatsTab />)

      const reviewChart = screen.getByTestId('model-chart-review')
      expect(reviewChart).toBeInTheDocument()
      expect(screen.getByText('Review Models')).toBeInTheDocument()
    })

    it('handles empty model usage data', () => {
      mockStatsReturn = {
        ...defaultMockStats,
        modelUsage: { plan: [], execution: [], review: [] },
      }

      render(<StatsTab />)

      expect(screen.getByTestId('model-chart-plan')).toBeInTheDocument()
      expect(screen.getByTestId('model-chart-execution')).toBeInTheDocument()
      expect(screen.getByTestId('model-chart-review')).toBeInTheDocument()
    })
  })

  describe('Average Duration Card', () => {
    it('displays formatted duration for minutes', () => {
      mockStatsReturn = {
        ...defaultMockStats,
        averageDuration: 45,
      }

      render(<StatsTab />)

      expect(screen.getByTestId('avg-duration')).toHaveTextContent('45m')
    })

    it('displays formatted duration for hours', () => {
      mockStatsReturn = {
        ...defaultMockStats,
        averageDuration: 120,
      }

      render(<StatsTab />)

      expect(screen.getByTestId('avg-duration')).toHaveTextContent('2h')
    })

    it('displays formatted duration for hours and minutes', () => {
      mockStatsReturn = {
        ...defaultMockStats,
        averageDuration: 154,
      }

      render(<StatsTab />)

      expect(screen.getByTestId('avg-duration')).toHaveTextContent('2h 34m')
    })

    it('displays 0m for zero duration', () => {
      mockStatsReturn = {
        ...defaultMockStats,
        averageDuration: 0,
      }

      render(<StatsTab />)

      expect(screen.getByTestId('avg-duration')).toHaveTextContent('0m')
    })
  })

  describe('Refresh Button', () => {
    it('calls loadAllStats when refresh button clicked', () => {
      render(<StatsTab />)

      const refreshButton = screen.getByRole('button', { name: /refresh/i })
      refreshButton.click()

      expect(mockLoadAllStats).toHaveBeenCalledTimes(1)
    })

    it('refresh button is available during background refresh', () => {
      mockStatsReturn = {
        ...defaultMockStats,
        isLoading: true, // Background refresh in progress
      }

      render(<StatsTab />)

      // During background refresh (when data exists), refresh button should be present
      expect(screen.getByRole('button', { name: /refresh/i })).toBeInTheDocument()
    })
  })

  describe('Number Formatting', () => {
    it('formats thousands with K suffix', () => {
      mockStatsReturn = {
        ...defaultMockStats,
        usageStats: { ...defaultMockStats.usageStats, totalTokens: 1500 },
      }

      render(<StatsTab />)

      expect(screen.getByTestId('tokens-7d')).toHaveTextContent('1.5K')
    })

    it('formats millions with M suffix', () => {
      mockStatsReturn = {
        ...defaultMockStats,
        usageStats: { ...defaultMockStats.usageStats, totalTokens: 1_500_000 },
      }

      render(<StatsTab />)

      expect(screen.getByTestId('tokens-7d')).toHaveTextContent('1.5M')
    })

    it('shows raw number for small values', () => {
      mockStatsReturn = {
        ...defaultMockStats,
        usageStats: { ...defaultMockStats.usageStats, totalTokens: 500 },
      }

      render(<StatsTab />)

      expect(screen.getByTestId('tokens-7d')).toHaveTextContent('500')
    })

    it('formats currency with $ prefix and 2 decimals', () => {
      mockStatsReturn = {
        ...defaultMockStats,
        usageStats: { ...defaultMockStats.usageStats, totalCost: 123.456 },
      }

      render(<StatsTab />)

      expect(screen.getByTestId('cost-7d')).toHaveTextContent('$123.46')
    })
  })

  describe('Accessibility', () => {
    it('refresh button is accessible', () => {
      render(<StatsTab />)

      const refreshButton = screen.getByRole('button', { name: /refresh/i })
      expect(refreshButton).toBeInTheDocument()
    })
  })

  describe('Edge Cases', () => {
    it('handles missing model names gracefully', () => {
      mockStatsReturn = {
        ...defaultMockStats,
        modelUsage: {
          plan: [{ model: '', count: 5 }],
          execution: [{ model: 'valid-model', count: 10 }],
          review: [],
        },
      }

      render(<StatsTab />)

      expect(screen.getByTestId('model-chart-plan')).toBeInTheDocument()
      expect(screen.getByTestId('model-chart-execution')).toBeInTheDocument()
    })

    it('handles very large numbers in token counts', () => {
      mockStatsReturn = {
        ...defaultMockStats,
        usageStats: {
          ...defaultMockStats.usageStats,
          totalTokens: 1_500_000_000,
          totalCost: 9999.99,
        },
      }

      render(<StatsTab />)

      // Very large numbers are shown in millions (1500.0M) since formatNumber uses M suffix for millions
      expect(screen.getByTestId('tokens-7d')).toHaveTextContent('1500.0M')
    })

    it('handles single data point in time series', () => {
      mockStatsReturn = {
        ...defaultMockStats,
        dailyUsage7d: [{ date: '2024-01-21', tokens: 100000, cost: 0.50 }],
      }

      render(<StatsTab />)

      expect(screen.getByText('Token & Cost Over Time (7 Days)')).toBeInTheDocument()
    })

    it('handles fractional review averages', () => {
      mockStatsReturn = {
        ...defaultMockStats,
        taskStats: { ...defaultMockStats.taskStats, averageReviews: 2.75 },
      }

      render(<StatsTab />)

      expect(screen.getByTestId('avg-reviews')).toHaveTextContent('2.8') // rounded to 1 decimal
    })
  })

  describe('Integration with useStats', () => {
    it('uses default values when hook returns empty data', () => {
      mockStatsReturn = {
        usageStats: { totalTokens: 0, totalCost: 0, tokenChange: 0, costChange: 0 },
        taskStats: { completed: 0, failed: 0, averageReviews: 0 },
        modelUsage: { plan: [], execution: [], review: [] },
        averageDuration: 0,
        hourlyUsage: [],
        dailyUsage7d: [],
        dailyUsage30d: [],
        isLoading: false,
        error: null,
        loadAllStats: mockLoadAllStats,
      }

      render(<StatsTab />)

      expect(screen.getByTestId('completed-count')).toHaveTextContent('0')
      expect(screen.getByTestId('failed-count')).toHaveTextContent('0')
      expect(screen.getByTestId('avg-duration')).toHaveTextContent('0m')
    })

    it('displays all data returned from hook', () => {
      render(<StatsTab />)

      // Verify all hook data is displayed
      expect(screen.getByTestId('completed-count')).toHaveTextContent(String(defaultMockStats.taskStats.completed))
      expect(screen.getByTestId('failed-count')).toHaveTextContent(String(defaultMockStats.taskStats.failed))
      expect(screen.getByTestId('avg-reviews')).toHaveTextContent(defaultMockStats.taskStats.averageReviews.toFixed(1))
    })
  })
})
