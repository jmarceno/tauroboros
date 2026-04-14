<script setup lang="ts">
import { ref, watch, nextTick, onMounted, computed, inject } from 'vue'
import type { ChatSession, ContextAttachment } from '@/composables/usePlanningChat'
import type { SessionMessage } from '@/types/api'
import type { useOptions } from '@/composables/useOptions'
import type { useModelSearch } from '@/composables/useModelSearch'
import ChatMessage from './ChatMessage.vue'
import MarkdownEditor from '@/components/common/MarkdownEditor.vue'
import ModelPicker from '@/components/common/ModelPicker.vue'
import ThinkingLevelSelect from '@/components/common/ThinkingLevelSelect.vue'
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
const options = inject<ReturnType<typeof useOptions>>('options')!
const modelSearch = inject<ReturnType<typeof useModelSearch>>('modelSearch')!
const messageInput = ref('')
const editorRef = ref<InstanceType<typeof MarkdownEditor> | null>(null)
const messagesContainer = ref<HTMLElement | null>(null)
const isEditingName = ref(false)
const editedName = ref('')
const nameInput = ref<HTMLInputElement | null>(null)
const showAttachMenu = ref(false)
const attachedContext = ref<ContextAttachment[]>([])

// Model selector state
const showModelMenu = ref(false)
const pendingModel = ref('')
const pendingThinkingLevel = ref<'default' | 'low' | 'medium' | 'high'>('default')
const isChangingModel = ref(false)

// Initialize pendingModel when menu opens
watch(showModelMenu, (isOpen) => {
  if (isOpen) {
    pendingModel.value = props.session.session?.model || ''
    pendingThinkingLevel.value = props.session.session?.thinkingLevel || 'default'
    nextTick(() => calculateModelMenuPosition())
  }
})

// Watch attach menu to calculate position
watch(showAttachMenu, (isOpen) => {
  if (isOpen) {
    nextTick(() => calculateAttachMenuPosition())
  }
})

// Calculate dropdown positions
const attachMenuRef = ref<HTMLElement | null>(null)
const modelMenuRef = ref<HTMLElement | null>(null)

const calculateAttachMenuPosition = () => {
  // Menu is now inline, no need for fixed positioning
}

const calculateModelMenuPosition = () => {
  // Menu is now inline, no need for fixed positioning
}

// Recalculate positions on resize and scroll
onMounted(() => {
  scrollToBottom()
})

const currentModel = computed(() => props.session.session?.model)
const currentModelLabel = computed(() => {
  const model = currentModel.value
  if (!model || model === 'default') return ''
  const parts = model.split('/')
  return parts.length > 1 ? parts[1] : model
})

// Auto-scroll to bottom on new messages
watch(() => props.session.messages.length, async () => {
  await nextTick()
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

const attachCurrentTask = () => {
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

  // Clear input and editor
  messageInput.value = ''
  attachedContext.value = []
  editorRef.value?.clear()

  try {
    await planningChat.sendMessage(props.session.id, content, attachments)
    scrollToBottom()
  } catch (e) {
    console.error('Failed to send message:', e)
    scrollToBottom()
  }
}

const handleKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Enter' && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault()
    if (messageInput.value.trim() && !props.session.isSending && props.session.session?.id && props.session.session?.status === 'active') {
      sendMessage()
    }
  }
}

const changeModel = async () => {
  if (!pendingModel.value || !props.session.session?.id) return

  isChangingModel.value = true
  try {
    await planningChat.setSessionModel(props.session.id, pendingModel.value, pendingThinkingLevel.value)
    showModelMenu.value = false
  } catch (e) {
    console.error('Failed to change model:', e)
  } finally {
    isChangingModel.value = false
  }
}

const canReconnect = computed(() => {
  const session = props.session.session
  return session && (session.status !== 'active' || props.session.error?.includes('not active'))
})

const createTasksFromChat = async () => {
  try {
    const result = await planningChat.createTasksFromChat(props.session.id)
    console.log('Tasks created:', result)
    emit('createTasks')
  } catch (e) {
    console.error('Failed to create tasks:', e)
  }
}

