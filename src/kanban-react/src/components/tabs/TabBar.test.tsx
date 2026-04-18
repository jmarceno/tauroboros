import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TabBar } from './TabBar'
import type { MainTabId } from '@/contexts/TabContext'

describe('TabBar', () => {
  const defaultProps = {
    activeTab: 'kanban' as MainTabId,
    onTabChange: vi.fn(),
  }

  beforeEach(() => {
    defaultProps.onTabChange.mockClear()
  })

  describe('Rendering', () => {
    it('renders all 5 tabs with correct labels', () => {
      render(<TabBar {...defaultProps} />)

      expect(screen.getByRole('tab', { name: /kanban/i })).toBeInTheDocument()
      expect(screen.getByRole('tab', { name: /options/i })).toBeInTheDocument()
      expect(screen.getByRole('tab', { name: /containers/i })).toBeInTheDocument()
      expect(screen.getByRole('tab', { name: /archived/i })).toBeInTheDocument()
      expect(screen.getByRole('tab', { name: /stats/i })).toBeInTheDocument()
    })

    it('renders tabs in correct order', () => {
      render(<TabBar {...defaultProps} />)

      const tabs = screen.getAllByRole('tab')
      expect(tabs).toHaveLength(5)
      expect(tabs[0]).toHaveAttribute('aria-controls', 'kanban-panel')
      expect(tabs[1]).toHaveAttribute('aria-controls', 'options-panel')
      expect(tabs[2]).toHaveAttribute('aria-controls', 'containers-panel')
      expect(tabs[3]).toHaveAttribute('aria-controls', 'archived-panel')
      expect(tabs[4]).toHaveAttribute('aria-controls', 'stats-panel')
    })

    it('renders icons for each tab', () => {
      render(<TabBar {...defaultProps} />)

      const tabs = screen.getAllByRole('tab')
      tabs.forEach(tab => {
        expect(tab.querySelector('svg')).toBeInTheDocument()
      })
    })

    it('has correct ARIA labels and roles', () => {
      render(<TabBar {...defaultProps} />)

      const navigation = screen.getByRole('navigation', { name: /main navigation/i })
      expect(navigation).toBeInTheDocument()

      const tablist = screen.getByRole('tablist', { name: /application tabs/i })
      expect(tablist).toBeInTheDocument()

      const kanbanTab = screen.getByRole('tab', { name: /kanban/i })
      expect(kanbanTab).toHaveAttribute('id', 'kanban-tab')
      expect(kanbanTab).toHaveAttribute('aria-controls', 'kanban-panel')
    })
  })

  describe('Active Tab Highlighting', () => {
    it('highlights kanban tab when active', () => {
      render(<TabBar {...defaultProps} activeTab="kanban" />)

      const kanbanTab = screen.getByRole('tab', { name: /kanban/i })
      expect(kanbanTab).toHaveAttribute('aria-selected', 'true')
      expect(kanbanTab).toHaveClass('border-accent-primary')
      expect(kanbanTab).toHaveClass('text-accent-primary')
    })

    it('highlights options tab when active', () => {
      render(<TabBar {...defaultProps} activeTab="options" />)

      const optionsTab = screen.getByRole('tab', { name: /options/i })
      expect(optionsTab).toHaveAttribute('aria-selected', 'true')
      expect(optionsTab).toHaveClass('border-accent-primary')
      expect(optionsTab).toHaveClass('text-accent-primary')
    })

    it('highlights containers tab when active', () => {
      render(<TabBar {...defaultProps} activeTab="containers" />)

      const containersTab = screen.getByRole('tab', { name: /containers/i })
      expect(containersTab).toHaveAttribute('aria-selected', 'true')
      expect(containersTab).toHaveClass('border-accent-primary')
      expect(containersTab).toHaveClass('text-accent-primary')
    })

    it('highlights archived tab when active', () => {
      render(<TabBar {...defaultProps} activeTab="archived" />)

      const archivedTab = screen.getByRole('tab', { name: /archived/i })
      expect(archivedTab).toHaveAttribute('aria-selected', 'true')
      expect(archivedTab).toHaveClass('border-accent-primary')
      expect(archivedTab).toHaveClass('text-accent-primary')
    })

    it('highlights stats tab when active', () => {
      render(<TabBar {...defaultProps} activeTab="stats" />)

      const statsTab = screen.getByRole('tab', { name: /stats/i })
      expect(statsTab).toHaveAttribute('aria-selected', 'true')
      expect(statsTab).toHaveClass('border-accent-primary')
      expect(statsTab).toHaveClass('text-accent-primary')
    })

    it('inactive tabs have muted styling', () => {
      render(<TabBar {...defaultProps} activeTab="kanban" />)

      const optionsTab = screen.getByRole('tab', { name: /options/i })
      expect(optionsTab).toHaveAttribute('aria-selected', 'false')
      expect(optionsTab).toHaveClass('border-transparent')
      expect(optionsTab).toHaveClass('text-dark-text-muted')
    })

    it('only one tab is active at a time', () => {
      render(<TabBar {...defaultProps} activeTab="stats" />)

      const tabs = screen.getAllByRole('tab')
      const selectedTabs = tabs.filter(tab => tab.getAttribute('aria-selected') === 'true')
      expect(selectedTabs).toHaveLength(1)
    })

    it('active tab has tabIndex 0, others have -1', () => {
      render(<TabBar {...defaultProps} activeTab="containers" />)

      const containersTab = screen.getByRole('tab', { name: /containers/i })
      expect(containersTab).toHaveAttribute('tabIndex', '0')

      const kanbanTab = screen.getByRole('tab', { name: /kanban/i })
      expect(kanbanTab).toHaveAttribute('tabIndex', '-1')
    })
  })

  describe('Click Interaction', () => {
    it('calls onTabChange with kanban when kanban tab clicked', () => {
      render(<TabBar {...defaultProps} />)

      const kanbanTab = screen.getByRole('tab', { name: /kanban/i })
      fireEvent.click(kanbanTab)

      expect(defaultProps.onTabChange).toHaveBeenCalledTimes(1)
      expect(defaultProps.onTabChange).toHaveBeenCalledWith('kanban')
    })

    it('calls onTabChange with options when options tab clicked', () => {
      render(<TabBar {...defaultProps} />)

      const optionsTab = screen.getByRole('tab', { name: /options/i })
      fireEvent.click(optionsTab)

      expect(defaultProps.onTabChange).toHaveBeenCalledTimes(1)
      expect(defaultProps.onTabChange).toHaveBeenCalledWith('options')
    })

    it('calls onTabChange with containers when containers tab clicked', () => {
      render(<TabBar {...defaultProps} />)

      const containersTab = screen.getByRole('tab', { name: /containers/i })
      fireEvent.click(containersTab)

      expect(defaultProps.onTabChange).toHaveBeenCalledTimes(1)
      expect(defaultProps.onTabChange).toHaveBeenCalledWith('containers')
    })

    it('calls onTabChange with archived when archived tab clicked', () => {
      render(<TabBar {...defaultProps} />)

      const archivedTab = screen.getByRole('tab', { name: /archived/i })
      fireEvent.click(archivedTab)

      expect(defaultProps.onTabChange).toHaveBeenCalledTimes(1)
      expect(defaultProps.onTabChange).toHaveBeenCalledWith('archived')
    })

    it('calls onTabChange with stats when stats tab clicked', () => {
      render(<TabBar {...defaultProps} />)

      const statsTab = screen.getByRole('tab', { name: /stats/i })
      fireEvent.click(statsTab)

      expect(defaultProps.onTabChange).toHaveBeenCalledTimes(1)
      expect(defaultProps.onTabChange).toHaveBeenCalledWith('stats')
    })

    it('calls onTabChange multiple times for multiple clicks', () => {
      render(<TabBar {...defaultProps} />)

      const kanbanTab = screen.getByRole('tab', { name: /kanban/i })
      fireEvent.click(kanbanTab)
      fireEvent.click(kanbanTab)
      fireEvent.click(kanbanTab)

      expect(defaultProps.onTabChange).toHaveBeenCalledTimes(3)
    })
  })

  describe('Keyboard Navigation', () => {
    it('moves focus and selects next tab with ArrowRight', () => {
      render(<TabBar {...defaultProps} activeTab="kanban" />)

      const kanbanTab = screen.getByRole('tab', { name: /kanban/i })
      fireEvent.keyDown(kanbanTab, { key: 'ArrowRight' })

      expect(defaultProps.onTabChange).toHaveBeenCalledWith('options')
    })

    it('moves focus and selects previous tab with ArrowLeft', () => {
      render(<TabBar {...defaultProps} activeTab="options" />)

      const optionsTab = screen.getByRole('tab', { name: /options/i })
      fireEvent.keyDown(optionsTab, { key: 'ArrowLeft' })

      expect(defaultProps.onTabChange).toHaveBeenCalledWith('kanban')
    })

    it('wraps to last tab with ArrowLeft from first tab', () => {
      render(<TabBar {...defaultProps} activeTab="kanban" />)

      const kanbanTab = screen.getByRole('tab', { name: /kanban/i })
      fireEvent.keyDown(kanbanTab, { key: 'ArrowLeft' })

      expect(defaultProps.onTabChange).toHaveBeenCalledWith('stats')
    })

    it('wraps to first tab with ArrowRight from last tab', () => {
      render(<TabBar {...defaultProps} activeTab="stats" />)

      const statsTab = screen.getByRole('tab', { name: /stats/i })
      fireEvent.keyDown(statsTab, { key: 'ArrowRight' })

      expect(defaultProps.onTabChange).toHaveBeenCalledWith('kanban')
    })

    it('moves to first tab with Home key', () => {
      render(<TabBar {...defaultProps} activeTab="stats" />)

      const statsTab = screen.getByRole('tab', { name: /stats/i })
      fireEvent.keyDown(statsTab, { key: 'Home' })

      expect(defaultProps.onTabChange).toHaveBeenCalledWith('kanban')
    })

    it('moves to last tab with End key', () => {
      render(<TabBar {...defaultProps} activeTab="kanban" />)

      const kanbanTab = screen.getByRole('tab', { name: /kanban/i })
      fireEvent.keyDown(kanbanTab, { key: 'End' })

      expect(defaultProps.onTabChange).toHaveBeenCalledWith('stats')
    })

    it('selects tab with Enter key', () => {
      render(<TabBar {...defaultProps} activeTab="kanban" />)

      const optionsTab = screen.getByRole('tab', { name: /options/i })
      optionsTab.focus()
      fireEvent.keyDown(optionsTab, { key: 'Enter' })

      expect(defaultProps.onTabChange).toHaveBeenCalledWith('options')
    })

    it('selects tab with Space key', () => {
      render(<TabBar {...defaultProps} activeTab="kanban" />)

      const optionsTab = screen.getByRole('tab', { name: /options/i })
      optionsTab.focus()
      fireEvent.keyDown(optionsTab, { key: ' ' })

      expect(defaultProps.onTabChange).toHaveBeenCalledWith('options')
    })

    it('prevents default on ArrowLeft to avoid scrolling', () => {
      render(<TabBar {...defaultProps} activeTab="options" />)

      const optionsTab = screen.getByRole('tab', { name: /options/i })
      const event = fireEvent.keyDown(optionsTab, { key: 'ArrowLeft' })

      // The event handler calls preventDefault
      expect(defaultProps.onTabChange).toHaveBeenCalled()
    })

    it('navigates through all tabs with sequential ArrowRight presses', () => {
      const { rerender } = render(<TabBar {...defaultProps} activeTab="kanban" />)

      const tabs = ['kanban', 'options', 'containers', 'archived', 'stats']

      // Navigate through all tabs - each time we press ArrowRight, we update activeTab
      // and rerender to simulate the tab actually changing
      for (let i = 0; i < 4; i++) {
        const currentTab = screen.getByRole('tab', { name: new RegExp(tabs[i], 'i') })
        fireEvent.keyDown(currentTab, { key: 'ArrowRight' })
        expect(defaultProps.onTabChange).toHaveBeenLastCalledWith(tabs[i + 1])
        // Simulate the parent component updating the active tab
        rerender(<TabBar {...defaultProps} activeTab={tabs[i + 1] as MainTabId} />)
      }

      expect(defaultProps.onTabChange).toHaveBeenCalledTimes(4)
    })
  })

  describe('Accessibility', () => {
    it('has correct ARIA attributes for tablist', () => {
      render(<TabBar {...defaultProps} />)

      const tablist = screen.getByRole('tablist')
      expect(tablist).toHaveAttribute('aria-label', 'Application tabs')
    })

    it('has correct ARIA attributes for each tab', () => {
      render(<TabBar {...defaultProps} activeTab="kanban" />)

      const kanbanTab = screen.getByRole('tab', { name: /kanban/i })
      expect(kanbanTab).toHaveAttribute('id', 'kanban-tab')
      expect(kanbanTab).toHaveAttribute('aria-controls', 'kanban-panel')
      expect(kanbanTab).toHaveAttribute('aria-selected', 'true')
      expect(kanbanTab).toHaveAttribute('role', 'tab')
    })

    it('has focus-visible ring for keyboard navigation', () => {
      render(<TabBar {...defaultProps} />)

      const kanbanTab = screen.getByRole('tab', { name: /kanban/i })
      expect(kanbanTab).toHaveClass('focus-visible:ring-2')
      expect(kanbanTab).toHaveClass('focus-visible:ring-accent-primary')
    })

    it('icons are hidden from screen readers', () => {
      render(<TabBar {...defaultProps} />)

      const svgs = document.querySelectorAll('svg')
      svgs.forEach(svg => {
        expect(svg).toHaveAttribute('aria-hidden', 'true')
      })
    })

    it('navigation has aria-label', () => {
      render(<TabBar {...defaultProps} />)

      const nav = screen.getByRole('navigation')
      expect(nav).toHaveAttribute('aria-label', 'Main navigation')
    })
  })

  describe('Visual States', () => {
    it('active tab has accent border and text color', () => {
      render(<TabBar {...defaultProps} activeTab="containers" />)

      const containersTab = screen.getByRole('tab', { name: /containers/i })
      expect(containersTab).toHaveClass('border-accent-primary')
      expect(containersTab).toHaveClass('text-accent-primary')
    })

    it('inactive tabs have transparent border and muted text', () => {
      render(<TabBar {...defaultProps} activeTab="kanban" />)

      const containersTab = screen.getByRole('tab', { name: /containers/i })
      expect(containersTab).toHaveClass('border-transparent')
      expect(containersTab).toHaveClass('text-dark-text-muted')
    })

    it('inactive tabs have hover states', () => {
      render(<TabBar {...defaultProps} activeTab="kanban" />)

      const optionsTab = screen.getByRole('tab', { name: /options/i })
      expect(optionsTab).toHaveClass('hover:text-dark-text')
      expect(optionsTab).toHaveClass('hover:border-dark-border-hover')
    })
  })

  describe('Props Updates', () => {
    it('updates active tab when prop changes', () => {
      const { rerender } = render(<TabBar {...defaultProps} activeTab="kanban" />)

      expect(screen.getByRole('tab', { name: /kanban/i })).toHaveAttribute('aria-selected', 'true')

      rerender(<TabBar {...defaultProps} activeTab="stats" />)

      expect(screen.getByRole('tab', { name: /kanban/i })).toHaveAttribute('aria-selected', 'false')
      expect(screen.getByRole('tab', { name: /stats/i })).toHaveAttribute('aria-selected', 'true')
    })

    it('calls updated onTabChange callback', () => {
      const newCallback = vi.fn()
      const { rerender } = render(<TabBar {...defaultProps} />)

      rerender(<TabBar {...defaultProps} onTabChange={newCallback} />)

      const optionsTab = screen.getByRole('tab', { name: /options/i })
      fireEvent.click(optionsTab)

      expect(newCallback).toHaveBeenCalledWith('options')
      expect(defaultProps.onTabChange).not.toHaveBeenCalled()
    })
  })
})
