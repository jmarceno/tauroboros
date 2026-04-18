import { memo, useCallback, useRef, useEffect, type ReactNode } from "react"
import type { MainTabId } from "@/contexts/TabContext"

/**
 * Props for the TabBar component.
 */
export interface TabBarProps {
  /** Currently active tab ID */
  activeTab: MainTabId
  /** Callback when a tab is selected */
  onTabChange: (tab: MainTabId) => void
}

/**
 * Tab definition with ID, label, and icon.
 */
interface TabDefinition {
  id: MainTabId
  label: string
  icon: ReactNode
}

// SVG Icons for each tab
const KanbanIcon = memo(function KanbanIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-4 h-4"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
    </svg>
  )
})

const OptionsIcon = memo(function OptionsIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-4 h-4"
      aria-hidden="true"
    >
      <path d="M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z" />
      <path d="M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" />
      <path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m6.34 17.66-1.41 1.41" />
      <path d="m19.07 4.93-1.41 1.41" />
    </svg>
  )
})

const ContainersIcon = memo(function ContainersIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-4 h-4"
      aria-hidden="true"
    >
      <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
      <path d="m3.3 7 8.7 5 8.7-5" />
      <path d="M12 22V12" />
    </svg>
  )
})

const ArchivedIcon = memo(function ArchivedIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-4 h-4"
      aria-hidden="true"
    >
      <path d="M21 8v13H3V8" />
      <path d="M1 3h22v5H1z" />
      <path d="M10 12h4" />
    </svg>
  )
})

const StatsIcon = memo(function StatsIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-4 h-4"
      aria-hidden="true"
    >
      <path d="M3 3v18h18" />
      <path d="m19 9-5 5-4-4-3 3" />
    </svg>
  )
})

const TAB_DEFINITIONS: TabDefinition[] = [
  { id: "kanban", label: "Kanban", icon: <KanbanIcon /> },
  { id: "options", label: "Options", icon: <OptionsIcon /> },
  { id: "containers", label: "Containers", icon: <ContainersIcon /> },
  { id: "archived", label: "Archived", icon: <ArchivedIcon /> },
  { id: "stats", label: "Stats", icon: <StatsIcon /> },
]

/**
 * Horizontal tab bar component for the main application areas.
 * Replaces the project name in the TopBar area with 5 tabs.
 */
export const TabBar = memo(function TabBar({ activeTab, onTabChange }: TabBarProps) {
  const tabsRef = useRef<(HTMLButtonElement | null)[]>([])

  const handleTabClick = useCallback(
    (tabId: MainTabId) => {
      onTabChange(tabId)
    },
    [onTabChange]
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
      let newIndex: number | null = null

      switch (event.key) {
        case "ArrowLeft":
          event.preventDefault()
          newIndex = index > 0 ? index - 1 : TAB_DEFINITIONS.length - 1
          break
        case "ArrowRight":
          event.preventDefault()
          newIndex = index < TAB_DEFINITIONS.length - 1 ? index + 1 : 0
          break
        case "Home":
          event.preventDefault()
          newIndex = 0
          break
        case "End":
          event.preventDefault()
          newIndex = TAB_DEFINITIONS.length - 1
          break
        case "Enter":
        case " ":
          event.preventDefault()
          onTabChange(TAB_DEFINITIONS[index].id)
          break
      }

      if (newIndex !== null) {
        const tabElement = tabsRef.current[newIndex]
        if (tabElement) {
          tabElement.focus()
          onTabChange(TAB_DEFINITIONS[newIndex].id)
        }
      }
    },
    [onTabChange]
  )

  useEffect(() => {
    tabsRef.current = tabsRef.current.slice(0, TAB_DEFINITIONS.length)
  }, [])

  return (
    <nav
      className="flex items-center px-4 bg-dark-surface border-b border-dark-border"
      aria-label="Main navigation"
    >
      <div
        className="flex items-center gap-1"
        role="tablist"
        aria-label="Application tabs"
      >
        {TAB_DEFINITIONS.map((tab, index) => {
          const isActive = tab.id === activeTab

          return (
            <button
              key={tab.id}
              ref={(el) => {
                tabsRef.current[index] = el
              }}
              role="tab"
              aria-selected={isActive}
              aria-controls={`${tab.id}-panel`}
              id={`${tab.id}-tab`}
              tabIndex={isActive ? 0 : -1}
              onClick={() => handleTabClick(tab.id)}
              onKeyDown={(e) => handleKeyDown(e, index)}
              className={`
                flex items-center gap-2 px-4 py-3 text-sm font-medium
                border-b-2 transition-colors duration-150 cursor-pointer
                focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary focus-visible:ring-inset
                ${
                  isActive
                    ? "border-accent-primary text-accent-primary"
                    : "border-transparent text-dark-text-muted hover:text-dark-text hover:border-dark-border-hover"
                }
              `}
            >
              {tab.icon}
              <span>{tab.label}</span>
            </button>
          )
        })}
      </div>
    </nav>
  )
})
