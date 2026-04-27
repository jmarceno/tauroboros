/**
 * TopBar Component - Top header bar with tabs and keyboard shortcuts hint
 * Tabs are always visible; keyboard shortcuts hide on small screens to save space.
 * Ported from React to SolidJS - Full feature parity
 */

import { For, createSignal } from 'solid-js'
import type { MainTabId } from '@/stores/tabStore'

interface TopBarProps {
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
    class="w-4 h-4 shrink-0"
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
    class="w-4 h-4 shrink-0"
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

const ContainersIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    class="w-4 h-4 shrink-0"
    aria-hidden="true"
  >
    <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
    <path d="m3.3 7 8.7 5 8.7-5" />
    <path d="M12 22V12" />
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
    class="w-4 h-4 shrink-0"
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
    class="w-4 h-4 shrink-0"
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
    class="w-4 h-4 shrink-0"
    aria-hidden="true"
  >
    <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10Z" />
    <path d="m9 12 2 2 4-4" />
  </svg>
)

const TAB_DEFINITIONS: TabDefinition[] = [
  { id: 'kanban', label: 'Kanban', icon: KanbanIcon },
  { id: 'options', label: 'Options', icon: OptionsIcon },
  { id: 'containers', label: 'Containers', icon: ContainersIcon },
  { id: 'archived', label: 'Archived', icon: ArchivedIcon },
  { id: 'stats', label: 'Stats', icon: StatsIcon },
  { id: 'self-heal', label: 'Self-Heal', icon: SelfHealIcon },
]

export function TopBar(props: TopBarProps) {
  const [tabRefs, setTabRefs] = createSignal<(HTMLButtonElement | null)[]>([])

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
    <header class="top-bar gap-0">
      {/* Left: Tabs */}
      <div
        class="flex items-center gap-1 overflow-x-auto min-w-0 flex-1"
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
                onClick={() => props.onTabChange(tab.id)}
                onKeyDown={(e) => handleKeyDown(e, index())}
                class={`
                  flex items-center gap-1.5 px-3 py-2 text-sm font-medium whitespace-nowrap
                  border-b-2 transition-colors duration-150 cursor-pointer shrink-0
                  focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary focus-visible:ring-inset
                  ${
                    isActive()
                      ? 'border-accent-primary text-accent-primary'
                      : 'border-transparent text-dark-text-muted hover:text-dark-text hover:border-dark-border-hover'
                  }
                `}
              >
                {tab.icon()}
                {/* Label hidden on very small screens, shown on md+ */}
                <span class="hidden sm:inline">{tab.label}</span>
              </button>
            )
          }}
        </For>
      </div>

      {/* Right: Keyboard shortcuts hint - hidden on small screens to save space for tabs */}
      <div class="hidden md:flex items-center gap-3 text-xs text-dark-text-muted flex-shrink-0 ml-2">
        <span class="flex items-center gap-1">
          <kbd class="font-mono text-dark-text font-bold border border-dark-border rounded px-1 bg-dark-surface2">T</kbd>
          Template
        </span>
        <span class="flex items-center gap-1">
          <kbd class="font-mono text-dark-text font-bold border border-dark-border rounded px-1 bg-dark-surface2">B</kbd>
          Task
        </span>
        <span class="flex items-center gap-1">
          <kbd class="font-mono text-dark-text font-bold border border-dark-border rounded px-1 bg-dark-surface2">P</kbd>
          Chat
        </span>
        <span class="flex items-center gap-1">
          <kbd class="font-mono text-dark-text font-bold border border-dark-border rounded px-1 bg-dark-surface2">Ctrl+1-5</kbd>
          Tabs
        </span>
        <span class="flex items-center gap-1">
          <kbd class="font-mono text-dark-text font-bold border border-dark-border rounded px-1 bg-dark-surface2">Esc</kbd>
          Close
        </span>
      </div>
    </header>
  )
}
