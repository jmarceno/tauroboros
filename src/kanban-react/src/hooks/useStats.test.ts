import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useStats } from './useStats'
import type { UsageStats, TaskStats, ModelUsageStats, HourlyUsage, DailyUsage } from '@/types'

// Mock TanStack Query hooks
const mockInvalidateQueries = vi.fn()
const mockQueryClient = {
  invalidateQueries: mockInvalidateQueries,
}

interface MockQueryResult<T> {
  data: T | undefined
  isFetching: boolean
  error: Error | null
}

function createMockQueryResult<T>(overrides: Partial<MockQueryResult<T>> = {}): MockQueryResult<T> {
  return {
    data: overrides.data,
    isFetching: overrides.isFetching ?? false,
    error: overrides.error ?? null,
  }
}

// Mock query hook returns - will be controlled per test
let mockUsageQuery = createMockQueryResult<UsageStats>({ data: undefined })
let mockTaskStatsQuery = createMockQueryResult<TaskStats>({ data: undefined })
let mockModelUsageQuery = createMockQueryResult<ModelUsageStats>({ data: undefined })
let mockDurationQuery = createMockQueryResult<number>({ data: undefined })
let mockHourlyQuery = createMockQueryResult<HourlyUsage[]>({ data: undefined })
let mockDaily7Query = createMockQueryResult<DailyUsage[]>({ data: undefined })
let mockDaily30Query = createMockQueryResult<DailyUsage[]>({ data: undefined })

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => mockQueryClient,
}))

vi.mock('@/queries', () => ({
  queryKeys: {
    stats: {
      all: ['stats'],
      usage: (range: string) => ['stats', 'usage', range],
      tasks: ['stats', 'tasks'],
      models: ['stats', 'models'],
      duration: ['stats', 'duration'],
      hourly: ['stats', 'hourly'],
      daily: (days: number) => ['stats', 'daily', days],
    },
  },
  useUsageStatsQuery: vi.fn(() => mockUsageQuery),
  useTaskStatsQuery: vi.fn(() => mockTaskStatsQuery),
  useModelUsageQuery: vi.fn(() => mockModelUsageQuery),
  useAverageDurationQuery: vi.fn(() => mockDurationQuery),
  useHourlyUsageQuery: vi.fn(() => mockHourlyQuery),
  useDailyUsageQuery: vi.fn((days: number) => {
    if (days === 7) return mockDaily7Query
    if (days === 30) return mockDaily30Query
    return createMockQueryResult<DailyUsage[]>({ data: undefined })
  }),
}))

