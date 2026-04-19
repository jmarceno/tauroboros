/**
 * TopBar Component - Top header bar with keyboard shortcuts hint
 * Ported from React to SolidJS - Full feature parity
 */

export function TopBar() {
  return (
    <header class="top-bar">
      {/* Left: Spacer (TabBar now handles navigation) */}
      <div class="flex-1" />

      {/* Right: Actions */}
      <div class="flex items-center gap-3">
        {/* Keyboard shortcuts hint */}
        <div class="hidden md:flex items-center gap-3 text-xs text-dark-text-muted">
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
      </div>
    </header>
  )
}
