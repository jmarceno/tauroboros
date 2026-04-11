<script setup lang="ts">
import { ref, watch, nextTick, onMounted, computed, inject } from 'vue'
import type { ChatSession, ContextAttachment } from '@/composables/usePlanningChat'
import type { SessionMessage } from '@/types/api'
import ChatMessage from './ChatMessage.vue'
import MarkdownEditor from '@/components/common/MarkdownEditor.vue'
import { useApi } from '@/composables/useApi'

const props = defineProps<{
  session: ChatSession
}>()

const emit = defineEmits<{
  minimize: []
  close: []
  rename: [name: string]
  createTasks: []
}>()

const api = useApi()
const planningChat = inject<any>('planningChat')
const messageInput = ref('')
const messagesContainer = ref<HTMLElement | null>(null)
const isEditingName = ref(false)
const editedName = ref('')
const nameInput = ref<HTMLInputElement | null>(null)
const showAttachMenu = ref(false)
const attachedContext = ref<ContextAttachment[]>([])

// Auto-scroll to bottom on new messages
watch(() => props.session.messages.length, async () => {
  await nextTick()
  scrollToBottom()
})

onMounted(() => {
  scrollToBottom()
})

const scrollToBottom = () => {
  if (messagesContainer.value) {
    messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight
  }
}

const startEditingName = () => {
  isEditingName.value = true
  editedName.value = props.session.name
  nextTick(() => {
    nameInput.value?.focus()
    nameInput.value?.select()
  })
}

const saveName = () => {
  if (editedName.value.trim() && editedName.value !== props.session.name) {
    emit('rename', editedName.value.trim())
  }
  isEditingName.value = false
}

const cancelEditName = () => {
  isEditingName.value = false
}

const attachFile = async () => {
  // Create a file input element
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.accept = '.ts,.js,.tsx,.jsx,.json,.md,.txt,.vue,.css,.scss'
  
  input.onchange = async (e) => {
    const files = (e.target as HTMLInputElement).files
    if (!files) return
    
    for (const file of files) {
      try {
        const text = await file.text()
        attachedContext.value.push({
          type: 'file',
          name: file.name,
          content: text,
        })
      } catch (err) {
        console.error('Failed to read file:', err)
      }
    }
    showAttachMenu.value = false
  }
  
  input.click()
}

const attachScreenshot = () => {
  // Placeholder for screenshot functionality
  alert('Screenshot capture not yet implemented')
  showAttachMenu.value = false
}

const attachCurrentTask = () => {
  // Attach context from the currently selected task if any
  attachedContext.value.push({
    type: 'task',
    name: 'Current Task Context',
    taskId: 'current',
  })
  showAttachMenu.value = false
}

const clearAttachedContext = () => {
  attachedContext.value = []
}

const sendMessage = async () => {
  if (!messageInput.value.trim() || props.session.isSending) return
  if (!props.session.session?.id) {
    console.error('No session ID available')
    return
  }

  const content = messageInput.value.trim()
  const attachments = [...attachedContext.value]
  
  messageInput.value = ''
  attachedContext.value = [] // Clear after sending

  try {
    await planningChat.sendMessage(props.session.id, content, attachments)
    scrollToBottom()
  } catch (e) {
    console.error('Failed to send message:', e)
    scrollToBottom()
  }
}

const createTasksFromChat = async () => {
  try {
    const result = await planningChat.createTasksFromChat(props.session.id)
    console.log('Tasks created:', result)
    emit('createTasks')
  } catch (e) {
    console.error('Failed to create tasks:', e)
  }
}

