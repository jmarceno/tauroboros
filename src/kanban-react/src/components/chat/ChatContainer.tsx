import { useState, useEffect, useCallback, useRef } from 'react'
import type { ChatSession, ContextAttachment } from '@/hooks/usePlanningChat'
import type { PlanningSession, ThinkingLevel } from '@/types'
import { usePlanningChat } from '@/hooks/usePlanningChat'
import { useApi } from '@/hooks/useApi'
import { useOptions } from '@/hooks/useOptions'
import { useModelSearch } from '@/hooks/useModelSearch'
import { ChatPanel } from './ChatPanel'
import { ModelPicker } from '../common/ModelPicker'
import { ThinkingLevelSelect } from '../common/ThinkingLevelSelect'

const MIN_PANEL_WIDTH = 350
const DEFAULT_PANEL_WIDTH = 500

export function ChatContainer() {
  const planningChat = usePlanningChat()
  const api = useApi()
  const options = useOptions()
  const modelSearch = useModelSearch()

  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH)
  const [isResizing, setIsResizing] = useState(false)
  const [activeTab, setActiveTab] = useState<'chat' | 'sessions'>('chat')
  const [allSessions, setAllSessions] = useState<PlanningSession[]>([])
  const [isLoadingSessions, setIsLoadingSessions] = useState(false)
  const [showModelSelector, setShowModelSelector] = useState(false)
  const [selectedModel, setSelectedModel] = useState('')
  const [selectedThinkingLevel, setSelectedThinkingLevel] = useState<'default' | 'low' | 'medium' | 'high'>('default')

  const resizeStartX = useRef(0)
  const resizeStartWidth = useRef(0)

  const openModal = useCallback((name: string, data?: Record<string, unknown>) => {
    console.warn('openModal not provided, planning prompt editor will not work:', name, data)
  }, [])

  useEffect(() => {
    const savedWidth = localStorage.getItem('chatPanelWidth')
    if (savedWidth) {
      const width = parseInt(savedWidth, 10)
      if (width >= MIN_PANEL_WIDTH) {
        setPanelWidth(width)
      }
    }
  }, [])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return
      const newWidth = window.innerWidth - e.clientX
      if (newWidth >= MIN_PANEL_WIDTH) {
        setPanelWidth(newWidth)
      }
    }

    const handleMouseUp = () => {
      if (isResizing) {
        setIsResizing(false)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        localStorage.setItem('chatPanelWidth', panelWidth.toString())
      }
    }

    if (isResizing) {
      window.addEventListener('mousemove', handleMouseMove)
      window.addEventListener('mouseup', handleMouseUp)
    }

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizing, panelWidth])

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    setIsResizing(true)
    document.body.style.cursor = 'ew-resize'
    document.body.style.userSelect = 'none'
  }

  const createNewChat = async () => {
    if (!options.options) {
      await options.loadOptions()
    }
    setShowModelSelector(true)
    const defaultModel = options.options?.planModel?.trim() || ''
    const defaultThinkingLevel = options.options?.planThinkingLevel || 'default'
    setSelectedModel(defaultModel)
    setSelectedThinkingLevel(defaultThinkingLevel)
  }

  const loadAllSessions = async () => {
    setIsLoadingSessions(true)
    try {
      const sessions = await api.getPlanningSessions()
      setAllSessions(sessions.sort((a, b) => b.createdAt - a.createdAt))
    } catch (e) {
      console.error('Failed to load planning sessions:', e)
    } finally {
      setIsLoadingSessions(false)
    }
  }

  useEffect(() => {
    loadAllSessions()
  }, [])

  useEffect(() => {
    if (activeTab === 'sessions') {
      loadAllSessions()
    }
  }, [activeTab])

  const resumeSession = async (dbSession: PlanningSession) => {
    const existingSession = planningChat.sessions.find(
      s => s.session?.id === dbSession.id
    )

    if (existingSession) {
      planningChat.switchToSession(existingSession.id)
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
      const messages = await api.getPlanningSessionMessages(dbSession.id, 100)
      newSession.messages = messages
    } catch (e) {
      console.error('Failed to load session messages:', e)
    }

    planningChat.sessions.push(newSession)
    planningChat.activeSessionId = sessionId
    setActiveTab('chat')
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

  const activeSessionsCount = allSessions.filter(s => s.status === 'active' || s.status === 'starting').length

  const confirmModelAndCreate = async () => {
    let model = selectedModel
    if (!model) {
      const normalized = modelSearch.normalizeValue(selectedModel)
      if (!normalized) return
      model = normalized
    }

    setShowModelSelector(false)
    await planningChat.createNewSession(model, selectedThinkingLevel)
    setActiveTab('chat')
  }

  const getTabStatusClass = (session: ChatSession) => {
    switch (session.session?.status) {
      case 'active': return 'online'
      case 'starting': return 'typing'
      default: return 'offline'
    }
  }

  const handleSendMessage = async (sessionId: string, content: string, attachments?: ContextAttachment[]) => {
    await planningChat.sendMessage(sessionId, content, attachments)
  }

  const handleReconnect = async (sessionId: string) => {
    await planningChat.reconnectSession(sessionId)
  }

  const handleChangeModel = async (sessionId: string, model: string, thinkingLevel?: string) => {
    await planningChat.setSessionModel(sessionId, model, thinkingLevel)
  }

  const handleCreateTasks = async (sessionId: string) => {
    await planningChat.createTasksFromChat(sessionId)
  }

  if (!planningChat.isOpen) {
    return (
      <button
        className="chat-toggle"
        style={{ right: '0' }}
        onClick={() => planningChat.openPanel()}
      >
        <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
        </svg>
        <span>Chat</span>
        {planningChat.sessions.length > 0 && (
          <span className="chat-toggle-badge">
            {planningChat.sessions.length}
          </span>
        )}
      </button>
    )
  }

  return (
    <>
      <div
        className={`chat-panel open ${isResizing ? 'resizing' : ''}`}
        style={{ width: `${panelWidth}px`, right: '0' }}
      >
        <div className="chat-resize-handle" onMouseDown={startResize} title="Drag to resize" />

        <div className="chat-tabs-container">
          <div className="chat-tabs-primary">
            {planningChat.visibleSessions.map(session => (
              <button
                key={session.id}
                className={`chat-session-tab ${planningChat.activeSessionId === session.id ? 'active' : ''}`}
                onClick={() => planningChat.switchToSession(session.id)}
              >
                <span className={`tab-status ${getTabStatusClass(session)}`} />
                <span className="tab-name">{session.name}</span>
                <span className="tab-close" onClick={(e) => { e.stopPropagation(); planningChat.closeSession(session.id) }}>
                  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </span>
              </button>
            ))}
          </div>

          <div className="chat-tabs-secondary">
            <div className="flex items-center gap-2">
              <button className="new-session-btn" onClick={createNewChat}>
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 4v16m8-8H4" />
                </svg>
                New Session
              </button>
              <button
                className={`new-session-btn ${activeTab === 'chat' ? 'text-accent-primary' : ''}`}
                onClick={() => setActiveTab('chat')}
              >
                Chat
              </button>
              <button
                className={`new-session-btn ${activeTab === 'sessions' ? 'text-accent-primary' : ''}`}
                onClick={() => setActiveTab('sessions')}
              >
                History
                {activeSessionsCount > 0 && (
                  <span className="px-1.5 py-0.5 text-xs bg-accent-success/20 text-accent-success rounded-full">
                    {activeSessionsCount}
                  </span>
                )}
              </button>
            </div>
            <div className="flex items-center gap-1">
              <button
                className="chat-action-btn"
                title="Edit planning assistant prompt"
                onClick={() => openModal('planningPrompt')}
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M12 1v6m0 6v6m4.22-10.22l4.24-4.24M6.34 17.66l-4.24 4.24M23 12h-6m-6 0H1m20.24 4.24l-4.24-4.24M6.34 6.34L2.1 2.1" />
                </svg>
              </button>
              <button
                className="chat-action-btn"
                title="Close panel"
                onClick={() => planningChat.closePanel()}
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        </div>

        {activeTab === 'chat' && (
          <div className="flex-1 overflow-hidden relative">
            {planningChat.activeSession ? (
              <ChatPanel
                session={planningChat.activeSession}
                onMinimize={() => planningChat.minimizeSession(planningChat.activeSession!.id)}
                onClose={() => planningChat.closeSession(planningChat.activeSession!.id)}
                onRename={(name) => planningChat.renameSession(planningChat.activeSession!.id, name)}
                onSendMessage={handleSendMessage}
                onReconnect={() => handleReconnect(planningChat.activeSession!.id)}
                onChangeModel={(model, thinkingLevel) => handleChangeModel(planningChat.activeSession!.id, model, thinkingLevel)}
                onCreateTasks={() => handleCreateTasks(planningChat.activeSession!.id)}
              />
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-dark-text-muted p-4">
                <svg className="w-12 h-12 mb-3 opacity-30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
                <p className="text-sm text-center mb-4">No active chat sessions</p>
                <button className="btn btn-primary btn-sm" onClick={createNewChat}>
                  Start New Chat
                </button>
              </div>
            )}
          </div>
        )}

        {activeTab === 'sessions' && (
          <div className="flex-1 overflow-y-auto bg-dark-bg">
            {isLoadingSessions ? (
              <div className="flex items-center justify-center py-12">
                <svg className="w-8 h-8 animate-spin text-accent-primary" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
              </div>
            ) : allSessions.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-dark-text-muted">
                <svg className="w-12 h-12 mb-3 opacity-30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <p className="text-sm">No previous planning sessions</p>
                <p className="text-xs text-dark-text-muted/60 mt-1">Start a new chat to create a session</p>
              </div>
            ) : (
              <div className="p-3 space-y-2">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-medium text-dark-text">
                    {allSessions.length} session{allSessions.length === 1 ? '' : 's'}
                  </h3>
                  <button
                    className="text-xs text-accent-primary hover:text-accent-primary/80 flex items-center gap-1"
                    onClick={loadAllSessions}
                  >
                    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    Refresh
                  </button>
                </div>

                {allSessions.map(session => (
                  <div
                    key={session.id}
                    className="group flex items-start gap-3 p-3 rounded-lg bg-dark-surface border border-dark-border hover:border-accent-primary/30 transition-colors cursor-pointer"
                    onClick={() => resumeSession(session)}
                  >
                    <div className="flex-shrink-0 mt-0.5">
                      <div className={`w-3 h-3 rounded-full ${getStatusClass(session.status)}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-sm font-medium text-dark-text truncate">Session {session.id}</span>
                        {session.status === 'active' || session.status === 'starting' ? (
                          <span className="px-1.5 py-0.5 text-xs bg-accent-success/20 text-accent-success rounded">
                            Active
                          </span>
                        ) : null}
                      </div>
                      <div className="text-xs text-dark-text-secondary space-y-0.5">
                        <p>{formatSessionDate(session.createdAt)}</p>
                        {session.model && session.model !== 'default' && (
                          <p className="text-dark-text-muted">Model: {session.model}</p>
                        )}
                      </div>
                    </div>
                    <div className="flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button className="p-1.5 rounded hover:bg-dark-surface3 text-dark-text-muted hover:text-accent-primary">
                        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M13 7l5 5m0 0l-5 5m5-5H6" />
                        </svg>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {planningChat.minimizedSessions.length > 0 && (
        <div
          className="minimized-dock"
          style={{ right: `${panelWidth + 20}px` }}
        >
          {planningChat.minimizedSessions.map(session => (
            <button
              key={session.id}
              className="minimized-session"
              onClick={() => planningChat.switchToSession(session.id)}
            >
              <span className={`min-status ${getStatusClass(session.session?.status || '')}`} />
              <span className="min-name">{session.name}</span>
              {session.messages.length > 0 && (
                <span className="min-badge">{session.messages.length}</span>
              )}
            </button>
          ))}
        </div>
      )}

      {showModelSelector && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={(e) => { if (e.target === e.currentTarget) setShowModelSelector(false) }}
        >
          <div className="bg-dark-surface border border-dark-border rounded-lg shadow-xl w-[400px] max-w-[90vw] p-4">
            <h3 className="text-lg font-medium text-dark-text mb-2">New Planning Chat</h3>
            <p className="text-sm text-dark-text-muted mb-4">
              Select the AI model for this planning session.
            </p>

            <ModelPicker
              modelValue={selectedModel}
              label="Model"
              help="The AI model to use for this planning session"
              onUpdate={setSelectedModel}
            />

            <ThinkingLevelSelect
              modelValue={selectedThinkingLevel}
              label="Thinking Level"
              help="Controls how much reasoning effort the agent should spend"
              onUpdate={setSelectedThinkingLevel}
            />

            <div className="flex items-center justify-end gap-2 mt-4">
              <button className="btn btn-sm" onClick={() => setShowModelSelector(false)}>
                Cancel
              </button>
              <button
                className="btn btn-primary btn-sm"
                disabled={!selectedModel}
                onClick={confirmModelAndCreate}
              >
                Start Chat
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}