interface HelpButtonProps {
  tooltip: string
  'aria-label'?: string
}

export function HelpButton({ tooltip, 'aria-label': ariaLabel }: HelpButtonProps) {
  return (
    <span className="tooltip-container">
      <span className="help-btn" aria-label={ariaLabel} role="button" tabIndex={0}>
        ?
      </span>
      <span className="tooltip">{tooltip}</span>
    </span>
  )
}
