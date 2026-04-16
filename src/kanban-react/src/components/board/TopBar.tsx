import { useOptionsContext } from '@/contexts/AppContext'

export function TopBar() {
  const { options } = useOptionsContext()

  return (
    <header className="top-bar">
      <div className="flex items-center gap-4">
        <div className="text-sm text-dark-text-secondary">
          Branch: <span className="text-dark-text font-medium">{options?.branch || 'default'}</span>
        </div>
        {options?.planModel && (
          <div className="text-sm text-dark-text-secondary">
            Plan: <span className="text-dark-text font-medium">{options.planModel}</span>
          </div>
        )}
        {options?.executionModel && (
          <div className="text-sm text-dark-text-secondary">
            Exec: <span className="text-dark-text font-medium">{options.executionModel}</span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-4">
        {options?.container?.enabled && (
          <div className="flex items-center gap-2 text-sm text-accent-success">
            <span>🐳</span>
            <span>Container Mode</span>
          </div>
        )}
        {options?.showExecutionGraph && (
          <div className="text-sm text-dark-text-muted">
            Execution Graph Preview
          </div>
        )}
      </div>
    </header>
  )
}
