<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, inject, computed } from 'vue'
import type { ChatSession, usePlanningChat } from '@/composables/usePlanningChat'
import type { PlanningSession } from '@/types/api'
import type { useOptions } from '@/composables/useOptions'
import type { useModelSearch } from '@/composables/useModelSearch'
import { useApi } from '@/composables/useApi'
import ModelPicker from '@/components/common/ModelPicker.vue'
import ThinkingLevelSelect from '@/components/common/ThinkingLevelSelect.vue'
import ChatPanel from './ChatPanel.vue'

type PlanningChatType = ReturnType<typeof usePlanningChat>

const planningChat = inject<PlanningChatType>('planningChat')
if (!planningChat) {
  throw new Error('ChatContainer must be used within an app that provides planningChat')
}

const options = inject<ReturnType<typeof useOptions>>('options')!
const modelSearch = inject<ReturnType<typeof useModelSearch>>('modelSearch')!

const openModal = inject<(name: string, data?: Record<string, unknown>) => void>('openModal', () => {
  console.warn('openModal not provided, planning prompt editor will not work')
})

const api = useApi()

// Active tab: 'chat' | 'sessions'
const activeTab = ref<'chat' | 'sessions'>('chat')

// All sessions from database (for Sessions tab)
const allSessions = ref<PlanningSession[]>([])
const isLoadingSessions = ref(false)

// Resize logic
const containerRef = ref<HTMLElement | null>(null)
const resizeHandleRef = ref<HTMLElement | null>(null)

const startResize = (e: MouseEvent) => {
  e.preventDefault()
  planningChat.isResizing.value = true
  document.body.style.cursor = 'ew-resize'
  document.body.style.userSelect = 'none'
}

const stopResize = () => {
  if (planningChat.isResizing.value) {
    planningChat.isResizing.value = false
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }
}

const onResize = (e: MouseEvent) => {
  if (!planningChat.isResizing.value) return
  const newWidth = window.innerWidth - e.clientX
  planningChat.setWidth(newWidth)
}

watch(() => planningChat.isResizing.value, (isResizing) => {
  if (isResizing) {
    document.addEventListener('mousemove', onResize)
    document.addEventListener('mouseup', stopResize)
  } else {
    document.removeEventListener('mousemove', onResize)
    document.removeEventListener('mouseup', stopResize)
  }
})

onUnmounted(() => {
  document.removeEventListener('mousemove', onResize)
  document.removeEventListener('mouseup', stopResize)
})

// Load all sessions for the Sessions tab
const loadAllSessions = async () => {
  isLoadingSessions.value = true
  try {
    const sessions = await api.getPlanningSessions()
    allSessions.value = sessions.sort((a, b) => b.createdAt - a.createdAt)
  } catch (e) {
    console.error('Failed to load planning sessions:', e)
  } finally {
    isLoadingSessions.value = false
  }
}

// Session management
const createNewChat = async () => {
  // Load options if not loaded
  if (!options.options.value) {
    await options.loadOptions()
  }

  // Always show model selector, pre-filled with default if available
  showModelSelector.value = true
  selectedModel.value = defaultModel.value || ''
  selectedThinkingLevel.value = defaultThinkingLevel.value || 'default'
}

const minimizeSession = (session: ChatSession) => {
  planningChat.minimizeSession(session.id)
}

const restoreSession = (session: ChatSession) => {
  planningChat.switchToSession(session.id)
}

const closeSession = (session: ChatSession) => {
  planningChat.closeSession(session.id)
}

const setActiveSession = (session: ChatSession) => {
  planningChat.switchToSession(session.id)
}

const renameSession = (session: ChatSession, newName: string) => {
  planningChat.renameSession(session.id, newName)
}

// Sessions tab actions
const resumeSession = async (dbSession: PlanningSession) => {
  // Check if we already have this session loaded
  const existingSession = planningChat.sessions.value.find(
    s => s.session?.id === dbSession.id
  )
  
  if (existingSession) {
    planningChat.switchToSession(existingSession.id)
    activeTab.value = 'chat'
    return
  }
  
  // Create a new chat session wrapper for this existing planning session
  const sessionId = `chat-${Date.now()}`
  const newSession: ChatSession = {
    id: sessionId,
    name: dbSession.id, // Use the session ID as the name initially
    session: dbSession,
    messages: [],
    isMinimized: false,
    isLoading: false,
    error: null,
  }
  
  // Load messages for this session
  try {
    const messages = await api.getPlanningSessionMessages(dbSession.id, 100)
    newSession.messages = messages
  } catch (e) {
    console.error('Failed to load session messages:', e)
  }
  
  planningChat.sessions.value.push(newSession)
  planningChat.activeSessionId.value = sessionId
  activeTab.value = 'chat'
}

