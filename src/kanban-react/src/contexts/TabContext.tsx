import { createContext, useContext, useState, useCallback, memo, type ReactNode } from "react"

/**
 * Tab ID type for the main application tabs.
 * These tabs replace the project name area in the TopBar.
 */
export type MainTabId = "kanban" | "options" | "containers" | "archived" | "stats"

/**
 * Interface for the tab context value.
 */
interface TabContextValue {
  /** Currently active tab ID */
  activeTab: MainTabId
  /** Function to change the active tab */
  setActiveTab: (tab: MainTabId) => void
}

/**
 * React context for managing tab state.
 * Default tab is "kanban" and state is NOT persisted to localStorage.
 */
const TabContext = createContext<TabContextValue | undefined>(undefined)

/**
 * Hook to access the tab context.
 * Must be used within a TabProvider.
 */
export function useTabContext(): TabContextValue {
  const context = useContext(TabContext)
  if (context === undefined) {
    throw new Error("useTabContext must be used within a TabProvider")
  }
  return context
}

interface TabProviderProps {
  children: ReactNode
  /** Initial active tab, defaults to "kanban" */
  initialTab?: MainTabId
}

/**
 * Provider component for tab state management.
 * Manages the active tab state without persisting to localStorage.
 */
export const TabProvider = memo(function TabProvider({
  children,
  initialTab = "kanban",
}: TabProviderProps) {
  const [activeTab, setActiveTabState] = useState<MainTabId>(initialTab)

  const setActiveTab = useCallback((tab: MainTabId) => {
    setActiveTabState(tab)
  }, [])

  const value: TabContextValue = {
    activeTab,
    setActiveTab,
  }

  return <TabContext.Provider value={value}>{children}</TabContext.Provider>
})

export { TabContext }
