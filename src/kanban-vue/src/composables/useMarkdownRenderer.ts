import { ref } from 'vue'
import type mermaidType from 'mermaid'
import type hljsType from 'highlight.js'

// Lazy initialization - will be loaded on demand
let mermaidInstance: typeof mermaidType | null = null
let hljsInstance: typeof hljsType | null = null

async function getMermaid(): Promise<typeof mermaidType> {
  if (!mermaidInstance) {
    const mermaid = (await import('mermaid')).default
    mermaid.initialize({
      startOnLoad: false,
      theme: 'dark',
      securityLevel: 'strict',
      flowchart: {
        useMaxWidth: true,
        htmlLabels: true,
      },
      sequence: {
        useMaxWidth: true,
      },
      gantt: {
        useMaxWidth: true,
      },
    })
    mermaidInstance = mermaid
  }
  return mermaidInstance
}

async function getHljs(): Promise<typeof hljsType> {
  if (!hljsInstance) {
    const hljs = (await import('highlight.js')).default
    hljsInstance = hljs
  }
  return hljsInstance
}

export interface RenderedBlock {
  type: 'text' | 'mermaid' | 'code'
  content: string
  language?: string
  id?: string
}

/**
 * Parse content into blocks (text, mermaid charts, code blocks)
 */
export function parseContentBlocks(content: string): RenderedBlock[] {
  const blocks: RenderedBlock[] = []
  const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g
  let lastIndex = 0
  let match

  while ((match = codeBlockRegex.exec(content)) !== null) {
    // Add text before this code block
    if (match.index > lastIndex) {
      blocks.push({
        type: 'text',
        content: content.slice(lastIndex, match.index),
      })
    }

    const language = match[1]?.toLowerCase() || ''
    const codeContent = match[2]

    if (language === 'mermaid') {
      blocks.push({
        type: 'mermaid',
        content: codeContent.trim(),
        id: `mermaid-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      })
    } else {
      blocks.push({
        type: 'code',
        content: codeContent,
        language: language || 'plaintext',
      })
    }

    lastIndex = match.index + match[0].length
  }

  // Add remaining text after last code block
  if (lastIndex < content.length) {
    blocks.push({
      type: 'text',
      content: content.slice(lastIndex),
    })
  }

  // If no code blocks found, return the whole content as text
  if (blocks.length === 0) {
    blocks.push({
      type: 'text',
      content: content,
    })
  }

  return blocks
}

/**
 * Render mermaid chart and return SVG string
 */
export async function renderMermaidChart(content: string, id: string): Promise<string> {
  try {
    const mermaid = await getMermaid()
    const { svg } = await mermaid.render(id, content)
    return svg
  } catch (error) {
    console.error('Mermaid rendering error:', error)
    return `<div class="mermaid-error">Failed to render chart: ${error instanceof Error ? error.message : 'Unknown error'}</div>`
  }
}

/**
 * Apply syntax highlighting to code
 */
export async function highlightCode(content: string, language: string): Promise<string> {
  try {
    const hljs = await getHljs()
    if (language && language !== 'plaintext' && hljs.getLanguage(language)) {
      const result = hljs.highlight(content, { language, ignoreIllegals: true })
      return result.value
    }
    // Fall back to auto-detection
    const result = hljs.highlightAuto(content)
    return result.value
  } catch (error) {
    console.error('Highlight.js error:', error)
    return escapeHtml(content)
  }
}

/**
 * Escape HTML special characters
 */
export function escapeHtml(text: string): string {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}

/**
 * Simple markdown to HTML converter for non-code content
 */
export function markdownToHtml(text: string): string {
  let result = text
    // Escape HTML
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  // Headers (multiline mode)
  result = result.replace(/^### (.*$)/gim, '<h3>$1</h3>')
  result = result.replace(/^## (.*$)/gim, '<h2>$1</h2>')
  result = result.replace(/^# (.*$)/gim, '<h1>$1</h1>')

  // Bold and italic
  result = result.replace(/\*\*\*(.*?)\*\*\*/g, '<strong><em>$1</em></strong>')
  result = result.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
  result = result.replace(/\*(.*?)\*/g, '<em>$1</em>')
  result = result.replace(/__(.*?)__/g, '<strong>$1</strong>')
  result = result.replace(/_(.*?)_/g, '<em>$1</em>')

  // Inline code
  result = result.replace(/`([^`]+)`/g, '<code>$1</code>')

  // Links
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')

  // Line breaks
  result = result.replace(/\n/g, '<br>')

  return result
}

/**
 * Composable for rendering markdown content with mermaid and syntax highlighting
 */
export function useMarkdownRenderer() {
  const isRendering = ref(false)
  const renderErrors = ref<string[]>([])

  /**
   * Render all blocks and return HTML content
   */
  async function renderContent(content: string): Promise<RenderedBlock[]> {
    isRendering.value = true
    renderErrors.value = []

    try {
      const blocks = parseContentBlocks(content)
      const renderedBlocks: RenderedBlock[] = []

      for (const block of blocks) {
        if (block.type === 'mermaid') {
          try {
            const svg = await renderMermaidChart(block.content, block.id || `mermaid-${Date.now()}`)
            renderedBlocks.push({
              ...block,
              content: svg,
            })
          } catch (error) {
            renderErrors.value.push(`Mermaid error: ${error instanceof Error ? error.message : 'Unknown error'}`)
            renderedBlocks.push(block)
          }
        } else if (block.type === 'code') {
          const highlighted = await highlightCode(block.content, block.language || 'plaintext')
          renderedBlocks.push({
            ...block,
            content: highlighted,
          })
        } else {
          // Convert markdown text to HTML
          renderedBlocks.push({
            ...block,
            content: markdownToHtml(block.content),
          })
        }
      }

      return renderedBlocks
    } finally {
      isRendering.value = false
    }
  }

  return {
    isRendering,
    renderErrors,
    renderContent,
    parseContentBlocks,
    renderMermaidChart,
    highlightCode,
  }
}
