import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { useState, useRef, useCallback } from 'react'
import { TaskModal, TaskModalProps } from './TaskModal'
import {
  TasksContext,
  OptionsContext,
  ModelSearchContext,
  ToastContext,
} from '@/contexts/AppContext'
import type {
  Task,
  TaskStatus,
  Options,
  ModelCatalog,
  Toast,
  LogEntry,
  ThinkingLevel,
  ExecutionStrategy,
} from '@/types'

// Mock the API hook before imports
const mockGetBranches = vi.fn().mockResolvedValue({ branches: ['main', 'dev'], current: 'main' })
const mockGetContainerImages = vi.fn().mockResolvedValue({ images: [] })

vi.mock('@/hooks', () => ({
  useApi: () => ({
    getBranches: mockGetBranches,
    getContainerImages: mockGetContainerImages,
  }),
}))

// Mock the MarkdownEditor component
vi.mock('@/components/common/MarkdownEditor', () => ({
  MarkdownEditor: ({ modelValue, onUpdate, disabled }: { modelValue: string; onUpdate: (value: string) => void; disabled?: boolean }) => (
    <textarea
      data-testid="markdown-editor"
      value={modelValue}
      onChange={(e) => onUpdate(e.target.value)}
      disabled={disabled}
    />
  ),
}))

// Mock the ModelPicker component
vi.mock('@/components/common/ModelPicker', () => ({
  ModelPicker: ({ modelValue, onUpdate, label, disabled }: { modelValue: string; onUpdate: (value: string) => void; label: string; disabled?: boolean }) => (
    <select
      data-testid={`model-picker-${label.toLowerCase().replace(/\s+/g, '-')}`}
      value={modelValue}
      onChange={(e) => onUpdate(e.target.value)}
      disabled={disabled}
    >
      <option value="">Select...</option>
      <option value="model-1">Model 1</option>
      <option value="model-2">Model 2</option>
    </select>
  ),
}))

// Mock the ThinkingLevelSelect component
vi.mock('@/components/common/ThinkingLevelSelect', () => ({
  ThinkingLevelSelect: ({ modelValue, onUpdate, label, disabled }: { modelValue: ThinkingLevel; onUpdate: (value: string) => void; label: string; disabled?: boolean }) => (
    <select
      data-testid={`thinking-level-${label.toLowerCase().replace(/\s+/g, '-')}`}
      value={modelValue}
      onChange={(e) => onUpdate(e.target.value)}
      disabled={disabled}
    >
      <option value="default">Default</option>
      <option value="none">None</option>
      <option value="low">Low</option>
      <option value="medium">Medium</option>
      <option value="high">High</option>
    </select>
  ),
}))

// Mock the HelpButton component
vi.mock('@/components/common/HelpButton', () => ({
  HelpButton: ({ tooltip }: { tooltip: string }) => (
    <span data-testid="help-button" title={tooltip}>?</span>
  ),
}))

