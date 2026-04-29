/**
 * TabBar Component - Tab navigation bar
 * Ported from React to SolidJS
 */

import { For, createSignal, onMount } from 'solid-js'
import type { MainTabId } from '@/stores/tabStore'

interface TabBarProps {
  activeTab: MainTabId
  onTabChange: (tab: MainTabId) => void
}

interface TabDefinition {
  id: MainTabId
  label: string
  icon: () => JSX.Element
}

// SVG Icons for each tab
const KanbanIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    class="w-4 h-4"
    aria-hidden="true"
  >
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="14" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
  </svg>
)

const OptionsIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    class="w-4 h-4"
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

const ArchivedIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    class="w-4 h-4"
    aria-hidden="true"
  >
    <path d="M21 8v13H3V8" />
    <path d="M1 3h22v5H1z" />
    <path d="M10 12h4" />
  </svg>
)

const StatsIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    class="w-4 h-4"
    aria-hidden="true"
  >
    <path d="M3 3v18h18" />
    <path d="m19 9-5 5-4-4-3 3" />
  </svg>
)

const SelfHealIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    class="w-4 h-4"
    aria-hidden="true"
  >
    <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10Z" />
    <path d="m9 12 2 2 4-4" />
  </svg>
)

const TAB_DEFINITIONS: TabDefinition[] = [
  { id: 'kanban', label: 'Kanban', icon: KanbanIcon },
  { id: 'options', label: 'Options', icon: OptionsIcon },
  { id: 'archived', label: 'Archived', icon: ArchivedIcon },
  { id: 'stats', label: 'Stats', icon: StatsIcon },
  { id: 'self-heal', label: 'Self-Heal', icon: SelfHealIcon },
]

export function TabBar(props: TabBarProps) {
  const [tabRefs, setTabRefs] = createSignal<(HTMLButtonElement | null)[]>([])

  const handleTabClick = (tabId: MainTabId) => {
    props.onTabChange(tabId)
  }

  const handleKeyDown = (event: KeyboardEvent, index: number) => {
    let newIndex: number | null = null

    switch (event.key) {
      case 'ArrowLeft':
        event.preventDefault()
        newIndex = index > 0 ? index - 1 : TAB_DEFINITIONS.length - 1
        break
      case 'ArrowRight':
        event.preventDefault()
        newIndex = index < TAB_DEFINITIONS.length - 1 ? index + 1 : 0
        break
      case 'Home':
        event.preventDefault()
        newIndex = 0
        break
      case 'End':
        event.preventDefault()
        newIndex = TAB_DEFINITIONS.length - 1
        break
      case 'Enter':
      case ' ':
        event.preventDefault()
        props.onTabChange(TAB_DEFINITIONS[index].id)
        break
    }

    if (newIndex !== null) {
      const tabElement = tabRefs()[newIndex]
      if (tabElement) {
        tabElement.focus()
        props.onTabChange(TAB_DEFINITIONS[newIndex].id)
      }
    }
  }

  return (
    <nav
      class="flex items-center px-4 bg-dark-surface border-b border-dark-border"
      aria-label="Main navigation"
    >
      <div
        class="flex items-center gap-1"
        role="tablist"
        aria-label="Application tabs"
      >
        <For each={TAB_DEFINITIONS}>
          {(tab, index) => {
            const isActive = () => tab.id === props.activeTab

            return (
              <button
                ref={(el) => {
                  const refs = tabRefs()
                  refs[index()] = el
                  setTabRefs(refs)
                }}
                role="tab"
                aria-selected={isActive()}
                aria-controls={`${tab.id}-panel`}
                id={`${tab.id}-tab`}
                tabIndex={isActive() ? 0 : -1}
                onClick={() => handleTabClick(tab.id)}
                onKeyDown={(e) => handleKeyDown(e, index())}
                class={`
                  flex items-center gap-2 px-4 py-3 text-sm font-medium
                  border-b-2 transition-colors duration-150 cursor-pointer
                  focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary focus-visible:ring-inset
                  ${
                    isActive()
                      ? 'border-accent-primary text-accent-primary'
                      : 'border-transparent text-dark-text-muted hover:text-dark-text hover:border-dark-border-hover'
                  }
                `}
              >
                {tab.icon()}
                <span>{tab.label}</span>
              </button>
            )
          }}
        </For>
      </div>
    </nav>
  )
}