const formatSessionDate = (timestamp: number) => {
  const date = new Date(timestamp * 1000)
  const now = new Date()
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  
  if (date.toDateString() === now.toDateString()) {
    return `Today, ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
  } else if (date.toDateString() === yesterday.toDateString()) {
    return `Yesterday, ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
  } else {
    return date.toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  }
}

const getStatusColor = (status: string) => {
  switch (status) {
    case 'active': return 'bg-green-500'
    case 'starting': return 'bg-yellow-500'
    case 'paused': return 'bg-orange-500'
    case 'completed': return 'bg-blue-500'
    case 'failed': return 'bg-red-500'
    default: return 'bg-gray-500'
  }
}

const activeSessionsCount = computed(() => {
  return allSessions.value.filter(s => s.status === 'active' || s.status === 'starting').length
})

// Load sessions when switching to sessions tab
watch(activeTab, (tab) => {
  if (tab === 'sessions') {
    loadAllSessions()
  }
})

onMounted(() => {
  // Load sessions initially
  loadAllSessions()
})

// Model selection for new sessions
const showModelSelector = ref(false)
const selectedModel = ref('')
const selectedThinkingLevel = ref<'default' | 'low' | 'medium' | 'high'>('default')

// Get default model from options
const defaultModel = computed(() => {
  const planModel = options.options.value?.planModel
  if (planModel && planModel.trim()) {
    return planModel
  }
  return ''
})

// Get default thinking level from options
const defaultThinkingLevel = computed(() => {
  return options.options.value?.planThinkingLevel || 'default'
})

const confirmModelAndCreate = async () => {
  if (!selectedModel.value) {
    // Try to normalize the value
    const normalized = modelSearch.normalizeValue(selectedModel.value)
    if (!normalized) {
      return
    }
    selectedModel.value = normalized
  }

  showModelSelector.value = false
  await planningChat.createNewSession(selectedModel.value, selectedThinkingLevel.value)
  activeTab.value = 'chat'
}

const cancelModelSelection = () => {
  showModelSelector.value = false
  selectedModel.value = ''
  selectedThinkingLevel.value = 'default'
}
</script>

