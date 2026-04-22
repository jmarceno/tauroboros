/**
 * ChatPanel Component - Chat side panel UI
 * Ported from React to SolidJS with reactivity fixes
 */

import { createSignal, createMemo, Show, For, onMount, createEffect, type Accessor } from 'solid-js'
import { ChatMessage } from './ChatMessage'
import type { ChatSession, ContextAttachment } from '@/stores/planningChatStore'
import type { SessionMessage } from '@/types'

interface ChatPanelProps {
  session: Accessor<ChatSession | undefined>
  onMinimize: () => void
  onClose: () => void
  onRename: (name: string) => void
  onSendMessage: (sessionId: string, content: string, attachments?: ContextAttachment[]) => Promise<void>
  onReconnect: () => Promise<void>
  onChangeModel: (model: string, thinkingLevel?: string) => Promise<void>
  onCreateTasks: () => Promise<void>
}

export function ChatPanel(props: ChatPanelProps) {
  const [messageInput, setMessageInput] = createSignal('')
  const [attachedContext, setAttachedContext] = createSignal<ContextAttachment[]>([])
  const [isEditingName, setIsEditingName] = createSignal(false)
  const [editedName, setEditedName] = createSignal('')
  const [showModelMenu, setShowModelMenu] = createSignal(false)
  const [pendingModel, setPendingModel] = createSignal('')
  const [pendingThinkingLevel, setPendingThinkingLevel] = createSignal<'default' | 'low' | 'medium' | 'high'>('default')
  const [isChangingModel, setIsChangingModel] = createSignal(false)
  let messagesContainerRef: HTMLDivElement | undefined
  let nameInputRef: HTMLInputElement | undefined

  // Update local state when session changes
  createEffect(() => {
    const session = props.session()
    if (session) {
      setEditedName(session.name)
      setPendingModel(session.session?.model || '')
      setPendingThinkingLevel(session.session?.thinkingLevel || 'default')
    }
  })

  const currentModel = () => props.session()?.session?.model
  const currentModelLabel = createMemo(() =>
    currentModel()?.split('/').pop() || currentModel() || ''
  )

  const canReconnect = createMemo(() => {
    const session = props.session()
    return session?.session && (session.session.status !== 'active' || session.error?.includes('not active'))
  })

  const hasEnoughMessages = createMemo(() =>
    (props.session()?.messages?.length || 0) > 2
  )

  const statusColorClass = createMemo(() => {
    const status = props.session()?.session?.status
    switch (status) {
      case 'active': return 'bg-accent-success'
      case 'starting': return 'bg-accent-warning animate-pulse'
      case 'paused': return 'bg-accent-warning'
      case 'completed': return 'bg-dark-text-muted'
      case 'failed': return 'bg-accent-danger'
      default: return 'bg-dark-text-muted'
    }
  })

  const statusText = createMemo(() => {
    const status = props.session()?.session?.status
    switch (status) {
      case 'active': return 'Active'
      case 'starting': return 'Starting...'
      case 'paused': return 'Paused'
      case 'completed': return 'Completed'
      case 'failed': return 'Failed'
      default: return 'Initializing'
    }
  })

  const sessionId = () => props.session()?.id
  const sessionObj = () => props.session()?.session
  const isLoading = () => props.session()?.isLoading || false
  const isSending = () => props.session()?.isSending || false
  const isReconnecting = () => props.session()?.isReconnecting || false
  const error = () => props.session()?.error || null
  const messages = () => props.session()?.messages || []
  const sessionName = () => props.session()?.name || ''

  createEffect(() => {
    if (messagesContainerRef) {
      messagesContainerRef.scrollTop = messagesContainerRef.scrollHeight
    }
  })

  createEffect(() => {
    if (isEditingName() && nameInputRef) {
      nameInputRef.focus()
      nameInputRef.select()
    }
  })

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      const session = props.session()
      if (messageInput().trim() && !isSending() && session?.session?.id && session?.session?.status === 'active') {
        handleSend()
      }
    }
  }

  const handleSend = async () => {
    const session = props.session()
    if (!messageInput().trim() || isSending()) return
    if (!session?.session?.id) return

    const content = messageInput().trim()
    const attachments = [...attachedContext()]

    setMessageInput('')
    setAttachedContext([])

    try {
      await props.onSendMessage(session.id, content, attachments)
      if (messagesContainerRef) {
        messagesContainerRef.scrollTop = messagesContainerRef.scrollHeight
      }
    } catch {
      // Message send failed - error handled by store
    }
  }

  const handleNameSave = () => {
    const session = props.session()
    if (editedName().trim() && editedName() !== session?.name) {
      props.onRename(editedName().trim())
    }
    setIsEditingName(false)
  }

  const handleChangeModel = async () => {
    const session = props.session()
    if (!pendingModel() || !session?.session?.id) return
    setIsChangingModel(true)
    try {
      await props.onChangeModel(pendingModel(), pendingThinkingLevel())
      setShowModelMenu(false)
    } catch {
      // Model change failed - error handled by store
    } finally {
      setIsChangingModel(false)
    }
  }

  return (
    <div class="h-full flex flex-col bg-dark-bg">
      <div class="flex items-center justify-between px-2 py-1 bg-dark-surface2 border-b border-dark-border">
        <div class="flex items-center gap-2 min-w-0">
          <span
            class={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${statusColorClass()}`}
            title={statusText()}
          />
          <div class="min-w-0 flex-1">
            <Show
              when={isEditingName()}
              fallback={
                <button
                  class="text-sm font-medium text-dark-text hover:text-accent-primary truncate max-w-[150px] text-left"
                  onClick={() => setIsEditingName(true)}
                >
                  {sessionName()}
                </button>
              }
            >
              <input
                ref={nameInputRef}
                class="w-full bg-dark-bg border border-accent-primary rounded px-2 py-0.5 text-sm text-dark-text focus:outline-none"
                value={editedName()}
                onChange={(e) => setEditedName(e.currentTarget.value)}
                onBlur={handleNameSave}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleNameSave()
                  if (e.key === 'Escape') setIsEditingName(false)
                }}
              />
            </Show>
          </div>
        </div>

        <div class="flex items-center gap-0.5">
          <Show when={sessionObj()?.sessionUrl}>
            <a
              href={sessionObj()?.sessionUrl}
              target="_blank"
              rel="noopener noreferrer"
              class="p-1.5 rounded hover:bg-dark-surface3 text-dark-text-secondary hover:text-accent-primary transition-colors"
              title="Open in Pi"
            >
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </a>
          </Show>
          <button
            class="p-1.5 rounded hover:bg-dark-surface3 text-dark-text-secondary hover:text-dark-text transition-colors"
            title="Minimize"
            onClick={props.onMinimize}
          >
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 12H6" />
            </svg>
          </button>
          <button
            class="p-1.5 rounded hover:bg-dark-surface3 text-dark-text-secondary hover:text-accent-danger transition-colors"
            title="Close session"
            onClick={props.onClose}
          >
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      <div ref={messagesContainerRef} class="chat-messages flex-1 overflow-y-auto">
        <Show
          when={messages().length > 0}
          fallback={
            <div class="h-full flex flex-col items-center justify-center text-dark-text-muted px-4">
              <div class="text-center mb-4">
                <svg class="w-10 h-10 mx-auto mb-2 opacity-40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
                <p class="text-sm">Start a conversation with the planning assistant</p>
              </div>
              <div class="text-xs text-dark-text-muted/60 space-y-1 text-center">
                <p>Break down complex tasks into manageable pieces</p>
                <p>Get architecture and design suggestions</p>
                <p>Plan implementation steps before creating tasks</p>
              </div>
            </div>
          }
        >
          <For each={messages()}>
            {(message) => <ChatMessage message={message} />}
          </For>
        </Show>

        <Show when={isLoading() || isSending()}>
          <div class="flex items-center gap-2 text-dark-text-muted text-sm py-1 px-3">
            <svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            <span>
              {isReconnecting() ? 'Reconnecting session...' :
               isLoading() ? 'Starting session...' :
               'Waiting for response...'}
            </span>
          </div>
        </Show>

        <Show when={canReconnect() && !isReconnecting()}>
          <div class="mx-2 my-1 p-2 rounded bg-accent-warning/10 border border-accent-warning/30 text-accent-warning text-sm">
            <div class="flex items-start gap-2">
              <svg class="w-4 h-4 mt-0.5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
              </svg>
              <div class="flex-1">
                <p class="mb-2">This session is not currently active. Reconnect to continue chatting.</p>
                <button
                  class="btn btn-primary btn-xs"
                  disabled={isLoading() || isReconnecting()}
                  onClick={props.onReconnect}
                >
                  Reconnect
                </button>
              </div>
            </div>
          </div>
        </Show>

        <Show when={error() && !canReconnect()}>
          <div class="mx-2 my-1 p-2 rounded bg-accent-danger/10 border border-accent-danger/30 text-accent-danger text-sm">
            <div class="flex items-start gap-2">
              <svg class="w-4 h-4 mt-0.5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span>{error()}</span>
            </div>
          </div>
        </Show>
      </div>

      <div class="chat-input-container border-t border-dark-border">
        {/* Session loading indicator - shows when session is starting */}
        <Show when={isLoading() && !isReconnecting() && !error()}>
          <div class="px-3 py-2 bg-accent-warning/10 border-b border-accent-warning/30">
            <div class="flex items-center gap-2 text-accent-warning text-sm">
              <svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              <span class="font-medium">Starting planning session...</span>
            </div>
            <p class="text-xs text-accent-warning/70 mt-0.5 ml-6">
              Please wait while we connect to the AI. This may take a few moments.
            </p>
          </div>
        </Show>

        <div class="chat-toolbar flex items-center gap-2 px-2 py-1 border-b border-dark-border/50">
          <Show when={hasEnoughMessages()}>
            <button
              class="chat-tool-btn border-accent-primary/50 text-accent-primary"
              onClick={props.onCreateTasks}
            >
              <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
              </svg>
              Create Tasks
            </button>
          </Show>

          <div class="relative">
            <button
              class="chat-tool-btn"
              onClick={() => setShowModelMenu(!showModelMenu())}
              disabled={!sessionObj() || sessionObj()?.status !== 'active'}
            >
              <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
              Model
              <Show when={currentModel()}>
                <span class="ml-1 text-accent-primary">{currentModelLabel()}</span>
              </Show>
            </button>

            <Show when={showModelMenu()}>
              <div class="absolute bottom-full left-0 mb-1 w-72 bg-dark-surface border border-dark-border rounded-lg shadow-xl z-50 py-2">
                <div class="px-3 py-1 text-xs text-dark-text-muted border-b border-dark-border mb-2">
                  Change Model & Thinking Level
                </div>
                <div class="px-2 pb-2 space-y-2">
                  <div class="form-group">
                    <div class="label-row"><label>Model</label></div>
                    <input
                      type="text"
                      class="form-input"
                      value={pendingModel()}
                      onChange={(e) => setPendingModel(e.currentTarget.value)}
                      placeholder="Type model name..."
                    />
                  </div>
                  <div class="form-group">
                    <div class="label-row"><label>Thinking Level</label></div>
                    <select
                      class="form-select"
                      value={pendingThinkingLevel()}
                      onChange={(e) => setPendingThinkingLevel(e.currentTarget.value as 'default' | 'low' | 'medium' | 'high')}
                    >
                      <option value="default">Default</option>
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                    </select>
                  </div>
                </div>
                <div class="px-3 py-2 border-t border-dark-border flex justify-end">
                  <button
                    class="btn btn-primary btn-xs"
                    disabled={!pendingModel() || (pendingModel() === sessionObj()?.model && pendingThinkingLevel() === sessionObj()?.thinkingLevel) || isChangingModel()}
                    onClick={handleChangeModel}
                  >
                    Apply
                  </button>
                </div>
              </div>
            </Show>
          </div>

          <Show when={attachedContext().length > 0}>
            <button
              class="text-xs text-dark-text-muted hover:text-accent-danger flex items-center gap-1"
              onClick={() => setAttachedContext([])}
            >
              <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M6 18L18 6M6 6l12 12" />
              </svg>
              Clear
            </button>
          </Show>
        </div>

        <Show when={attachedContext().length > 0}>
          <div class="mb-1.5 flex flex-wrap gap-1 px-2 pt-1.5">
            <For each={attachedContext()}>
              {(ctx) => (
                <div class="px-2 py-1 text-xs bg-accent-primary/10 text-accent-primary border border-accent-primary/20 rounded flex items-center gap-1">
                  <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                  </svg>
                  <span class="truncate max-w-[120px]">{ctx.name}</span>
                </div>
              )}
            </For>
          </div>
        </Show>

        <div class="chat-input-box px-2 py-1">
          <textarea
            class="min-h-[96px] max-h-[250px] w-full bg-dark-surface border border-dark-border rounded-lg px-2 py-1.5 text-sm text-dark-text placeholder-dark-text-muted/50 focus:outline-none focus:border-accent-primary resize-none disabled:opacity-50 disabled:cursor-not-allowed"
            placeholder={isLoading() && !isReconnecting() ? "Waiting for session to start..." : "Type your message... (Shift+Enter to send)"}
            value={messageInput()}
            onChange={(e) => setMessageInput(e.currentTarget.value)}
            onKeyDown={handleKeyDown}
            disabled={isLoading() || isReconnecting() || !sessionObj()?.id}
          />
        </div>

        <div class="px-2 pb-1">
          <button
            class="chat-send-btn w-full"
            disabled={!messageInput().trim() || isSending() || !sessionObj()?.id || isLoading() || isReconnecting()}
            onClick={handleSend}
          >
            <span class="flex items-center justify-center gap-1">
              <Show when={isLoading() && !isReconnecting()} fallback={
                <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                </svg>
              }>
                <svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
              </Show>
              {isLoading() && !isReconnecting() ? 'Starting session...' : 'Send'}
            </span>
          </button>
        </div>

        <div class="px-2 pb-1 text-xs text-dark-text-muted flex items-center justify-between">
          <span>
            {isReconnecting() ? 'Reconnecting session...' :
             isSending() ? 'Sending...' :
             sessionObj()?.status === 'starting' ? 'Session starting...' :
             sessionObj()?.status === 'active' ? 'Ready' :
             sessionObj()?.status === 'failed' ? 'Session failed' :
             'Connect Pi to start chatting'}
          </span>
          <span class="text-dark-text-muted/50">Shift+Enter to send</span>
        </div>
      </div>

      <Show when={showModelMenu()}>
        <div class="fixed inset-0 z-40" onClick={() => setShowModelMenu(false)} />
      </Show>
    </div>
  )
}
