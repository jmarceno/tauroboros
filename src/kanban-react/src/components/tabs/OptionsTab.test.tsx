import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { OptionsTab } from './OptionsTab'
import {
  OptionsContext,
  ToastContext,
} from '@/contexts/AppContext'
import type {
  Options,
  Toast,
  LogEntry,
  ThinkingLevel,
  TelegramNotificationLevel,
} from '@/types'

const VALID_THINKING_LEVELS: ThinkingLevel[] = ['default', 'low', 'medium', 'high']
const VALID_TELEGRAM_LEVELS: TelegramNotificationLevel[] = ['all', 'failures', 'done_and_failures', 'workflow_done_and_failures']

const isValidThinkingLevel = (value: string): value is ThinkingLevel =>
  VALID_THINKING_LEVELS.includes(value as ThinkingLevel)

const isValidTelegramLevel = (value: string): value is TelegramNotificationLevel =>
  VALID_TELEGRAM_LEVELS.includes(value as TelegramNotificationLevel)

const mockGetBranches = vi.fn()

vi.mock('@/hooks', () => ({
  useApi: () => ({
    getBranches: mockGetBranches,
  }),
}))

interface MockModelPickerProps {
  modelValue: string
  onUpdate: (value: string) => void
  label: string
  disabled?: boolean
}

const normalizeLabelForTestId = (label: string): string =>
  label.toLowerCase().replace(/[\s()]+/g, '-').replace(/-+/g, '-').replace(/-$/, '')

vi.mock('@/components/common/ModelPicker', () => ({
  ModelPicker: ({ modelValue, onUpdate, label, disabled }: MockModelPickerProps) => {
    const testIdSuffix = normalizeLabelForTestId(label)
    return (
      <div data-testid={`model-picker-${testIdSuffix}`}>
        <label>{label}</label>
        <input
          type="text"
          data-testid={`model-input-${testIdSuffix}`}
          value={modelValue}
          onChange={(e) => onUpdate(e.target.value)}
          disabled={disabled}
          placeholder="Type model name..."
        />
      </div>
    )
  },
}))

interface MockThinkingLevelSelectProps {
  modelValue: ThinkingLevel
  onUpdate: (value: ThinkingLevel) => void
  label: string
  disabled?: boolean
}

vi.mock('@/components/common/ThinkingLevelSelect', () => ({
  ThinkingLevelSelect: ({ modelValue, onUpdate, label, disabled }: MockThinkingLevelSelectProps) => {
    const handleChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
      const value = e.target.value
      if (isValidThinkingLevel(value)) {
        onUpdate(value)
      }
    }

    return (
      <div data-testid={`thinking-level-${label.toLowerCase().replace(/\s+/g, '-')}`}>
        <label>{label}</label>
        <select
          data-testid={`thinking-select-${label.toLowerCase().replace(/\s+/g, '-')}`}
          value={modelValue}
          onChange={handleChange}
          disabled={disabled}
        >
          <option value="default">Default</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
      </div>
    )
  },
}))

interface MockHelpButtonProps {
  tooltip: string
}

vi.mock('@/components/common/HelpButton', () => ({
  HelpButton: ({ tooltip }: MockHelpButtonProps) => (
    <span data-testid="help-button" title={tooltip}>?</span>
  ),
}))

interface OptionsContextValue {
  options: Options | null
  isLoading: boolean
  error: Error | null
  loadOptions: () => Promise<Options | null>
  saveOptions: (options: Partial<Options>) => Promise<Options>
  updateOptions: (options: Partial<Options>) => Promise<Options>
  startExecution: () => void
  stopExecution: () => void
}

interface ToastContextValue {
  toasts: Toast[]
  logs: LogEntry[]
  showToast: (message: string, variant: 'info' | 'success' | 'error') => void
  removeToast: (id: number) => void
  addLog: (entry: LogEntry) => void
  clearLogs: () => void
}

