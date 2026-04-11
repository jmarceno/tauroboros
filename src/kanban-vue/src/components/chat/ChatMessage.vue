<script setup lang="ts">
import { computed } from 'vue'
import type { SessionMessage } from '@/types/api'

const props = defineProps<{
  message: SessionMessage
  showTimestamp?: boolean
}>()

const isUser = computed(() => props.message.role === 'user')
const isAssistant = computed(() => props.message.role === 'assistant')
const isSystem = computed(() => props.message.role === 'system')
const isTool = computed(() => props.message.role === 'tool' || props.message.messageType === 'tool_call' || props.message.messageType === 'tool_result')

const messageText = computed(() => {
  const content = props.message.contentJson
  if (typeof content.text === 'string') return content.text
  if (typeof content.message === 'string') return content.message
  return JSON.stringify(content)
})

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
          'bg-accent/20 text-accent': isAssistant,
          'bg-dark-surface3 text-dark-dim': isSystem || isTool
        }"
      >
        <svg
          v-if="isAssistant"
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
        class="max-w-[85%] rounded-lg px-3 py-2 text-sm prose prose-invert prose-sm"
        :class="{
          'bg-accent text-white': isUser,
          'bg-dark-surface2 text-dark-text': isAssistant,
          'bg-dark-surface3/50 text-dark-dim text-xs italic': isSystem,
          'bg-dark-surface3/80 text-dark-dim text-xs': isTool
        }"
      >
        <!-- Render HTML content (from TipTap) -->
        <div
          v-if="messageText.startsWith('<')"
          v-html="messageText"
        />
        <!-- Render plain text -->
        <div
          v-else
          class="whitespace-pre-wrap"
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

        <!-- Timestamp in message -->
        <div
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
  font-family: monospace;
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
</style>
