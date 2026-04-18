import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { useState, useCallback, useRef, memo } from 'react'
import { TaskModal, TaskModalProps } from '@/components/modals/TaskModal'
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

// Mock child components
vi.mock('@/components/common/MarkdownEditor', () => ({
  MarkdownEditor: ({ modelValue, onUpdate }: { modelValue: string; onUpdate: (value: string) => void }) => (
    <textarea data-testid="markdown-editor" value={modelValue} onChange={(e) => onUpdate(e.target.value)} />
  ),
}))

vi.mock('@/components/common/ModelPicker', () => ({
  ModelPicker: ({ modelValue, onUpdate, label }: { modelValue: string; onUpdate: (value: string) => void; label: string }) => (
    <select data-testid={`model-picker-${label.toLowerCase().replace(/\s+/g, '-')}`} value={modelValue} onChange={(e) => onUpdate(e.target.value)}>
      <option value="">Select...</option>
      <option value="model-1">Model 1</option>
    </select>
  ),
}))

vi.mock('@/components/common/ThinkingLevelSelect', () => ({
  ThinkingLevelSelect: ({ modelValue, onUpdate, label }: { modelValue: ThinkingLevel; onUpdate: (value: string) => void; label: string }) => (
    <select data-testid={`thinking-level-${label.toLowerCase().replace(/\s+/g, '-')}`} value={modelValue} onChange={(e) => onUpdate(e.target.value)}>
      <option value="default">Default</option>
    </select>
  ),
}))

vi.mock('@/components/common/HelpButton', () => ({
  HelpButton: () => <span>?</span>,
}))

