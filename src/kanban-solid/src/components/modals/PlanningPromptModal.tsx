/**
 * PlanningPromptModal Component - Planning prompt editor
 * Ported from React to SolidJS with full feature parity
 * OPTIMIZED: Replaced heavy MarkdownEditor with fast textarea
 */

import { createSignal, createEffect, Show, onCleanup } from 'solid-js'
import { planningApi, runApiEffect } from '@/api'

const DEFAULT_PROMPT = `You are a specialized Planning Assistant for software development task management.

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

You have access to file exploration tools to understand the codebase structure when needed. Use them to provide context-aware planning suggestions.`

interface PlanningPromptModalProps {
  onClose: () => void
}

export function PlanningPromptModal(props: PlanningPromptModalProps) {
  const [isLoading, setIsLoading] = createSignal(false)
  const [isSaving, setIsSaving] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [promptData, setPromptData] = createSignal<{
    id: number
    key: string
    name: string
    description: string
    promptText: string
    isActive: boolean
    createdAt: number
    updatedAt: number
  } | null>(null)

  const [editedPrompt, setEditedPrompt] = createSignal({
    name: '',
    description: '',
    promptText: '',
  })

  const hasChanges = () => promptData()
    ? editedPrompt().name !== promptData()!.name ||
      editedPrompt().description !== promptData()!.description ||
      editedPrompt().promptText !== promptData()!.promptText
    : false

  createEffect(() => {
    let cancelled = false
    
    const loadPrompt = async () => {
      setIsLoading(true)
      setError(null)
      try {
        const prompt = await runApiEffect(planningApi.getPrompt())
        if (cancelled) return
        setPromptData(prompt)
        setEditedPrompt({
          name: prompt.name,
          description: prompt.description,
          promptText: prompt.promptText,
        })
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to load planning prompt')
        }
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }
    
    loadPrompt()
    
    onCleanup(() => {
      cancelled = true
    })
  })

  const savePrompt = async () => {
    if (!hasChanges() || !promptData()) return

    setIsSaving(true)
    setError(null)
    try {
      const updated = await runApiEffect(planningApi.updatePrompt({
        key: promptData()!.key,
        name: editedPrompt().name,
        description: editedPrompt().description,
        promptText: editedPrompt().promptText,
      }))
      setPromptData(updated)
      props.onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save planning prompt')
    } finally {
      setIsSaving(false)
    }
  }

  const resetToDefault = () => {
    if (!confirm('Reset to default planning prompt? This will overwrite your customizations.')) return

    setEditedPrompt(prev => ({
      ...prev,
      name: 'Default Planning Prompt',
      description: 'System prompt for the planning assistant agent',
      promptText: DEFAULT_PROMPT,
    }))
  }

  return (
    <div class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80" onClick={props.onClose}>
      <div
        class="bg-dark-surface2 rounded-lg shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col border border-dark-surface3"
        onClick={(e) => e.stopPropagation()}
      >
        <div class="flex items-center justify-between px-4 py-3 border-b border-dark-surface3">
          <div>
            <h2 class="text-lg font-semibold text-dark-text">Edit Planning Assistant Prompt</h2>
            <p class="text-sm text-dark-text-muted">
              Customize the system prompt used by the planning chat agent
            </p>
          </div>
          <button
            class="p-1.5 rounded hover:bg-dark-surface3 text-dark-text-muted hover:text-dark-text transition-colors"
            onClick={props.onClose}
          >
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div class="flex-1 overflow-y-auto p-4 space-y-4">
          <Show when={isLoading()}>
            <div class="flex flex-col items-center justify-center py-12 space-y-3">
              <svg class="w-8 h-8 animate-spin text-accent-primary" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              <div class="text-center">
                <p class="text-sm text-dark-text">Loading planning prompt...</p>
                <p class="text-xs text-dark-text-muted mt-1">This may take a few moments</p>
              </div>
            </div>
          </Show>

          <Show when={error()}>
            <div class="p-4 rounded bg-red-500/10 border border-red-500/30 text-red-400">
              <div class="flex items-start gap-2">
                <svg class="w-5 h-5 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span>{error()}</span>
              </div>
            </div>
          </Show>

          <Show when={!isLoading() && !error()}>
            <div class="space-y-4">
              <div>
                <label class="block text-sm font-medium text-dark-text mb-1">Name</label>
                <input
                  type="text"
                  class="w-full bg-dark-bg border border-dark-surface3 rounded px-3 py-2 text-dark-text focus:outline-none focus:ring-1 focus:ring-accent-primary focus:border-accent-primary"
                  value={editedPrompt().name}
                  onChange={(e) => setEditedPrompt(prev => ({ ...prev, name: e.currentTarget.value }))}
                />
              </div>

              <div>
                <label class="block text-sm font-medium text-dark-text mb-1">Description</label>
                <input
                  type="text"
                  class="w-full bg-dark-bg border border-dark-surface3 rounded px-3 py-2 text-dark-text focus:outline-none focus:ring-1 focus:ring-accent-primary focus:border-accent-primary"
                  value={editedPrompt().description}
                  onChange={(e) => setEditedPrompt(prev => ({ ...prev, description: e.currentTarget.value }))}
                />
              </div>

              <div>
                <label class="block text-sm font-medium text-dark-text mb-1">System Prompt</label>
                <p class="text-xs text-dark-text-muted mb-2">
                  This prompt defines how the planning assistant behaves. It uses Markdown formatting.
                </p>
                <textarea
                  class="w-full min-h-[400px] bg-dark-bg border border-dark-surface3 rounded px-3 py-2 text-sm text-dark-text font-mono focus:outline-none focus:ring-1 focus:ring-accent-primary focus:border-accent-primary resize-vertical"
                  value={editedPrompt().promptText}
                  placeholder="Enter the system prompt for the planning assistant..."
                  onChange={(e) => setEditedPrompt(prev => ({ ...prev, promptText: e.currentTarget.value }))}
                />
              </div>

              <div class="bg-dark-surface rounded p-3 text-sm space-y-2">
                <h4 class="font-medium text-dark-text">Prompt Tips</h4>
                <ul class="text-dark-text-muted space-y-1 text-xs">
                  <li>Be specific about the assistant's role and expertise</li>
                  <li>Define clear interaction guidelines</li>
                  <li>Specify output formats for better structured responses</li>
                  <li>Mention available tools and when to use them</li>
                </ul>
              </div>
            </div>
          </Show>
        </div>

        <div class="flex items-center justify-between px-4 py-3 border-t border-dark-surface3">
          <button
            class="btn btn-sm"
            disabled={isLoading() || isSaving()}
            onClick={resetToDefault}
          >
            Reset to Default
          </button>

          <div class="flex items-center gap-2">
            <button
              class="btn btn-sm"
              disabled={isSaving()}
              onClick={props.onClose}
            >
              Cancel
            </button>
            <button
              class="btn btn-primary btn-sm"
              disabled={!hasChanges() || isSaving()}
              onClick={savePrompt}
            >
              {isSaving() ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
