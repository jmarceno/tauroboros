/**
 * Tab Store - Tab state management
 * Replaces: TabContext
 */

import { createSignal } from 'solid-js'

export type MainTabId = 'kanban' | 'options' | 'containers' | 'archived' | 'stats'

function createTabStore() {
  const [activeTab, setActiveTab] = createSignal<MainTabId>('kanban')

  return {
    activeTab,
    setActiveTab,
  }
}

export const tabStore = createTabStore()
