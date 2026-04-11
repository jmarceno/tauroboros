<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'
import type { SessionMessage } from '@/types/api'
import { useMarkdownRenderer, type RenderedBlock } from '@/composables/useMarkdownRenderer'

const props = defineProps<{
  message: SessionMessage
  showTimestamp?: boolean
}>()

const { renderContent, parseContentBlocks } = useMarkdownRenderer()

const isUser = computed(() => props.message.role === 'user')
const isAssistant = computed(() => props.message.role === 'assistant')
const isSystem = computed(() => props.message.role === 'system')
const isTool = computed(() => props.message.role === 'tool' || props.message.messageType === 'tool_call' || props.message.messageType === 'tool_result')

// Check if this is a thinking message
const isThinking = computed(() => {
  const content = props.message.contentJson || {}
  return content.isThinking === true || props.message.messageType === 'thinking'
})

// Check if this is a streaming/incomplete message
const isStreaming = computed(() => {
  const content = props.message.contentJson || {}
  return content.streaming === true
})

const messageText = computed(() => {
  const content = props.message.contentJson
  
  // For thinking messages, show the thinking content
  if (isThinking.value && typeof content.thinking === 'string') {
    return content.thinking
  }
  
  // For regular messages
  if (typeof content.text === 'string') return content.text
  if (typeof content.message === 'string') return content.message
  return JSON.stringify(content)
})

// Rendered content blocks
const renderedBlocks = ref<RenderedBlock[]>([])

// Watch for message changes and render content
watch(() => messageText.value, async (text) => {
  if (!text) {
    renderedBlocks.value = []
    return
  }

  // For HTML content from TipTap, don't re-render
  if (text.startsWith('<')) {
    renderedBlocks.value = [{ type: 'text', content: text }]
    return
  }

  // For thinking messages or streaming messages, just parse blocks without async rendering
  if (isThinking.value || isStreaming.value) {
    renderedBlocks.value = parseContentBlocks(text)
    return
  }

  // Render full content with mermaid and syntax highlighting
  renderedBlocks.value = await renderContent(text)
}, { immediate: true })

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

// Template ref for mermaid containers
const mermaidContainerRefs = ref<Map<string, HTMLElement>>(new Map())

// Render mermaid charts after DOM updates
watch(() => renderedBlocks.value, async () => {
  await nextTick()
  
  // Find all mermaid blocks and render them
  for (const block of renderedBlocks.value) {
    if (block.type === 'mermaid' && block.id && !block.content.startsWith('<svg')) {
      const container = mermaidContainerRefs.value.get(block.id)
      if (container) {
        try {
          const mermaid = (await import('mermaid')).default
          const { svg } = await mermaid.render(`${block.id}-svg`, block.content)
          container.innerHTML = svg
        } catch (error) {
          console.error('Failed to render mermaid chart:', error)
          container.innerHTML = `<div class="mermaid-error text-red-400 text-xs p-2 bg-red-500/10 rounded">Failed to render chart: ${error instanceof Error ? error.message : 'Unknown error'}</div>`
        }
      }
    }
  }
}, { flush: 'post' })

// Store mermaid container ref
const setMermaidRef = (id: string, el: HTMLElement | null) => {
  if (el) {
    mermaidContainerRefs.value.set(id, el)
  }
}
</script>

