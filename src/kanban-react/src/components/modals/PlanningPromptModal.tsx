import { useState, useEffect, useRef } from 'react'
import { useApi } from '@/hooks'
import { MarkdownEditor, type MarkdownEditorRef } from '../common/MarkdownEditor'

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

export function PlanningPromptModal({ onClose }: PlanningPromptModalProps) {
  const api = useApi()
  const getPlanningPrompt = api.getPlanningPrompt
  const [isLoading, setIsLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [promptData, setPromptData] = useState<{
    id: number
    key: string
    name: string
    description: string
    promptText: string
    isActive: boolean
    createdAt: number
    updatedAt: number
  } | null>(null)

  const [editedPrompt, setEditedPrompt] = useState({
    name: '',
    description: '',
    promptText: '',
  })

  const editorRef = useRef<MarkdownEditorRef>(null)

  const hasChanges = promptData
    ? editedPrompt.name !== promptData.name ||
      editedPrompt.description !== promptData.description ||
      editedPrompt.promptText !== promptData.promptText
    : false

  useEffect(() => {
    let cancelled = false
    const loadPrompt = async () => {
      setIsLoading(true)
      setError(null)
      try {
        const prompt = await getPlanningPrompt()
        if (cancelled) return
        setPromptData(prompt)
        setEditedPrompt({
          name: prompt.name,
          description: prompt.description,
          promptText: prompt.promptText,
        })
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load planning prompt')
        console.error('Failed to load planning prompt:', e)
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }
    loadPrompt()
    return () => { cancelled = true }
  }, [getPlanningPrompt])

  const savePrompt = async () => {
    if (!hasChanges || !promptData) return

    setIsSaving(true)
    setError(null)
    try {
      const updated = await api.updatePlanningPrompt({
        key: promptData.key,
        name: editedPrompt.name,
        description: editedPrompt.description,
        promptText: editedPrompt.promptText,
      })
      setPromptData(updated)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save planning prompt')
      console.error('Failed to save planning prompt:', e)
    } finally {
      setIsSaving(false)
    }
  }

  const resetToDefault = () => {
    if (!confirm('Reset to default planning prompt? This will overwrite your customizations.')) return

    const defaultText = DEFAULT_PROMPT.replace(/\\n/g, '\n').replace(/\\`\\`\\`/g, '```')
    setEditedPrompt({
      name: 'Default Planning Prompt',
      description: 'System prompt for the planning assistant agent',
      promptText: defaultText,
    })
    editorRef.current?.clear()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80" onClick={onClose}>
      <div
        className="bg-dark-surface2 rounded-lg shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col border border-dark-surface3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-dark-surface3">
          <div>
            <h2 className="text-lg font-semibold text-dark-text">Edit Planning Assistant Prompt</h2>
            <p className="text-sm text-dark-text-muted">
              Customize the system prompt used by the planning chat agent
            </p>
          </div>
          <button
            className="p-1.5 rounded hover:bg-dark-surface3 text-dark-text-muted hover:text-dark-text transition-colors"
            onClick={onClose}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <svg className="w-8 h-8 animate-spin text-accent-primary" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
            </div>
          ) : error ? (
            <div className="p-4 rounded bg-red-500/10 border border-red-500/30 text-red-400">
              <div className="flex items-start gap-2">
                <svg className="w-5 h-5 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span>{error}</span>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-dark-text mb-1">Name</label>
                <input
                  type="text"
                  className="w-full bg-dark-bg border border-dark-surface3 rounded px-3 py-2 text-dark-text focus:outline-none focus:ring-1 focus:ring-accent-primary focus:border-accent-primary"
                  value={editedPrompt.name}
                  onChange={(e) => setEditedPrompt({ ...editedPrompt, name: e.target.value })}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-dark-text mb-1">Description</label>
                <input
                  type="text"
                  className="w-full bg-dark-bg border border-dark-surface3 rounded px-3 py-2 text-dark-text focus:outline-none focus:ring-1 focus:ring-accent-primary focus:border-accent-primary"
                  value={editedPrompt.description}
                  onChange={(e) => setEditedPrompt({ ...editedPrompt, description: e.target.value })}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-dark-text mb-1">System Prompt</label>
                <p className="text-xs text-dark-text-muted mb-2">
                  This prompt defines how the planning assistant behaves. It uses Markdown formatting.
                </p>
                <div className="border border-dark-surface3 rounded overflow-hidden">
                  <MarkdownEditor
                    ref={editorRef}
                    modelValue={editedPrompt.promptText}
                    placeholder="Enter the system prompt for the planning assistant..."
                    onUpdate={(value) => setEditedPrompt({ ...editedPrompt, promptText: value })}
                  />
                </div>
              </div>

              <div className="bg-dark-surface rounded p-3 text-sm space-y-2">
                <h4 className="font-medium text-dark-text">Prompt Tips</h4>
                <ul className="text-dark-text-muted space-y-1 text-xs">
                  <li>Be specific about the assistant's role and expertise</li>
                  <li>Define clear interaction guidelines</li>
                  <li>Specify output formats for better structured responses</li>
                  <li>Mention available tools and when to use them</li>
                </ul>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between px-4 py-3 border-t border-dark-surface3">
          <button
            className="btn btn-sm"
            disabled={isLoading || isSaving}
            onClick={resetToDefault}
          >
            Reset to Default
          </button>

          <div className="flex items-center gap-2">
            <button
              className="btn btn-sm"
              disabled={isSaving}
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              className="btn btn-primary btn-sm"
              disabled={!hasChanges || isSaving}
              onClick={savePrompt}
            >
              {isSaving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
