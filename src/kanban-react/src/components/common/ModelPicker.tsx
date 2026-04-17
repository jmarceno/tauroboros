import { useState, useRef, useEffect, useCallback } from 'react'
import type { ModelEntry } from '@/types'
import { useModelSearch } from '@/hooks'
import { HelpButton } from './HelpButton'

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
  const [isMouseDown, setIsMouseDown] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setQuery(modelValue)
  }, [modelValue])

  const suggestions = modelSearch.getSuggestions(query, 12)

  const handleFocus = useCallback(() => {
    if (!disabled) {
      setShowDropdown(true)
    }
  }, [disabled])

  const handleBlur = useCallback(() => {
    // Delay to allow clicking on dropdown items
    setTimeout(() => {
      if (!isMouseDown) {
        setShowDropdown(false)
        const normalized = modelSearch.normalizeValue(query)
        if (normalized !== modelValue) {
          onUpdate(normalized)
        }
      }
    }, 200)
  }, [query, modelValue, modelSearch, onUpdate, isMouseDown])

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value
    setQuery(value)
    setShowDropdown(true)
  }, [])

  const handleSelect = useCallback((value: string) => {
    setQuery(value)
    onUpdate(value)
    setShowDropdown(false)
    setIsMouseDown(false)
    inputRef.current?.blur()
  }, [onUpdate])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // Prevent blur from firing when clicking dropdown
    if (showDropdown) {
      setIsMouseDown(true)
    }
  }, [showDropdown])

  const handleMouseUp = useCallback(() => {
    setIsMouseDown(false)
  }, [])

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowDropdown(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  return (
    <div className="form-group" ref={containerRef}>
      <div className="label-row">
        <label>{label}</label>
        {help && <HelpButton tooltip={help} />}
      </div>
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          className="form-input"
          placeholder="Type model name..."
          disabled={disabled}
          value={query}
          onChange={handleInputChange}
          onFocus={handleFocus}
          onBlur={handleBlur}
        />
        {showDropdown && suggestions.length > 0 && (
          <div
            className="absolute top-full left-0 right-0 mt-1 bg-[#1a1a1a] border border-dark-surface3 rounded-lg shadow-lg z-[100] max-h-48 overflow-y-auto"
            onMouseDown={handleMouseDown}
            onMouseUp={handleMouseUp}
          >
            {suggestions.map((suggestion: ModelEntry) => (
              <div
                key={`${suggestion.value}-${suggestion.providerId}`}
                className="px-3 py-2 text-sm cursor-pointer hover:bg-accent-primary/10"
                onClick={() => handleSelect(suggestion.value)}
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