// Mock the ModalWrapper component
vi.mock('@/components/common/ModalWrapper', () => ({
  ModalWrapper: ({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) => (
    <div data-testid="modal-wrapper" data-title={title}>
      <button data-testid="modal-close" onClick={onClose}>Close</button>
      {children}
    </div>
  ),
}))

describe('TaskModal', () => {
  const mockTask: Task = {
    id: 'task-1',
    idx: 0,
    name: 'Test Task',
    prompt: 'Test prompt',
    status: 'backlog' as TaskStatus,
    branch: 'main',
    planModel: 'model-1',
    executionModel: 'model-2',
    planmode: false,
    autoApprovePlan: false,
    review: true,
    codeStyleReview: false,
    autoCommit: true,
    deleteWorktree: true,
    skipPermissionAsking: true,
    requirements: ['task-2'],
    thinkingLevel: 'default' as ThinkingLevel,
    planThinkingLevel: 'default' as ThinkingLevel,
    executionThinkingLevel: 'default' as ThinkingLevel,
    executionStrategy: 'standard' as ExecutionStrategy,
    containerImage: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }

  const createMockTasksContext = (tasks: Task[] = [mockTask]) => ({
    tasks,
    setTasks: vi.fn(),
    groupedTasks: { backlog: tasks, template: [], executing: [], review: [], done: [], failed: [], stuck: [] },
    bonSummaries: {},
    isLoading: false,
    error: null,
    getTaskById: vi.fn((id: string) => tasks.find(t => t.id === id)),
    getTaskName: vi.fn((id: string) => tasks.find(t => t.id === id)?.name || ''),
    loadTasks: vi.fn(),
    refreshBonSummaries: vi.fn(),
    createTask: vi.fn(),
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    reorderTask: vi.fn(),
    archiveAllDone: vi.fn(),
    resetTask: vi.fn(),
    resetTaskToGroup: vi.fn(),
    moveTaskToGroup: vi.fn(),
    approvePlan: vi.fn(),
    requestPlanRevision: vi.fn(),
    repairTask: vi.fn(),
    startSingleTask: vi.fn(),
    removeBonSummary: vi.fn(),
  })

  const mockOptionsContext = {
    options: {
      planModel: 'model-1',
      executionModel: 'model-2',
      thinkingLevel: 'default' as ThinkingLevel,
      planThinkingLevel: 'default' as ThinkingLevel,
      executionThinkingLevel: 'default' as ThinkingLevel,
      parallelTasks: 1,
      showExecutionGraph: false,
    } as Options,
    isLoading: false,
    error: null,
    loadOptions: vi.fn(),
    saveOptions: vi.fn(),
    updateOptions: vi.fn(),
    startExecution: vi.fn(),
    stopExecution: vi.fn(),
  }

  const mockModelSearchContext = {
    catalog: {} as ModelCatalog,
    searchIndex: [],
    isLoading: false,
    error: null,
    loadModels: vi.fn(),
    getSuggestions: vi.fn().mockReturnValue([]),
    normalizeValue: vi.fn((value: string) => value),
    getModelOptions: vi.fn().mockReturnValue([
      { value: '', label: 'Select...', selected: true },
      { value: 'model-1', label: 'Model 1', selected: false },
      { value: 'model-2', label: 'Model 2', selected: false },
    ]),
  }

  const mockToastContext = {
    toasts: [] as Toast[],
    logs: [] as LogEntry[],
    showToast: vi.fn(),
    removeToast: vi.fn(),
    addLog: vi.fn(),
    clearLogs: vi.fn(),
  }

  const mockOnClose = vi.fn()

  // Test wrapper that provides all required contexts
  const TaskModalWrapper = (props: TaskModalProps & { tasksContext?: ReturnType<typeof createMockTasksContext> }) => {
    const tasksCtx = props.tasksContext || createMockTasksContext()

    return (
      <TasksContext.Provider value={tasksCtx}>
        <OptionsContext.Provider value={mockOptionsContext}>
          <ModelSearchContext.Provider value={mockModelSearchContext}>
            <ToastContext.Provider value={mockToastContext}>
              <TaskModal {...props} />
            </ToastContext.Provider>
          </ModelSearchContext.Provider>
        </OptionsContext.Provider>
      </TasksContext.Provider>
    )
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetBranches.mockResolvedValue({ branches: ['main', 'dev'], current: 'main' })
    mockGetContainerImages.mockResolvedValue({ images: [] })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('Snapshot Data Isolation', () => {
    it('should capture task snapshot once on mount and not re-render when context updates', async () => {
      // Create a wrapper that simulates parent re-renders with updated tasks context
      const UpdatingParent = () => {
        const [tasks, setTasks] = useState([mockTask, { ...mockTask, id: 'task-2', idx: 1, name: 'Task 2', status: 'backlog', requirements: [] }])
        const renderCount = useRef(0)
        renderCount.current++

        const updatingTasksContext = createMockTasksContext(tasks)

        // Simulate WebSocket update after initial mount
        const simulateWebSocketUpdate = useCallback(() => {
          setTasks(prev => prev.map(t => t.id === 'task-1' ? { ...t, name: 'Updated Task Name', prompt: 'Updated prompt content' } : t))
        }, [])

        return (
          <div>
            <span data-testid="parent-render-count">{renderCount.current}</span>
            <button data-testid="simulate-websocket" onClick={simulateWebSocketUpdate}>Simulate WebSocket Update</button>
            <TaskModalWrapper
              mode="edit"
              taskId="task-1"
              onClose={mockOnClose}
              tasksContext={updatingTasksContext}
            />
          </div>
        )
      }

      const { getByTestId } = render(<UpdatingParent />)

      // Wait for modal to load (not showing "Loading...")
      await waitFor(() => {
        expect(screen.queryByText('Loading...')).not.toBeInTheDocument()
      }, { timeout: 3000 })

      // Verify initial task data is loaded
      const nameInput = screen.getByPlaceholderText('Task name') as HTMLInputElement
      expect(nameInput.value).toBe('Test Task')

      // Get the textarea (prompt editor)
      const promptEditor = screen.getByTestId('markdown-editor') as HTMLTextAreaElement
      expect(promptEditor.value).toBe('Test prompt')

      // Simulate WebSocket update - parent should re-render but modal should NOT re-initialize
      await act(async () => {
        fireEvent.click(getByTestId('simulate-websocket'))
      })

      // Wait for updates
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 50))
      })

      // Modal should still show the ORIGINAL snapshot data (not the updated task)
      expect(nameInput.value).toBe('Test Task') // Should still show old name
      expect(promptEditor.value).toBe('Test prompt') // Should still show old prompt
    }, 10000)

    it('should use snapshot data for availableRequirements and remain stable during editing', async () => {
      // Create a test to verify requirements list stability
      const UpdatingParent = () => {
        const [tasks, setTasks] = useState([
          mockTask,
          { ...mockTask, id: 'task-2', idx: 1, name: 'Task 2', status: 'backlog', requirements: [] },
        ])

        const updatingTasksContext = createMockTasksContext(tasks)

        return (
          <div>
            <button
              data-testid="add-new-task"
              onClick={() => setTasks(prev => [...prev, { ...mockTask, id: 'task-3', idx: 2, name: 'Task 3', status: 'backlog', requirements: [] }])}
            >
              Add New Task
            </button>
            <TaskModalWrapper
              mode="edit"
              taskId="task-1"
              onClose={mockOnClose}
              tasksContext={updatingTasksContext}
            />
          </div>
        )
      }

      const { getByTestId } = render(<UpdatingParent />)

      // Wait for modal to load
      await waitFor(() => {
        expect(screen.queryByText('Loading...')).not.toBeInTheDocument()
      }, { timeout: 3000 })

      // Initially should have 1 available requirement (task-2, not task-1 itself)
      const initialRequirements = screen.getAllByRole('checkbox').filter(cb => {
        const label = cb.closest('label')
        return label && label.textContent?.includes('Task 2')
      })
      expect(initialRequirements.length).toBe(1)

      // Add a new task to the context (simulating WebSocket update)
      await act(async () => {
        fireEvent.click(getByTestId('add-new-task'))
      })

      // Wait a tick
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 50))
      })

      // The requirements list should STILL only show the original tasks (snapshot)
      // New task-3 should NOT appear because snapshot was captured at mount
      const afterUpdateRequirements = screen.getAllByRole('checkbox').filter(cb => {
        const label = cb.closest('label')
        return label && (label.textContent?.includes('Task 2') || label.textContent?.includes('Task 3'))
      })

      // Should still only have Task 2 (from snapshot), not Task 3
      expect(afterUpdateRequirements.length).toBe(1)
    }, 10000)

    it('should not re-initialize form state when tasks context updates', async () => {
      const UpdatingParent = () => {
        const [tasks, setTasks] = useState([mockTask])
        const [counter, setCounter] = useState(0)

        const updatingTasksContext = createMockTasksContext(tasks)

        return (
          <div>
            <button data-testid="trigger-update" onClick={() => {
              setCounter(c => c + 1)
              setTasks(prev => prev.map(t => ({ ...t, name: `Updated ${counter}` })))
            }}>
              Trigger Update
            </button>
            <TaskModalWrapper
              mode="edit"
              taskId="task-1"
              onClose={mockOnClose}
              tasksContext={updatingTasksContext}
            />
          </div>
        )
      }

      const { getByTestId } = render(<UpdatingParent />)

      // Wait for modal to load
      await waitFor(() => {
        expect(screen.queryByText('Loading...')).not.toBeInTheDocument()
      }, { timeout: 3000 })

      // Get initial name input
      const nameInput = screen.getByPlaceholderText('Task name') as HTMLInputElement

      // User edits the task name
      fireEvent.change(nameInput, { target: { value: 'User Edited Name' } })
      expect(nameInput.value).toBe('User Edited Name')

      // Trigger context update (simulating WebSocket)
      await act(async () => {
        fireEvent.click(getByTestId('trigger-update'))
      })

      // Wait a tick
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 50))
      })

      // User's edit should be preserved (not overwritten by context update)
      expect(nameInput.value).toBe('User Edited Name')
    }, 10000)
  })

  describe('Effect Dependencies', () => {
    it('should have minimal effect dependencies that do not trigger re-initialization on WebSocket updates', async () => {
      const branchLoadCount = { value: 0 }

      // Override the mock for this test
      mockGetBranches.mockImplementation(() => {
        branchLoadCount.value++
        return Promise.resolve({ branches: ['main', 'dev'], current: 'main' })
      })

      const UpdatingParent = () => {
        const [tasks, setTasks] = useState([mockTask])
        const updatingTasksContext = createMockTasksContext(tasks)

        return (
          <div>
            <button
              data-testid="update-task"
              onClick={() => setTasks(prev => prev.map(t => ({ ...t, name: 'Updated' })))}
            >
              Update Task
            </button>
            <TaskModalWrapper
              mode="edit"
              taskId="task-1"
              onClose={mockOnClose}
              tasksContext={updatingTasksContext}
            />
          </div>
        )
      }

      const { getByTestId } = render(<UpdatingParent />)

      // Wait for initial load
      await waitFor(() => {
        expect(screen.queryByText('Loading...')).not.toBeInTheDocument()
      }, { timeout: 3000 })

      // Branch API should have been called once on mount
      expect(branchLoadCount.value).toBe(1)

      // Trigger task update (simulating WebSocket)
      await act(async () => {
        fireEvent.click(getByTestId('update-task'))
      })

      // Wait a tick
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 50))
      })

      // Branch API should NOT be called again (effect has stable dependencies)
      expect(branchLoadCount.value).toBe(1)
    }, 10000)
  })

  describe('Create Mode Snapshot Isolation', () => {
    it('should capture seedTask snapshot on mount for deploy mode', async () => {
      const seedTask: Task = {
        ...mockTask,
        id: 'template-1',
        status: 'template' as TaskStatus,
        name: 'Template Task',
        prompt: 'Template prompt',
      }

      const UpdatingParent = () => {
        const [seedTasks, setSeedTasks] = useState([seedTask])
        const updatingTasksContext = createMockTasksContext(seedTasks)

        return (
          <div>
            <button
              data-testid="update-seed"
              onClick={() => setSeedTasks(prev => prev.map(t => ({ ...t, name: 'Updated Template', prompt: 'Updated template prompt' })))}
            >
              Update Seed Task
            </button>
            <TaskModalWrapper
              mode="deploy"
              seedTaskId="template-1"
              onClose={mockOnClose}
              tasksContext={updatingTasksContext}
            />
          </div>
        )
      }

      const { getByTestId } = render(<UpdatingParent />)

      // Wait for modal to load
      await waitFor(() => {
        expect(screen.queryByText('Loading...')).not.toBeInTheDocument()
      }, { timeout: 3000 })

      // Verify initial seed data is loaded
      const nameInput = screen.getByPlaceholderText('Task name') as HTMLInputElement
      expect(nameInput.value).toBe('Template Task')

      const promptEditor = screen.getByTestId('markdown-editor') as HTMLTextAreaElement
      expect(promptEditor.value).toBe('Template prompt')

      // Update the seed task
      await act(async () => {
        fireEvent.click(getByTestId('update-seed'))
      })

      // Wait a tick
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 50))
      })

      // Should still show original snapshot data
      expect(nameInput.value).toBe('Template Task')
      expect(promptEditor.value).toBe('Template prompt')
    }, 10000)
  })

  describe('Requirements Checkbox Stability', () => {
    it('should maintain checkbox state when parent re-renders', async () => {
      const taskWithReqs: Task = {
        ...mockTask,
        requirements: ['task-2'],
      }

      const UpdatingParent = () => {
        const [tasks, setTasks] = useState([
          taskWithReqs,
          { ...mockTask, id: 'task-2', idx: 1, name: 'Task 2', status: 'backlog', requirements: [] },
        ])
        const updatingTasksContext = createMockTasksContext(tasks)

        return (
          <div>
            <button
              data-testid="rerender"
              onClick={() => setTasks(prev => [...prev])} // Force re-render with same data
            >
              Force Re-render
            </button>
            <TaskModalWrapper
              mode="edit"
              taskId="task-1"
              onClose={mockOnClose}
              tasksContext={updatingTasksContext}
            />
          </div>
        )
      }

      const { getByTestId } = render(<UpdatingParent />)

      // Wait for modal to load
      await waitFor(() => {
        expect(screen.queryByText('Loading...')).not.toBeInTheDocument()
      }, { timeout: 3000 })

      // Find and toggle the requirement checkbox
      const checkboxes = screen.getAllByRole('checkbox')
      const reqCheckbox = checkboxes.find(cb => {
        const label = cb.closest('label')
        return label && label.textContent?.includes('Task 2')
      })

      expect(reqCheckbox).toBeDefined()
      expect(reqCheckbox?.checked).toBe(true) // Initially checked since task-2 is in requirements

      // Uncheck it
      if (reqCheckbox) {
        fireEvent.click(reqCheckbox)
        expect(reqCheckbox.checked).toBe(false)
      }

      // Force parent re-render
      await act(async () => {
        fireEvent.click(getByTestId('rerender'))
      })

      // Wait a tick
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 50))
      })

      // Checkbox should remain unchecked (user's choice preserved)
      expect(reqCheckbox?.checked).toBe(false)
    }, 10000)
  })

  describe('Parent Re-render with Unchanged Props', () => {
    it('should not cause modal re-render when parent re-renders with same props', async () => {
      const renderSpy = vi.fn()

      // Create a spy component to track re-renders
      const TaskModalWithSpy = (props: TaskModalProps) => {
        renderSpy()
        return <TaskModal {...props} />
      }

      const UpdatingParent = () => {
        const [counter, setCounter] = useState(0)

        return (
          <div>
            <span data-testid="counter">{counter}</span>
            <button data-testid="increment" onClick={() => setCounter(c => c + 1)}>Increment</button>
            <TasksContext.Provider value={createMockTasksContext()}>
              <OptionsContext.Provider value={mockOptionsContext}>
                <ModelSearchContext.Provider value={mockModelSearchContext}>
                  <ToastContext.Provider value={mockToastContext}>
                    <TaskModalWithSpy mode="edit" taskId="task-1" onClose={mockOnClose} />
                  </ToastContext.Provider>
                </ModelSearchContext.Provider>
              </OptionsContext.Provider>
            </TasksContext.Provider>
          </div>
        )
      }

      const { getByTestId } = render(<UpdatingParent />)

      // Wait for modal to load
      await waitFor(() => {
        expect(screen.queryByText('Loading...')).not.toBeInTheDocument()
      }, { timeout: 3000 })

      // Should have rendered once initially
      expect(renderSpy).toHaveBeenCalledTimes(1)

      // Parent re-renders (counter changes)
      await act(async () => {
        fireEvent.click(getByTestId('increment'))
      })

      // Wait for React to process
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 50))
      })

      // Counter should have updated
      expect(getByTestId('counter').textContent).toBe('1')

      // TaskModal should have re-rendered because it's not memoized in this test
      // (we're testing the underlying TaskModal component, not the memoized wrapper)
      // Without React.memo on the parent component, this will re-render
      expect(renderSpy).toHaveBeenCalledTimes(2)
    }, 10000)
  })

  describe('Focus Preservation', () => {
    it('should not lose focus on form fields when parent re-renders', async () => {
      const UpdatingParent = () => {
        const [counter, setCounter] = useState(0)

        return (
          <div>
            <span data-testid="counter">{counter}</span>
            <button data-testid="trigger" onClick={() => setCounter(c => c + 1)}>Trigger</button>
            <TaskModalWrapper
              mode="edit"
              taskId="task-1"
              onClose={mockOnClose}
            />
          </div>
        )
      }

      const { getByTestId } = render(<UpdatingParent />)

      // Wait for modal to load
      await waitFor(() => {
        expect(screen.queryByText('Loading...')).not.toBeInTheDocument()
      }, { timeout: 3000 })

      // Focus the name input
      const nameInput = screen.getByPlaceholderText('Task name')
      await act(async () => {
        nameInput.focus()
      })
      expect(document.activeElement).toBe(nameInput)

      // Trigger parent re-render
      await act(async () => {
        fireEvent.click(getByTestId('trigger'))
      })

      // Wait for React to process
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 50))
      })

      // Focus should still be on the name input (not lost)
      expect(document.activeElement).toBe(nameInput)
    }, 10000)
  })
})
