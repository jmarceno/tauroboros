/**
 * HelpButton Component - Help tooltip button
 * Ported from React to SolidJS
 */

interface HelpButtonProps {
  tooltip: string
  'aria-label'?: string
}

export function HelpButton(props: HelpButtonProps) {
  return (
    <span class="tooltip-container">
      <span class="help-btn" aria-label={props['aria-label']} role="button" tabIndex={0}>
        ?
      </span>
      <span class="tooltip">{props.tooltip}</span>
    </span>
  )
}
