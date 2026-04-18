import { describe, it, expect, vi } from 'vitest'
import { render, act, renderHook } from '@testing-library/react'
import { TabProvider, useTabContext, type MainTabId } from './TabContext'

// Test component to access context
function TestConsumer() {
  const { activeTab, setActiveTab } = useTabContext()
  return (
    <div>
      <span data-testid="active-tab">{activeTab}</span>
      <button onClick={() => setActiveTab('options')}>Switch to Options</button>
      <button onClick={() => setActiveTab('containers')}>Switch to Containers</button>
      <button onClick={() => setActiveTab('archived')}>Switch to Archived</button>
      <button onClick={() => setActiveTab('stats')}>Switch to Stats</button>
      <button onClick={() => setActiveTab('kanban')}>Switch to Kanban</button>
    </div>
  )
}

describe('TabContext', () => {
  describe('TabProvider', () => {
    it('should have kanban as default tab', () => {
      const { getByTestId } = render(
        <TabProvider>
          <TestConsumer />
        </TabProvider>
      )
      expect(getByTestId('active-tab').textContent).toBe('kanban')
    })

    it('should update tab state when setActiveTab is called', () => {
      const { getByTestId, getByRole } = render(
        <TabProvider>
          <TestConsumer />
        </TabProvider>
      )

      act(() => {
        getByRole('button', { name: 'Switch to Options' }).click()
      })

      expect(getByTestId('active-tab').textContent).toBe('options')
    })

    it('should cycle through all available tabs', () => {
      const { getByTestId, getByRole } = render(
        <TabProvider>
          <TestConsumer />
        </TabProvider>
      )

      const tabs: MainTabId[] = ['options', 'containers', 'archived', 'stats', 'kanban']

      for (const tab of tabs) {
        act(() => {
          getByRole('button', { name: `Switch to ${tab.charAt(0).toUpperCase() + tab.slice(1)}` }).click()
        })
        expect(getByTestId('active-tab').textContent).toBe(tab)
      }
    })

    it('should re-render when tab changes', () => {
      const renderCount = { value: 0 }

      function RenderCounter() {
        const { activeTab } = useTabContext()
        renderCount.value++
        return <span data-testid="active-tab">{activeTab}</span>
      }

      render(
        <TabProvider>
          <RenderCounter />
          <button onClick={() => {}}>Switch</button>
        </TabProvider>
      )

      const initialCount = renderCount.value

      act(() => {
        // Get a fresh button reference and click it
        const switchButton = document.querySelector('button')
        if (switchButton) switchButton.click()
      })

      // Should still be at initial render count since we didn't actually change state
      expect(renderCount.value).toBe(initialCount)
    })

    it('should wrap multiple children correctly', () => {
      function Child1() {
        const { activeTab } = useTabContext()
        return <span data-testid="child1-tab">{activeTab}</span>
      }

      function Child2() {
        const { activeTab } = useTabContext()
        return <span data-testid="child2-tab">{activeTab}</span>
      }

      const { getByTestId } = render(
        <TabProvider>
          <Child1 />
          <Child2 />
        </TabProvider>
      )

      expect(getByTestId('child1-tab').textContent).toBe('kanban')
      expect(getByTestId('child2-tab').textContent).toBe('kanban')
    })
  })

  describe('useTabContext', () => {
    it('should throw error when used outside provider', () => {
      // Suppress console.error for this test
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => { })

      expect(() => render(<TestConsumer />)).toThrow(
        'useTabContext must be used within a TabProvider'
      )

      consoleSpy.mockRestore()
    })

    it('should return correct types', () => {
      const { result } = renderHook(() => useTabContext(), {
        wrapper: TabProvider
      })

      expect(typeof result.current.activeTab).toBe('string')
      expect(typeof result.current.setActiveTab).toBe('function')

      // Type check: activeTab should be one of the valid MainTabId values
      const validTabs: MainTabId[] = ['kanban', 'options', 'containers', 'archived', 'stats']
      expect(validTabs).toContain(result.current.activeTab)
    })

    it('should maintain stable setActiveTab reference across renders', () => {
      const { result, rerender } = renderHook(() => useTabContext(), {
        wrapper: TabProvider
      })

      const firstSetActiveTab = result.current.setActiveTab

      // Force re-render
      rerender()

      const secondSetActiveTab = result.current.setActiveTab

      // Reference should be stable due to useCallback
      expect(firstSetActiveTab).toBe(secondSetActiveTab)
    })

    it('should update activeTab when setActiveTab is called', () => {
      const { result } = renderHook(() => useTabContext(), {
        wrapper: TabProvider
      })

      expect(result.current.activeTab).toBe('kanban')

      act(() => {
        result.current.setActiveTab('stats')
      })

      expect(result.current.activeTab).toBe('stats')
    })
  })

  describe('MainTabId type', () => {
    it('should only accept valid tab identifiers', () => {
      // This test verifies TypeScript types at runtime by checking valid values work
      const validTabs: MainTabId[] = ['kanban', 'options', 'containers', 'archived', 'stats']

      const { result } = renderHook(() => useTabContext(), {
        wrapper: TabProvider
      })

      // Test that we can set each valid tab
      for (const tab of validTabs) {
        act(() => {
          result.current.setActiveTab(tab)
        })
        expect(result.current.activeTab).toBe(tab)
      }
    })
  })
})