const createMockOptions = (overrides?: Partial<Options>): Options => {
  const defaultThinkingLevel: ThinkingLevel = 'default'
  const mediumThinkingLevel: ThinkingLevel = 'medium'
  const highThinkingLevel: ThinkingLevel = 'high'
  const lowThinkingLevel: ThinkingLevel = 'low'
  const telegramLevel: TelegramNotificationLevel = 'done_and_failures'

  return {
    branch: 'main',
    planModel: 'claude-3-5-sonnet',
    executionModel: 'gpt-4o',
    reviewModel: 'claude-3-5-sonnet',
    repairModel: 'gpt-4o-mini',
    command: 'npm install',
    commitPrompt: 'Commit changes with descriptive message',
    extraPrompt: 'Additional context',
    codeStylePrompt: 'Follow project conventions',
    parallelTasks: 2,
    maxReviews: 5,
    maxJsonParseRetries: 3,
    showExecutionGraph: true,
    autoDeleteNormalSessions: false,
    autoDeleteReviewSessions: true,
    thinkingLevel: defaultThinkingLevel,
    planThinkingLevel: mediumThinkingLevel,
    executionThinkingLevel: highThinkingLevel,
    reviewThinkingLevel: defaultThinkingLevel,
    repairThinkingLevel: lowThinkingLevel,
    telegramNotificationLevel: telegramLevel,
    telegramBotToken: 'test-token-123',
    telegramChatId: '-1001234567890',
    ...overrides,
  }
}

const createMockOptionsContext = (overrides?: Partial<OptionsContextValue>): OptionsContextValue => ({
  options: createMockOptions(),
  isLoading: false,
  error: null,
  loadOptions: vi.fn().mockResolvedValue(createMockOptions()),
  saveOptions: vi.fn().mockImplementation((opts) => Promise.resolve(createMockOptions(opts))),
  updateOptions: vi.fn().mockImplementation((opts) => Promise.resolve(createMockOptions(opts))),
  startExecution: vi.fn(),
  stopExecution: vi.fn(),
  ...overrides,
})

const createMockToastContext = (overrides?: Partial<ToastContextValue>): ToastContextValue => ({
  toasts: [],
  logs: [],
  showToast: vi.fn(),
  removeToast: vi.fn(),
  addLog: vi.fn(),
  clearLogs: vi.fn(),
  ...overrides,
})

interface OptionsTabWrapperProps {
  optionsContext: OptionsContextValue
  toastContext: ToastContextValue
}

const OptionsTabWrapper = ({ optionsContext, toastContext }: OptionsTabWrapperProps) => (
  <OptionsContext.Provider value={optionsContext}>
    <ToastContext.Provider value={toastContext}>
      <OptionsTab />
    </ToastContext.Provider>
  </OptionsContext.Provider>
)

const waitForLoadingToComplete = async (): Promise<void> => {
  await waitFor(() => {
    expect(screen.queryByText('Loading options...')).not.toBeInTheDocument()
  }, { timeout: 3000 })
}

const queryBranchSelect = (): HTMLSelectElement | null =>
  document.querySelector('select.form-select')

const getBranchSelect = (): HTMLSelectElement => {
  const select = queryBranchSelect()
  if (!select) {
    throw new Error('Branch select element not found in the DOM')
  }
  return select
}

const getCheckboxByLabel = (labelPattern: RegExp): HTMLInputElement => {
  const checkbox = screen.getByLabelText(labelPattern)
  if (!(checkbox instanceof HTMLInputElement)) {
    throw new Error(`Checkbox with label matching ${labelPattern.source} is not an HTMLInputElement`)
  }
  return checkbox
}

const getInputByPlaceholder = (placeholderPattern: RegExp): HTMLInputElement => {
  const input = screen.getByPlaceholderText(placeholderPattern)
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`Input with placeholder matching ${placeholderPattern.source} is not an HTMLInputElement`)
  }
  return input
}

