import { useState, useRef, useEffect } from 'react'
import type { ModelEntry } from '@/types'
import { useModelSearch } from '@/hooks'

interface ModelPickerProps {
  modelValue: string
  label: string
  help?: string
  disabled?: boolean
  onUpdate: (value: string) => void
}

export function ModelPicker({ modelValue, label, help, disabled, onUpdate }: ModelPickerProps) {
  const modelSearch = useModelSearch()
  const [query, setQuery] = useState(modelValue)
  const [showDropdown, setShowDropdown] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setQuery(modelValue)
  }, [modelValue])

  const suggestions = modelSearch.getSuggestions(query, 12)

  const onBlur = () => {
    setTimeout(() => {
      setShowDropdown(false)
      const normalized = modelSearch.normalizeValue(query)
      if (normalized !== modelValue) {
        onUpdate(normalized)
      }
    }, 200)
  }

  const selectOption = (value: string) => {
    setQuery(value)
    onUpdate(value)
    setShowDropdown(false)
    inputRef.current?.blur()
  }

  return (
    <div className="form-group">
      <div className="label-row">
        <label>{label}</label>
        {help && <span className="help-btn" title={help}>?</span>}
      </div>
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          className="form-input"
          placeholder="Type model name..."
          disabled={disabled}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setShowDropdown(true)
          }}
          onFocus={() => setShowDropdown(true)}
          onBlur={onBlur}
        />
        {showDropdown && suggestions.length > 0 && (
          <div className="absolute top-full left-0 right-0 mt-1 bg-[#1a1a1a] border border-dark-surface3 rounded-lg shadow-lg z-50 max-h-48 overflow-y-auto">
            {suggestions.map((suggestion: ModelEntry) => (
              <div
                key={`${suggestion.value}-${suggestion.providerId}`}
                className="px-3 py-2 text-sm cursor-pointer hover:bg-accent-primary/10"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => selectOption(suggestion.value)}
              >
                <div className="font-medium">{suggestion.label}</div>
                {suggestion.providerName && suggestion.providerName !== 'default' && (
                  <div className="text-xs text-dark-text-muted">
                    {suggestion.providerName}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}