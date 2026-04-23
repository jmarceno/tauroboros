/**
 * MermaidModal Component - Fullscreen modal for viewing mermaid diagrams
 */

import { createSignal, Show, onMount, onCleanup, createEffect } from 'solid-js'
import { Portal } from 'solid-js/web'

interface MermaidModalProps {
  isOpen: boolean
  content: string
  title?: string
  onClose: () => void
}

export function MermaidModal(props: MermaidModalProps) {
  const [zoom, setZoom] = createSignal(1)
  const [svgContent, setSvgContent] = createSignal('')
  const [isLoading, setIsLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  // Render mermaid content when modal opens
  createEffect(() => {
    if (!props.isOpen || !props.content) return

    // If content is already an SVG, use it directly
    if (props.content.trim().startsWith('<svg') || props.content.trim().startsWith('<!DOCTYPE svg')) {
      setSvgContent(props.content)
      setIsLoading(false)
      setError(null)
      return
    }

    setIsLoading(true)
    setError(null)

    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default
        mermaid.initialize({
          startOnLoad: false,
          theme: 'dark',
          securityLevel: 'strict',
        })
        const { svg } = await mermaid.render(`modal-mermaid-${Date.now()}`, props.content)
        setSvgContent(svg)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to render diagram')
      } finally {
        setIsLoading(false)
      }
    })()
  })

  // Reset zoom when closing
  createEffect(() => {
    if (!props.isOpen) {
      setZoom(1)
    }
  })

  // Handle keyboard shortcuts
  onMount(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!props.isOpen) return

      switch (e.key) {
        case 'Escape':
          e.preventDefault()
          props.onClose()
          break
        case '+':
        case '=':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault()
            setZoom(prev => Math.min(prev + 0.25, 3))
          }
          break
        case '-':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault()
            setZoom(prev => Math.max(prev - 0.25, 0.25))
          }
          break
        case '0':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault()
            setZoom(1)
          }
          break
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    onCleanup(() => window.removeEventListener('keydown', handleKeyDown))
  })

  return (
    <Portal>
      <Show when={props.isOpen}>
        <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
          {/* Modal Container */}
          <div class="w-[95vw] h-[95vh] bg-dark-surface rounded-lg border border-dark-border flex flex-col shadow-2xl">
            {/* Header */}
            <div class="flex items-center justify-between px-4 py-3 border-b border-dark-border bg-dark-surface2 rounded-t-lg">
              <div class="flex items-center gap-3">
                <svg class="w-5 h-5 text-accent-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
                <span class="text-dark-text font-medium">
                  {props.title || 'Mermaid Diagram'}
                </span>
              </div>
              <div class="flex items-center gap-2">
                {/* Zoom Controls */}
                <div class="flex items-center gap-1 bg-dark-bg rounded-lg px-2 py-1">
                  <button
                    class="p-1.5 rounded hover:bg-dark-surface3 text-dark-text-secondary hover:text-dark-text transition-colors"
                    onClick={() => setZoom(prev => Math.max(prev - 0.25, 0.25))}
                    title="Zoom out (-)"
                  >
                    <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M20 12H4" />
                    </svg>
                  </button>
                  <span class="text-xs text-dark-text-muted min-w-[3rem] text-center">
                    {Math.round(zoom() * 100)}%
                  </span>
                  <button
                    class="p-1.5 rounded hover:bg-dark-surface3 text-dark-text-secondary hover:text-dark-text transition-colors"
                    onClick={() => setZoom(prev => Math.min(prev + 0.25, 3))}
                    title="Zoom in (+)"
                  >
                    <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M12 4v16m8-8H4" />
                    </svg>
                  </button>
                  <div class="w-px h-4 bg-dark-border mx-1" />
                  <button
                    class="p-1.5 rounded hover:bg-dark-surface3 text-dark-text-secondary hover:text-accent-primary transition-colors text-xs font-medium"
                    onClick={() => setZoom(1)}
                    title="Reset zoom (Ctrl+0)"
                  >
                    Fit
                  </button>
                </div>

                {/* Close Button */}
                <button
                  class="p-1.5 rounded hover:bg-accent-danger/20 text-dark-text-secondary hover:text-accent-danger transition-colors"
                  onClick={props.onClose}
                  title="Close (Escape)"
                >
                  <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Content Area */}
            <div class="flex-1 overflow-auto bg-dark-bg relative">
              <Show when={isLoading()}>
                <div class="absolute inset-0 flex items-center justify-center">
                  <svg class="w-8 h-8 animate-spin text-accent-primary" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                </div>
              </Show>

              <Show when={error()}>
                <div class="absolute inset-0 flex items-center justify-center p-8">
                  <div class="bg-accent-danger/10 border border-accent-danger/30 rounded-lg p-4 text-center">
                    <svg class="w-8 h-8 text-accent-danger mx-auto mb-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <p class="text-accent-danger text-sm">{error()}</p>
                  </div>
                </div>
              </Show>

              <Show when={!isLoading() && !error() && svgContent()}>
                <div 
                  class="min-h-full flex items-center justify-center p-8"
                  style={{ transform: `scale(${zoom()})`, 'transform-origin': 'center center' }}
                >
                  <div innerHTML={svgContent()} />
                </div>
              </Show>
            </div>

            {/* Footer with shortcuts */}
            <div class="px-4 py-2 border-t border-dark-border bg-dark-surface2 rounded-b-lg">
              <div class="flex items-center justify-between text-xs text-dark-text-muted">
                <div class="flex items-center gap-4">
                  <span class="flex items-center gap-1">
                    <kbd class="px-1.5 py-0.5 bg-dark-surface3 rounded text-dark-text-secondary">Ctrl/Cmd</kbd>
                    <span>+</span>
                    <kbd class="px-1.5 py-0.5 bg-dark-surface3 rounded text-dark-text-secondary">+</kbd>
                    <span>Zoom in</span>
                  </span>
                  <span class="flex items-center gap-1">
                    <kbd class="px-1.5 py-0.5 bg-dark-surface3 rounded text-dark-text-secondary">Ctrl/Cmd</kbd>
                    <span>+</span>
                    <kbd class="px-1.5 py-0.5 bg-dark-surface3 rounded text-dark-text-secondary">-</kbd>
                    <span>Zoom out</span>
                  </span>
                  <span class="flex items-center gap-1">
                    <kbd class="px-1.5 py-0.5 bg-dark-surface3 rounded text-dark-text-secondary">Esc</kbd>
                    <span>Close</span>
                  </span>
                </div>
                <div class="text-dark-text-muted/50">
                  Mermaid Diagram Viewer
                </div>
              </div>
            </div>
          </div>
        </div>
      </Show>
    </Portal>
  )
}