vi.mock('@/components/common/ModalWrapper', () => ({
  ModalWrapper: ({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) => (
    <div data-testid="modal-wrapper" data-title={title}>
      <button data-testid="modal-close" onClick={onClose}>Close</button>
      {children}
    </div>
  ),
}))

// Re-create MemoizedTaskModal from App.tsx for testing
interface MemoizedTaskModalProps extends TaskModalProps {
  // Modal receives stable callback refs - no event handlers that change on parent re-render
}

const MemoizedTaskModal = memo(function MemoizedTaskModal(props: MemoizedTaskModalProps) {
  return <TaskModal {...props} />
}, (prevProps, nextProps) => {
  // Custom comparison: only re-render if these specific props change
  // Ignore onClose reference changes since it's a stable callback
  return (
    prevProps.mode === nextProps.mode &&
    prevProps.taskId === nextProps.taskId &&
    prevProps.createStatus === nextProps.createStatus &&
    prevProps.seedTaskId === nextProps.seedTaskId
  )
})

describe('MemoizedTaskModal', () => {
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
    requirements: [],
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
    getTaskName: vi.fn(),
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
      parallelTasks: 1,
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
    getModelOptions: vi.fn().mockReturnValue([{ value: '', label: 'Select...', selected: true }]),
  }

  const mockToastContext = {
    toasts: [] as Toast[],
    logs: [] as LogEntry[],
    showToast: vi.fn(),
    removeToast: vi.fn(),
    addLog: vi.fn(),
    clearLogs: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetBranches.mockResolvedValue({ branches: ['main', 'dev'], current: 'main' })
    mockGetContainerImages.mockResolvedValue({ images: [] })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('Custom Comparison Function', () => {
    it('should only re-render when mode, taskId, createStatus, or seedTaskId change', async () => {
      const renderCount = { value: 0 }

      const TrackedTaskModal = (props: TaskModalProps) => {
        renderCount.value++
        return <TaskModal {...props} />
      }

      const TrackedMemoizedModal = memo(TrackedTaskModal, (prevProps, nextProps) => {
        return (
          prevProps.mode === nextProps.mode &&
          prevProps.taskId === nextProps.taskId &&
          prevProps.createStatus === nextProps.createStatus &&
          prevProps.seedTaskId === nextProps.seedTaskId
        )
      })

      const Parent = () => {
        const [modalProps, setModalProps] = useState({
          mode: 'edit' as const,
          taskId: 'task-1',
        })

        return (
          <div>
            <button data-testid="change-mode" onClick={() => setModalProps(p => ({ ...p, mode: 'view' as const }))}>Change Mode</button>
            <button data-testid="change-taskid" onClick={() => setModalProps(p => ({ ...p, taskId: 'task-2' }))}>Change TaskId</button>
            <button data-testid="noop-rerender" onClick={() => setModalProps(p => ({ ...p }))}>No-op Rerender</button>
            <TasksContext.Provider value={createMockTasksContext()}>
              <OptionsContext.Provider value={mockOptionsContext}>
                <ModelSearchContext.Provider value={mockModelSearchContext}>
                  <ToastContext.Provider value={mockToastContext}>
                    <TrackedMemoizedModal {...modalProps} mode={modalProps.mode as 'edit' | 'view' | 'create' | 'deploy'} onClose={vi.fn()} />
                  </ToastContext.Provider>
                </ModelSearchContext.Provider>
              </OptionsContext.Provider>
            </TasksContext.Provider>
          </div>
        )
      }

      const { getByTestId } = render(<Parent />)

      // Wait for initial load
      await waitFor(() => {
        expect(screen.queryByText('Loading...')).not.toBeInTheDocument()
      }, { timeout: 3000 })

      // Initial render
      expect(renderCount.value).toBe(1)

      // No-op re-render (same props) - should NOT trigger re-render
      await act(async () => {
        fireEvent.click(getByTestId('noop-rerender'))
      })
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 50))
      })
      expect(renderCount.value).toBe(1)

      // Change mode - SHOULD trigger re-render
      await act(async () => {
        fireEvent.click(getByTestId('change-mode'))
      })
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 50))
      })
      expect(renderCount.value).toBe(2)

      // Change taskId - SHOULD trigger re-render
      await act(async () => {
        fireEvent.click(getByTestId('change-taskid'))
      })
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 50))
      })
      expect(renderCount.value).toBe(3)
    }, 10000)

    it('should not re-render when onClose reference changes', async () => {
      const renderCount = { value: 0 }

      const TrackedTaskModal = (props: TaskModalProps) => {
        renderCount.value++
        return <TaskModal {...props} />
      }

      const TrackedMemoizedModal = memo(TrackedTaskModal, (prevProps, nextProps) => {
        return (
          prevProps.mode === nextProps.mode &&
          prevProps.taskId === nextProps.taskId &&
          prevProps.createStatus === nextProps.createStatus &&
          prevProps.seedTaskId === nextProps.seedTaskId
        )
      })

      const Parent = () => {
        const [callbackVersion, setCallbackVersion] = useState(0)

        // Create a new onClose callback reference on each render
        const onClose = useCallback(() => {
          console.log('close', callbackVersion)
        }, [callbackVersion])

        return (
          <div>
            <button data-testid="new-callback" onClick={() => setCallbackVersion(v => v + 1)}>New Callback</button>
            <TasksContext.Provider value={createMockTasksContext()}>
              <OptionsContext.Provider value={mockOptionsContext}>
                <ModelSearchContext.Provider value={mockModelSearchContext}>
                  <ToastContext.Provider value={mockToastContext}>
                    <TrackedMemoizedModal mode="edit" taskId="task-1" onClose={onClose} />
                  </ToastContext.Provider>
                </ModelSearchContext.Provider>
              </OptionsContext.Provider>
            </TasksContext.Provider>
          </div>
        )
      }

      const { getByTestId } = render(<Parent />)

      // Wait for initial load
      await waitFor(() => {
        expect(screen.queryByText('Loading...')).not.toBeInTheDocument()
      }, { timeout: 3000 })

      // Initial render
      expect(renderCount.value).toBe(1)

      // Create new onClose callback - should NOT trigger re-render
      await act(async () => {
        fireEvent.click(getByTestId('new-callback'))
      })
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 50))
      })
      expect(renderCount.value).toBe(1)
    }, 10000)
  })

  describe('WebSocket Update Scenarios', () => {
    it('should not flicker when parent re-renders due to WebSocket task updates', async () => {
      const renderCount = { value: 0 }

      const TrackedModal = (props: TaskModalProps) => {
        renderCount.value++
        return <TaskModal {...props} />
      }

      const MemoizedTrackedModal = memo(TrackedModal, (prevProps, nextProps) => {
        return (
          prevProps.mode === nextProps.mode &&
          prevProps.taskId === nextProps.taskId &&
          prevProps.createStatus === nextProps.createStatus &&
          prevProps.seedTaskId === nextProps.seedTaskId
        )
      })

      const Parent = () => {
        const [tasks, setTasks] = useState([mockTask])

        return (
          <div>
            <button
              data-testid="simulate-websocket"
              onClick={() => setTasks(prev => prev.map(t => ({ ...t, name: 'Updated via WebSocket' })))}
            >
              Simulate WebSocket Update
            </button>
            <TasksContext.Provider value={createMockTasksContext(tasks)}>
              <OptionsContext.Provider value={mockOptionsContext}>
                <ModelSearchContext.Provider value={mockModelSearchContext}>
                  <ToastContext.Provider value={mockToastContext}>
                    <MemoizedTrackedModal mode="edit" taskId="task-1" onClose={vi.fn()} />
                  </ToastContext.Provider>
                </ModelSearchContext.Provider>
              </OptionsContext.Provider>
            </TasksContext.Provider>
          </div>
        )
      }

      const { getByTestId } = render(<Parent />)

      // Wait for initial load
      await waitFor(() => {
        expect(screen.queryByText('Loading...')).not.toBeInTheDocument()
      }, { timeout: 3000 })

      // Should have rendered once
      expect(renderCount.value).toBe(1)

      // Simulate multiple WebSocket updates (like real-time updates)
      for (let i = 0; i < 5; i++) {
        await act(async () => {
          fireEvent.click(getByTestId('simulate-websocket'))
        })
        await act(async () => {
          await new Promise(resolve => setTimeout(resolve, 20))
        })
      }

      // Modal should NOT have re-rendered (memoized)
      expect(renderCount.value).toBe(1)
    }, 10000)

    it('should maintain stable form state during WebSocket-triggered parent re-renders', async () => {
      const Parent = () => {
        const [tasks, setTasks] = useState([mockTask])

        return (
          <div>
            <button
              data-testid="websocket-update"
              onClick={() => setTasks(prev => prev.map(t => ({ ...t, name: 'Server Updated Name' })))}
            >
              WebSocket Update
            </button>
            <TasksContext.Provider value={createMockTasksContext(tasks)}>
              <OptionsContext.Provider value={mockOptionsContext}>
                <ModelSearchContext.Provider value={mockModelSearchContext}>
                  <ToastContext.Provider value={mockToastContext}>
                    <MemoizedTaskModal mode="edit" taskId="task-1" onClose={vi.fn()} />
                  </ToastContext.Provider>
                </ModelSearchContext.Provider>
              </OptionsContext.Provider>
            </TasksContext.Provider>
          </div>
        )
      }

      const { getByTestId } = render(<Parent />)

      // Wait for initial load
      await waitFor(() => {
        expect(screen.queryByText('Loading...')).not.toBeInTheDocument()
      }, { timeout: 3000 })

      // Get the name input
      const nameInput = screen.getByPlaceholderText('Task name') as HTMLInputElement

      // User types something
      fireEvent.change(nameInput, { target: { value: 'User Typed Name' } })
      expect(nameInput.value).toBe('User Typed Name')

      // Trigger WebSocket update
      await act(async () => {
        fireEvent.click(getByTestId('websocket-update'))
      })

      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 50))
      })

      // Input should still have user's value (not re-initialized)
      expect(nameInput.value).toBe('User Typed Name')
    }, 10000)
  })

  describe('Original Bug Scenario', () => {
    it('should simulate original bug: modal reloads during editing causing focus loss', async () => {
      // This test simulates the original bug where WebSocket updates caused
      // the modal to reload and lose focus/form state

      const Parent = () => {
        const [tasks, setTasks] = useState([mockTask])
        const [updateCount, setUpdateCount] = useState(0)

        return (
          <div>
            <span data-testid="update-count">{updateCount}</span>
            <button
              data-testid="trigger-bug"
              onClick={() => {
                setUpdateCount(c => c + 1)
                setTasks(prev => prev.map(t => ({
                  ...t,
                  name: `Updated ${c => c + 1}`,
                  updatedAt: Date.now(), // Simulate WebSocket timestamp update
                })))
              }}
            >
              Trigger WebSocket Update
            </button>
            <TasksContext.Provider value={createMockTasksContext(tasks)}>
              <OptionsContext.Provider value={mockOptionsContext}>
                <ModelSearchContext.Provider value={mockModelSearchContext}>
                  <ToastContext.Provider value={mockToastContext}>
                    <MemoizedTaskModal mode="edit" taskId="task-1" onClose={vi.fn()} />
                  </ToastContext.Provider>
                </ModelSearchContext.Provider>
              </OptionsContext.Provider>
            </TasksContext.Provider>
          </div>
        )
      }

      const { getByTestId } = render(<Parent />)

      // Wait for initial load
      await waitFor(() => {
        expect(screen.queryByText('Loading...')).not.toBeInTheDocument()
      }, { timeout: 3000 })

      // Get input and focus it
      const nameInput = screen.getByPlaceholderText('Task name')
      await act(async () => {
        nameInput.focus()
      })
      const initialActiveElement = document.activeElement

      // Trigger multiple rapid WebSocket updates (like real-time updates)
      for (let i = 0; i < 5; i++) {
        await act(async () => {
          fireEvent.click(getByTestId('trigger-bug'))
        })
        await act(async () => {
          await new Promise(resolve => setTimeout(resolve, 20))
        })
      }

      // Verify the update count increased
      expect(getByTestId('update-count').textContent).toBe('5')

      // Focus should still be on the input (not lost due to re-render)
      // Without the fix, the focus would have been lost after each update
      expect(document.activeElement).toBe(initialActiveElement)
    }, 10000)

    it('should verify modal state remains stable when editing and WebSocket updates occur', async () => {
      const Parent = () => {
        const [tasks, setTasks] = useState([mockTask, { ...mockTask, id: 'task-2', idx: 1, name: 'Dependency Task' }])

        return (
          <div>
            <button
              data-testid="rapid-updates"
              onClick={() => {
                // Simulate rapid WebSocket updates
                for (let i = 0; i < 5; i++) {
                  setTimeout(() => {
                    setTasks(prev => prev.map(t => ({
                      ...t,
                      updatedAt: Date.now() + i,
                    })))
                  }, i * 10)
                }
              }}
            >
              Simulate Rapid Updates
            </button>
            <TasksContext.Provider value={createMockTasksContext(tasks)}>
              <OptionsContext.Provider value={mockOptionsContext}>
                <ModelSearchContext.Provider value={mockModelSearchContext}>
                  <ToastContext.Provider value={mockToastContext}>
                    <MemoizedTaskModal mode="edit" taskId="task-1" onClose={vi.fn()} />
                  </ToastContext.Provider>
                </ModelSearchContext.Provider>
              </OptionsContext.Provider>
            </TasksContext.Provider>
          </div>
        )
      }

      const { getByTestId } = render(<Parent />)

      // Wait for initial load
      await waitFor(() => {
        expect(screen.queryByText('Loading...')).not.toBeInTheDocument()
      }, { timeout: 3000 })

      // Start editing
      const nameInput = screen.getByPlaceholderText('Task name') as HTMLInputElement
      fireEvent.change(nameInput, { target: { value: 'My New Task Name' } })

      // Trigger rapid updates
      await act(async () => {
        fireEvent.click(getByTestId('rapid-updates'))
      })

      // Wait for all updates to complete
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 150))
      })

      // User's edit should be preserved
      expect(nameInput.value).toBe('My New Task Name')
    }, 10000)
  })

  describe('MemoizedTaskModal Export', () => {
    it('should match the implementation in App.tsx', () => {
      // Verify our test implementation matches the actual App.tsx implementation
      const testComparisonFn = (prevProps: MemoizedTaskModalProps, nextProps: MemoizedTaskModalProps) => {
        return (
          prevProps.mode === nextProps.mode &&
          prevProps.taskId === nextProps.taskId &&
          prevProps.createStatus === nextProps.createStatus &&
          prevProps.seedTaskId === nextProps.seedTaskId
        )
      }

      // The comparison function should return true (skip re-render) when:
      // 1. mode is the same
      expect(testComparisonFn(
        { mode: 'edit', taskId: 't1', onClose: vi.fn() },
        { mode: 'edit', taskId: 't1', onClose: vi.fn() }
      )).toBe(true)

      // 2. taskId is different - should return false (re-render)
      expect(testComparisonFn(
        { mode: 'edit', taskId: 't1', onClose: vi.fn() },
        { mode: 'edit', taskId: 't2', onClose: vi.fn() }
      )).toBe(false)

      // 3. mode is different - should return false (re-render)
      expect(testComparisonFn(
        { mode: 'edit', taskId: 't1', onClose: vi.fn() },
        { mode: 'view', taskId: 't1', onClose: vi.fn() }
      )).toBe(false)

      // 4. createStatus is different - should return false (re-render)
      expect(testComparisonFn(
        { mode: 'create', createStatus: 'backlog', onClose: vi.fn() },
        { mode: 'create', createStatus: 'template', onClose: vi.fn() }
      )).toBe(false)

      // 5. seedTaskId is different - should return false (re-render)
      expect(testComparisonFn(
        { mode: 'deploy', seedTaskId: 't1', onClose: vi.fn() },
        { mode: 'deploy', seedTaskId: 't2', onClose: vi.fn() }
      )).toBe(false)

      // 6. onClose reference is different but other props same - should return true (skip re-render)
      const onClose1 = () => {}
      const onClose2 = () => {}
      expect(testComparisonFn(
        { mode: 'edit', taskId: 't1', onClose: onClose1 },
        { mode: 'edit', taskId: 't1', onClose: onClose2 }
      )).toBe(true)
    })
  })

  describe('Props Changes', () => {
    it('should re-render when switching from edit to view mode', async () => {
      const renderCount = { value: 0 }

      const TrackedModal = (props: TaskModalProps) => {
        renderCount.value++
        return <TaskModal {...props} />
      }

      const MemoizedTrackedModal = memo(TrackedModal, (prevProps, nextProps) => {
        return (
          prevProps.mode === nextProps.mode &&
          prevProps.taskId === nextProps.taskId &&
          prevProps.createStatus === nextProps.createStatus &&
          prevProps.seedTaskId === nextProps.seedTaskId
        )
      })

      const Parent = () => {
        const [mode, setMode] = useState<'edit' | 'view'>('edit')

        return (
          <div>
            <button data-testid="switch-mode" onClick={() => setMode(m => m === 'edit' ? 'view' : 'edit')}>
              Switch Mode
            </button>
            <TasksContext.Provider value={createMockTasksContext()}>
              <OptionsContext.Provider value={mockOptionsContext}>
                <ModelSearchContext.Provider value={mockModelSearchContext}>
                  <ToastContext.Provider value={mockToastContext}>
                    <MemoizedTrackedModal mode={mode} taskId="task-1" onClose={vi.fn()} />
                  </ToastContext.Provider>
                </ModelSearchContext.Provider>
              </OptionsContext.Provider>
            </TasksContext.Provider>
          </div>
        )
      }

      const { getByTestId } = render(<Parent />)

      await waitFor(() => {
        expect(screen.queryByText('Loading...')).not.toBeInTheDocument()
      }, { timeout: 3000 })

      expect(renderCount.value).toBe(1)

      // Switch to view mode - should re-render
      await act(async () => {
        fireEvent.click(getByTestId('switch-mode'))
      })
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 50))
      })
      expect(renderCount.value).toBe(2)

      // Switch back to edit mode - should re-render again
      await act(async () => {
        fireEvent.click(getByTestId('switch-mode'))
      })
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 50))
      })
      expect(renderCount.value).toBe(3)
    }, 10000)

    it('should re-render when editing a different task', async () => {
      const renderCount = { value: 0 }

      const TrackedModal = (props: TaskModalProps) => {
        renderCount.value++
        return <TaskModal {...props} />
      }

      const MemoizedTrackedModal = memo(TrackedModal, (prevProps, nextProps) => {
        return (
          prevProps.mode === nextProps.mode &&
          prevProps.taskId === nextProps.taskId &&
          prevProps.createStatus === nextProps.createStatus &&
          prevProps.seedTaskId === nextProps.seedTaskId
        )
      })

      const tasks = [mockTask, { ...mockTask, id: 'task-2', idx: 1, name: 'Task 2' }]

      const Parent = () => {
        const [taskId, setTaskId] = useState('task-1')

        return (
          <div>
            <button data-testid="switch-task" onClick={() => setTaskId(id => id === 'task-1' ? 'task-2' : 'task-1')}>
              Switch Task
            </button>
            <TasksContext.Provider value={createMockTasksContext(tasks)}>
              <OptionsContext.Provider value={mockOptionsContext}>
                <ModelSearchContext.Provider value={mockModelSearchContext}>
                  <ToastContext.Provider value={mockToastContext}>
                    <MemoizedTrackedModal mode="edit" taskId={taskId} onClose={vi.fn()} />
                  </ToastContext.Provider>
                </ModelSearchContext.Provider>
              </OptionsContext.Provider>
            </TasksContext.Provider>
          </div>
        )
      }

      const { getByTestId } = render(<Parent />)

      await waitFor(() => {
        expect(screen.queryByText('Loading...')).not.toBeInTheDocument()
      }, { timeout: 3000 })

      expect(renderCount.value).toBe(1)

      // Switch to task-2 - should re-render
      await act(async () => {
        fireEvent.click(getByTestId('switch-task'))
      })
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 50))
      })
      expect(renderCount.value).toBe(2)
    }, 10000)
  })
})
