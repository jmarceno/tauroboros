/**
 * ChatMessage Component - Individual chat message
 * Ported from React to SolidJS - Full feature parity with markdown, code highlighting, mermaid
 */

import { createMemo, Show, For, createSignal, createEffect, onMount } from 'solid-js'
import type { SessionMessage } from '@/types'
import { formatRelativeTime, formatLocalDate } from '@/utils/date'
import hljs from 'highlight.js'
import 'highlight.js/styles/github-dark.css'

interface RenderedBlock {
  type: 'text' | 'mermaid' | 'code'
  content: string
  language?: string
  id?: string
}

interface ChatMessageProps {
  message: SessionMessage
  showTimestamp?: boolean
}

function parseContentBlocks(content: string): RenderedBlock[] {
  const blocks: RenderedBlock[] = []
  const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g
  let lastIndex = 0
  let match

  while ((match = codeBlockRegex.exec(content)) !== null) {
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

  if (lastIndex < content.length) {
    blocks.push({
      type: 'text',
      content: content.slice(lastIndex),
    })
  }

  if (blocks.length === 0) {
    blocks.push({
      type: 'text',
      content: content,
    })
  }

  return blocks
}

function renderMarkdown(text: string): string {
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, code) => {
      return `<pre><code class="hljs language-${lang || 'plaintext'}">${code.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code></pre>`
    })
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\n/g, '<br/>')
  return html
}

