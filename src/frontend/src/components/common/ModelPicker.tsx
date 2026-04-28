/**
 * ModelPicker Component - AI model selection with search
 * Ported from React to SolidJS
 */

import { createSignal, createEffect, onMount, Show, For } from 'solid-js'
import { createQuery } from '@tanstack/solid-query'
import Fuse from 'fuse.js'
import { referenceApi, runApiEffect } from '@/api'
import { HelpButton } from './HelpButton'
import type { ModelEntry } from '@/types'

interface ModelPickerProps {
  modelValue: string
  label: string
  help?: string
  disabled?: boolean
  onUpdate: (value: string) => void
}

export function ModelPicker(props: ModelPickerProps) {
  const [query, setQuery] = createSignal(props.modelValue)
  const [showDropdown, setShowDropdown] = createSignal(false)
  const [isMouseDown, setIsMouseDown] = createSignal(false)
  const [fuse, setFuse] = createSignal<Fuse<ModelEntry> | null>(null)
  let inputRef: HTMLInputElement | undefined
  let containerRef: HTMLDivElement | undefined

  const modelsQuery = createQuery(() => ({
    queryKey: ['models'],
    queryFn: () => runApiEffect(referenceApi.getModels()),
    staleTime: 60000,
  }))

  // Build fuse index when models load
  createEffect(() => {
    const catalog = modelsQuery.data
    if (!catalog) return

    const searchIndex: ModelEntry[] = []
    for (const provider of catalog.providers) {
      for (const model of provider.models) {
        searchIndex.push({
          ...model,
          providerId: provider.id,
          providerName: provider.name,
        })
      }
    }

    const fuseInstance = new Fuse(searchIndex, {
      keys: ['label', 'value', 'providerName'],
      threshold: 0.4,
    })
    setFuse(fuseInstance)
  })

  // Update query when modelValue changes
  createEffect(() => {
    setQuery(props.modelValue)
  })

  const suggestions = (): ModelEntry[] => {
    const fuseInstance = fuse()
    if (!fuseInstance) return []
    if (!query()) {
      return fuseInstance.getIndex().docs.slice(0, 12)
    }
    const results = fuseInstance.search(query(), { limit: 12 })
    return results.map(r => r.item)
  }

  const handleFocus = () => {
    if (!props.disabled) {
      setShowDropdown(true)
    }
  }

  const handleBlur = () => {
    // Delay to allow clicking on dropdown items
    setTimeout(() => {
      if (!isMouseDown()) {
        setShowDropdown(false)
        normalizeAndUpdate()
      }
    }, 200)
  }

  const normalizeAndUpdate = () => {
    const catalog = modelsQuery.data
    if (!catalog) return

    const normalized = query().toLowerCase().trim()
    const searchIndex: ModelEntry[] = []
    for (const provider of catalog.providers) {
      for (const model of provider.models) {
        searchIndex.push({
          ...model,
          providerId: provider.id,
          providerName: provider.name,
        })
      }
    }

    const found = searchIndex.find(m =>
      m.value.toLowerCase() === normalized ||
      m.label.toLowerCase() === normalized
    )

    const finalValue = found?.value || query()
    if (finalValue !== props.modelValue) {
      props.onUpdate(finalValue)
    }
  }

  const handleInputChange = (e: Event) => {
    const value = (e.target as HTMLInputElement).value
    setQuery(value)
    setShowDropdown(true)
  }

  const handleSelect = (value: string) => {
    setQuery(value)
    props.onUpdate(value)
    setShowDropdown(false)
    setIsMouseDown(false)
    inputRef?.blur()
  }

  const handleMouseDown = () => {
    if (showDropdown()) {
      setIsMouseDown(true)
    }
  }

  const handleMouseUp = () => {
    setIsMouseDown(false)
  }

  // Close dropdown when clicking outside
  const handleClickOutside = (e: MouseEvent) => {
    if (containerRef && !containerRef.contains(e.target as Node)) {
      setShowDropdown(false)
    }
  }

  onMount(() => {
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  })

  return (
    <div class="form-group" ref={containerRef}>
      <div class="label-row">
        <label>{props.label}</label>
        <Show when={props.help}>
          <HelpButton tooltip={props.help!} />
        </Show>
      </div>
      <div class="relative">
        <input
          ref={inputRef}
          type="text"
          class="form-input"
          placeholder="Type model name..."
          disabled={props.disabled}
          value={query()}
          onInput={handleInputChange}
          onFocus={handleFocus}
          onBlur={handleBlur}
        />
        <Show when={showDropdown() && suggestions().length > 0}>
          <div
            class="absolute top-full left-0 right-0 mt-1 bg-[#1a1a1a] border border-dark-surface3 rounded-lg shadow-lg z-[100] max-h-48 overflow-y-auto"
            onMouseDown={handleMouseDown}
            onMouseUp={handleMouseUp}
          >
            <For each={suggestions()}>
              {(suggestion) => (
                <div
                  class="px-3 py-2 text-sm cursor-pointer hover:bg-accent-primary/10"
                  onClick={() => handleSelect(suggestion.value)}
                >
                  <div class="font-medium">{suggestion.label}</div>
                  <Show when={suggestion.providerName && suggestion.providerName !== 'default'}>
                    <div class="text-xs text-dark-text-muted">
                      {suggestion.providerName}
                    </div>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  )
}