describe('useStats hook', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset all mock queries to default empty state
    mockUsageQuery = createMockQueryResult<UsageStats>({ data: undefined })
    mockTaskStatsQuery = createMockQueryResult<TaskStats>({ data: undefined })
    mockModelUsageQuery = createMockQueryResult<ModelUsageStats>({ data: undefined })
    mockDurationQuery = createMockQueryResult<number>({ data: undefined })
    mockHourlyQuery = createMockQueryResult<HourlyUsage[]>({ data: undefined })
    mockDaily7Query = createMockQueryResult<DailyUsage[]>({ data: undefined })
    mockDaily30Query = createMockQueryResult<DailyUsage[]>({ data: undefined })
  })

  describe('initial state with default values', () => {
    it('returns default usageStats when data is undefined', () => {
      const { result } = renderHook(() => useStats())

      expect(result.current.usageStats).toEqual({
        totalTokens: 0,
        totalCost: 0,
        tokenChange: 0,
        costChange: 0,
      })
    })

    it('returns default taskStats when data is undefined', () => {
      const { result } = renderHook(() => useStats())

      expect(result.current.taskStats).toEqual({
        completed: 0,
        failed: 0,
        averageReviews: 0,
      })
    })

    it('returns default modelUsage when data is undefined', () => {
      const { result } = renderHook(() => useStats())

      expect(result.current.modelUsage).toEqual({
        plan: [],
        execution: [],
        review: [],
      })
    })

    it('returns default averageDuration when data is undefined', () => {
      const { result } = renderHook(() => useStats())

      expect(result.current.averageDuration).toBe(0)
    })

    it('returns empty arrays for usage time series when data is undefined', () => {
      const { result } = renderHook(() => useStats())

      expect(result.current.hourlyUsage).toEqual([])
      expect(result.current.dailyUsage7d).toEqual([])
      expect(result.current.dailyUsage30d).toEqual([])
    })

    it('returns isLoading false when no queries are fetching', () => {
      const { result } = renderHook(() => useStats())

      expect(result.current.isLoading).toBe(false)
    })

    it('returns null error when no queries have errors', () => {
      const { result } = renderHook(() => useStats())

      expect(result.current.error).toBeNull()
    })
  })

  describe('loading state aggregation', () => {
    it('returns isLoading true when usageStats query is fetching', () => {
      mockUsageQuery = createMockQueryResult<UsageStats>({
        data: undefined,
        isFetching: true,
      })

      const { result } = renderHook(() => useStats())

      expect(result.current.isLoading).toBe(true)
    })

    it('returns isLoading true when taskStats query is fetching', () => {
      mockTaskStatsQuery = createMockQueryResult<TaskStats>({
        data: undefined,
        isFetching: true,
      })

      const { result } = renderHook(() => useStats())

      expect(result.current.isLoading).toBe(true)
    })

    it('returns isLoading true when modelUsage query is fetching', () => {
      mockModelUsageQuery = createMockQueryResult<ModelUsageStats>({
        data: undefined,
        isFetching: true,
      })

      const { result } = renderHook(() => useStats())

      expect(result.current.isLoading).toBe(true)
    })

    it('returns isLoading true when duration query is fetching', () => {
      mockDurationQuery = createMockQueryResult<number>({
        data: undefined,
        isFetching: true,
      })

      const { result } = renderHook(() => useStats())

      expect(result.current.isLoading).toBe(true)
    })

    it('returns isLoading true when hourly query is fetching', () => {
      mockHourlyQuery = createMockQueryResult<HourlyUsage[]>({
        data: undefined,
        isFetching: true,
      })

      const { result } = renderHook(() => useStats())

      expect(result.current.isLoading).toBe(true)
    })

    it('returns isLoading true when daily7 query is fetching', () => {
      mockDaily7Query = createMockQueryResult<DailyUsage[]>({
        data: undefined,
        isFetching: true,
      })

      const { result } = renderHook(() => useStats())

      expect(result.current.isLoading).toBe(true)
    })

    it('returns isLoading true when daily30 query is fetching', () => {
      mockDaily30Query = createMockQueryResult<DailyUsage[]>({
        data: undefined,
        isFetching: true,
      })

      const { result } = renderHook(() => useStats())

      expect(result.current.isLoading).toBe(true)
    })

    it('returns isLoading true when multiple queries are fetching', () => {
      mockUsageQuery = createMockQueryResult<UsageStats>({ data: undefined, isFetching: true })
      mockTaskStatsQuery = createMockQueryResult<TaskStats>({ data: undefined, isFetching: true })
      mockDurationQuery = createMockQueryResult<number>({ data: undefined, isFetching: true })

      const { result } = renderHook(() => useStats())

      expect(result.current.isLoading).toBe(true)
    })

    it('returns isLoading false when all queries are idle', () => {
      mockUsageQuery = createMockQueryResult<UsageStats>({ data: undefined, isFetching: false })
      mockTaskStatsQuery = createMockQueryResult<TaskStats>({ data: undefined, isFetching: false })
      mockModelUsageQuery = createMockQueryResult<ModelUsageStats>({ data: undefined, isFetching: false })
      mockDurationQuery = createMockQueryResult<number>({ data: undefined, isFetching: false })
      mockHourlyQuery = createMockQueryResult<HourlyUsage[]>({ data: undefined, isFetching: false })
      mockDaily7Query = createMockQueryResult<DailyUsage[]>({ data: undefined, isFetching: false })
      mockDaily30Query = createMockQueryResult<DailyUsage[]>({ data: undefined, isFetching: false })

      const { result } = renderHook(() => useStats())

      expect(result.current.isLoading).toBe(false)
    })
  })

  describe('error extraction from failed queries', () => {
    it('returns error message from usageStats query error', () => {
      mockUsageQuery = createMockQueryResult<UsageStats>({
        data: undefined,
        error: new Error('Failed to fetch usage stats'),
      })

      const { result } = renderHook(() => useStats())

      expect(result.current.error).toBe('Failed to fetch usage stats')
    })

    it('returns error message from taskStats query error', () => {
      mockTaskStatsQuery = createMockQueryResult<TaskStats>({
        data: undefined,
        error: new Error('Failed to fetch task stats'),
      })

      const { result } = renderHook(() => useStats())

      expect(result.current.error).toBe('Failed to fetch task stats')
    })

    it('returns error message from modelUsage query error', () => {
      mockModelUsageQuery = createMockQueryResult<ModelUsageStats>({
        data: undefined,
        error: new Error('Failed to fetch model usage'),
      })

      const { result } = renderHook(() => useStats())

      expect(result.current.error).toBe('Failed to fetch model usage')
    })

    it('returns error message from duration query error', () => {
      mockDurationQuery = createMockQueryResult<number>({
        data: undefined,
        error: new Error('Failed to fetch duration'),
      })

      const { result } = renderHook(() => useStats())

      expect(result.current.error).toBe('Failed to fetch duration')
    })

    it('returns error message from hourly query error', () => {
      mockHourlyQuery = createMockQueryResult<HourlyUsage[]>({
        data: undefined,
        error: new Error('Failed to fetch hourly usage'),
      })

      const { result } = renderHook(() => useStats())

      expect(result.current.error).toBe('Failed to fetch hourly usage')
    })

    it('returns error message from daily7 query error', () => {
      mockDaily7Query = createMockQueryResult<DailyUsage[]>({
        data: undefined,
        error: new Error('Failed to fetch daily usage (7d)'),
      })

      const { result } = renderHook(() => useStats())

      expect(result.current.error).toBe('Failed to fetch daily usage (7d)')
    })

    it('returns error message from daily30 query error', () => {
      mockDaily30Query = createMockQueryResult<DailyUsage[]>({
        data: undefined,
        error: new Error('Failed to fetch daily usage (30d)'),
      })

      const { result } = renderHook(() => useStats())

      expect(result.current.error).toBe('Failed to fetch daily usage (30d)')
    })

    it('returns first error when multiple queries fail', () => {
      mockUsageQuery = createMockQueryResult<UsageStats>({
        data: undefined,
        error: new Error('First error'),
      })
      mockTaskStatsQuery = createMockQueryResult<TaskStats>({
        data: undefined,
        error: new Error('Second error'),
      })
      mockModelUsageQuery = createMockQueryResult<ModelUsageStats>({
        data: undefined,
        error: new Error('Third error'),
      })

      const { result } = renderHook(() => useStats())

      expect(result.current.error).toBe('First error')
    })

    it('returns error message for non-Error errors with message property', () => {
      mockUsageQuery = createMockQueryResult<UsageStats>({
        data: undefined,
        error: { message: 'Custom error object' } as unknown as Error,
      })

      const { result } = renderHook(() => useStats())

      expect(result.current.error).toBe('Custom error object')
    })

    it('returns string representation for non-Error errors without message', () => {
      mockUsageQuery = createMockQueryResult<UsageStats>({
        data: undefined,
        error: 'string error' as unknown as Error,
      })

      const { result } = renderHook(() => useStats())

      expect(result.current.error).toBe('string error')
    })
  })

  describe('data return from successful queries', () => {
    it('returns usageStats data from query', () => {
      const mockData: UsageStats = {
        totalTokens: 1000000,
        totalCost: 5.50,
        tokenChange: 150000,
        costChange: 0.75,
      }
      mockUsageQuery = createMockQueryResult<UsageStats>({ data: mockData })

      const { result } = renderHook(() => useStats())

      expect(result.current.usageStats).toEqual(mockData)
    })

    it('returns taskStats data from query', () => {
      const mockData: TaskStats = {
        completed: 42,
        failed: 3,
        averageReviews: 1.5,
      }
      mockTaskStatsQuery = createMockQueryResult<TaskStats>({ data: mockData })

      const { result } = renderHook(() => useStats())

      expect(result.current.taskStats).toEqual(mockData)
    })

    it('returns modelUsage data from query', () => {
      const mockData: ModelUsageStats = {
        plan: [{ model: 'claude-3-opus', count: 15 }],
        execution: [{ model: 'claude-3-sonnet', count: 42 }],
        review: [{ model: 'claude-3-haiku', count: 8 }],
      }
      mockModelUsageQuery = createMockQueryResult<ModelUsageStats>({ data: mockData })

      const { result } = renderHook(() => useStats())

      expect(result.current.modelUsage).toEqual(mockData)
    })

    it('returns averageDuration data from query', () => {
      mockDurationQuery = createMockQueryResult<number>({ data: 125000 })

      const { result } = renderHook(() => useStats())

      expect(result.current.averageDuration).toBe(125000)
    })

    it('returns hourlyUsage data from query', () => {
      const mockData: HourlyUsage[] = [
        { hour: '00:00', tokens: 1000, cost: 0.05 },
        { hour: '01:00', tokens: 2000, cost: 0.10 },
      ]
      mockHourlyQuery = createMockQueryResult<HourlyUsage[]>({ data: mockData })

      const { result } = renderHook(() => useStats())

      expect(result.current.hourlyUsage).toEqual(mockData)
    })

    it('returns dailyUsage7d data from query', () => {
      const mockData: DailyUsage[] = [
        { date: '2024-01-01', tokens: 50000, cost: 2.50 },
        { date: '2024-01-02', tokens: 75000, cost: 3.75 },
      ]
      mockDaily7Query = createMockQueryResult<DailyUsage[]>({ data: mockData })

      const { result } = renderHook(() => useStats())

      expect(result.current.dailyUsage7d).toEqual(mockData)
    })

    it('returns dailyUsage30d data from query', () => {
      const mockData: DailyUsage[] = Array.from({ length: 30 }, (_, i) => ({
        date: `2024-01-${String(i + 1).padStart(2, '0')}`,
        tokens: 10000 + i * 1000,
        cost: 0.50 + i * 0.05,
      }))
      mockDaily30Query = createMockQueryResult<DailyUsage[]>({ data: mockData })

      const { result } = renderHook(() => useStats())

      expect(result.current.dailyUsage30d).toHaveLength(30)
      expect(result.current.dailyUsage30d[0]).toEqual({
        date: '2024-01-01',
        tokens: 10000,
        cost: 0.50,
      })
    })
  })

  describe('loadAllStats cache invalidation', () => {
    it('invalidates all stats queries when called', async () => {
      mockInvalidateQueries.mockResolvedValue(undefined)

      const { result } = renderHook(() => useStats())

      await act(async () => {
        await result.current.loadAllStats()
      })

      expect(mockInvalidateQueries).toHaveBeenCalledWith({
        queryKey: ['stats'],
      })
    })

    it('handles invalidateQueries errors gracefully', async () => {
      mockInvalidateQueries.mockRejectedValue(new Error('Cache invalidation failed'))

      const { result } = renderHook(() => useStats())

      // Should not throw - loadAllStats doesn't catch, so we expect rejection
      await expect(result.current.loadAllStats()).rejects.toThrow('Cache invalidation failed')
    })

    it('maintains stable loadAllStats reference across renders', () => {
      const { result, rerender } = renderHook(() => useStats())

      const firstRef = result.current.loadAllStats
      rerender()
      const secondRef = result.current.loadAllStats

      // Should be the same function reference due to useCallback
      expect(firstRef).toBe(secondRef)
    })
  })

  describe('memoization of computed values', () => {
    it('maintains stable isLoading reference when query states unchanged', () => {
      mockUsageQuery = createMockQueryResult<UsageStats>({ data: undefined, isFetching: false })
      mockTaskStatsQuery = createMockQueryResult<TaskStats>({ data: undefined, isFetching: false })
      mockModelUsageQuery = createMockQueryResult<ModelUsageStats>({ data: undefined, isFetching: false })
      mockDurationQuery = createMockQueryResult<number>({ data: undefined, isFetching: false })
      mockHourlyQuery = createMockQueryResult<HourlyUsage[]>({ data: undefined, isFetching: false })
      mockDaily7Query = createMockQueryResult<DailyUsage[]>({ data: undefined, isFetching: false })
      mockDaily30Query = createMockQueryResult<DailyUsage[]>({ data: undefined, isFetching: false })

      const { result, rerender } = renderHook(() => useStats())

      const firstLoading = result.current.isLoading
      rerender()
      const secondLoading = result.current.isLoading

      // Should be the same boolean value
      expect(firstLoading).toBe(secondLoading)
    })

    it('maintains stable error reference when query errors unchanged', () => {
      mockUsageQuery = createMockQueryResult<UsageStats>({
        data: undefined,
        error: new Error('Test error'),
      })

      const { result, rerender } = renderHook(() => useStats())

      const firstError = result.current.error
      rerender()
      const secondError = result.current.error

      // Error string should be stable
      expect(firstError).toBe(secondError)
    })

    it('returns same data references when query data unchanged', () => {
      const usageData: UsageStats = {
        totalTokens: 1000000,
        totalCost: 5.50,
        tokenChange: 150000,
        costChange: 0.75,
      }
      mockUsageQuery = createMockQueryResult<UsageStats>({ data: usageData })

      const { result, rerender } = renderHook(() => useStats())

      const firstStats = result.current.usageStats
      rerender()
      const secondStats = result.current.usageStats

      // Should be the same object reference (from query cache)
      expect(firstStats).toBe(secondStats)
    })

    it('updates isLoading when query fetching state changes', () => {
      mockUsageQuery = createMockQueryResult<UsageStats>({ data: undefined, isFetching: false })

      const { result, rerender } = renderHook(() => useStats())

      expect(result.current.isLoading).toBe(false)

      // Simulate query starting to fetch
      mockUsageQuery = createMockQueryResult<UsageStats>({ data: undefined, isFetching: true })
      rerender()

      expect(result.current.isLoading).toBe(true)
    })

    it('updates error when query error state changes', () => {
      mockUsageQuery = createMockQueryResult<UsageStats>({ data: undefined, error: null })

      const { result, rerender } = renderHook(() => useStats())

      expect(result.current.error).toBeNull()

      // Simulate query error
      mockUsageQuery = createMockQueryResult<UsageStats>({
        data: undefined,
        error: new Error('New error'),
      })
      rerender()

      expect(result.current.error).toBe('New error')
    })
  })

  describe('integration scenarios', () => {
    it('handles mixed loading and error states correctly', () => {
      // Some queries loading, some with errors, some with data
      mockUsageQuery = createMockQueryResult<UsageStats>({
        data: { totalTokens: 1000, totalCost: 0.05, tokenChange: 0, costChange: 0 },
        isFetching: false,
        error: null,
      })
      mockTaskStatsQuery = createMockQueryResult<TaskStats>({
        data: undefined,
        isFetching: true,
        error: null,
      })
      mockModelUsageQuery = createMockQueryResult<ModelUsageStats>({
        data: undefined,
        isFetching: false,
        error: new Error('Model query failed'),
      })

      const { result } = renderHook(() => useStats())

      // Should be loading because taskStats is fetching
      expect(result.current.isLoading).toBe(true)
      // Should have error from model query
      expect(result.current.error).toBe('Model query failed')
      // Should have data from usage query
      expect(result.current.usageStats.totalTokens).toBe(1000)
    })

    it('handles all queries succeeding simultaneously', () => {
      mockUsageQuery = createMockQueryResult<UsageStats>({
        data: { totalTokens: 1000000, totalCost: 5.00, tokenChange: 100000, costChange: 0.50 },
      })
      mockTaskStatsQuery = createMockQueryResult<TaskStats>({
        data: { completed: 100, failed: 5, averageReviews: 2.3 },
      })
      mockModelUsageQuery = createMockQueryResult<ModelUsageStats>({
        data: {
          plan: [{ model: 'claude-3-opus', count: 10 }],
          execution: [{ model: 'claude-3-sonnet', count: 50 }],
          review: [{ model: 'claude-3-haiku', count: 20 }],
        },
      })
      mockDurationQuery = createMockQueryResult<number>({ data: 120000 })
      mockHourlyQuery = createMockQueryResult<HourlyUsage[]>({
        data: [{ hour: '12:00', tokens: 5000, cost: 0.25 }],
      })
      mockDaily7Query = createMockQueryResult<DailyUsage[]>({
        data: [{ date: '2024-01-01', tokens: 100000, cost: 5.00 }],
      })
      mockDaily30Query = createMockQueryResult<DailyUsage[]>({
        data: [{ date: '2024-01-01', tokens: 100000, cost: 5.00 }],
      })

      const { result } = renderHook(() => useStats())

      expect(result.current.isLoading).toBe(false)
      expect(result.current.error).toBeNull()
      expect(result.current.usageStats.totalTokens).toBe(1000000)
      expect(result.current.taskStats.completed).toBe(100)
      expect(result.current.modelUsage.plan[0].model).toBe('claude-3-opus')
      expect(result.current.averageDuration).toBe(120000)
      expect(result.current.hourlyUsage[0].hour).toBe('12:00')
      expect(result.current.dailyUsage7d[0].date).toBe('2024-01-01')
      expect(result.current.dailyUsage30d[0].date).toBe('2024-01-01')
    })

    it('provides working loadAllStats function in hook return', async () => {
      mockInvalidateQueries.mockResolvedValue(undefined)

      const { result } = renderHook(() => useStats())

      expect(typeof result.current.loadAllStats).toBe('function')

      await act(async () => {
        await result.current.loadAllStats()
      })

      expect(mockInvalidateQueries).toHaveBeenCalledTimes(1)
    })
  })
})