const getTextareaByPlaceholder = (placeholderPattern: RegExp): HTMLTextAreaElement => {
  const textarea = screen.getByPlaceholderText(placeholderPattern)
  if (!(textarea instanceof HTMLTextAreaElement)) {
    throw new Error(`Textarea with placeholder matching ${placeholderPattern.source} is not an HTMLTextAreaElement`)
  }
  return textarea
}

describe('OptionsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetBranches.mockResolvedValue({
      branches: ['main', 'dev', 'feature-branch'],
      current: 'main',
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('Rendering', () => {
    it('renders loading state initially', () => {
      render(<OptionsTabWrapper optionsContext={createMockOptionsContext()} toastContext={createMockToastContext()} />)
      expect(screen.getByText('Loading options...')).toBeInTheDocument()
    })

    it('renders all form fields after loading', async () => {
      render(<OptionsTabWrapper optionsContext={createMockOptionsContext()} toastContext={createMockToastContext()} />)
      await waitForLoadingToComplete()

      expect(screen.getByText('Options Configuration')).toBeInTheDocument()
      expect(screen.getByText('Default Branch')).toBeInTheDocument()
      expect(screen.getByText('Plan Model (global)')).toBeInTheDocument()
      expect(screen.getByText('Execution Model (global)')).toBeInTheDocument()
      expect(screen.getByText('Review Model')).toBeInTheDocument()
      expect(screen.getByText('Repair Model')).toBeInTheDocument()
      expect(screen.getByText('Plan Thinking')).toBeInTheDocument()
      expect(screen.getByText('Execution Thinking')).toBeInTheDocument()
      expect(screen.getByText('Review Thinking')).toBeInTheDocument()
      expect(screen.getByText('Repair Thinking')).toBeInTheDocument()
      expect(screen.getByPlaceholderText(/e\.g\. npm install/i)).toBeInTheDocument()
      expect(getCheckboxByLabel(/auto-delete normal sessions/i)).toBeInTheDocument()
      expect(getCheckboxByLabel(/auto-delete review sessions/i)).toBeInTheDocument()
      expect(getCheckboxByLabel(/show execution graph/i)).toBeInTheDocument()
      expect(screen.getByPlaceholderText(/instructions for committing changes/i)).toBeInTheDocument()
      expect(screen.getByPlaceholderText(/code style rules/i)).toBeInTheDocument()
      expect(screen.getByPlaceholderText(/additional context or instructions/i)).toBeInTheDocument()
      expect(screen.getByText(/telegram notifications/i)).toBeInTheDocument()
      expect(screen.getAllByRole('button', { name: /reset/i })).toHaveLength(2)
      expect(screen.getAllByRole('button', { name: /save/i })).toHaveLength(2)
    })

    it('renders help buttons for fields with help text', async () => {
      render(<OptionsTabWrapper optionsContext={createMockOptionsContext()} toastContext={createMockToastContext()} />)
      await waitForLoadingToComplete()

      const helpButtons = screen.getAllByTestId('help-button')
      expect(helpButtons.length).toBeGreaterThan(5)
    })
  })

  describe('Form Data Loading', () => {
    it('loads saved options into form fields', async () => {
      const mockContext = createMockOptionsContext()
      render(<OptionsTabWrapper optionsContext={mockContext} toastContext={createMockToastContext()} />)
      await waitForLoadingToComplete()

      const branchSelect = getBranchSelect()
      expect(branchSelect.value).toBe('main')

      expect(getCheckboxByLabel(/show execution graph/i).checked).toBe(true)
      expect(getCheckboxByLabel(/auto-delete review sessions/i).checked).toBe(true)
      expect(getCheckboxByLabel(/auto-delete normal sessions/i).checked).toBe(false)

      expect(getInputByPlaceholder(/e\.g\. npm install/i).value).toBe('npm install')
    })

    it('loads branch list from API', async () => {
      render(<OptionsTabWrapper optionsContext={createMockOptionsContext()} toastContext={createMockToastContext()} />)
      await waitForLoadingToComplete()

      expect(mockGetBranches).toHaveBeenCalledTimes(1)

      const branchSelect = getBranchSelect()
      const options = Array.from(branchSelect.options).map(opt => opt.value)
      expect(options).toContain('main')
      expect(options).toContain('dev')
      expect(options).toContain('feature-branch')
    })

    it('handles API error when loading branches', async () => {
      mockGetBranches.mockRejectedValueOnce(new Error('Git command failed'))
      render(<OptionsTabWrapper optionsContext={createMockOptionsContext()} toastContext={createMockToastContext()} />)
      await waitForLoadingToComplete()

      expect(screen.getByText(/error loading branches/i)).toBeInTheDocument()
    })
  })

  describe('Form Validation', () => {
    it('shows error when trying to save without branch selected', async () => {
      mockGetBranches.mockResolvedValueOnce({ branches: [], current: null })

      const emptyOptionsContext = createMockOptionsContext({
        loadOptions: vi.fn().mockResolvedValue({
          ...createMockOptions(),
          branch: '',
        }),
      })
      const toastContext = createMockToastContext()

      render(<OptionsTabWrapper optionsContext={emptyOptionsContext} toastContext={toastContext} />)
      await waitForLoadingToComplete()

      const saveButton = screen.getAllByRole('button', { name: /save/i })[0]
      fireEvent.click(saveButton)

      await waitFor(() => {
        expect(toastContext.showToast).toHaveBeenCalledWith(
          'Select a valid default branch',
          'error'
        )
      })

      expect(emptyOptionsContext.saveOptions).not.toHaveBeenCalled()
    })
  })

  describe('Form Interaction', () => {
    it('updates branch selection', async () => {
      render(<OptionsTabWrapper optionsContext={createMockOptionsContext()} toastContext={createMockToastContext()} />)
      await waitForLoadingToComplete()

      const branchSelect = getBranchSelect()
      fireEvent.change(branchSelect, { target: { value: 'dev' } })

      expect(branchSelect.value).toBe('dev')
    })

    it('toggles checkboxes', async () => {
      render(<OptionsTabWrapper optionsContext={createMockOptionsContext()} toastContext={createMockToastContext()} />)
      await waitForLoadingToComplete()

      const showGraphCheckbox = getCheckboxByLabel(/show execution graph/i)
      expect(showGraphCheckbox.checked).toBe(true)

      fireEvent.click(showGraphCheckbox)
      expect(showGraphCheckbox.checked).toBe(false)

      fireEvent.click(showGraphCheckbox)
      expect(showGraphCheckbox.checked).toBe(true)
    })

    it('updates textarea values', async () => {
      render(<OptionsTabWrapper optionsContext={createMockOptionsContext()} toastContext={createMockToastContext()} />)
      await waitForLoadingToComplete()

      const commitPromptTextarea = getTextareaByPlaceholder(/instructions for committing changes/i)
      fireEvent.change(commitPromptTextarea, { target: { value: 'New commit instructions' } })

      expect(commitPromptTextarea.value).toBe('New commit instructions')
    })

    it('updates telegram notification level', async () => {
      render(<OptionsTabWrapper optionsContext={createMockOptionsContext()} toastContext={createMockToastContext()} />)
      await waitForLoadingToComplete()

      expect(screen.getByText('Notification Level')).toBeInTheDocument()

      const allSelects = document.querySelectorAll('select.form-select')
      expect(allSelects.length).toBeGreaterThanOrEqual(1)
    })

    it('updates telegram bot token and chat ID', async () => {
      render(<OptionsTabWrapper optionsContext={createMockOptionsContext()} toastContext={createMockToastContext()} />)
      await waitForLoadingToComplete()

      const passwordInputs = document.querySelectorAll('input[type="password"]')
      expect(passwordInputs.length).toBeGreaterThanOrEqual(1)

      const chatIdInput = getInputByPlaceholder(/@channel_name/i)
      expect(chatIdInput).toBeDefined()

      fireEvent.change(chatIdInput, { target: { value: '@newchannel' } })
      expect(chatIdInput.value).toBe('@newchannel')
    })
  })

  describe('Save Functionality', () => {
    it('saves options successfully', async () => {
      const optionsContext = createMockOptionsContext()
      const toastContext = createMockToastContext()

      render(<OptionsTabWrapper optionsContext={optionsContext} toastContext={toastContext} />)
      await waitForLoadingToComplete()

      const commandInput = getInputByPlaceholder(/e\.g\. npm install/i)
      fireEvent.change(commandInput, { target: { value: 'pnpm install' } })

      const saveButton = screen.getAllByRole('button', { name: /save/i })[0]
      await act(async () => {
        fireEvent.click(saveButton)
      })

      await waitFor(() => {
        expect(optionsContext.saveOptions).toHaveBeenCalled()
      })

      expect(toastContext.showToast).toHaveBeenCalledWith(
        'Options saved successfully',
        'success'
      )
    })

    it('shows saving state during save', async () => {
      const delayedSaveContext = createMockOptionsContext({
        saveOptions: vi.fn().mockImplementation(() =>
          new Promise(resolve => setTimeout(() => resolve(createMockOptions()), 100))
        ),
      })

      render(<OptionsTabWrapper optionsContext={delayedSaveContext} toastContext={createMockToastContext()} />)
      await waitForLoadingToComplete()

      const saveButtons = screen.getAllByRole('button', { name: /save/i })
      fireEvent.click(saveButtons[0])

      await waitFor(() => {
        expect(screen.getAllByText(/saving/i).length).toBeGreaterThan(0)
      })
    })

    it('handles save error by showing toast and re-throwing for upstream handling', async () => {
      const errorSaveContext = createMockOptionsContext({
        saveOptions: vi.fn().mockRejectedValue(new Error('Database write failed')),
      })
      const toastContext = createMockToastContext()

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      render(<OptionsTabWrapper optionsContext={errorSaveContext} toastContext={toastContext} />)
      await waitForLoadingToComplete()

      const saveButton = screen.getAllByRole('button', { name: /save/i })[0]

      await act(async () => {
        fireEvent.click(saveButton)
      })

      await waitFor(() => {
        expect(toastContext.showToast).toHaveBeenCalledWith(
          'Database write failed',
          'error'
        )
      })

      consoleSpy.mockRestore()
    })
  })

  describe('Reset Functionality', () => {
    it('resets form to saved values', async () => {
      const optionsContext = createMockOptionsContext()
      const toastContext = createMockToastContext()

      render(<OptionsTabWrapper optionsContext={optionsContext} toastContext={toastContext} />)
      await waitForLoadingToComplete()

      const commandInput = getInputByPlaceholder(/e\.g\. npm install/i)
      fireEvent.change(commandInput, { target: { value: 'yarn install' } })
      expect(commandInput.value).toBe('yarn install')

      const resetButton = screen.getAllByRole('button', { name: /reset/i })[0]
      await act(async () => {
        fireEvent.click(resetButton)
      })

      await waitFor(() => {
        expect(commandInput.value).toBe('npm install')
      })

      expect(toastContext.showToast).toHaveBeenCalledWith(
        'Options reset to saved values',
        'info'
      )
    })

    it('handles reset error by showing toast and re-throwing for upstream handling', async () => {
      const errorResetContext = createMockOptionsContext({
        loadOptions: vi.fn().mockRejectedValue(new Error('Failed to load options')),
      })
      const toastContext = createMockToastContext()

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      render(<OptionsTabWrapper optionsContext={errorResetContext} toastContext={toastContext} />)
      await waitForLoadingToComplete()

      const resetButton = screen.getAllByRole('button', { name: /reset/i })[0]

      await act(async () => {
        fireEvent.click(resetButton)
      })

      await waitFor(() => {
        expect(toastContext.showToast).toHaveBeenCalledWith(
          'Failed to load options',
          'error'
        )
      })

      consoleSpy.mockRestore()
    })
  })

  describe('Type Safety', () => {
    it('validates thinking level values', async () => {
      render(<OptionsTabWrapper optionsContext={createMockOptionsContext()} toastContext={createMockToastContext()} />)
      await waitForLoadingToComplete()

      const thinkingSelects = [
        screen.getByTestId('thinking-select-plan-thinking'),
        screen.getByTestId('thinking-select-execution-thinking'),
        screen.getByTestId('thinking-select-review-thinking'),
        screen.getByTestId('thinking-select-repair-thinking'),
      ]

      thinkingSelects.forEach(select => {
        if (!(select instanceof HTMLSelectElement)) {
          throw new Error('Expected HTMLSelectElement')
        }
        const options = Array.from(select.options).map(opt => opt.value)
        expect(options).toContain('default')
        expect(options).toContain('low')
        expect(options).toContain('medium')
        expect(options).toContain('high')
      })
    })

    it('validates telegram notification level options exist', async () => {
      render(<OptionsTabWrapper optionsContext={createMockOptionsContext()} toastContext={createMockToastContext()} />)
      await waitForLoadingToComplete()

      expect(screen.getByText('Notification Level')).toBeInTheDocument()
    })
  })

  describe('Edge Cases', () => {
    it('handles missing options gracefully', async () => {
      const emptyOptionsContext = createMockOptionsContext({
        options: null,
        loadOptions: vi.fn().mockResolvedValue(null),
      })

      render(<OptionsTabWrapper optionsContext={emptyOptionsContext} toastContext={createMockToastContext()} />)
      await waitForLoadingToComplete()

      expect(screen.getByText('Options Configuration')).toBeInTheDocument()
    })

    it('handles empty branch list', async () => {
      mockGetBranches.mockResolvedValueOnce({ branches: [], current: null })

      render(<OptionsTabWrapper optionsContext={createMockOptionsContext()} toastContext={createMockToastContext()} />)
      await waitForLoadingToComplete()

      const branchSelect = getBranchSelect()
      expect(branchSelect.disabled).toBe(true)
    })

    it('disables save button while saving', async () => {
      const delayedSaveContext = createMockOptionsContext({
        saveOptions: vi.fn().mockImplementation(() =>
          new Promise(resolve => setTimeout(() => resolve(createMockOptions()), 100))
        ),
      })

      render(<OptionsTabWrapper optionsContext={delayedSaveContext} toastContext={createMockToastContext()} />)
      await waitForLoadingToComplete()

      const saveButtons = screen.getAllByRole('button', { name: /save/i })
      fireEvent.click(saveButtons[0])

      await waitFor(() => {
        saveButtons.forEach(button => {
          expect(button).toBeDisabled()
        })
      })
    })

    it('disables reset button while saving', async () => {
      const delayedSaveContext = createMockOptionsContext({
        saveOptions: vi.fn().mockImplementation(() =>
          new Promise(resolve => setTimeout(() => resolve(createMockOptions()), 200))
        ),
      })

      render(<OptionsTabWrapper optionsContext={delayedSaveContext} toastContext={createMockToastContext()} />)
      await waitForLoadingToComplete()

      const saveButton = screen.getAllByRole('button', { name: /save/i })[0]
      const resetButtons = screen.getAllByRole('button', { name: /reset/i })

      fireEvent.click(saveButton)

      await waitFor(() => {
        resetButtons.forEach(button => {
          expect(button).toBeDisabled()
        })
      })
    })
  })

  describe('Responsive Layout', () => {
    it('renders with full height container', async () => {
      const { container } = render(<OptionsTabWrapper optionsContext={createMockOptionsContext()} toastContext={createMockToastContext()} />)
      await waitForLoadingToComplete()

      const formContainer = container.querySelector('.overflow-y-auto')
      expect(formContainer).toBeInTheDocument()
    })

    it('uses grid layout for form sections', async () => {
      const { container } = render(<OptionsTabWrapper optionsContext={createMockOptionsContext()} toastContext={createMockToastContext()} />)
      await waitForLoadingToComplete()

      const gridContainer = container.querySelector('.grid')
      expect(gridContainer).toBeInTheDocument()
    })
  })
})
