import { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from 'react'

export type MainTabId = 'kanban' | 'options' | 'containers' | 'archived' | 'stats'

interface TabContextValue {
  activeTab: MainTabId
  setActiveTab: (tab: MainTabId) => void
}

const TabContext = createContext<TabContextValue | undefined>(undefined)

export function TabProvider({ children }: { children: ReactNode }) {
  const [activeTab, setActiveTabState] = useState<MainTabId>('kanban')

  const setActiveTab = useCallback((tab: MainTabId) => {
    setActiveTabState(tab)
  }, [])

  const value = useMemo(() => ({
    activeTab,
    setActiveTab
  }), [activeTab, setActiveTab])

  return (
    <TabContext.Provider value={value}>
      {children}
    </TabContext.Provider>
  )
}

export function useTabContext(): TabContextValue {
  const context = useContext(TabContext)
  if (!context) {
    throw new Error('useTabContext must be used within a TabProvider')
  }
  return context
}