export function ChatMessage(props: ChatMessageProps) {
  const [renderedBlocks, setRenderedBlocks] = createSignal<RenderedBlock[]>([])
  const [highlightedCode, setHighlightedCode] = createSignal<Map<string, string>>(new Map())
  const mermaidContainerRefs: Record<string, HTMLDivElement | undefined> = {}

  const isUser = createMemo(() => props.message.role === 'user')
  const isAssistant = createMemo(() => props.message.role === 'assistant')
  const isSystem = createMemo(() => props.message.role === 'system')
  const isTool = createMemo(() => props.message.role === 'tool' || props.message.messageType === 'tool_call' || props.message.messageType === 'tool_result')

  const isThinking = createMemo(() => {
    const content = props.message.contentJson || {}
    return content.isThinking === true || props.message.messageType === 'thinking'
  })

  const isStreaming = createMemo(() => {
    const content = props.message.contentJson || {}
    return content.streaming === true
  })

  const messageText = createMemo(() => {
    const content = props.message.contentJson || {}

    if (isThinking() && typeof content.thinking === 'string') {
      return content.thinking
    }

    if (typeof content.text === 'string') return content.text
    if (typeof content.message === 'string') return content.message
    return JSON.stringify(content)
  })

  // Parse content blocks when text changes
  createEffect(() => {
    const text = messageText()
    if (!text) {
      setRenderedBlocks([])
      return
    }

    if (text.startsWith('<')) {
      setRenderedBlocks([{ type: 'text', content: text }])
      return
    }

    const blocks = parseContentBlocks(text)
    setRenderedBlocks(blocks)

    // Highlight code blocks
    blocks.forEach(block => {
      if (block.type === 'code' && !highlightedCode().has(block.content)) {
        try {
          const result = hljs.highlight(block.content, { language: block.language || 'plaintext' })
          setHighlightedCode(prev => new Map(prev).set(block.content, result.value))
        } catch (err) {
          console.error('Failed to highlight code:', err)
          setHighlightedCode(prev => new Map(prev).set(block.content, block.content))
        }
      }
    })
  })

  // Render mermaid diagrams
  createEffect(() => {
    const blocks = renderedBlocks()
    blocks.forEach(async (block) => {
      if (block.type === 'mermaid' && block.id && !block.content.startsWith('<svg')) {
        const container = mermaidContainerRefs[block.id]
        if (container) {
          try {
            const mermaid = (await import('mermaid')).default
            mermaid.initialize({
              startOnLoad: false,
              theme: 'dark',
              securityLevel: 'strict',
            })
            const { svg } = await mermaid.render(`${block.id}-svg`, block.content)
            container.innerHTML = svg
          } catch (error) {
            container.innerHTML = `<div class="mermaid-error">Failed to render chart</div>`
          }
        }
      }
    })
  })

  const setMermaidRef = (id: string, el: HTMLDivElement | undefined) => {
    if (el) {
      mermaidContainerRefs[id] = el
    }
  }

  const formatTimestamp = (timestamp: number) => {
    return formatRelativeTime(timestamp)
  }

  const formatDate = (timestamp: number) => {
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) {
      return 'Unknown date'
    }

    const date = new Date(timestamp * 1000)
    const today = new Date()
    const yesterday = new Date(today)
    yesterday.setDate(yesterday.getDate() - 1)

    if (date.toDateString() === today.toDateString()) {
      return 'Today'
    } else if (date.toDateString() === yesterday.toDateString()) {
      return 'Yesterday'
    } else {
      return formatLocalDate(timestamp)
    }
  }

  return (
    <div class="chat-message">
      <Show when={props.showTimestamp}>
        <div class="flex items-center justify-center my-1">
          <span class="text-xs text-dark-text-muted/50 bg-dark-surface2 px-2 py-0.5 rounded">
            {formatDate(props.message.timestamp)}
          </span>
        </div>
      </Show>

      <div class="chat-message-header">
        <span class={`chat-message-sender ${props.message.role}`}>
          {props.message.role}
        </span>
        <span class="chat-message-time">{formatTimestamp(props.message.timestamp)}</span>
      </div>

      <div class={`chat-message-content ${isThinking() ? 'text-dark-text-muted/60' : ''}`}>
        <Show when={!isUser()}>
          <div
            class={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 text-xs ${
              isAssistant() && !isThinking()
                ? 'bg-accent-primary/20 text-accent-primary'
                : isThinking()
                ? 'bg-dark-surface3 text-dark-text-muted/50'
                : 'bg-dark-surface3 text-dark-text-muted'
            }`}
          >
            <Show when={isAssistant() && !isThinking()}>
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
              </svg>
            </Show>
            <Show when={isThinking()}>
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
              </svg>
            </Show>
            <Show when={isTool()}>
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </Show>
          </div>
        </Show>

        <For each={renderedBlocks()}>
          {(block, index) => {
            if (block.type === 'text' && block.content.startsWith('<')) {
              return <div innerHTML={block.content} />
            }

            if (block.type === 'text') {
              return (
                <div class="message-text" innerHTML={renderMarkdown(block.content)} />
              )
            }

            if (block.type === 'mermaid') {
              return (
                <div class="my-1.5 bg-dark-bg rounded-lg overflow-hidden border border-dark-border">
                  <div class="text-xs text-dark-text-muted/60 px-2 py-1 bg-dark-surface2 border-b border-dark-border flex items-center gap-2">
                    <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                    </svg>
                    Chart
                  </div>
                  <div class="p-2">
                    {block.content.startsWith('<svg') ? (
                      <div innerHTML={block.content} />
                    ) : (
                      <div
                        ref={(el) => setMermaidRef(block.id!, el)}
                        class="p-1"
                      >
                        <pre class="text-xs text-dark-text-muted/80">{block.content}</pre>
                      </div>
                    )}
                  </div>
                </div>
              )
            }

            if (block.type === 'code') {
              const highlighted = highlightedCode().get(block.content) || block.content
              return (
                <div class="my-1 rounded-lg overflow-hidden bg-dark-bg border border-dark-border">
                  <div class="text-xs text-dark-text-muted/60 px-2 py-1 bg-dark-surface2 border-b border-dark-border flex items-center justify-between">
                    <span class="font-mono">{block.language}</span>
                  </div>
                  <pre class="p-2 overflow-x-auto"><code class={`hljs language-${block.language}`} innerHTML={highlighted} /></pre>
                </div>
              )
            }

            return null
          }}
        </For>

        <Show when={renderedBlocks().length === 0}>
          <div class={`whitespace-pre-wrap ${isThinking() ? 'text-dark-text-muted/60' : ''}`}>
            {messageText()}
          </div>
        </Show>

        <Show when={isTool() && props.message.toolName}>
          <div class="mt-1 pt-1 border-t border-dark-border/30 text-xs opacity-70">
            <span class="font-medium">{props.message.toolName}</span>
            <Show when={props.message.toolStatus}>
              <span class={`ml-1 ${
                props.message.toolStatus === 'success' ? 'text-accent-success' : 'text-accent-danger'
              }`}>
                ({props.message.toolStatus})
              </span>
            </Show>
          </div>
        </Show>

        <Show when={isThinking()}>
          <div class="text-xs text-dark-text-muted/40 mt-1 font-medium select-none">
            thinking...
          </div>
        </Show>
      </div>
    </div>
  )
}