<template>
  <div class="flex flex-col gap-1">
    <!-- Date/Time Header -->
    <div
      v-if="showTimestamp"
      class="flex items-center justify-center my-2"
    >
      <span class="text-xs text-dark-dim/50 bg-dark-surface2 px-2 py-0.5 rounded">
        {{ formatDate(message.timestamp) }}
      </span>
    </div>

    <!-- Message Bubble -->
    <div
      class="flex gap-2"
      :class="{
        'justify-end': isUser,
        'justify-start': isAssistant || isSystem || isTool
      }"
    >
      <!-- Avatar/Icon -->
      <div
        v-if="!isUser"
        class="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 text-xs"
        :class="{
          'bg-accent/20 text-accent': isAssistant && !isThinking,
          'bg-dark-surface3 text-dark-dim/50': isThinking,
          'bg-dark-surface3 text-dark-dim': isSystem || isTool
        }"
      >
        <svg
          v-if="isAssistant && !isThinking"
          class="w-4 h-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
        </svg>
        <svg
          v-else-if="isThinking"
          class="w-4 h-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
        </svg>
        <svg
          v-else-if="isTool"
          class="w-4 h-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
        <svg
          v-else
          class="w-4 h-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      </div>

      <!-- Message Content -->
      <div
        class="max-w-[85%] rounded-lg px-3 py-2 text-sm prose prose-invert prose-sm overflow-hidden"
        :class="{
          'bg-accent text-white': isUser,
          'bg-dark-surface2 text-dark-text': isAssistant && !isThinking,
          'bg-transparent border border-dark-surface3/50 text-dark-dim/70 italic': isThinking,
          'bg-dark-surface3/50 text-dark-dim text-xs italic': isSystem,
          'bg-dark-surface3/80 text-dark-dim text-xs': isTool
        }"
      >
        <!-- Thinking Label -->
        <div 
          v-if="isThinking" 
          class="text-xs text-dark-dim/40 mb-1 font-medium select-none"
        >
          thinking...
        </div>

        <!-- Render blocks -->
        <template v-for="(block, index) in renderedBlocks" :key="index">
          <!-- HTML content from TipTap -->
          <div
            v-if="block.type === 'text' && block.content.startsWith('<')"
            v-html="block.content"
          />
          
          <!-- Rendered markdown text -->
          <div
            v-else-if="block.type === 'text'"
            class="message-text"
            v-html="block.content"
          />
          
          <!-- Mermaid chart -->
          <div
            v-else-if="block.type === 'mermaid'"
            class="mermaid-chart my-3 bg-dark-bg rounded-lg overflow-hidden"
          >
            <div class="mermaid-header text-xs text-dark-dim/60 px-2 py-1 bg-dark-surface3/50 border-b border-dark-surface3 flex items-center gap-2">
              <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
              Chart
            </div>
            <div
              v-if="block.content.startsWith('<svg')"
              class="mermaid-svg p-2"
              v-html="block.content"
            />
            <div
              v-else
              :ref="(el) => setMermaidRef(block.id || '', el as HTMLElement)"
              class="mermaid-container p-2"
            >
              <pre class="text-xs text-dark-dim/80">{{ block.content }}</pre>
            </div>
          </div>
          
          <!-- Code block with syntax highlighting -->
          <div
            v-else-if="block.type === 'code'"
            class="code-block my-2 rounded-lg overflow-hidden bg-dark-bg border border-dark-surface3"
          >
            <div class="code-header text-xs text-dark-dim/60 px-3 py-1.5 bg-dark-surface3/50 border-b border-dark-surface3 flex items-center justify-between">
              <span class="font-mono">{{ block.language }}</span>
            </div>
            <pre class="p-3 overflow-x-auto"><code class="hljs language-{{ block.language }}" v-html="block.content"></code></pre>
          </div>
        </template>

        <!-- Fallback for plain text (when no blocks rendered yet) -->
        <div
          v-if="renderedBlocks.length === 0"
          class="whitespace-pre-wrap"
          :class="{ 'text-dark-dim/60': isThinking }"
        >{{ messageText }}</div>

        <!-- Tool Call Details -->
        <div
          v-if="isTool && message.toolName"
          class="mt-1 pt-1 border-t border-dark-surface3/30 text-xs opacity-70"
        >
          <span class="font-medium">{{ message.toolName }}</span>
          <span
            v-if="message.toolStatus"
            class="ml-1"
            :class="{
              'text-green-400': message.toolStatus === 'success',
              'text-red-400': message.toolStatus === 'error'
            }"
          >
            ({{ message.toolStatus }})
          </span>
        </div>

        <!-- Timestamp in message (only for non-streaming complete messages) -->
        <div
          v-if="!isStreaming && !isThinking"
          class="mt-1 text-xs opacity-50 text-right"
          :class="{
            'text-white/50': isUser,
            'text-dark-dim': !isUser
          }"
        >
          {{ formatTimestamp(message.timestamp) }}
        </div>
      </div>

      <!-- User Avatar -->
      <div
        v-if="isUser"
        class="w-6 h-6 rounded-full bg-dark-surface3 flex items-center justify-center flex-shrink-0 text-xs"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
        </svg>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Style markdown content from TipTap */
