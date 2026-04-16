<script setup lang="ts">
import { ref, computed, inject, onMounted, onUnmounted, watch, nextTick } from 'vue'
import type { Session, SessionMessage, TaskRun, Task } from '@/types/api'
import { useApi } from '@/composables/useApi'
import { useSessionUsage } from '@/composables/useSessionUsage'

const props = defineProps<{
  taskId: string
}>()

const emit = defineEmits<{
  close: []
}>()

const api = useApi()
const sessionUsage = useSessionUsage()

interface SessionData {
  id: string
  session: Session | null
  messages: SessionMessage[]
  taskRun: TaskRun | null
  isLoading: boolean
  error: string | null
}

const task = ref<Task | null>(null)
const taskRuns = ref<TaskRun[]>([])
const sessions = ref<Map<string, SessionData>>(new Map())
const activeSessionId = ref<string | null>(null)
const timelineRef = ref<HTMLElement | null>(null)
const showUsageDetails = ref<Record<string, boolean>>({})

const loadToken = ref(0)

onMounted(async () => {
  const token = ++loadToken.value

  try {
    const [taskData, runsData] = await Promise.all([
      api.getTask(props.taskId),
      api.getTaskRuns(props.taskId)
    ])

    if (token !== loadToken.value) return

    task.value = taskData
    taskRuns.value = runsData

    const sessionIds: string[] = []

    if (taskData.sessionId) {
      sessionIds.push(taskData.sessionId)
    }

    for (const run of runsData) {
      if (run.sessionId && !sessionIds.includes(run.sessionId)) {
        sessionIds.push(run.sessionId)
      }
    }

    for (const sessionId of sessionIds) {
      sessions.value.set(sessionId, {
        id: sessionId,
        session: null,
        messages: [],
        taskRun: runsData.find(r => r.sessionId === sessionId) || null,
        isLoading: true,
        error: null
      })
      sessionUsage.startWatching(sessionId)
      loadSessionData(sessionId)
    }

    if (sessionIds.length > 0) {
      activeSessionId.value = sessionIds[0]
    }
  } catch (e) {
    console.error('Failed to load task sessions:', e)
  }
})

const loadSessionData = async (sessionId: string) => {
  const token = ++loadToken.value
  const sessionData = sessions.value.get(sessionId)
  if (!sessionData) return

  try {
    const [session, messages] = await Promise.all([
      api.getSession(sessionId),
      api.getSessionMessages(sessionId, 1000)
    ])

    if (token !== loadToken.value) return

    sessionData.session = session
    sessionData.messages = messages.sort((a, b) => {
      const ta = Number(a.timestamp || 0)
      const tb = Number(b.timestamp || 0)
      if (ta !== tb) return ta - tb
      return Number(a.id || 0) - Number(b.id || 0)
    })
    sessionData.isLoading = false
  } catch (e) {
    if (token !== loadToken.value) return
    sessionData.error = e instanceof Error ? e.message : String(e)
    sessionData.isLoading = false
  }
}

watch(() => sessions.value.get(activeSessionId.value || '')?.messages, async () => {
  await nextTick()
  if (timelineRef.value) {
    timelineRef.value.scrollTop = timelineRef.value.scrollHeight
  }
}, { deep: true })

watch(activeSessionId, (newId) => {
  if (newId) {
    sessionUsage.loadSessionUsage(newId)
  }
})

const sortedSessions = computed(() => {
  const result: SessionData[] = []

  const directSession = Array.from(sessions.value.values()).find(
    s => s.id === task.value?.sessionId
  )
  if (directSession) {
    result.push(directSession)
  }

  for (const session of sessions.value.values()) {
    if (session.id !== task.value?.sessionId) {
      result.push(session)
    }
  }

  return result
})

const activeSession = computed(() => {
  if (!activeSessionId.value) return null
  return sessions.value.get(activeSessionId.value) || null
})

const sessionLabel = computed(() => {
  if (!task.value) return 'Task Sessions'
  return `${task.value.name} • Sessions`
})

const formatTimestamp = (ts: number) => {
  return ts > 0 ? new Date(ts * 1000).toLocaleTimeString() : '—'
}

