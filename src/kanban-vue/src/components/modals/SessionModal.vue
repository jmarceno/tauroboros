<script setup lang="ts">
import { ref, computed, inject, onMounted, watch, nextTick } from 'vue'
import type { Session, SessionMessage } from '@/types/api'
import type { useSession } from '@/composables/useSession'
import type { useTasks } from '@/composables/useTasks'

const props = defineProps<{
  sessionId: string
}>()

const emit = defineEmits<{
  close: []
}>()

const session = inject<ReturnType<typeof useSession>>('session')!
const tasks = inject<ReturnType<typeof useTasks>>('tasks')!

const timelineRef = ref<HTMLElement | null>(null)

onMounted(() => {
  session.loadSession(props.sessionId)
})

watch(() => session.messages.value, async () => {
  await nextTick()
  if (timelineRef.value) {
    timelineRef.value.scrollTop = timelineRef.value.scrollHeight
  }
}, { deep: true })

const sessionLabel = computed(() => {
  if (!session.session.value) return 'Session Viewer'
  const task = session.session.value.taskId
    ? tasks.getTaskById(session.session.value.taskId)
    : null
  if (task) {
    return `${task.name} • Session ${session.session.value.id}`
  }
  return `Session ${session.session.value.id}`
})

const formatTimestamp = (ts: number) => {
  return ts > 0 ? new Date(ts * 1000).toLocaleTimeString() : '—'
}

// Aggregate consecutive message_part types from the same role
const aggregatedMessages = computed(() => {
  const groups: {
    role: string
    messageType: string
    timestamp: number
    toolName?: string | null
    toolArgsJson?: unknown
    toolResultJson?: unknown
    text: string
    isError: boolean
    isThinking: boolean
    messages: SessionMessage[]
  }[] = []

  let currentGroup: typeof groups[0] | null = null

  for (const message of session.messages.value) {
    const isStreamingPart = message.messageType === 'message_part'
    const role = message.role || 'assistant'

    if (isStreamingPart && currentGroup && currentGroup.role === role) {
      currentGroup.messages.push(message)
      currentGroup.text += getMessageText(message)
    } else {
      if (currentGroup) groups.push(currentGroup)
      currentGroup = {
        role,
        messageType: isStreamingPart ? 'text' : message.messageType,
        timestamp: message.timestamp,
        toolName: message.toolName,
        toolArgsJson: message.toolArgsJson,
        toolResultJson: message.toolResultJson,
        text: getMessageText(message),
        isError: message.messageType === 'error' || message.messageType === 'session_error',
        isThinking: message.messageType === 'thinking',
        messages: [message],
      }
    }
  }

  if (currentGroup) groups.push(currentGroup)
  return groups
})

const getMessageText = (message: SessionMessage): string => {
  const content = message.contentJson
  if (!content || typeof content !== 'object') return ''
  if (typeof content.text === 'string' && content.text.trim()) return content.text
  if (typeof content.message === 'string' && content.message.trim()) return content.message
  if (typeof content.output === 'string' && content.output.trim()) return content.output
  if (typeof content.content === 'string' && content.content.trim()) return content.content
  if (typeof content.summary === 'string' && content.summary.trim()) return content.summary
  return ''
}

const formatJson = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

const closeOnOverlay = (e: MouseEvent) => {
  if (e.target === e.currentTarget) {
    emit('close')
  }
}
</script>

