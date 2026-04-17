import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { TabbedLogPanel, MIN_PANEL_HEIGHT, DEFAULT_PANEL_HEIGHT, STORAGE_KEY, getMaxPanelHeight } from '@/components/common/TabbedLogPanel'
import type { LogEntry, WorkflowRun } from '@/types'

describe('TabbedLogPanel', () => {
  const mockLogs: LogEntry[] = []
  const mockRuns: WorkflowRun[] = []
  const mockStaleRuns: WorkflowRun[] = []
  const mockProps = {
    collapsed: false,
    onCollapsedChange: vi.fn(),
    logs: mockLogs,
    runs: mockRuns,
    staleRuns: mockStaleRuns,
    onClear: vi.fn(),
    onArchiveRun: vi.fn(),
    onArchiveAllStaleRuns: vi.fn(),
    onHighlightRun: vi.fn(),
    onClearHighlight: vi.fn(),
  }

  // Setup DOM for tests
  beforeEach(() => {
    // Mock window dimensions
    Object.defineProperty(window, 'innerHeight', {
      writable: true,
      configurable: true,
      value: 1000,
    })

    // Clear localStorage
    localStorage.clear()

    // Clear body styles
    document.body.style.cursor = ''
    document.body.style.userSelect = ''

    // Clean up any lingering event listeners
    vi.clearAllMocks()
  })

  afterEach(() => {
    localStorage.clear()
  })

  describe('Resize Handle', () => {
    it('renders resize handle when not collapsed', () => {
      render(<TabbedLogPanel {...mockProps} />)

      const resizeHandle = screen.getByTitle('Drag to resize')
      expect(resizeHandle).toBeInTheDocument()
      expect(resizeHandle).toHaveClass('log-panel-resize-handle')
    })

    it('does not render resize handle when collapsed', () => {
      render(<TabbedLogPanel {...mockProps} collapsed={true} />)

      expect(screen.queryByTitle('Drag to resize')).not.toBeInTheDocument()
    })
  })

  describe('Mouse Down (Start Resize)', () => {
    it('starts resize on mouse down and sets cursor to ns-resize', () => {
      render(<TabbedLogPanel {...mockProps} />)

      const resizeHandle = screen.getByTitle('Drag to resize')
      
      fireEvent.mouseDown(resizeHandle, { clientY: 500 })

      expect(document.body.style.cursor).toBe('ns-resize')
      expect(document.body.style.userSelect).toBe('none')
    })

    it('prevents default on mouse down', async () => {
      render(<TabbedLogPanel {...mockProps} />)

      const resizeHandle = screen.getByTitle('Drag to resize')
      let preventDefaultCalled = false

      // Create a custom event with tracking
      const mouseDownEvent = new MouseEvent('mousedown', {
        clientY: 500,
        bubbles: true,
        cancelable: true,
      })

      // Override preventDefault to track it
      Object.defineProperty(mouseDownEvent, 'preventDefault', {
        value: () => { preventDefaultCalled = true },
        writable: false,
      })

      await act(async () => {
        resizeHandle.dispatchEvent(mouseDownEvent)
      })

      expect(preventDefaultCalled).toBe(true)
    })
  })

  describe('Mouse Move (Update Height)', () => {
    it('updates panel height when dragging upward', async () => {
      render(<TabbedLogPanel {...mockProps} />)

      const resizeHandle = screen.getByTitle('Drag to resize')
      const panel = screen.getByText('Workflow Runs').closest('.border-t') as HTMLElement
      const initialHeight = panel.style.height

      // Start resize
      fireEvent.mouseDown(resizeHandle, { clientY: 500 })

      // Drag upward (increase height) by 100px
      fireEvent.mouseMove(window, { clientY: 400 })

      await waitFor(() => {
        const newHeight = parseInt(panel.style.height)
        expect(newHeight).toBeGreaterThan(parseInt(initialHeight))
      })
    })

    it('updates panel height when dragging downward', async () => {
      render(<TabbedLogPanel {...mockProps} />)

      const resizeHandle = screen.getByTitle('Drag to resize')
      const panel = screen.getByText('Workflow Runs').closest('.border-t') as HTMLElement

      // Start resize
      fireEvent.mouseDown(resizeHandle, { clientY: 500 })

      // Drag downward (decrease height) by 50px
      fireEvent.mouseMove(window, { clientY: 550 })

      await waitFor(() => {
        const newHeight = parseInt(panel.style.height)
        expect(newHeight).toBeLessThan(DEFAULT_PANEL_HEIGHT)
      })
    })

    it('does not respond to mouse move when not resizing', () => {
      render(<TabbedLogPanel {...mockProps} />)

      const panel = screen.getByText('Workflow Runs').closest('.border-t') as HTMLElement
      const initialHeight = panel.style.height

      // Mouse move without starting resize
      fireEvent.mouseMove(window, { clientY: 400 })

      expect(panel.style.height).toBe(initialHeight)
    })
  })

  describe('Mouse Up (Stop Resize)', () => {
    it('stops resize on mouse up and resets cursor', async () => {
      render(<TabbedLogPanel {...mockProps} />)

      const resizeHandle = screen.getByTitle('Drag to resize')

      // Start resize
      fireEvent.mouseDown(resizeHandle, { clientY: 500 })
      expect(document.body.style.cursor).toBe('ns-resize')

      // Drag to change height
      fireEvent.mouseMove(window, { clientY: 400 })

      // Stop resize
      fireEvent.mouseUp(window)

      await waitFor(() => {
        expect(document.body.style.cursor).toBe('')
        expect(document.body.style.userSelect).toBe('')
      })
    })

    it('persists panel height to localStorage on mouse up', async () => {
      render(<TabbedLogPanel {...mockProps} />)

      const resizeHandle = screen.getByTitle('Drag to resize')

      // Start resize
      fireEvent.mouseDown(resizeHandle, { clientY: 500 })

      // Drag upward to increase height
      fireEvent.mouseMove(window, { clientY: 400 })

      // Stop resize
      fireEvent.mouseUp(window)

      // Wait a tick for the effect to run
      await new Promise(resolve => setTimeout(resolve, 0))

      // Verify localStorage was updated
      const stored = localStorage.getItem(STORAGE_KEY)
      expect(stored).toBeTruthy()
      expect(parseInt(stored!)).toBeGreaterThan(DEFAULT_PANEL_HEIGHT)
    })
  })

  describe('Height Bounds', () => {
    it('clamps height to MIN_PANEL_HEIGHT when dragging below minimum', async () => {
      render(<TabbedLogPanel {...mockProps} />)

      const resizeHandle = screen.getByTitle('Drag to resize')
      const panel = screen.getByText('Workflow Runs').closest('.border-t') as HTMLElement

      // Start resize
      fireEvent.mouseDown(resizeHandle, { clientY: 500 })

      // Drag way down (would make height very small)
      fireEvent.mouseMove(window, { clientY: 900 })

      await waitFor(() => {
        const height = parseInt(panel.style.height)
        expect(height).toBeGreaterThanOrEqual(MIN_PANEL_HEIGHT)
      })
    })

    it('clamps height to dynamic max when dragging above maximum', async () => {
      Object.defineProperty(window, 'innerHeight', {
        writable: true,
        configurable: true,
        value: 1000,
      })
      const expectedMax = getMaxPanelHeight() // 1000 * 0.7 = 700

      render(<TabbedLogPanel {...mockProps} />)

      const resizeHandle = screen.getByTitle('Drag to resize')
      const panel = screen.getByText('Workflow Runs').closest('.border-t') as HTMLElement

      // Start resize
      fireEvent.mouseDown(resizeHandle, { clientY: 500 })

      // Drag way up (would make height very large)
      fireEvent.mouseMove(window, { clientY: 0 })

      await waitFor(() => {
        const height = parseInt(panel.style.height)
        expect(height).toBeLessThanOrEqual(expectedMax)
      })
    })
  })

  describe('Dynamic Max Height', () => {
    it('computes max height dynamically based on current window size', () => {
      // Set window height
      Object.defineProperty(window, 'innerHeight', {
        writable: true,
        configurable: true,
        value: 1000,
      })
      expect(getMaxPanelHeight()).toBe(700) // 1000 * 0.7

      // Change window height
      Object.defineProperty(window, 'innerHeight', {
        writable: true,
        configurable: true,
        value: 800,
      })
      expect(getMaxPanelHeight()).toBe(560) // 800 * 0.7
    })

    it('uses current window height for max bound during resize', async () => {
      // Start with a large window
      Object.defineProperty(window, 'innerHeight', {
        writable: true,
        configurable: true,
        value: 1000,
      })

      render(<TabbedLogPanel {...mockProps} />)

      const resizeHandle = screen.getByTitle('Drag to resize')
      const panel = screen.getByText('Workflow Runs').closest('.border-t') as HTMLElement

      // Start resize
      fireEvent.mouseDown(resizeHandle, { clientY: 500 })

      // Resize window down to 500px
      Object.defineProperty(window, 'innerHeight', {
        writable: true,
        configurable: true,
        value: 500,
      })
      const newMax = getMaxPanelHeight() // 500 * 0.7 = 350

      // Try to drag up beyond the new max
      fireEvent.mouseMove(window, { clientY: 0 })

      await waitFor(() => {
        const height = parseInt(panel.style.height)
        expect(height).toBeLessThanOrEqual(newMax)
      })
    })
  })

  describe('localStorage Persistence', () => {
    it('restores saved height from localStorage on mount', () => {
      const savedHeight = 250
      localStorage.setItem(STORAGE_KEY, savedHeight.toString())

      render(<TabbedLogPanel {...mockProps} />)

      const panel = screen.getByText('Workflow Runs').closest('.border-t') as HTMLElement
      expect(parseInt(panel.style.height)).toBe(savedHeight)
    })

    it('uses default height when localStorage is empty', () => {
      localStorage.removeItem(STORAGE_KEY)

      render(<TabbedLogPanel {...mockProps} />)

      const panel = screen.getByText('Workflow Runs').closest('.border-t') as HTMLElement
      expect(parseInt(panel.style.height)).toBe(DEFAULT_PANEL_HEIGHT)
    })

    it('ignores saved height below MIN_PANEL_HEIGHT', () => {
      localStorage.setItem(STORAGE_KEY, '50') // Below minimum

      render(<TabbedLogPanel {...mockProps} />)

      const panel = screen.getByText('Workflow Runs').closest('.border-t') as HTMLElement
      expect(parseInt(panel.style.height)).toBe(DEFAULT_PANEL_HEIGHT)
    })

    it('ignores saved height above dynamic max', () => {
      Object.defineProperty(window, 'innerHeight', {
        writable: true,
        configurable: true,
        value: 400, // Max will be 280
      })
      localStorage.setItem(STORAGE_KEY, '500') // Above max

      render(<TabbedLogPanel {...mockProps} />)

      const panel = screen.getByText('Workflow Runs').closest('.border-t') as HTMLElement
      expect(parseInt(panel.style.height)).toBe(DEFAULT_PANEL_HEIGHT)
    })

    it('updates localStorage with current height after resize', async () => {
      const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')

      render(<TabbedLogPanel {...mockProps} />)

      const resizeHandle = screen.getByTitle('Drag to resize')

      // Start and perform resize
      fireEvent.mouseDown(resizeHandle, { clientY: 500 })
      fireEvent.mouseMove(window, { clientY: 400 })
      fireEvent.mouseUp(window)

      await waitFor(() => {
        const stored = localStorage.getItem(STORAGE_KEY)
        expect(stored).toBeTruthy()
        expect(parseInt(stored!)).toBeGreaterThan(DEFAULT_PANEL_HEIGHT)
      }, { timeout: 2000 })

      setItemSpy.mockRestore()
    })
  })

  describe('Resize State', () => {
    it('adds resizing class to panel during resize', async () => {
      render(<TabbedLogPanel {...mockProps} />)

      const resizeHandle = screen.getByTitle('Drag to resize')
      const panel = screen.getByText('Workflow Runs').closest('.border-t') as HTMLElement

      // Initially should have transition class
      expect(panel).toHaveClass('transition-all')

      // Start resize
      fireEvent.mouseDown(resizeHandle, { clientY: 500 })

      await waitFor(() => {
        expect(panel).toHaveClass('resizing')
        expect(panel).not.toHaveClass('transition-all')
      })

      // Stop resize
      fireEvent.mouseUp(window)

      await waitFor(() => {
        expect(panel).not.toHaveClass('resizing')
        expect(panel).toHaveClass('transition-all')
      })
    })
  })
})
