import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useKeyboard } from './useKeyboard'

describe('useKeyboard', () => {
  let addEventListenerSpy: ReturnType<typeof vi.spyOn>
  let removeEventListenerSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    addEventListenerSpy = vi.spyOn(document, 'addEventListener')
    removeEventListenerSpy = vi.spyOn(document, 'removeEventListener')

    Object.defineProperty(document, 'activeElement', {
      value: {
        tagName: 'DIV',
        isContentEditable: false,
        shadowRoot: null,
      },
      writable: true,
      configurable: true,
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const invokeKeydownHandler = (event: KeyboardEvent) => {
    const handlers = addEventListenerSpy.mock.calls
      .filter(([name]) => name === 'keydown')
      .map(([, handler]) => handler)
    handlers.forEach(handler => handler(event))
  }

  describe('Ctrl+G shortcut (Create Group)', () => {
    it('calls onCreateGroup when Ctrl+G is pressed with 2+ selected tasks', () => {
      const onCreateGroup = vi.fn()

      renderHook(() =>
        useKeyboard({
          selectedCount: () => 2,
          onCreateGroup,
        })
      )

      const event = new KeyboardEvent('keydown', {
        key: 'g',
        ctrlKey: true,
        bubbles: true,
      })
      invokeKeydownHandler(event)

      expect(onCreateGroup).toHaveBeenCalledTimes(1)
    })

    it('calls onCreateGroup when Ctrl+G is pressed with 5 selected tasks', () => {
      const onCreateGroup = vi.fn()

      renderHook(() =>
        useKeyboard({
          selectedCount: () => 5,
          onCreateGroup,
        })
      )

      const event = new KeyboardEvent('keydown', {
        key: 'g',
        ctrlKey: true,
        bubbles: true,
      })
      invokeKeydownHandler(event)

      expect(onCreateGroup).toHaveBeenCalledTimes(1)
    })

    it('does NOT call onCreateGroup when Ctrl+G is pressed with only 1 selected task', () => {
      const onCreateGroup = vi.fn()

      renderHook(() =>
        useKeyboard({
          selectedCount: () => 1,
          onCreateGroup,
        })
      )

      const event = new KeyboardEvent('keydown', {
        key: 'g',
        ctrlKey: true,
        bubbles: true,
      })
      invokeKeydownHandler(event)

      expect(onCreateGroup).not.toHaveBeenCalled()
    })

    it('does NOT call onCreateGroup when Ctrl+G is pressed with 0 selected tasks', () => {
      const onCreateGroup = vi.fn()

      renderHook(() =>
        useKeyboard({
          selectedCount: () => 0,
          onCreateGroup,
        })
      )

      const event = new KeyboardEvent('keydown', {
        key: 'g',
        ctrlKey: true,
        bubbles: true,
      })
      invokeKeydownHandler(event)

      expect(onCreateGroup).not.toHaveBeenCalled()
    })

    it('calls onCreateGroup when Cmd+G is pressed (Mac)', () => {
      const onCreateGroup = vi.fn()

      renderHook(() =>
        useKeyboard({
          selectedCount: () => 2,
          onCreateGroup,
        })
      )

      const event = new KeyboardEvent('keydown', {
        key: 'g',
        metaKey: true,
        bubbles: true,
      })
      invokeKeydownHandler(event)

      expect(onCreateGroup).toHaveBeenCalledTimes(1)
    })

    it('is case-insensitive for G key', () => {
      const onCreateGroup = vi.fn()

      renderHook(() =>
        useKeyboard({
          selectedCount: () => 2,
          onCreateGroup,
        })
      )

      // Test with uppercase G
      const event = new KeyboardEvent('keydown', {
        key: 'G',
        ctrlKey: true,
        bubbles: true,
      })
      invokeKeydownHandler(event)

      expect(onCreateGroup).toHaveBeenCalledTimes(1)
    })
  })

  describe('Escape key (Close Group Panel)', () => {
    it('calls onCloseGroupPanel when Escape is pressed and panel is open', () => {
      const onCloseGroupPanel = vi.fn()

      renderHook(() =>
        useKeyboard({
          isGroupPanelOpen: () => true,
          onCloseGroupPanel,
        })
      )

      const event = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
      })
      invokeKeydownHandler(event)

      expect(onCloseGroupPanel).toHaveBeenCalledTimes(1)
    })

    it('does NOT call onCloseGroupPanel when Escape is pressed and panel is closed', () => {
      const onCloseGroupPanel = vi.fn()

      renderHook(() =>
        useKeyboard({
          isGroupPanelOpen: () => false,
          onCloseGroupPanel,
        })
      )

      const event = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
      })
      invokeKeydownHandler(event)

      expect(onCloseGroupPanel).not.toHaveBeenCalled()
    })

    it('calls generic onEscape when Escape is pressed and panel is not open', () => {
      const onEscape = vi.fn().mockReturnValue(true)

      renderHook(() =>
        useKeyboard({
          isGroupPanelOpen: () => false,
          onEscape,
        })
      )

      const event = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
      })
      invokeKeydownHandler(event)

      expect(onEscape).toHaveBeenCalledTimes(1)
    })

    it('does NOT call onEscape when Escape is pressed but panel is open', () => {
      const onEscape = vi.fn()

      renderHook(() =>
        useKeyboard({
          isGroupPanelOpen: () => true,
          onCloseGroupPanel: vi.fn(),
          onEscape,
        })
      )

      const event = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
      })
      invokeKeydownHandler(event)

      // onEscape should NOT be called when panel is open
      expect(onEscape).not.toHaveBeenCalled()
    })

    it('has higher priority for group panel close than generic escape', () => {
      const onCloseGroupPanel = vi.fn()
      const onEscape = vi.fn()

      renderHook(() =>
        useKeyboard({
          isGroupPanelOpen: () => true,
          onCloseGroupPanel,
          onEscape,
        })
      )

      const event = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
      })
      invokeKeydownHandler(event)

      expect(onCloseGroupPanel).toHaveBeenCalledTimes(1)
      expect(onEscape).not.toHaveBeenCalled()
    })
  })

  describe('Other keyboard shortcuts', () => {
    it('skips shortcuts when modal is open', () => {
      const onCreateGroup = vi.fn()

      renderHook(() =>
        useKeyboard({
          isModalOpen: () => true,
          selectedCount: () => 2,
          onCreateGroup,
        })
      )

      const event = new KeyboardEvent('keydown', {
        key: 'g',
        ctrlKey: true,
        bubbles: true,
      })
      invokeKeydownHandler(event)

      expect(onCreateGroup).not.toHaveBeenCalled()
    })

    it('skips shortcuts when editable control is focused', () => {
      const onCreateGroup = vi.fn()

      // Set active element to input
      Object.defineProperty(document, 'activeElement', {
        value: {
          tagName: 'INPUT',
          isContentEditable: false,
          shadowRoot: null,
        },
        writable: true,
        configurable: true,
      })

      renderHook(() =>
        useKeyboard({
          selectedCount: () => 2,
          onCreateGroup,
        })
      )

      const event = new KeyboardEvent('keydown', {
        key: 'g',
        ctrlKey: true,
        bubbles: true,
      })
      invokeKeydownHandler(event)

      expect(onCreateGroup).not.toHaveBeenCalled()
    })

    it('skips shortcuts when textarea is focused', () => {
      const onCreateGroup = vi.fn()

      // Set active element to textarea
      Object.defineProperty(document, 'activeElement', {
        value: {
          tagName: 'TEXTAREA',
          isContentEditable: false,
          shadowRoot: null,
        },
        writable: true,
        configurable: true,
      })

      renderHook(() =>
        useKeyboard({
          selectedCount: () => 2,
          onCreateGroup,
        })
      )

      const event = new KeyboardEvent('keydown', {
        key: 'g',
        ctrlKey: true,
        bubbles: true,
      })
      invokeKeydownHandler(event)

      expect(onCreateGroup).not.toHaveBeenCalled()
    })
  })

  describe('Cleanup', () => {
    it('removes event listener on unmount', () => {
      const { unmount } = renderHook(() =>
        useKeyboard({
          selectedCount: () => 2,
          onCreateGroup: vi.fn(),
        })
      )

      unmount()

      expect(removeEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function))
    })
  })

  describe('Ctrl+1-5 tab switching shortcuts', () => {
    it('calls onSwitchTab with 1 when Ctrl+1 is pressed', () => {
      const onSwitchTab = vi.fn()

      renderHook(() =>
        useKeyboard({
          onSwitchTab,
        })
      )

      const event = new KeyboardEvent('keydown', {
        key: '1',
        ctrlKey: true,
        bubbles: true,
      })
      invokeKeydownHandler(event)

      expect(onSwitchTab).toHaveBeenCalledTimes(1)
      expect(onSwitchTab).toHaveBeenCalledWith(1)
    })

    it('calls onSwitchTab with 2 when Ctrl+2 is pressed', () => {
      const onSwitchTab = vi.fn()

      renderHook(() =>
        useKeyboard({
          onSwitchTab,
        })
      )

      const event = new KeyboardEvent('keydown', {
        key: '2',
        ctrlKey: true,
        bubbles: true,
      })
      invokeKeydownHandler(event)

      expect(onSwitchTab).toHaveBeenCalledTimes(1)
      expect(onSwitchTab).toHaveBeenCalledWith(2)
    })

    it('calls onSwitchTab with 3 when Ctrl+3 is pressed', () => {
      const onSwitchTab = vi.fn()

      renderHook(() =>
        useKeyboard({
          onSwitchTab,
        })
      )

      const event = new KeyboardEvent('keydown', {
        key: '3',
        ctrlKey: true,
        bubbles: true,
      })
      invokeKeydownHandler(event)

      expect(onSwitchTab).toHaveBeenCalledTimes(1)
      expect(onSwitchTab).toHaveBeenCalledWith(3)
    })

    it('calls onSwitchTab with 4 when Ctrl+4 is pressed', () => {
      const onSwitchTab = vi.fn()

      renderHook(() =>
        useKeyboard({
          onSwitchTab,
        })
      )

      const event = new KeyboardEvent('keydown', {
        key: '4',
        ctrlKey: true,
        bubbles: true,
      })
      invokeKeydownHandler(event)

      expect(onSwitchTab).toHaveBeenCalledTimes(1)
      expect(onSwitchTab).toHaveBeenCalledWith(4)
    })

    it('calls onSwitchTab with 5 when Ctrl+5 is pressed', () => {
      const onSwitchTab = vi.fn()

      renderHook(() =>
        useKeyboard({
          onSwitchTab,
        })
      )

      const event = new KeyboardEvent('keydown', {
        key: '5',
        ctrlKey: true,
        bubbles: true,
      })
      invokeKeydownHandler(event)

      expect(onSwitchTab).toHaveBeenCalledTimes(1)
      expect(onSwitchTab).toHaveBeenCalledWith(5)
    })

    it('calls onSwitchTab when Cmd+1 is pressed (Mac)', () => {
      const onSwitchTab = vi.fn()

      renderHook(() =>
        useKeyboard({
          onSwitchTab,
        })
      )

      const event = new KeyboardEvent('keydown', {
        key: '1',
        metaKey: true,
        bubbles: true,
      })
      invokeKeydownHandler(event)

      expect(onSwitchTab).toHaveBeenCalledTimes(1)
      expect(onSwitchTab).toHaveBeenCalledWith(1)
    })

    it('does NOT call onSwitchTab for Ctrl+6 (out of range)', () => {
      const onSwitchTab = vi.fn()

      renderHook(() =>
        useKeyboard({
          onSwitchTab,
        })
      )

      const event = new KeyboardEvent('keydown', {
        key: '6',
        ctrlKey: true,
        bubbles: true,
      })
      invokeKeydownHandler(event)

      expect(onSwitchTab).not.toHaveBeenCalled()
    })

    it('does NOT call onSwitchTab for Ctrl+0 (out of range)', () => {
      const onSwitchTab = vi.fn()

      renderHook(() =>
        useKeyboard({
          onSwitchTab,
        })
      )

      const event = new KeyboardEvent('keydown', {
        key: '0',
        ctrlKey: true,
        bubbles: true,
      })
      invokeKeydownHandler(event)

      expect(onSwitchTab).not.toHaveBeenCalled()
    })

    it('prevents default on tab switch shortcuts', () => {
      const onSwitchTab = vi.fn()

      renderHook(() =>
        useKeyboard({
          onSwitchTab,
        })
      )

      const event = new KeyboardEvent('keydown', {
        key: '1',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      })
      const preventDefaultSpy = vi.spyOn(event, 'preventDefault')
      invokeKeydownHandler(event)

      expect(preventDefaultSpy).toHaveBeenCalled()
    })

    it('does NOT call onSwitchTab when modal is open', () => {
      const onSwitchTab = vi.fn()

      renderHook(() =>
        useKeyboard({
          onSwitchTab,
          isModalOpen: () => true,
        })
      )

      const event = new KeyboardEvent('keydown', {
        key: '1',
        ctrlKey: true,
        bubbles: true,
      })
      invokeKeydownHandler(event)

      expect(onSwitchTab).not.toHaveBeenCalled()
    })

    it('does NOT call onSwitchTab when editable control is focused', () => {
      const onSwitchTab = vi.fn()

      // Set active element to input
      Object.defineProperty(document, 'activeElement', {
        value: {
          tagName: 'INPUT',
          isContentEditable: false,
          shadowRoot: null,
        },
        writable: true,
        configurable: true,
      })

      renderHook(() =>
        useKeyboard({
          onSwitchTab,
        })
      )

      const event = new KeyboardEvent('keydown', {
        key: '1',
        ctrlKey: true,
        bubbles: true,
      })
      invokeKeydownHandler(event)

      expect(onSwitchTab).not.toHaveBeenCalled()
    })

    it('handles multiple tab switches in sequence', () => {
      const onSwitchTab = vi.fn()

      renderHook(() =>
        useKeyboard({
          onSwitchTab,
        })
      )

      // Press Ctrl+1 through Ctrl+5 in sequence
      for (let i = 1; i <= 5; i++) {
        const event = new KeyboardEvent('keydown', {
          key: String(i),
          ctrlKey: true,
          bubbles: true,
        })
        invokeKeydownHandler(event)
      }

      expect(onSwitchTab).toHaveBeenCalledTimes(5)
      expect(onSwitchTab).toHaveBeenNthCalledWith(1, 1)
      expect(onSwitchTab).toHaveBeenNthCalledWith(2, 2)
      expect(onSwitchTab).toHaveBeenNthCalledWith(3, 3)
      expect(onSwitchTab).toHaveBeenNthCalledWith(4, 4)
      expect(onSwitchTab).toHaveBeenNthCalledWith(5, 5)
    })
  })
})