/**
 * MermaidBlock Component - Renders a single mermaid diagram
 * Handles its own lifecycle to ensure proper rendering
 */

import { createSignal, onMount, Show } from 'solid-js'

interface MermaidBlockProps {
  content: string
  id: string
  onMaximize: (svg: string) => void
}

export function MermaidBlock(props: MermaidBlockProps) {
  const [svg, setSvg] = createSignal<string | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [loading, setLoading] = createSignal(true)

  onMount(async () => {
    try {
      // Pre-validation: Check content validity
      if (!props.content?.trim()) {
        throw new Error('Empty diagram content')
      }
      
      if (props.content.length > 5000) {
        throw new Error('Diagram too large (max 5000 chars)')
      }

      const mermaid = (await import('mermaid')).default
      
      // Try to parse first - catches syntax errors early (non-blocking)
      try {
        await mermaid.parse(props.content)
      } catch (parseErr) {
        console.warn('Mermaid parse warning:', parseErr)
      }

      mermaid.initialize({
        startOnLoad: false,
        theme: 'dark',
        securityLevel: 'strict',
      })

      const { svg: renderedSvg } = await mermaid.render(
        `${props.id}-svg`, 
        props.content
      )
      
      setSvg(renderedSvg)
      setError(null)
    } catch (err) {
      console.error('Mermaid render failed:', err)
      setError(err instanceof Error ? err.message : 'Failed to render diagram')
    } finally {
      setLoading(false)
    }
  })

  const handleMaximize = () => {
    const currentSvg = svg()
    if (currentSvg) {
      props.onMaximize(currentSvg)
    } else {
      // If not rendered yet, use raw content
      props.onMaximize(props.content)
    }
  }

  return (
    <div class="my-1.5 bg-dark-bg rounded-lg overflow-hidden border border-dark-border">
      <div class="text-xs text-dark-text-muted/60 px-2 py-1 bg-dark-surface2 border-b border-dark-border flex items-center justify-between">
        <div class="flex items-center gap-2">
          <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
          </svg>
          Chart
        </div>
        <button
          class="p-1 rounded hover:bg-dark-surface3 text-dark-text-muted hover:text-accent-primary transition-colors"
          onClick={handleMaximize}
          title="Maximize diagram"
          disabled={loading()}
        >
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
          </svg>
        </button>
      </div>
      <div class="p-2">
        <Show when={!loading() && !error() && svg()} fallback={
          <Show when={error()} fallback={
            <div class="p-1">
              <pre class="text-xs text-dark-text-muted/80">{props.content}</pre>
            </div>
          }>
            <div class="mermaid-error p-2 text-sm text-accent-danger border border-accent-danger/30 rounded bg-accent-danger/10">
              <div class="flex items-start gap-2">
                <svg class="w-4 h-4 mt-0.5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <div>
                  <p class="font-medium">Failed to render chart</p>
                  <p class="text-xs mt-1 opacity-80">{error()}</p>
                </div>
              </div>
            </div>
          </Show>
        }>
          <div innerHTML={svg()!} />
        </Show>
      </div>
    </div>
  )
}
