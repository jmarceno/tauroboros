import { useMemo, useRef, useEffect, useState } from 'react'
import type { SessionMessage } from '@/types'
import hljs from 'highlight.js'
import 'highlight.js/styles/github-dark.css'

interface RenderedBlock {
  type: 'text' | 'mermaid' | 'code'
  content: string
  language?: string
  id?: string
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

interface ChatMessageProps {
  message: SessionMessage
  showTimestamp?: boolean
}

export function ChatMessage({ message, showTimestamp }: ChatMessageProps) {
  const [renderedBlocks, setRenderedBlocks] = useState<RenderedBlock[]>([])
  const [highlightedCode, setHighlightedCode] = useState<Map<string, string>>(new Map())
  const mermaidContainerRefs = useRef<Map<string, HTMLDivElement>>(new Map())

  const isUser = message.role === 'user'
  const isAssistant = message.role === 'assistant'
  const isSystem = message.role === 'system'
  const isTool = message.role === 'tool' || message.messageType === 'tool_call' || message.messageType === 'tool_result'

  const isThinking = useMemo(() => {
    const content = message.contentJson as Record<string, unknown> || {}
    return content.isThinking === true || message.messageType === 'thinking'
  }, [message.contentJson, message.messageType])

  const isStreaming = useMemo(() => {
    const content = message.contentJson as Record<string, unknown> || {}
    return content.streaming === true
  }, [message.contentJson])

  const messageText = useMemo(() => {
    const content = message.contentJson as Record<string, unknown> || {}

    if (isThinking && typeof content.thinking === 'string') {
      return content.thinking
    }

    if (typeof content.text === 'string') return content.text
    if (typeof content.message === 'string') return content.message
    return JSON.stringify(content)
  }, [message.contentJson, isThinking])

  useEffect(() => {
    if (!messageText) {
      setRenderedBlocks([])
      return
    }

    if (messageText.startsWith('<')) {
      setRenderedBlocks([{ type: 'text', content: messageText }])
      return
    }

    const blocks = parseContentBlocks(messageText)
    setRenderedBlocks(blocks)

    blocks.forEach(block => {
      if (block.type === 'code' && !highlightedCode.has(block.content)) {
        try {
          const result = hljs.highlight(block.content, { language: block.language || 'plaintext' })
          setHighlightedCode(prev => new Map(prev).set(block.content, result.value))
        } catch {
          setHighlightedCode(prev => new Map(prev).set(block.content, block.content))
        }
      }
    })
  }, [messageText])

  useEffect(() => {
    renderedBlocks.forEach(async (block) => {
      if (block.type === 'mermaid' && block.id && !block.content.startsWith('<svg')) {
        const container = mermaidContainerRefs.current.get(block.id)
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
  }, [renderedBlocks])

  const setMermaidRef = (id: string, el: HTMLDivElement | null) => {
    if (el) {
      mermaidContainerRefs.current.set(id, el)
    }
  }

  const formatTimestamp = (timestamp: number) => {
    const date = new Date(timestamp * 1000)
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp * 1000)
    const today = new Date()
    const yesterday = new Date(today)
    yesterday.setDate(yesterday.getDate() - 1)

    if (date.toDateString() === today.toDateString()) {
      return 'Today'
    } else if (date.toDateString() === yesterday.toDateString()) {
      return 'Yesterday'
    } else {
      return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
    }
  }

  return (
    <div className="chat-message">
      {showTimestamp && (
        <div className="flex items-center justify-center my-1">
          <span className="text-xs text-dark-text-muted/50 bg-dark-surface2 px-2 py-0.5 rounded">
            {formatDate(message.timestamp)}
          </span>
        </div>
      )}

      <div className="chat-message-header">
        <span className={`chat-message-sender ${message.role}`}>
          {message.role}
        </span>
        <span className="chat-message-time">{formatTimestamp(message.timestamp)}</span>
      </div>

      <div className={`chat-message-content ${isThinking ? 'text-dark-text-muted/60' : ''}`}>
        {!isUser && (
          <div
            className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 text-xs ${
              isAssistant && !isThinking
                ? 'bg-accent-primary/20 text-accent-primary'
                : isThinking
                ? 'bg-dark-surface3 text-dark-text-muted/50'
                : 'bg-dark-surface3 text-dark-text-muted'
            }`}
          >
            {isAssistant && !isThinking ? (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
              </svg>
            ) : isThinking ? (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
              </svg>
            ) : isTool ? (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            )}
          </div>
        )}

        {renderedBlocks.map((block, index) => {
          if (block.type === 'text' && block.content.startsWith('<')) {
            return <div key={index} dangerouslySetInnerHTML={{ __html: block.content }} />
          }

          if (block.type === 'text') {
            return (
              <div key={index} className="message-text" dangerouslySetInnerHTML={{ __html: renderMarkdown(block.content) }} />
            )
          }

          if (block.type === 'mermaid') {
            return (
              <div key={index} className="my-1.5 bg-dark-bg rounded-lg overflow-hidden border border-dark-border">
                <div className="text-xs text-dark-text-muted/60 px-2 py-1 bg-dark-surface2 border-b border-dark-border flex items-center gap-2">
                  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                  </svg>
                  Chart
                </div>
                <div className="p-2">
                  {block.content.startsWith('<svg') ? (
                    <div dangerouslySetInnerHTML={{ __html: block.content }} />
                  ) : (
                    <div
                      ref={(el) => setMermaidRef(block.id || '', el as HTMLDivElement)}
                      className="p-1"
                    >
                      <pre className="text-xs text-dark-text-muted/80">{block.content}</pre>
                    </div>
                  )}
                </div>
              </div>
            )
          }

          if (block.type === 'code') {
            const highlighted = highlightedCode.get(block.content) || block.content
            return (
              <div key={index} className="my-1 rounded-lg overflow-hidden bg-dark-bg border border-dark-border">
                <div className="text-xs text-dark-text-muted/60 px-2 py-1 bg-dark-surface2 border-b border-dark-border flex items-center justify-between">
                  <span className="font-mono">{block.language}</span>
                </div>
                <pre className="p-2 overflow-x-auto"><code className={`hljs language-${block.language}`} dangerouslySetInnerHTML={{ __html: highlighted }} /></pre>
              </div>
            )
          }

          return null
        })}

        {renderedBlocks.length === 0 && (
          <div className={`whitespace-pre-wrap ${isThinking ? 'text-dark-text-muted/60' : ''}`}>
            {messageText}
          </div>
        )}

        {isTool && message.toolName && (
          <div className="mt-1 pt-1 border-t border-dark-border/30 text-xs opacity-70">
            <span className="font-medium">{message.toolName}</span>
            {message.toolStatus && (
              <span className={`ml-1 ${
                message.toolStatus === 'success' ? 'text-accent-success' : 'text-accent-danger'
              }`}>
                ({message.toolStatus})
              </span>
            )}
          </div>
        )}

        {isThinking && (
          <div className="text-xs text-dark-text-muted/40 mt-1 font-medium select-none">
            thinking...
          </div>
        )}
      </div>
    </div>
  )
}