.prose :deep(h1) { font-size: 1.25em; font-weight: 600; margin: 0.5em 0; }
.prose :deep(h2) { font-size: 1.1em; font-weight: 600; margin: 0.5em 0; }
.prose :deep(h3) { font-size: 1em; font-weight: 600; margin: 0.5em 0; }
.prose :deep(p) { margin: 0.3em 0; }
.prose :deep(ul) { list-style-type: disc; padding-left: 1.2em; margin: 0.3em 0; }
.prose :deep(ol) { list-style-type: decimal; padding-left: 1.2em; margin: 0.3em 0; }
.prose :deep(li) { margin: 0.1em 0; }
.prose :deep(code) {
  background: rgba(0, 0, 0, 0.2);
  padding: 0.1em 0.3em;
  border-radius: 3px;
  font-family: 'JetBrains Mono', 'Fira Code', 'Monaco', 'Menlo', monospace;
  font-size: 0.9em;
}
.prose :deep(pre) {
  background: rgba(0, 0, 0, 0.2);
  padding: 0.5em;
  border-radius: 4px;
  overflow-x: auto;
  margin: 0.3em 0;
}
.prose :deep(pre code) {
  background: none;
  padding: 0;
}
.prose :deep(blockquote) {
  border-left: 3px solid currentColor;
  padding-left: 0.5em;
  margin: 0.3em 0;
  opacity: 0.8;
}
.prose :deep(a) {
  color: inherit;
  text-decoration: underline;
  opacity: 0.9;
}
.prose :deep(strong) { font-weight: 600; }
.prose :deep(em) { font-style: italic; }
.prose :deep(s) { text-decoration: line-through; }

/* Dark theme adjustments */
.bg-accent .prose :deep(code) { background: rgba(0, 0, 0, 0.3); }
.bg-accent .prose :deep(pre) { background: rgba(0, 0, 0, 0.3); }

/* Thinking-specific styling */
.prose:has(.text-dark-dim\/60) :deep(*) {
  opacity: 0.85;
}

/* Message text styling */
.message-text :deep(br) {
  display: block;
  content: "";
  margin: 0.3em 0;
}

/* Mermaid chart styling */
.mermaid-chart {
  min-width: 200px;
}

.mermaid-chart :deep(svg) {
  max-width: 100%;
  height: auto;
  display: block;
  margin: 0 auto;
}

.mermaid-error {
  border: 1px solid rgba(239, 68, 68, 0.3);
}

/* Code block styling */
.code-block pre {
  margin: 0;
  font-size: 0.875em;
  line-height: 1.5;
}

.code-block code {
  font-family: 'JetBrains Mono', 'Fira Code', 'Monaco', 'Menlo', monospace;
}

/* Syntax highlighting adjustments for dark theme */
.code-block :deep(.hljs) {
  background: transparent;
  color: #e0e0e0;
  font-size: 0.875rem;
  line-height: 1.6;
}

/* Additional code block styling */
.code-block pre {
  background: #1a1a1a;
}

.code-block code {
  display: block;
  padding: 0;
}

/* Ensure proper scrolling */
.overflow-hidden {
  overflow: hidden;
}

.max-w-\[85\%\] {
  max-width: 85%;
}
</style>