<template>
  <div class="modal-overlay" @mousedown="closeOnOverlay">
    <div class="modal" style="width: min(980px, calc(100vw - 40px)); max-height: min(900px, calc(100vh - 40px));">
      <div class="modal-header">
        <h2>{{ sessionLabel }}</h2>
        <button class="modal-close" @click="emit('close')">×</button>
      </div>

      <div class="modal-body">
        <!-- Meta info -->
        <div v-if="session.session.value" class="flex flex-wrap gap-2 mb-3">
          <span class="badge">id: {{ session.session.value.id }}</span>
          <span class="badge">{{ session.session.value.sessionKind }}</span>
          <span class="badge">status: {{ session.session.value.status }}</span>
          <span class="badge">model: {{ session.session.value.model || 'default' }}</span>
          <span v-if="session.session.value.thinkingLevel && session.session.value.thinkingLevel !== 'default'" class="badge">
            thinking: {{ session.session.value.thinkingLevel }}
          </span>
          <span v-if="session.session.value.taskId" class="badge">
            task: {{ tasks.getTaskName(session.session.value.taskId) }}
          </span>
          <span v-if="session.session.value.taskRunId" class="badge">
            task run: {{ session.session.value.taskRunId }}
          </span>
          <span v-if="session.taskRunContext.value?.phase" class="badge">
            phase: {{ session.taskRunContext.value.phase }}
          </span>
          <span v-if="typeof session.taskRunContext.value?.slotIndex === 'number'" class="badge">
            slot: {{ session.taskRunContext.value.slotIndex + 1 }}
          </span>
          <span v-if="typeof session.taskRunContext.value?.attemptIndex === 'number'" class="badge">
            attempt: {{ session.taskRunContext.value.attemptIndex + 1 }}
          </span>
        </div>

        <!-- Loading -->
        <div v-if="session.isLoading.value && !session.session.value" class="session-entry text-dark-text-muted">
          Loading session…
        </div>

        <!-- Error -->
        <div v-else-if="session.error.value" class="session-entry error">
          {{ session.error.value }}
        </div>

        <!-- Timeline -->
        <div v-else ref="timelineRef" class="flex flex-col gap-2.5 max-h-[56vh] overflow-y-auto pr-1">
          <div v-if="aggregatedMessages.length === 0" class="session-entry text-dark-text-muted">
            No session messages yet.
          </div>

          <div
            v-for="(group, i) in aggregatedMessages"
            :key="i"
            :class="[
              'session-entry',
              group.isError ? 'error' : '',
              group.isThinking ? 'thinking' : ''
            ]"
          >
            <div class="flex items-center flex-wrap gap-1.5 mb-1.5">
              <span class="text-xs text-dark-text-muted mr-auto">
                {{ formatTimestamp(group.timestamp) }}
              </span>
              <span :class="['session-role', group.role]">
                {{ group.role }}
              </span>
              <span class="text-xs text-dark-text-muted border border-dark-surface3 rounded-full px-2 py-0.5">
                {{ group.messageType }}
              </span>
              <span v-if="group.toolName" class="text-xs text-orange-400 border border-orange-500/45 rounded-full px-2 py-0.5">
                {{ group.toolName }}
              </span>
            </div>

            <div
              :class="[
                'text-xs leading-relaxed whitespace-pre-wrap break-words',
                group.isThinking ? 'text-dark-text-muted italic' : 'text-dark-text',
                group.isError ? 'text-red-400' : ''
              ]"
            >
              {{ group.text || '(no text content)' }}
            </div>

            <!-- Tool payload -->
            <details v-if="group.toolArgsJson || group.toolResultJson" class="mt-2 text-xs text-dark-text-muted">
              <summary class="cursor-pointer">Tool payload</summary>
              <pre v-if="group.toolArgsJson" class="mt-1.5 bg-dark-surface2 border border-dark-surface3 rounded p-2 whitespace-pre-wrap break-words">args:
{{ formatJson(group.toolArgsJson) }}</pre>
              <pre v-if="group.toolResultJson" class="mt-1.5 bg-dark-surface2 border border-dark-surface3 rounded p-2 whitespace-pre-wrap break-words">result:
{{ formatJson(group.toolResultJson) }}</pre>
            </details>
          </div>
        </div>
      </div>

      <div class="modal-footer">
        <button class="btn" @click="emit('close')">Close</button>
      </div>
    </div>
  </div>
</template>
