/**
 * ThinkingLevelSelect Component - Thinking level dropdown
 * Ported from React to SolidJS
 */

import { Show } from 'solid-js'
import { HelpButton } from './HelpButton'
import type { ThinkingLevel } from '@/types'

interface ThinkingLevelSelectProps {
  modelValue: ThinkingLevel
  label?: string
  help?: string
  disabled?: boolean
  onUpdate: (value: ThinkingLevel) => void
}

export function ThinkingLevelSelect(props: ThinkingLevelSelectProps) {
  return (
    <div class="form-group">
      <Show when={props.label}>
        <div class="label-row">
          <label>{props.label}</label>
          <Show when={props.help}>
            <HelpButton tooltip={props.help!} />
          </Show>
        </div>
      </Show>
      <select
        class="form-select"
        disabled={props.disabled}
        value={props.modelValue}
        onChange={(e) => props.onUpdate(e.currentTarget.value as ThinkingLevel)}
      >
        <option value="default">Default</option>
        <option value="low">Low</option>
        <option value="medium">Medium</option>
        <option value="high">High</option>
      </select>
    </div>
  )
}
