import { HelpButton } from './HelpButton'
import type { ThinkingLevel } from '@/types'

interface ThinkingLevelSelectProps {
  modelValue: ThinkingLevel
  label?: string
  help?: string
  disabled?: boolean
  onUpdate: (value: ThinkingLevel) => void
}

export function ThinkingLevelSelect({ modelValue, label, help, disabled, onUpdate }: ThinkingLevelSelectProps) {
  return (
    <div className="form-group">
      {label && (
        <div className="label-row">
          <label>{label}</label>
          {help && <HelpButton tooltip={help} />}
        </div>
      )}
      <select
        className="form-select"
        disabled={disabled}
        value={modelValue}
        onChange={(e) => onUpdate(e.target.value as ThinkingLevel)}
      >
        <option value="default">Default</option>
        <option value="low">Low</option>
        <option value="medium">Medium</option>
        <option value="high">High</option>
      </select>
    </div>
  )
}