const aggregatedMessages = computed(() => {
  const messages = activeSession.value?.messages || []
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

  for (const message of messages) {
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

const getSessionTabLabel = (sessionData: SessionData): string => {
  if (sessionData.taskRun) {
    const run = sessionData.taskRun
    return `${run.phase} (slot ${run.slotIndex + 1})`
  }
  if (sessionData.id === task.value?.sessionId) {
    return 'direct'
  }
  return sessionData.id.substring(0, 8)
}

const getSessionStatus = (sessionData: SessionData): string => {
  if (sessionData.isLoading) return 'loading'
  if (sessionData.error) return 'error'
  if (sessionData.session) return sessionData.session.status
  return 'unknown'
}

const closeOnOverlay = (e: MouseEvent) => {
  if (e.target === e.currentTarget) {
    emit('close')
  }
}

onUnmounted(() => {
  for (const sessionId of sessions.value.keys()) {
    sessionUsage.stopWatching(sessionId)
  }
})
</script>

<template>
  <div class="modal-overlay" @mousedown="closeOnOverlay">
    <div class="modal" style="width: min(980px, calc(100vw - 40px)); max-height: min(900px, calc(100vh - 40px));">
      <div class="modal-header">
        <h2>{{ sessionLabel }}</h2>
        <button class="modal-close" @click="emit('close')">×</button>
      </div>

      <div class="modal-body">
        <div v-if="sortedSessions.length === 0" class="text-dark-text-muted text-center py-8">
          No sessions found for this task.
        </div>

        <template v-else>
          <div class="flex gap-1 border-b border-dark-surface3 mb-3 overflow-x-auto">
            <button
              v-for="sessionData in sortedSessions"
              :key="sessionData.id"
              :class="[
                'px-4 py-2 text-sm border-b-2 transition-colors whitespace-nowrap',
                activeSessionId === sessionData.id
                  ? 'text-accent-primary border-accent-primary'
                  : 'text-dark-text-muted border-transparent hover:text-dark-text'
              ]"
              @click="activeSessionId = sessionData.id"
            >
              <span class="flex items-center gap-2">
                {{ getSessionTabLabel(sessionData) }}
                <span
                  :class="[
                    'text-xs px-1.5 py-0.5 rounded-full',
                    getSessionStatus(sessionData) === 'running' || getSessionStatus(sessionData) === 'active'
                      ? 'bg-accent-primary/15 text-accent-primary'
                      : getSessionStatus(sessionData) === 'done' || getSessionStatus(sessionData) === 'completed'
                        ? 'bg-accent-success/15 text-accent-success'
                        : getSessionStatus(sessionData) === 'failed'
                          ? 'bg-accent-danger/15 text-accent-danger'
                          : 'bg-dark-surface text-dark-text-muted'
                  ]"
                >
                  {{ getSessionStatus(sessionData) }}
                </span>
              </span>
            </button>
          </div>

          <div v-if="activeSession">
            <div v-if="sessionUsage.getCachedUsage(activeSession.id)" class="mb-3 p-2 bg-dark-surface rounded-lg">
              <div
                class="flex items-center gap-3 cursor-pointer hover:bg-dark-surface2 rounded p-1 transition-colors"
                @click="showUsageDetails[activeSession.id] = !showUsageDetails[activeSession.id]"
              >
                <div class="flex items-center gap-1.5">
                  <span class="text-lg">💰</span>
                  <span class="font-medium">{{ sessionUsage.formatCost(sessionUsage.getCachedUsage(activeSession.id)!.totalCost) }}</span>
                </div>
                <div class="w-px h-4 bg-dark-surface3" />
                <div class="flex items-center gap-1.5">
                  <span class="text-lg">🪙</span>
                  <span class="font-medium">{{ sessionUsage.formatTokenCount(sessionUsage.getCachedUsage(activeSession.id)!.totalTokens) }} tokens</span>
                </div>
                <div class="ml-auto text-xs text-dark-text-muted">
                  {{ showUsageDetails[activeSession.id] ? '▼' : '▶' }} Details
                </div>
              </div>

              <div v-if="showUsageDetails[activeSession.id]" class="mt-2 pt-2 border-t border-dark-surface3 text-xs space-y-1">
                <div class="flex justify-between">
                  <span class="text-dark-text-muted">Prompt:</span>
                  <span>{{ sessionUsage.formatTokenCount(sessionUsage.getCachedUsage(activeSession.id)!.promptTokens) }} tokens</span>
                </div>
                <div class="flex justify-between">
                  <span class="text-dark-text-muted">Completion:</span>
                  <span>{{ sessionUsage.formatTokenCount(sessionUsage.getCachedUsage(activeSession.id)!.completionTokens) }} tokens</span>
                </div>
                <div v-if="sessionUsage.getCachedUsage(activeSession.id)!.cacheReadTokens > 0" class="flex justify-between">
                  <span class="text-dark-text-muted">Cache (read):</span>
                  <span>{{ sessionUsage.formatTokenCount(sessionUsage.getCachedUsage(activeSession.id)!.cacheReadTokens) }} tokens</span>
                </div>
                <div v-if="sessionUsage.getCachedUsage(activeSession.id)!.cacheWriteTokens > 0" class="flex justify-between">
                  <span class="text-dark-text-muted">Cache (write):</span>
                  <span>{{ sessionUsage.formatTokenCount(sessionUsage.getCachedUsage(activeSession.id)!.cacheWriteTokens) }} tokens</span>
                </div>
                <div class="flex justify-between pt-1 border-t border-dark-surface3">
                  <span class="text-dark-text-muted">Total Tokens:</span>
                  <span class="font-medium">{{ sessionUsage.formatTokenCount(sessionUsage.getCachedUsage(activeSession.id)!.totalTokens) }}</span>
                </div>
                <div class="flex justify-between">
                  <span class="text-dark-text-muted">Total Cost:</span>
                  <span class="font-medium text-accent-primary">{{ sessionUsage.formatCost(sessionUsage.getCachedUsage(activeSession.id)!.totalCost) }}</span>
                </div>
              </div>
            </div>

            <div v-if="activeSession.session" class="flex flex-wrap gap-2 mb-3">
              <span class="badge">id: {{ activeSession.session.id }}</span>
              <span class="badge">{{ activeSession.session.sessionKind }}</span>
              <span class="badge">status: {{ activeSession.session.status }}</span>
              <span class="badge">model: {{ activeSession.session.model || 'default' }}</span>
              <span v-if="activeSession.session.thinkingLevel && activeSession.session.thinkingLevel !== 'default'" class="badge">
                thinking: {{ activeSession.session.thinkingLevel }}
              </span>
              <span v-if="activeSession.session.taskId" class="badge">
                task: {{ activeSession.session.taskId.substring(0, 8) }}...
              </span>
              <span v-if="activeSession.session.taskRunId" class="badge">
                task run: {{ activeSession.session.taskRunId }}
              </span>
              <span v-if="activeSession.taskRun?.phase" class="badge">
                phase: {{ activeSession.taskRun.phase }}
              </span>
              <span v-if="typeof activeSession.taskRun?.slotIndex === 'number'" class="badge">
                slot: {{ activeSession.taskRun.slotIndex + 1 }}
              </span>
              <span v-if="typeof activeSession.taskRun?.attemptIndex === 'number'" class="badge">
                attempt: {{ activeSession.taskRun.attemptIndex + 1 }}
              </span>
              <span class="badge badge-cost">💰 {{ sessionUsage.formatCost(sessionUsage.getCachedUsage(activeSession.id)?.totalCost ?? 0) }}</span>
              <span class="badge">🪙 {{ sessionUsage.formatTokenCount(sessionUsage.getCachedUsage(activeSession.id)?.totalTokens ?? 0) }} tokens</span>
            </div>

            <div v-if="activeSession.isLoading && !activeSession.session" class="session-entry text-dark-text-muted">
              Loading session…
            </div>

            <div v-else-if="activeSession.error" class="session-entry error">
              {{ activeSession.error }}
            </div>

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
        </template>
      </div>

      <div class="modal-footer">
        <button class="btn" @click="emit('close')">Close</button>
      </div>
    </div>
  </div>
</template>
