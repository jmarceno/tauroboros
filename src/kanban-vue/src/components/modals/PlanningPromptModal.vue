<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useApi } from '@/composables/useApi'
import MarkdownEditor from '@/components/common/MarkdownEditor.vue'

const emit = defineEmits<{
  close: []
}>()

const api = useApi()
const isLoading = ref(false)
const isSaving = ref(false)
const error = ref<string | null>(null)
const promptData = ref<{
  id: number
  key: string
  name: string
  description: string
  promptText: string
  isActive: boolean
  createdAt: number
  updatedAt: number
} | null>(null)

const editedPrompt = ref({
  name: '',
  description: '',
  promptText: '',
})

const hasChanges = computed(() => {
  if (!promptData.value) return false
  return (
    editedPrompt.value.name !== promptData.value.name ||
    editedPrompt.value.description !== promptData.value.description ||
    editedPrompt.value.promptText !== promptData.value.promptText
  )
})

onMounted(async () => {
  isLoading.value = true
  error.value = null
  try {
    const prompt = await api.getPlanningPrompt()
    promptData.value = prompt
    editedPrompt.value = {
      name: prompt.name,
      description: prompt.description,
      promptText: prompt.promptText,
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to load planning prompt'
    console.error('Failed to load planning prompt:', e)
  } finally {
    isLoading.value = false
  }
})

const savePrompt = async () => {
  if (!hasChanges.value || !promptData.value) return

  isSaving.value = true
  error.value = null
  try {
    const updated = await api.updatePlanningPrompt({
      key: promptData.value.key,
      name: editedPrompt.value.name,
      description: editedPrompt.value.description,
      promptText: editedPrompt.value.promptText,
    })
    promptData.value = updated
    emit('close')
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to save planning prompt'
    console.error('Failed to save planning prompt:', e)
  } finally {
    isSaving.value = false
  }
}

const resetToDefault = () => {
  if (!confirm('Reset to default planning prompt? This will overwrite your customizations.')) return

  editedPrompt.value = {
    name: 'Default Planning Prompt',
    description: 'System prompt for the planning assistant agent',
    promptText: `You are a specialized Planning Assistant for software development task management.

Your role is to help users create well-structured implementation plans before they become kanban tasks.

## Core Capabilities

1. **Task Planning**: Break down complex requirements into actionable, well-defined tasks
2. **Architecture Design**: Suggest component structures, APIs, and data models
3. **Dependency Analysis**: Identify task dependencies and execution order
4. **Estimation Guidance**: Provide complexity assessments and implementation hints
5. **Visual Explanation**: Use diagrams and visual aids to explain complex concepts

## Interaction Guidelines

- Ask clarifying questions when requirements are ambiguous
- Suggest concrete next steps and validation approaches
- Reference existing codebase patterns when relevant
- Keep responses focused on planning and design
- Do NOT write actual implementation code unless specifically requested for prototyping
- **ALWAYS** try to visually explain things when possible using Mermaid charts
- **NEVER** use ASCII charts or text-based diagrams - always use Mermaid syntax instead

## Visual Explanations with Mermaid

When explaining:
- System architecture or component relationships
- Data flow between components
- Task dependencies and execution order
- State machines or workflows
- Class hierarchies or module structures
- Sequence of operations

Always use Mermaid chart syntax. Examples:

**Flowchart:**
\`\`\`mermaid
flowchart TD
    A[Start] --> B{Decision}
    B -->|Yes| C[Action 1]
    B -->|No| D[Action 2]
    C --> E[End]
    D --> E
\`\`\`

**Sequence Diagram:**
\`\`\`mermaid
sequenceDiagram
    User->>+API: Request
    API->>+Database: Query
    Database-->>-API: Results
    API-->>-User: Response
\`\`\`

**Class Diagram:**
\`\`\`mermaid
classDiagram
    class User {
        +String name
        +login()
    }
    class Order {
        +int id
        +place()
    }
    User "1" --> "*" Order : has
\`\`\`

## Output Format for Task Creation

When the user is ready to create tasks, help them structure:
- Clear task names
- Detailed prompts with context
- Suggested task dependencies
- Recommended execution order

## Tool Access

You have access to file exploration tools to understand the codebase structure when needed. Use them to provide context-aware planning suggestions.`,
  }
}
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" @click.self="emit('close')">
    <div
      class="bg-dark-surface rounded-lg shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col"
      @click.stop
    >
      <!-- Header -->
      <div class="flex items-center justify-between px-4 py-3 border-b border-dark-surface3">
        <div>
          <h2 class="text-lg font-semibold text-dark-text">Edit Planning Assistant Prompt</h2>
          <p class="text-sm text-dark-dim">
            Customize the system prompt used by the planning chat agent
          </p>
        </div>
        <button
          class="p-1.5 rounded hover:bg-dark-surface3 text-dark-dim hover:text-dark-text transition-colors"
          @click="emit('close')"
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <!-- Content -->
      <div class="flex-1 overflow-y-auto p-4 space-y-4">
        <!-- Loading State -->
        <div v-if="isLoading" class="flex items-center justify-center py-12">
          <svg class="w-8 h-8 animate-spin text-accent" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
        </div>

        <!-- Error -->
        <div
          v-else-if="error"
          class="p-4 rounded bg-red-500/10 border border-red-500/30 text-red-400"
        >
          <div class="flex items-start gap-2">
            <svg class="w-5 h-5 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>{{ error }}</span>
          </div>
        </div>

        <!-- Form -->
        <div v-else class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-dark-text mb-1">Name</label>
            <input
              v-model="editedPrompt.name"
              type="text"
              class="w-full bg-dark-bg border border-dark-surface3 rounded px-3 py-2 text-dark-text focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent"
            >
          </div>

          <div>
            <label class="block text-sm font-medium text-dark-text mb-1">Description</label>
            <input
              v-model="editedPrompt.description"
              type="text"
              class="w-full bg-dark-bg border border-dark-surface3 rounded px-3 py-2 text-dark-text focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent"
            >
          </div>

          <div>
            <label class="block text-sm font-medium text-dark-text mb-1">System Prompt</label>
            <p class="text-xs text-dark-dim mb-2">
              This prompt defines how the planning assistant behaves. It uses Markdown formatting.
            </p>
            <div class="border border-dark-surface3 rounded overflow-hidden">
              <MarkdownEditor
                v-model="editedPrompt.promptText"
                placeholder="Enter the system prompt for the planning assistant..."
                class="min-h-[300px]"
              />
            </div>
          </div>

          <!-- Help Section -->
          <div class="bg-dark-surface2 rounded p-3 text-sm space-y-2">
            <h4 class="font-medium text-dark-text">Prompt Tips</h4>
            <ul class="text-dark-dim space-y-1 text-xs">
              <li>• Be specific about the assistant's role and expertise</li>
              <li>• Define clear interaction guidelines</li>
              <li>• Specify output formats for better structured responses</li>
              <li>• Mention available tools and when to use them</li>
            </ul>
          </div>
        </div>
      </div>

      <!-- Footer -->
      <div class="flex items-center justify-between px-4 py-3 border-t border-dark-surface3">
        <button
          class="btn btn-sm"
          :disabled="isLoading || isSaving"
          @click="resetToDefault"
        >
          Reset to Default
        </button>

        <div class="flex items-center gap-2">
          <button
            class="btn btn-sm"
            :disabled="isSaving"
            @click="emit('close')"
          >
            Cancel
          </button>
          <button
            class="btn btn-primary btn-sm"
            :disabled="!hasChanges || isSaving"
            @click="savePrompt"
          >
            <span v-if="isSaving" class="flex items-center gap-1">
              <svg class="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              Saving...
            </span>
            <span v-else>Save Changes</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
