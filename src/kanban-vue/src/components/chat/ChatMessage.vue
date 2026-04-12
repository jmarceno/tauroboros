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
  <div class="chat-message">
    <!-- Date/Time Header -->
    <div
      v-if="showTimestamp"
      class="flex items-center justify-center my-2"
    >
      <span class="text-xs text-dark-text-muted/50 bg-dark-surface2 px-2 py-0.5 rounded">
        {{ formatDate(message.timestamp) }}
      </span>
    </div>

    <!-- Message Header -->
    <div class="chat-message-header">
      <span :class="['chat-message-sender', message.role]">
        {{ message.role }}
      </span>
      <span class="chat-message-time">{{ formatTimestamp(message.timestamp) }}</span>
    </div>

    <!-- Message Content -->
    <div
      class="chat-message-content"
      :class="{
        'text-dark-text-muted/60': isThinking
      }"
    >
      <!-- Avatar/Icon (for non-user messages) -->
      <div
        v-if="!isUser"
        class="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 text-xs"
        :class="{
          'bg-accent-primary/20 text-accent-primary': isAssistant && !isThinking,
          'bg-dark-surface3 text-dark-text-muted/50': isThinking,
          'bg-dark-surface3 text-dark-text-muted': isSystem || isTool
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
          class="my-3 bg-dark-bg rounded-lg overflow-hidden border border-dark-border"
        >
          <div class="text-xs text-dark-text-muted/60 px-2 py-1 bg-dark-surface2 border-b border-dark-border flex items-center gap-2">
            <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
            Chart
          </div>
          <div
            v-if="block.content.startsWith('<svg')"
            class="p-2"
            v-html="block.content"
          />
          <div
            v-else
            :ref="(el) => setMermaidRef(block.id || '', el as HTMLElement)"
            class="p-2"
          >
            <pre class="text-xs text-dark-text-muted/80">{{ block.content }}</pre>
          </div>
        </div>
        
        <!-- Code block with syntax highlighting -->
        <div
          v-else-if="block.type === 'code'"
          class="my-2 rounded-lg overflow-hidden bg-dark-bg border border-dark-border"
        >
          <div class="text-xs text-dark-text-muted/60 px-3 py-1.5 bg-dark-surface2 border-b border-dark-border flex items-center justify-between">
            <span class="font-mono">{{ block.language }}</span>
          </div>
          <pre class="p-3 overflow-x-auto"><code class="hljs language-{{ block.language }}" v-html="block.content"></code></pre>
        </div>
      </template>

      <!-- Fallback for plain text (when no blocks rendered yet) -->
      <div
        v-if="renderedBlocks.length === 0"
        class="whitespace-pre-wrap"
        :class="{ 'text-dark-text-muted/60': isThinking }"
      >{{ messageText }}</div>

      <!-- Tool Call Details -->
      <div
        v-if="isTool && message.toolName"
        class="mt-1 pt-1 border-t border-dark-border/30 text-xs opacity-70"
      >
        <span class="font-medium">{{ message.toolName }}</span>
        <span
          v-if="message.toolStatus"
          class="ml-1"
          :class="{
            'text-accent-success': message.toolStatus === 'success',
            'text-accent-danger': message.toolStatus === 'error'
          }"
        >
          ({{ message.toolStatus }})
        </span>
      </div>

      <!-- Thinking Label -->
      <div 
        v-if="isThinking" 
        class="text-xs text-dark-text-muted/40 mt-1 font-medium select-none"
      >
        thinking...
      </div>
    </div>
  </div>
</template>

<style scoped>
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
  border: 1px solid rgba(255, 51, 102, 0.3);
}

/* Code block styling */
pre {
  margin: 0;
  font-size: 0.875em;
  line-height: 1.5;
}

code {
  font-family: 'JetBrains Mono', 'Fira Code', 'Monaco', 'Menlo', monospace;
}

/* Syntax highlighting adjustments for dark theme */
:deep(.hljs) {
  background: transparent;
  color: #e0e0e0;
  font-size: 0.875rem;
  line-height: 1.6;
}

/* Additional code block styling */
pre {
  background: #0a0a12;
}

code {
  display: block;
  padding: 0;
}
</style>
