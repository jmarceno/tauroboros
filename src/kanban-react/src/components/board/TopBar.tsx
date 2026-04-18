export function TopBar() {
  return (
    <header className="top-bar">
      {/* Left: Spacer (TabBar now handles navigation) */}
      <div className="flex-1" />

      {/* Right: Actions */}
      <div className="flex items-center gap-3">
        {/* Keyboard shortcuts hint */}
        <div className="hidden md:flex items-center gap-3 text-xs text-dark-text-muted">
          <span className="flex items-center gap-1">
            <kbd className="font-mono text-dark-text font-bold border border-dark-border rounded px-1 bg-dark-surface2">T</kbd>
            Template
          </span>
          <span className="flex items-center gap-1">
            <kbd className="font-mono text-dark-text font-bold border border-dark-border rounded px-1 bg-dark-surface2">B</kbd>
            Task
          </span>
          <span className="flex items-center gap-1">
            <kbd className="font-mono text-dark-text font-bold border border-dark-border rounded px-1 bg-dark-surface2">P</kbd>
            Chat
          </span>
          <span className="flex items-center gap-1">
            <kbd className="font-mono text-dark-text font-bold border border-dark-border rounded px-1 bg-dark-surface2">Ctrl+1-5</kbd>
            Tabs
          </span>
          <span className="flex items-center gap-1">
            <kbd className="font-mono text-dark-text font-bold border border-dark-border rounded px-1 bg-dark-surface2">Esc</kbd>
            Close
          </span>
        </div>
      </div>
    </header>
  )
}