const formatTimestamp = (timestamp: number) => {
  const date = new Date(timestamp * 1000)
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

const statusColor = computed(() => {
  const status = props.session.session?.status
  switch (status) {
    case 'active': return 'bg-green-500'
    case 'starting': return 'bg-yellow-500 animate-pulse'
    case 'paused': return 'bg-orange-500'
    case 'completed': return 'bg-gray-500'
    case 'failed': return 'bg-red-500'
    default: return 'bg-gray-400'
  }
})

const statusText = computed(() => {
  const status = props.session.session?.status
  switch (status) {
    case 'active': return 'Active'
    case 'starting': return 'Starting...'
    case 'paused': return 'Paused'
    case 'completed': return 'Completed'
    case 'failed': return 'Failed'
    default: return 'Initializing'
  }
})

const hasEnoughMessages = computed(() => props.session.messages.length > 2)
</script>

<template>
  <div class="h-full flex flex-col bg-dark-bg">
    <!-- Session Header -->
    <div class="flex items-center justify-between px-3 py-2 bg-dark-surface border-b border-dark-surface3">
      <div class="flex items-center gap-2 min-w-0">
        <!-- Status Indicator -->
        <span
          class="w-2.5 h-2.5 rounded-full flex-shrink-0"
          :class="statusColor"
          :title="statusText"
        />

        <!-- Name (editable) -->
        <div class="min-w-0 flex-1">
          <input
            v-if="isEditingName"
            ref="nameInput"
            v-model="editedName"
            class="w-full bg-dark-bg border border-accent rounded px-2 py-0.5 text-sm text-dark-text focus:outline-none focus:ring-1 focus:ring-accent"
            @blur="saveName"
            @keydown.enter="saveName"
            @keydown.esc="cancelEditName"
          >
          <button
            v-else
            class="text-sm font-medium text-dark-text hover:text-accent truncate max-w-[150px] text-left"
            @click="startEditingName"
          >
            {{ session.name }}
          </button>
        </div>
      </div>

      <div class="flex items-center gap-0.5">
        <!-- Show in Pi Button -->
        <a
          v-if="session.session?.sessionUrl"
          :href="session.session.sessionUrl"
          target="_blank"
          class="p-1.5 rounded hover:bg-dark-surface3 text-dark-dim hover:text-accent transition-colors"
          title="Open in Pi"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
        </a>

        <!-- Minimize -->
        <button
          class="p-1.5 rounded hover:bg-dark-surface3 text-dark-dim hover:text-dark-text transition-colors"
          title="Minimize"
          @click="emit('minimize')"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18 12H6" />
          </svg>
        </button>

        <!-- Close -->
        <button
          class="p-1.5 rounded hover:bg-dark-surface3 text-dark-dim hover:text-red-400 transition-colors"
          title="Close session"
          @click="emit('close')"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>

    <!-- Messages Area -->
    <div
      ref="messagesContainer"
      class="flex-1 overflow-y-auto p-3 space-y-3"
    >
      <!-- Empty State -->
      <div
        v-if="session.messages.length === 0"
        class="h-full flex flex-col items-center justify-center text-dark-dim px-4"
      >
        <div class="text-center mb-4">
          <svg class="w-10 h-10 mx-auto mb-2 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
          </svg>
          <p class="text-sm">Start a conversation with the planning assistant</p>
        </div>
        <div class="text-xs text-dark-dim/60 space-y-1 text-center">
          <p>• Break down complex tasks into manageable pieces</p>
          <p>• Get architecture and design suggestions</p>
          <p>• Plan implementation steps before creating tasks</p>
        </div>
      </div>

      <!-- Messages -->
      <ChatMessage
        v-for="(message, index) in session.messages"
        :key="message.id || index"
        :message="message"
        :show-timestamp="index === 0 || formatTimestamp(message.timestamp) !== formatTimestamp(session.messages[index - 1]?.timestamp || 0)"
      />

      <!-- Loading Indicator -->
      <div
        v-if="session.isLoading || session.isSending"
        class="flex items-center gap-2 text-dark-dim text-sm py-2"
      >
        <svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
        <span>{{ session.isLoading ? 'Starting session...' : 'Waiting for response...' }}</span>
      </div>

      <!-- Error -->
      <div
        v-if="session.error"
        class="p-3 rounded bg-red-500/10 border border-red-500/30 text-red-400 text-sm"
      >
        <div class="flex items-start gap-2">
          <svg class="w-4 h-4 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span>{{ session.error }}</span>
        </div>
      </div>
    </div>

    <!-- Input Area -->
    <div class="p-3 bg-dark-surface border-t border-dark-surface3">
      <!-- Toolbar -->
      <div class="flex items-center gap-2 mb-2">
        <!-- Create Tasks Button (Primary) -->
        <button
          v-if="hasEnoughMessages"
          class="btn btn-primary btn-xs flex items-center gap-1"
          @click="createTasksFromChat"
        >
          <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
          </svg>
          Create Tasks
        </button>

        <!-- Attach Context Dropdown -->
        <div class="relative">
          <button
            class="btn btn-xs flex items-center gap-1"
            @click="showAttachMenu = !showAttachMenu"
          >
            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
            </svg>
            Attach Context
            <span v-if="attachedContext.length > 0" class="ml-1 px-1 bg-accent/20 text-accent rounded text-xs">
              {{ attachedContext.length }}
            </span>
          </button>

          <!-- Attach Menu -->
          <div
            v-if="showAttachMenu"
            class="absolute bottom-full left-0 mb-1 w-48 bg-dark-surface border border-dark-surface3 rounded-lg shadow-xl z-50 py-1"
          >
            <button
              class="w-full px-3 py-2 text-left text-sm text-dark-text hover:bg-dark-surface2 flex items-center gap-2"
              @click="attachFile"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              Attach File(s)
            </button>
            <button
              class="w-full px-3 py-2 text-left text-sm text-dark-text hover:bg-dark-surface2 flex items-center gap-2"
              @click="attachScreenshot"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              Add Screenshot
            </button>
            <button
              class="w-full px-3 py-2 text-left text-sm text-dark-text hover:bg-dark-surface2 flex items-center gap-2"
              @click="attachCurrentTask"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
              Current Task
            </button>
          </div>
        </div>

        <!-- Clear Attachments Button -->
        <button
          v-if="attachedContext.length > 0"
          class="text-xs text-dark-dim hover:text-red-400 flex items-center gap-1"
          @click="clearAttachedContext"
        >
          <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
          Clear
        </button>
      </div>

      <!-- Attached Context Preview -->
      <div v-if="attachedContext.length > 0" class="mb-2 flex flex-wrap gap-1">
        <div
          v-for="(ctx, idx) in attachedContext"
          :key="idx"
          class="px-2 py-1 text-xs bg-accent/10 text-accent border border-accent/20 rounded flex items-center gap-1"
        >
          <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
          </svg>
          <span class="truncate max-w-[120px]">
            {{ ctx.type === 'file' ? ctx.name : ctx.name }}
          </span>
        </div>
      </div>

      <div class="flex flex-col gap-2">
        <MarkdownEditor
          v-model="messageInput"
          :disabled="session.isLoading || !session.session?.id"
          placeholder="Type your message... (Markdown supported)"
          class="min-h-[80px] max-h-[200px]"
        />

        <div class="flex items-center justify-between">
          <div class="text-xs text-dark-dim">
            <span v-if="session.isSending">Sending...</span>
            <span v-else-if="session.session?.status === 'starting'">Session starting...</span>
            <span v-else-if="session.session?.status === 'active'">Ready</span>
            <span v-else-if="session.session?.status === 'failed'">Session failed</span>
            <span v-else>Connect Pi to start chatting</span>
          </div>

          <div class="flex items-center gap-2">
            <button
              class="btn btn-sm"
              :disabled="session.isSending || !session.session?.id"
              @click="messageInput = ''"
            >
              Clear
            </button>
            <button
              class="btn btn-primary btn-sm"
              :disabled="!messageInput.trim() || session.isSending || !session.session?.id || session.isLoading"
              @click="sendMessage"
            >
              <span v-if="session.isSending" class="flex items-center gap-1">
                <svg class="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Sending...
              </span>
              <span v-else class="flex items-center gap-1">
                <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                </svg>
                Send
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Click outside to close attach menu -->
    <div
      v-if="showAttachMenu"
      class="fixed inset-0 z-40"
      @click="showAttachMenu = false"
    />
  </div>
</template>
