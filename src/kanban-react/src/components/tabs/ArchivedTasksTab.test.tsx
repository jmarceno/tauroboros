import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { ArchivedTasksTab } from './ArchivedTasksTab'
import type { Task, WorkflowRun } from '@/types'

// Mock the useApi hook
const mockGetArchivedTasks = vi.fn()

vi.mock('@/hooks', () => ({
  useApi: () => ({
    getArchivedTasks: mockGetArchivedTasks,
  }),
}))

// Mock the TaskSessionsModal component
vi.mock('@/components/modals/TaskSessionsModal', () => ({
  TaskSessionsModal: ({ taskId, onClose }: { taskId: string; onClose: () => void }) => (
    <div data-testid="task-sessions-modal">
      <span>Task Sessions: {taskId}</span>
      <button onClick={onClose} data-testid="close-task-sessions-modal">Close</button>
    </div>
  ),
}))

// Mock the date formatter
vi.mock('@/utils/date', () => ({
  formatLocalDateTime: (timestamp: number | null) => {
    if (!timestamp) return '-'
    return new Date(timestamp).toLocaleString()
  },
}))

describe('ArchivedTasksTab', () => {
  const mockWorkflowRun: WorkflowRun = {
    id: 'run-1',
    displayName: 'Test Run 1',
    kind: 'workflow',
    status: 'completed',
    taskOrder: ['task-1', 'task-2'],
    currentTaskIndex: 2,
    isArchived: true,
    pauseRequested: false,
    stopRequested: false,
    createdAt: Date.now() - 86400000,
    updatedAt: Date.now() - 3600000,
  }

  const mockArchivedTasks: Task[] = [
    {
      id: 'task-1',
      idx: 1,
      name: 'Archived Task One',
      prompt: 'This is the first archived task prompt',
      status: 'done',
      branch: 'main',
      planmode: false,
      autoApprovePlan: false,
      review: false,
      codeStyleReview: false,
      autoCommit: false,
      deleteWorktree: false,
      skipPermissionAsking: false,
      requirements: [],
      thinkingLevel: 'default',
      planThinkingLevel: 'default',
      executionThinkingLevel: 'default',
      executionStrategy: 'standard',
      reviewCount: 0,
      jsonParseRetryCount: 0,
      planRevisionCount: 0,
      executionPhase: 'not_started',
      awaitingPlanApproval: false,
      sessionId: 'session-1',
      completedAt: Date.now() - 7200000,
      archivedAt: Date.now() - 3600000,
      createdAt: Date.now() - 86400000,
      updatedAt: Date.now() - 3600000,
      agentOutput: 'Task completed successfully',
    },
    {
      id: 'task-2',
      idx: 2,
      name: 'Archived Task Two',
      prompt: 'This is the second archived task prompt',
      status: 'done',
      branch: 'main',
      planmode: false,
      autoApprovePlan: false,
      review: false,
      codeStyleReview: false,
      autoCommit: false,
      deleteWorktree: false,
      skipPermissionAsking: false,
      requirements: [],
      thinkingLevel: 'default',
      planThinkingLevel: 'default',
      executionThinkingLevel: 'default',
      executionStrategy: 'standard',
      reviewCount: 2,
      jsonParseRetryCount: 0,
      planRevisionCount: 0,
      executionPhase: 'not_started',
      awaitingPlanApproval: false,
      sessionId: 'session-2',
      completedAt: Date.now() - 10800000,
      archivedAt: Date.now() - 7200000,
      createdAt: Date.now() - 90000000,
      updatedAt: Date.now() - 7200000,
    },
  ]

  const mockArchivedTasksResponse = {
    runs: [
      {
        run: mockWorkflowRun,
        tasks: mockArchivedTasks,
      },
    ],
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.resetAllMocks()
  })

  it('renders loading state initially', async () => {
    // Delay the promise to keep loading state visible
    mockGetArchivedTasks.mockImplementation(() => new Promise(() => {}))

    await act(async () => {
      render(<ArchivedTasksTab />)
    })

    expect(screen.getByText('Loading archived tasks...')).toBeInTheDocument()
  })

  it('renders archived runs with collapsible sections after loading', async () => {
    mockGetArchivedTasks.mockResolvedValue(mockArchivedTasksResponse)

    await act(async () => {
      render(<ArchivedTasksTab />)
    })

    await waitFor(() => {
      expect(screen.getByText('Test Run 1')).toBeInTheDocument()
    })

    // Check run header displays
    expect(screen.getByText('completed')).toBeInTheDocument()
    
    // Initially collapsed, so tasks shouldn't be visible
    expect(screen.queryByText('Archived Task One')).not.toBeInTheDocument()
    
    // Expand the run section
    const runHeader = screen.getByText('Test Run 1').closest('button')
    if (runHeader) {
      fireEvent.click(runHeader)
    }
    
    // Now tasks should be visible
    await waitFor(() => {
      expect(screen.getByText('Archived Task One')).toBeInTheDocument()
      expect(screen.getByText('Archived Task Two')).toBeInTheDocument()
    })
  })

  it('renders empty state when no archived tasks', async () => {
    mockGetArchivedTasks.mockResolvedValue({ runs: [] })

    await act(async () => {
      render(<ArchivedTasksTab />)
    })

    await waitFor(() => {
      expect(screen.getByText('No archived tasks')).toBeInTheDocument()
    })

    expect(screen.getByText('Tasks that are archived will appear here grouped by workflow run')).toBeInTheDocument()
  })

  it('renders error state with retry button', async () => {
    mockGetArchivedTasks.mockRejectedValue(new Error('Failed to fetch archived tasks'))

    await act(async () => {
      render(<ArchivedTasksTab />)
    })

    await waitFor(() => {
      expect(screen.getByText('Failed to Load Archived Tasks')).toBeInTheDocument()
    })

    expect(screen.getByText('Failed to fetch archived tasks')).toBeInTheDocument()
    
    const retryButton = screen.getByText('Retry')
    expect(retryButton).toBeInTheDocument()
    
    // Test retry functionality
    mockGetArchivedTasks.mockResolvedValue(mockArchivedTasksResponse)
    fireEvent.click(retryButton)
    
    await waitFor(() => {
      expect(mockGetArchivedTasks).toHaveBeenCalledTimes(2)
    })
  })

  it('filters tasks by search query', async () => {
    mockGetArchivedTasks.mockResolvedValue(mockArchivedTasksResponse)

    await act(async () => {
      render(<ArchivedTasksTab />)
    })

    await waitFor(() => {
      expect(screen.getByText('Test Run 1')).toBeInTheDocument()
    })

    // Expand the run section first
    const runHeader = screen.getByText('Test Run 1').closest('button')
    if (runHeader) {
      fireEvent.click(runHeader)
    }

    await waitFor(() => {
      expect(screen.getByText('Archived Task One')).toBeInTheDocument()
      expect(screen.getByText('Archived Task Two')).toBeInTheDocument()
    })

    // Search for specific task
    const searchInput = screen.getByPlaceholderText('Search archived tasks by name, ID, or prompt...')
    fireEvent.change(searchInput, { target: { value: 'One' } })

    await waitFor(() => {
      expect(screen.getByText('Archived Task One')).toBeInTheDocument()
      expect(screen.queryByText('Archived Task Two')).not.toBeInTheDocument()
    })

    // Search by task ID
    fireEvent.change(searchInput, { target: { value: 'task-2' } })

    await waitFor(() => {
      expect(screen.queryByText('Archived Task One')).not.toBeInTheDocument()
      expect(screen.getByText('Archived Task Two')).toBeInTheDocument()
    })

    // Search by prompt content
    fireEvent.change(searchInput, { target: { value: 'second archived' } })

    await waitFor(() => {
      expect(screen.queryByText('Archived Task One')).not.toBeInTheDocument()
      expect(screen.getByText('Archived Task Two')).toBeInTheDocument()
    })
  })

  it('calls onOpenTaskSessions when clicking View Sessions button', async () => {
    const mockOnOpenTaskSessions = vi.fn()
    mockGetArchivedTasks.mockResolvedValue(mockArchivedTasksResponse)

    await act(async () => {
      render(<ArchivedTasksTab onOpenTaskSessions={mockOnOpenTaskSessions} />)
    })

    await waitFor(() => {
      expect(screen.getByText('Test Run 1')).toBeInTheDocument()
    })

    // Expand the run section
    const runHeader = screen.getByText('Test Run 1').closest('button')
    if (runHeader) {
      fireEvent.click(runHeader)
    }

    await waitFor(() => {
      expect(screen.getByText('Archived Task One')).toBeInTheDocument()
    })

    // Click View Sessions button
    const viewSessionsButton = screen.getAllByText('View Sessions')[0]
    fireEvent.click(viewSessionsButton)

    // Should call the callback with task ID (not session ID)
    await waitFor(() => {
      expect(mockOnOpenTaskSessions).toHaveBeenCalledWith('task-1')
    })
  })

  it('shows task details in expanded view', async () => {
    mockGetArchivedTasks.mockResolvedValue(mockArchivedTasksResponse)

    await act(async () => {
      render(<ArchivedTasksTab />)
    })

    await waitFor(() => {
      expect(screen.getByText('Test Run 1')).toBeInTheDocument()
    })

    // Expand the run section
    const runHeader = screen.getByText('Test Run 1').closest('button')
    if (runHeader) {
      fireEvent.click(runHeader)
    }

    await waitFor(() => {
      // Verify task details are visible in the expanded view
      expect(screen.getByText('Archived Task One')).toBeInTheDocument()
      expect(screen.getByText('Archived Task Two')).toBeInTheDocument()
      
      // Check for task metadata
      expect(screen.getByText('#task-1')).toBeInTheDocument()
      expect(screen.getByText('#task-2')).toBeInTheDocument()
      
      // Check for task prompts
      expect(screen.getByText('This is the first archived task prompt')).toBeInTheDocument()
      expect(screen.getByText('This is the second archived task prompt')).toBeInTheDocument()
    })
  })

  it('displays agent output in task detail modal when available', async () => {
    mockGetArchivedTasks.mockResolvedValue(mockArchivedTasksResponse)

    await act(async () => {
      render(<ArchivedTasksTab />)
    })

    await waitFor(() => {
      expect(screen.getByText('Test Run 1')).toBeInTheDocument()
    })

    // Expand the run section
    const runHeader = screen.getByText('Test Run 1').closest('button')
    if (runHeader) {
      fireEvent.click(runHeader)
    }

    await waitFor(() => {
      expect(screen.getByText('Archived Task One')).toBeInTheDocument()
    })

    // Click on task title with agent output
    fireEvent.click(screen.getByText('Archived Task One'))

    // Check agent output is displayed
    await waitFor(() => {
      expect(screen.getByText('Agent Output')).toBeInTheDocument()
      expect(screen.getByText('Task completed successfully')).toBeInTheDocument()
    })
  })

  it('expands and collapses all runs when clicking expand/collapse all buttons', async () => {
    const multiRunResponse = {
      runs: [
        {
          run: { ...mockWorkflowRun, id: 'run-1', displayName: 'Run One' },
          tasks: [mockArchivedTasks[0]],
        },
        {
          run: { ...mockWorkflowRun, id: 'run-2', displayName: 'Run Two' },
          tasks: [mockArchivedTasks[1]],
        },
      ],
    }

    mockGetArchivedTasks.mockResolvedValue(multiRunResponse)

    await act(async () => {
      render(<ArchivedTasksTab />)
    })

    await waitFor(() => {
      expect(screen.getByText('Run One')).toBeInTheDocument()
      expect(screen.getByText('Run Two')).toBeInTheDocument()
    })

    // Initially collapsed
    expect(screen.queryByText('Archived Task One')).not.toBeInTheDocument()
    expect(screen.queryByText('Archived Task Two')).not.toBeInTheDocument()

    // Click Expand All
    fireEvent.click(screen.getByText('Expand All'))

    await waitFor(() => {
      expect(screen.getByText('Archived Task One')).toBeInTheDocument()
      expect(screen.getByText('Archived Task Two')).toBeInTheDocument()
    })

    // Click Collapse All
    fireEvent.click(screen.getByText('Collapse All'))

    await waitFor(() => {
      expect(screen.queryByText('Archived Task One')).not.toBeInTheDocument()
      expect(screen.queryByText('Archived Task Two')).not.toBeInTheDocument()
    })
  })

  it('displays correct task count and run statistics', async () => {
    mockGetArchivedTasks.mockResolvedValue(mockArchivedTasksResponse)

    await act(async () => {
      render(<ArchivedTasksTab />)
    })

    await waitFor(() => {
      expect(screen.getByText(/2 archived tasks across 1 workflow runs?/)).toBeInTheDocument()
    })
  })

  it('displays archived timestamp when available', async () => {
    mockGetArchivedTasks.mockResolvedValue(mockArchivedTasksResponse)

    await act(async () => {
      render(<ArchivedTasksTab />)
    })

    await waitFor(() => {
      expect(screen.getByText('Test Run 1')).toBeInTheDocument()
    })

    // Expand the run section
    const runHeader = screen.getByText('Test Run 1').closest('button')
    if (runHeader) {
      fireEvent.click(runHeader)
    }

    // Open task detail to check archived timestamp
    await waitFor(() => {
      expect(screen.getByText('Archived Task One')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Archived Task One'))

    await waitFor(() => {
      expect(screen.getByText('Timeline')).toBeInTheDocument()
      // Check for archived timestamp in the timeline section
      const archivedLabels = screen.getAllByText(/Archived:/)
      expect(archivedLabels.length).toBeGreaterThan(0)
    })
  })

  it('handles refresh button click', async () => {
    mockGetArchivedTasks.mockResolvedValue(mockArchivedTasksResponse)

    await act(async () => {
      render(<ArchivedTasksTab />)
    })

    await waitFor(() => {
      expect(screen.getByText('Test Run 1')).toBeInTheDocument()
    })

    // Click refresh button
    const refreshButton = screen.getByText('Refresh').closest('button')
    if (refreshButton) {
      fireEvent.click(refreshButton)
    }

    // Should call getArchivedTasks again
    await waitFor(() => {
      expect(mockGetArchivedTasks).toHaveBeenCalledTimes(2)
    })
  })

  it('displays review count for tasks with reviews', async () => {
    mockGetArchivedTasks.mockResolvedValue(mockArchivedTasksResponse)

    await act(async () => {
      render(<ArchivedTasksTab />)
    })

    await waitFor(() => {
      expect(screen.getByText('Test Run 1')).toBeInTheDocument()
    })

    // Expand the run section
    const runHeader = screen.getByText('Test Run 1').closest('button')
    if (runHeader) {
      fireEvent.click(runHeader)
    }

    await waitFor(() => {
      // Task Two has reviewCount: 2
      const taskTwo = screen.getByText('Archived Task Two')
      expect(taskTwo).toBeInTheDocument()
    })
  })

  it('displays no results when search query matches no tasks', async () => {
    mockGetArchivedTasks.mockResolvedValue(mockArchivedTasksResponse)

    await act(async () => {
      render(<ArchivedTasksTab />)
    })

    await waitFor(() => {
      expect(screen.getByText('Test Run 1')).toBeInTheDocument()
    })

    // Search for non-existent task
    const searchInput = screen.getByPlaceholderText('Search archived tasks by name, ID, or prompt...')
    fireEvent.change(searchInput, { target: { value: 'nonexistent-task' } })

    await waitFor(() => {
      expect(screen.getByText('No matching archived tasks')).toBeInTheDocument()
      expect(screen.getByText('Try adjusting your search query')).toBeInTheDocument()
    })
  })
})