const statusColorClass = computed(() => {
  const status = props.session.session?.status
  switch (status) {
    case 'active': return 'bg-accent-success'
    case 'starting': return 'bg-accent-warning animate-pulse'
    case 'paused': return 'bg-accent-warning'
    case 'completed': return 'bg-dark-text-muted'
    case 'failed': return 'bg-accent-danger'
    default: return 'bg-dark-text-muted'
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

const handleReconnect = async () => {
  try {
    await planningChat.reconnectSession(props.session.id)
  } catch (e) {
    console.error('Failed to reconnect:', e)
  }
}
</script>

<template>
  <div class="h-full flex flex-col bg-dark-bg">
    <!-- Session Header -->
    <div class="flex items-center justify-between px-3 py-2 bg-dark-surface2 border-b border-dark-border">
      <div class="flex items-center gap-2 min-w-0">
        <span
          class="w-2.5 h-2.5 rounded-full flex-shrink-0"
          :class="statusColorClass"
          :title="statusText"
        />
        <div class="min-w-0 flex-1">
          <input
            v-if="isEditingName"
            ref="nameInput"
            v-model="editedName"
            class="w-full bg-dark-bg border border-accent-primary rounded px-2 py-0.5 text-sm text-dark-text focus:outline-none"
            @blur="saveName"
            @keydown.enter="saveName"
            @keydown.esc="cancelEditName"
          >
          <button
            v-else
            class="text-sm font-medium text-dark-text hover:text-accent-primary truncate max-w-[150px] text-left"
            @click="startEditingName"
          >
            {{ session.name }}
          </button>
        </div>
      </div>

      <div class="flex items-center gap-0.5">
        <a
          v-if="session.session?.sessionUrl"
          :href="session.session.sessionUrl"
          target="_blank"
          class="p-1.5 rounded hover:bg-dark-surface3 text-dark-text-secondary hover:text-accent-primary transition-colors"
          title="Open in Pi"
        >
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
        </a>
        <button
          class="p-1.5 rounded hover:bg-dark-surface3 text-dark-text-secondary hover:text-dark-text transition-colors"
          title="Minimize"
          @click="emit('minimize')"
        >
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 12H6" />
          </svg>
        </button>
        <button
          class="p-1.5 rounded hover:bg-dark-surface3 text-dark-text-secondary hover:text-accent-danger transition-colors"
          title="Close session"
          @click="emit('close')"
        >
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>

    <!-- Messages Area -->
    <div ref="messagesContainer" class="chat-messages">
      <!-- Empty State -->
      <div
        v-if="session.messages.length === 0"
        class="h-full flex flex-col items-center justify-center text-dark-text-muted px-4"
      >
        <div class="text-center mb-4">
          <svg class="w-10 h-10 mx-auto mb-2 opacity-40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
          </svg>
          <p class="text-sm">Start a conversation with the planning assistant</p>
        </div>
        <div class="text-xs text-dark-text-muted/60 space-y-1 text-center">
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
      />

      <!-- Loading Indicator -->
      <div
        v-if="session.isLoading || session.isSending"
        class="flex items-center gap-2 text-dark-text-muted text-sm py-2 px-4"
      >
        <svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
        <span>{{ session.isLoading ? 'Starting session...' : 'Waiting for response...' }}</span>
      </div>

      <!-- Reconnect Button -->
      <div
        v-if="canReconnect"
        class="mx-4 my-2 p-3 rounded bg-accent-warning/10 border border-accent-warning/30 text-accent-warning text-sm"
      >
        <div class="flex items-start gap-2">
          <svg class="w-4 h-4 mt-0.5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
          </svg>
          <div class="flex-1">
            <p class="mb-2">This session is not currently active. Reconnect to continue chatting.</p>
            <button
              class="btn btn-primary btn-xs"
              :disabled="session.isLoading"
              @click="handleReconnect"
            >
              <span v-if="session.isLoading" class="flex items-center gap-1">
                <svg class="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Reconnecting...
              </span>
              <span v-else>Reconnect</span>
            </button>
          </div>
        </div>
      </div>

      <!-- Error -->
      <div
        v-if="session.error && !canReconnect"
        class="mx-4 my-2 p-3 rounded bg-accent-danger/10 border border-accent-danger/30 text-accent-danger text-sm"
      >
        <div class="flex items-start gap-2">
          <svg class="w-4 h-4 mt-0.5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span>{{ session.error }}</span>
        </div>
      </div>
    </div>

    <!-- Input Area -->
    <div class="chat-input-container">
      <!-- Toolbar -->
      <div class="chat-toolbar">
        <button
          v-if="hasEnoughMessages"
          class="chat-tool-btn border-accent-primary/50 text-accent-primary"
          @click="createTasksFromChat"
        >
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
          </svg>
          Create Tasks
        </button>

        <!-- Attach Context Dropdown -->
        <div class="relative">
          <button
            ref="attachMenuRef"
            class="chat-tool-btn"
            @click="showAttachMenu = !showAttachMenu"
          >
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
            </svg>
            Attach Context
            <span v-if="attachedContext.length > 0" class="ml-1 px-1 bg-accent-primary/20 text-accent-primary rounded text-xs">
              {{ attachedContext.length }}
            </span>
          </button>

          <!-- Attach Menu -->
          <div
            v-if="showAttachMenu"
            class="absolute bottom-full left-0 mb-1 w-48 bg-dark-surface border border-dark-border rounded-lg shadow-xl z-50 py-1"
          >
            <button
              class="w-full px-3 py-2 text-left text-sm text-dark-text hover:bg-dark-surface2 flex items-center gap-2"
              @click="attachFile"
            >
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              Attach File(s)
            </button>
            <button
              class="w-full px-3 py-2 text-left text-sm text-dark-text hover:bg-dark-surface2 flex items-center gap-2"
              @click="attachCurrentTask"
            >
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
              Current Task
            </button>
          </div>
        </div>

        <!-- Model Selector Dropdown -->
        <div class="relative">
          <button
            ref="modelMenuRef"
            class="chat-tool-btn"
            :disabled="!session.session || session.session.status !== 'active'"
            @click="showModelMenu = !showModelMenu"
          >
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
            Model
            <span v-if="currentModel" class="ml-1 text-accent-primary">
              {{ currentModelLabel }}
            </span>
          </button>

          <!-- Model Menu -->
          <div
            v-if="showModelMenu"
            class="absolute bottom-full left-0 mb-1 w-72 bg-dark-surface border border-dark-border rounded-lg shadow-xl z-50 py-2"
          >
            <div class="px-3 py-1 text-xs text-dark-text-muted border-b border-dark-border mb-2">
              Change Model & Thinking Level
            </div>
            <div class="px-2 pb-2 space-y-2">
              <ModelPicker
                v-model="pendingModel"
                label="Model"
                placeholder="Type model name..."
              />
              <ThinkingLevelSelect
                v-model="pendingThinkingLevel"
                label="Thinking Level"
              />
            </div>
            <div class="px-3 py-2 border-t border-dark-border flex justify-end">
              <button
                class="btn btn-primary btn-xs"
                :disabled="!pendingModel || (pendingModel === session.session?.model && pendingThinkingLevel === session.session?.thinkingLevel) || isChangingModel"
                @click="changeModel"
              >
                <span v-if="isChangingModel" class="flex items-center gap-1">
                  <svg class="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  Changing...
                </span>
                <span v-else>Apply</span>
              </button>
            </div>
          </div>
        </div>

        <!-- Clear Attachments Button -->
        <button
          v-if="attachedContext.length > 0"
          class="text-xs text-dark-text-muted hover:text-accent-danger flex items-center gap-1"
          @click="clearAttachedContext"
        >
          <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M6 18L18 6M6 6l12 12" />
          </svg>
          Clear
        </button>
      </div>

      <!-- Attached Context Preview -->
      <div v-if="attachedContext.length > 0" class="mb-2 flex flex-wrap gap-1">
        <div
          v-for="(ctx, idx) in attachedContext"
          :key="idx"
          class="px-2 py-1 text-xs bg-accent-primary/10 text-accent-primary border border-accent-primary/20 rounded flex items-center gap-1"
        >
          <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
          </svg>
          <span class="truncate max-w-[120px]">{{ ctx.name }}</span>
        </div>
      </div>

      <!-- Input Box -->
      <div class="chat-input-box">
        <MarkdownEditor
          ref="editorRef"
          v-model="messageInput"
          :disabled="session.isLoading || !session.session?.id"
          placeholder="Type your message... (Shift+Enter to send)"
          class="min-h-[60px] max-h-[150px] w-full"
          @keydown="handleKeydown"
        />
      </div>

      <!-- Send Button (below input) -->
      <button
        class="chat-send-btn"
        :disabled="!messageInput.trim() || session.isSending || !session.session?.id || session.isLoading"
        @click="sendMessage"
      >
        <span v-if="session.isSending" class="flex items-center gap-1">
          <svg class="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
        </span>
        <span v-else class="flex items-center gap-1">
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
          </svg>
          Send
        </span>
      </button>

      <!-- Status -->
      <div class="mt-2 text-xs text-dark-text-muted flex items-center justify-between">
        <span v-if="session.isSending">Sending...</span>
        <span v-else-if="session.session?.status === 'starting'">Session starting...</span>
        <span v-else-if="session.session?.status === 'active'">Ready</span>
        <span v-else-if="session.session?.status === 'failed'">Session failed</span>
        <span v-else>Connect Pi to start chatting</span>
        <span class="text-dark-text-muted/50">Shift+Enter to send</span>
      </div>
    </div>

    <!-- Click outside to close menus -->
    <div
      v-if="showAttachMenu || showModelMenu"
      class="fixed inset-0 z-40"
      @click="showAttachMenu = false; showModelMenu = false"
    />
  </div>
</template>
