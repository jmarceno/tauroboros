/**
 * ChatContainer Component - Chat state container
 * Ported from React to SolidJS
 */

import { createSignal, createMemo, Show, For, createEffect, onMount, type Accessor } from 'solid-js'
import { createQuery, useQueryClient } from '@tanstack/solid-query'
import { ChatPanel } from './ChatPanel'
import { ModelPicker } from '@/components/common/ModelPicker'
import { ThinkingLevelSelect } from '@/components/common/ThinkingLevelSelect'
import { planningApi, runApiEffect } from '@/api'
import { uiStore } from '@/stores'
import type { ChatSession, ContextAttachment, createPlanningChatStore } from '@/stores/planningChatStore'
import type { PlanningSession } from '@/types'
import { formatLocalTime, formatCompactDateTime } from '@/utils/date'

const MIN_PANEL_WIDTH = 350
const DEFAULT_PANEL_WIDTH = 500

interface ChatContainerProps {
  planningChat: ReturnType<typeof createPlanningChatStore>
  options: () => { planModel?: string; planThinkingLevel?: string } | null
  loadOptions: () => Promise<void>
}

export function ChatContainer(props: ChatContainerProps) {
  const queryClient = useQueryClient()
  const [isResizing, setIsResizing] = createSignal(false)
  const [activeTab, setActiveTab] = createSignal<'chat' | 'sessions'>('chat')
  const [allSessions, setAllSessions] = createSignal<PlanningSession[]>([])
  const [isLoadingSessions, setIsLoadingSessions] = createSignal(false)
  const [showModelSelector, setShowModelSelector] = createSignal(false)
  const [selectedModel, setSelectedModel] = createSignal('')
  const [selectedThinkingLevel, setSelectedThinkingLevel] = createSignal<'default' | 'low' | 'medium' | 'high'>('default')
  const [modelError, setModelError] = createSignal<string | null>(null)

  let resizeStartX = 0
  let resizeStartWidth = 0

  onMount(() => {
    const savedWidth = localStorage.getItem('chatPanelWidth')
    if (savedWidth) {
      const width = parseInt(savedWidth, 10)
      if (width >= MIN_PANEL_WIDTH) {
        props.planningChat.setPanelWidth(width)
      }
    }
  })

  createEffect(() => {
    if (!isResizing()) return

    const handleMouseMove = (e: MouseEvent) => {
      const newWidth = window.innerWidth - e.clientX
      if (newWidth >= MIN_PANEL_WIDTH) {
        props.planningChat.setPanelWidth(newWidth)
      }
    }

    const handleMouseUp = () => {
      setIsResizing(false)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      localStorage.setItem('chatPanelWidth', props.planningChat.width().toString())
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  })

  const startResize = (e: MouseEvent) => {
    e.preventDefault()
    setIsResizing(true)
    document.body.style.cursor = 'ew-resize'
    document.body.style.userSelect = 'none'
  }

  const createNewChat = async () => {
    if (!props.options()) {
      await props.loadOptions()
    }
    setShowModelSelector(true)
    setModelError(null)
    const defaultModel = props.options()?.planModel?.trim() || ''
    const defaultThinkingLevel = props.options()?.planThinkingLevel || 'default'
    setSelectedModel(defaultModel)
    setSelectedThinkingLevel(defaultThinkingLevel as 'default' | 'low' | 'medium' | 'high')
  }

  const loadAllSessions = async () => {
    setIsLoadingSessions(true)
    try {
      const sessions = await runApiEffect(planningApi.getSessions())
      setAllSessions(sessions.sort((a, b) => b.createdAt - a.createdAt))
    } catch {
      uiStore.showToast('Failed to load planning sessions', 'error')
    } finally {
      setIsLoadingSessions(false)
    }
  }

  onMount(() => {
    loadAllSessions()
  })

  createEffect(() => {
    if (activeTab() === 'sessions') {
      loadAllSessions()
    }
  })

  const resumeSession = async (dbSession: PlanningSession) => {
    const existingSession = props.planningChat.sessions().find(
      s => s.session?.id === dbSession.id
    )

    if (existingSession) {
      props.planningChat.switchToSession(existingSession.id)
      setActiveTab('chat')
      return
    }

    const sessionId = `chat-${Date.now()}`
    const newSession: ChatSession = {
      id: sessionId,
      name: dbSession.id,
      session: dbSession,
      messages: [],
      isMinimized: false,
      isLoading: false,
      isSending: false,
      error: null,
    }

    try {
      const messages = await runApiEffect(planningApi.getSessionMessages(dbSession.id, 100))
      newSession.messages = messages
    } catch {
      uiStore.showToast('Failed to load session messages', 'error')
    }

    props.planningChat.addExistingSession(newSession)
    setActiveTab('chat')
  }

  const formatSessionDate = (timestamp: number) => {
    const date = new Date(timestamp * 1000)
    const now = new Date()
    const yesterday = new Date(now)
    yesterday.setDate(yesterday.getDate() - 1)

    if (date.toDateString() === now.toDateString()) {
      return `Today, ${formatLocalTime(timestamp)}`
    } else if (date.toDateString() === yesterday.toDateString()) {
      return `Yesterday, ${formatLocalTime(timestamp)}`
    } else {
      return formatCompactDateTime(timestamp)
    }
  }

  const getStatusClass = (status: string) => {
    switch (status) {
      case 'active': return 'bg-accent-success'
      case 'starting': return 'bg-accent-warning'
      case 'paused': return 'bg-accent-warning'
      case 'completed': return 'bg-dark-text-muted'
      case 'failed': return 'bg-accent-danger'
      default: return 'bg-dark-text-muted'
    }
  }

  const activeSessionsCount = () => allSessions().filter(s => s.status === 'active' || s.status === 'starting').length

  const confirmModelAndCreate = async () => {
    let model = selectedModel().trim()

    setModelError(null)

    if (!model) {
      setModelError('Please select a valid AI model')
      return
    }

    setShowModelSelector(false)
    setModelError(null)
    await props.planningChat.createNewSession(model, selectedThinkingLevel())
    setActiveTab('chat')
  }

  const handleModelSelectorClose = () => {
    setShowModelSelector(false)
    setModelError(null)
  }

  const getTabStatusClass = (session: ChatSession) => {
    switch (session.session?.status) {
      case 'active': return 'online'
      case 'starting': return 'typing'
      default: return 'offline'
    }
  }

  return (
    <Show
      when={props.planningChat.isOpen()}
      fallback={
        <button
          class="chat-toggle right-0"
          onClick={() => props.planningChat.openPanel()}
        >
          <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
          <span>Chat</span>
          <Show when={props.planningChat.sessions().length > 0}>
            <span class="chat-toggle-badge">
              {props.planningChat.sessions().length}
            </span>
          </Show>
        </button>
      }
    >
      <>
        <div
          class={`chat-panel open right-0 ${isResizing() ? 'resizing' : ''}`}
          style={{ width: `${props.planningChat.width()}px` }}
        >
          <div class="chat-resize-handle" onMouseDown={startResize} title="Drag to resize" />

          <div class="chat-tabs-container">
            <div class="chat-tabs-primary">
              <For each={props.planningChat.visibleSessions()}>
                {(session) => (
                  <button
                    class={`chat-session-tab ${props.planningChat.activeSessionId() === session.id ? 'active' : ''}`}
                    onClick={() => props.planningChat.switchToSession(session.id)}
                  >
                    <span class={`tab-status ${getTabStatusClass(session)}`} />
                    <span class="tab-name">{session.name}</span>
                    <span class="tab-close" onClick={(e) => { e.stopPropagation(); props.planningChat.closeSession(session.id) }}>
                      <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </span>
                  </button>
                )}
              </For>
            </div>

            <div class="chat-tabs-secondary">
              <div class="flex items-center gap-2">
                <button class="new-session-btn" onClick={createNewChat}>
                  <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M12 4v16m8-8H4" />
                  </svg>
                  New Session
                </button>
                <button
                  class={`new-session-btn ${activeTab() === 'chat' ? 'text-accent-primary' : ''}`}
                  onClick={() => setActiveTab('chat')}
                >
                  Chat
                </button>
                <button
                  class={`new-session-btn ${activeTab() === 'sessions' ? 'text-accent-primary' : ''}`}
                  onClick={() => setActiveTab('sessions')}
                >
                  History
                  <Show when={activeSessionsCount() > 0}>
                    <span class="px-1.5 py-0.5 text-xs bg-accent-success/20 text-accent-success rounded-full">
                      {activeSessionsCount()}
                    </span>
                  </Show>
                </button>
              </div>
              <div class="flex items-center gap-1">
                <button
                  class="chat-action-btn"
                  title="Edit planning assistant prompt"
                  onClick={() => uiStore.openModal('planningPrompt', {})}
                >
                  <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M12 1v6m0 6v6m4.22-10.22l4.24-4.24M6.34 17.66l-4.24 4.24M23 12h-6m-6 0H1m20.24 4.24l-4.24-4.24M6.34 6.34L2.1 2.1" />
                  </svg>
                </button>
                <button
                  class="chat-action-btn"
                  title="Close panel"
                  onClick={() => props.planningChat.closePanel()}
                >
                  <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
          </div>

          <Show when={activeTab() === 'chat'}>
            <div class="flex-1 overflow-hidden relative">
              <Show
                when={props.planningChat.activeSessionId()}
                fallback={
                  <div class="h-full flex flex-col items-center justify-center text-dark-text-muted p-4">
                    <svg class="w-12 h-12 mb-3 opacity-30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                    </svg>
                    <p class="text-sm text-center mb-4">No active chat sessions</p>
                    <button class="btn btn-primary btn-sm" onClick={createNewChat}>
                      Start New Chat
                    </button>
                  </div>
                }
              >
                {(sessionId) => {
                  const session = createMemo(() => props.planningChat.sessions().find(s => s.id === sessionId()))
                  return (
                    <ChatPanel
                      session={session}
                      onMinimize={() => props.planningChat.minimizeSession(sessionId())}
                      onClose={() => props.planningChat.closeSession(sessionId())}
                      onRename={(name) => props.planningChat.renameSession(sessionId(), name)}
                      onSendMessage={props.planningChat.sendMessage}
                      onReconnect={() => props.planningChat.reconnectSession(sessionId())}
                      onChangeModel={(model, thinkingLevel) => props.planningChat.setSessionModel(sessionId(), model, thinkingLevel)}
                      onCreateTasks={() => props.planningChat.createTasksFromChat(sessionId())}
                    />
                  )
                }}
              </Show>
            </div>
          </Show>

          <Show when={activeTab() === 'sessions'}>
            <div class="flex-1 overflow-y-auto bg-dark-bg">
              <Show
                when={!isLoadingSessions()}
                fallback={
                  <div class="flex items-center justify-center py-12">
                    <svg class="w-8 h-8 animate-spin text-accent-primary" fill="none" viewBox="0 0 24 24">
                      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                      <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                  </div>
                }
              >
                <Show
                  when={allSessions().length > 0}
                  fallback={
                    <div class="flex flex-col items-center justify-center py-12 text-dark-text-muted">
                      <svg class="w-12 h-12 mb-3 opacity-30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      <p class="text-sm">No previous planning sessions</p>
                      <p class="text-xs text-dark-text-muted/60 mt-1">Start a new chat to create a session</p>
                    </div>
                  }
                >
                  <div class="p-3 space-y-2">
                    <div class="flex items-center justify-between mb-3">
                      <h3 class="text-sm font-medium text-dark-text">
                        {allSessions().length} session{allSessions().length === 1 ? '' : 's'}
                      </h3>
                      <button
                        class="text-xs text-accent-primary hover:text-accent-primary/80 flex items-center gap-1"
                        onClick={loadAllSessions}
                      >
                        <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                        </svg>
                        Refresh
                      </button>
                    </div>

                    <For each={allSessions()}>
                      {(session) => (
                        <div
                          class="group flex items-start gap-3 p-3 rounded-lg bg-dark-surface border border-dark-border hover:border-accent-primary/30 transition-colors cursor-pointer"
                          onClick={() => resumeSession(session)}
                        >
                          <div class="flex-shrink-0 mt-0.5">
                            <div class={`w-3 h-3 rounded-full ${getStatusClass(session.status)}`} />
                          </div>
                          <div class="flex-1 min-w-0">
                            <div class="flex items-center gap-2 mb-1">
                              <span class="text-sm font-medium text-dark-text truncate">Session {session.id}</span>
                              <Show when={session.status === 'active' || session.status === 'starting'}>
                                <span class="px-1.5 py-0.5 text-xs bg-accent-success/20 text-accent-success rounded">
                                  Active
                                </span>
                              </Show>
                            </div>
                            <div class="text-xs text-dark-text-secondary space-y-0.5">
                              <p>{formatSessionDate(session.createdAt)}</p>
                              <Show when={session.model && session.model !== 'default'}>
                                <p class="text-dark-text-muted">Model: {session.model}</p>
                              </Show>
                            </div>
                          </div>
                          <div class="flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button class="p-1.5 rounded hover:bg-dark-surface3 text-dark-text-muted hover:text-accent-primary">
                              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M13 7l5 5m0 0l-5 5m5-5H6" />
                              </svg>
                            </button>
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </Show>
            </div>
          </Show>
        </div>

        <Show when={props.planningChat.minimizedSessions().length > 0}>
          <div
            class="minimized-dock"
            style={{ right: `${props.planningChat.width() + 20}px` }}
          >
            <For each={props.planningChat.minimizedSessions()}>
              {(session) => (
                <button
                  class="minimized-session"
                  onClick={() => props.planningChat.switchToSession(session.id)}
                >
                  <span class={`min-status ${getStatusClass(session.session?.status || '')}`} />
                  <span class="min-name">{session.name}</span>
                  <Show when={session.messages.length > 0}>
                    <span class="min-badge">{session.messages.length}</span>
                  </Show>
                </button>
              )}
            </For>
          </div>
        </Show>

        <Show when={showModelSelector()}>
          <div
            class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
            onClick={(e) => { if (e.target === e.currentTarget) handleModelSelectorClose() }}
          >
            <div class="bg-dark-surface border border-dark-border rounded-lg shadow-xl w-[400px] max-w-[90vw] p-4">
              <h3 class="text-lg font-medium text-dark-text mb-2">New Planning Chat</h3>
              <p class="text-sm text-dark-text-muted mb-4">
                Select the AI model for this planning session.
              </p>

              <ModelPicker
                modelValue={selectedModel()}
                label="Model"
                help="The AI model to use for this planning session"
                onUpdate={(value) => {
                  setSelectedModel(value)
                  setModelError(null)
                }}
              />

              <ThinkingLevelSelect
                modelValue={selectedThinkingLevel()}
                label="Thinking Level"
                help="Controls how much reasoning effort the agent should spend"
                onUpdate={setSelectedThinkingLevel}
              />

              <Show when={modelError()}>
                <div class="mt-3 p-2 rounded bg-accent-danger/10 border border-accent-danger/30 text-accent-danger text-sm flex items-center gap-2">
                  <svg class="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  {modelError()}
                </div>
              </Show>

              <div class="flex items-center justify-end gap-2 mt-4">
                <button class="btn btn-sm" onClick={handleModelSelectorClose}>
                  Cancel
                </button>
                <button
                  class="btn btn-primary btn-sm"
                  disabled={!selectedModel().trim()}
                  onClick={confirmModelAndCreate}
                >
                  Start Chat
                </button>
              </div>
            </div>
          </div>
        </Show>
      </>
    </Show>
  )
}
