/**
 * Tab Store - Tab state management
 * Replaces: TabContext
 */

import { createSignal, createRoot } from 'solid-js'

export type MainTabId = 'kanban' | 'options' | 'archived' | 'stats' | 'self-heal'

function createTabStore() {
  const [activeTab, setActiveTab] = createSignal<MainTabId>('kanban')

  return {
    activeTab,
    setActiveTab,
  }
}

// Export singleton store - wrapped in createRoot for proper disposal
export const tabStore = createRoot((dispose) => {
  const store = createTabStore()
  return store
})