<template>
  <div
    v-if="planningChat.isOpen.value"
    ref="containerRef"
    class="fixed right-0 top-0 h-screen bg-dark-surface border-l border-dark-surface3 shadow-2xl z-40 flex flex-col"
    :style="{ width: planningChat.width.value + 'px' }"
  >
    <!-- Resize Handle -->
    <div
      ref="resizeHandleRef"
      class="absolute left-0 top-0 w-1 h-full cursor-ew-resize hover:bg-accent/50 active:bg-accent transition-colors z-50"
      @mousedown="startResize"
    />

    <!-- Header -->
    <div class="flex items-center justify-between px-3 py-2 border-b border-dark-surface3 bg-dark-surface2">
      <div class="flex items-center gap-2">
        <span class="text-sm font-semibold text-dark-text">Planning Chat</span>
        <span v-if="planningChat.sessions.value.length > 0" class="text-xs text-dark-dim">
          ({{ planningChat.sessions.value.length }})
        </span>
      </div>
      <div class="flex items-center gap-1">
        <!-- Edit Prompt Button -->
        <button
          v-if="openModal"
          class="p-1.5 rounded hover:bg-dark-surface3 text-dark-dim hover:text-accent transition-colors"
          title="Edit planning assistant prompt"
          @click="openModal('planningPrompt')"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>
        <button
          class="p-1.5 rounded hover:bg-dark-surface3 text-dark-dim hover:text-dark-text transition-colors"
          title="New chat"
          @click="createNewChat"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
          </svg>
        </button>
        <button
          class="p-1.5 rounded hover:bg-dark-surface3 text-dark-dim hover:text-dark-text transition-colors"
          title="Close panel"
          @click="planningChat.closePanel"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>

    <!-- Navigation Tabs -->
    <div class="flex border-b border-dark-surface3 bg-dark-bg">
      <button
        class="flex-1 px-4 py-2 text-sm font-medium transition-colors relative"
        :class="{
          'text-accent bg-accent/10': activeTab === 'chat',
          'text-dark-dim hover:text-dark-text hover:bg-dark-surface2': activeTab !== 'chat'
        }"
        @click="activeTab = 'chat'"
      >
        <div class="flex items-center justify-center gap-2">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
          Chat
        </div>
        <div
          v-if="activeTab === 'chat'"
          class="absolute bottom-0 left-0 right-0 h-0.5 bg-accent"
        />
      </button>
      <button
        class="flex-1 px-4 py-2 text-sm font-medium transition-colors relative"
        :class="{
          'text-accent bg-accent/10': activeTab === 'sessions',
          'text-dark-dim hover:text-dark-text hover:bg-dark-surface2': activeTab !== 'sessions'
        }"
        @click="activeTab = 'sessions'"
      >
        <div class="flex items-center justify-center gap-2">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          Sessions
          <span
            v-if="activeSessionsCount > 0"
            class="px-1.5 py-0.5 text-xs bg-accent/20 text-accent rounded-full"
          >
            {{ activeSessionsCount }}
          </span>
        </div>
        <div
          v-if="activeTab === 'sessions'"
          class="absolute bottom-0 left-0 right-0 h-0.5 bg-accent"
        />
      </button>
    </div>

    <!-- Minimized Sessions Bar (only in chat tab) -->
    <div
      v-if="activeTab === 'chat' && planningChat.minimizedSessions.value.length > 0"
      class="flex items-center gap-1 px-2 py-1.5 border-b border-dark-surface3 bg-dark-bg overflow-x-auto"
    >
      <span class="text-xs text-dark-dim mr-1 flex-shrink-0">Minimized:</span>
      <button
        v-for="session in planningChat.minimizedSessions.value"
        :key="session.id"
        class="flex items-center gap-1 px-2 py-1 rounded bg-dark-surface2 hover:bg-dark-surface3 text-xs text-dark-dim hover:text-dark-text transition-colors flex-shrink-0 max-w-[120px]"
        @click="restoreSession(session)"
      >
        <span class="truncate">{{ session.name }}</span>
        <span
          class="w-2 h-2 rounded-full flex-shrink-0"
          :class="{
            'bg-green-500': session.session?.status === 'active',
            'bg-yellow-500': session.session?.status === 'starting' || session.session?.status === 'paused',
            'bg-gray-500': !session.session || session.session?.status === 'completed' || session.session?.status === 'failed'
          }"
        />
      </button>
    </div>

    <!-- Sessions Tabs (when multiple visible, only in chat tab) -->
    <div
      v-if="activeTab === 'chat' && planningChat.visibleSessions.value.length > 1"
      class="flex items-center gap-0.5 px-2 py-1 border-b border-dark-surface3 bg-dark-bg overflow-x-auto"
    >
      <div
        v-for="session in planningChat.visibleSessions.value"
        :key="session.id"
        class="flex items-center gap-1.5 px-2 py-1 rounded text-xs transition-colors flex-shrink-0 max-w-[140px] cursor-pointer"
        :class="{
          'bg-accent/20 text-accent': planningChat.activeSessionId.value === session.id,
          'hover:bg-dark-surface3 text-dark-dim hover:text-dark-text': planningChat.activeSessionId.value !== session.id
        }"
        @click="setActiveSession(session)"
      >
        <span class="truncate">{{ session.name }}</span>
        <button
          class="opacity-60 hover:opacity-100 p-0.5 rounded hover:bg-dark-surface3"
          @click.stop="minimizeSession(session)"
        >
          <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18 12H6" />
          </svg>
        </button>
        <button
          class="opacity-60 hover:opacity-100 p-0.5 rounded hover:bg-red-500/20 hover:text-red-400"
          @click.stop="closeSession(session)"
        >
          <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>

    <!-- Chat Tab Content -->
    <div v-if="activeTab === 'chat'" class="flex-1 overflow-hidden relative">
      <ChatPanel
        v-if="planningChat.activeSession.value"
        :session="planningChat.activeSession.value"
        @minimize="minimizeSession(planningChat.activeSession.value!)"
        @close="closeSession(planningChat.activeSession.value!)"
        @rename="(name: string) => renameSession(planningChat.activeSession.value!, name)"
      />

      <!-- Empty State -->
      <div
        v-else
        class="h-full flex flex-col items-center justify-center text-dark-dim p-4"
      >
        <svg class="w-12 h-12 mb-3 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
        </svg>
        <p class="text-sm text-center mb-4">No active chat sessions</p>
        <button
          class="btn btn-primary btn-sm"
          @click="createNewChat"
        >
          Start New Chat
        </button>
      </div>
    </div>

    <!-- Sessions Tab Content -->
    <div v-else-if="activeTab === 'sessions'" class="flex-1 overflow-y-auto bg-dark-bg">
      <!-- Loading State -->
      <div v-if="isLoadingSessions" class="flex items-center justify-center py-12">
        <svg class="w-8 h-8 animate-spin text-accent" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
      </div>

      <!-- Empty State -->
      <div v-else-if="allSessions.length === 0" class="flex flex-col items-center justify-center py-12 text-dark-dim">
        <svg class="w-12 h-12 mb-3 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <p class="text-sm">No previous planning sessions</p>
        <p class="text-xs text-dark-dim/60 mt-1">Start a new chat to create a session</p>
      </div>

      <!-- Sessions List -->
      <div v-else class="p-3 space-y-2">
        <div class="flex items-center justify-between mb-3">
          <h3 class="text-sm font-medium text-dark-text">
            {{ allSessions.length }} session{{ allSessions.length === 1 ? '' : 's' }}
          </h3>
          <button
            class="text-xs text-accent hover:text-accent/80 flex items-center gap-1"
            @click="loadAllSessions"
          >
            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Refresh
          </button>
        </div>

        <div
          v-for="session in allSessions"
          :key="session.id"
          class="group flex items-start gap-3 p-3 rounded-lg bg-dark-surface border border-dark-surface3 hover:border-accent/30 transition-colors cursor-pointer"
          @click="resumeSession(session)"
        >
          <!-- Status Indicator -->
          <div class="flex-shrink-0 mt-0.5">
            <div
              class="w-3 h-3 rounded-full"
              :class="getStatusColor(session.status)"
              :title="session.status"
            />
          </div>

          <!-- Session Info -->
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 mb-1">
              <span class="text-sm font-medium text-dark-text truncate">Session {{ session.id }}</span>
              <span
                v-if="session.status === 'active' || session.status === 'starting'"
                class="px-1.5 py-0.5 text-xs bg-green-500/20 text-green-400 rounded"
              >
                Active
              </span>
            </div>
            <div class="text-xs text-dark-dim space-y-0.5">
              <p>{{ formatSessionDate(session.createdAt) }}</p>
              <p v-if="session.model && session.model !== 'default'" class="text-dark-dim/60">
                Model: {{ session.model }}
              </p>
            </div>
          </div>

          <!-- Action -->
          <div class="flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
            <button class="p-1.5 rounded hover:bg-dark-surface3 text-dark-dim hover:text-accent">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7l5 5m0 0l-5 5m5-5H6" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Model Selector Modal -->
    <div
      v-if="showModelSelector"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      @click.self="cancelModelSelection"
    >
      <div class="bg-dark-surface border border-dark-surface3 rounded-lg shadow-xl w-[400px] max-w-[90vw] p-4">
        <h3 class="text-lg font-medium text-dark-text mb-2">New Planning Chat</h3>
        <p class="text-sm text-dark-dim mb-4">
          Select the AI model for this planning session. The default is based on your Options settings.
        </p>

        <ModelPicker
          v-model="selectedModel"
          label="Model"
          help="The AI model to use for this planning session"
        />

        <ThinkingLevelSelect
          v-model="selectedThinkingLevel"
          label="Thinking Level"
          help="Controls how much reasoning effort the agent should spend"
        />

        <div class="flex items-center justify-end gap-2 mt-4">
          <button
            class="btn btn-sm"
            @click="cancelModelSelection"
          >
            Cancel
          </button>
          <button
            class="btn btn-primary btn-sm"
            :disabled="!selectedModel"
            @click="confirmModelAndCreate"
          >
            Start Chat
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
