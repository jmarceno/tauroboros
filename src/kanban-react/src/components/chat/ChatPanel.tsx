import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import type { ChatSession, ContextAttachment } from '@/hooks/usePlanningChat'
import type { SessionMessage } from '@/types'
import { ChatMessage } from './ChatMessage'

interface ChatPanelProps {
  session: ChatSession
  onMinimize: () => void
  onClose: () => void
  onRename: (name: string) => void
  onSendMessage: (sessionId: string, content: string, attachments?: ContextAttachment[]) => Promise<void>
  onReconnect: () => Promise<void>
  onChangeModel: (model: string, thinkingLevel?: string) => Promise<void>
  onCreateTasks: () => Promise<void>
}

export function ChatPanel({
  session,
  onMinimize,
  onClose,
  onRename,
  onSendMessage,
  onReconnect,
  onChangeModel,
  onCreateTasks,
}: ChatPanelProps) {
  const [messageInput, setMessageInput] = useState('')
  const [attachedContext, setAttachedContext] = useState<ContextAttachment[]>([])
  const [isEditingName, setIsEditingName] = useState(false)
  const [editedName, setEditedName] = useState(session.name)
  const [showModelMenu, setShowModelMenu] = useState(false)
  const [pendingModel, setPendingModel] = useState(session.session?.model || '')
  const [pendingThinkingLevel, setPendingThinkingLevel] = useState<'default' | 'low' | 'medium' | 'high'>(session.session?.thinkingLevel || 'default')
  const [isChangingModel, setIsChangingModel] = useState(false)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)

  const currentModel = session.session?.model
  const currentModelLabel = useMemo(() =>
    currentModel?.split('/').pop() || currentModel || ''
  , [currentModel])

  const canReconnect = useMemo(() =>
    session.session && (session.session.status !== 'active' || session.error?.includes('not active'))
  , [session.session, session.error])

  const hasEnoughMessages = useMemo(() =>
    session.messages.length > 2
  , [session.messages.length])

  // Memoize computed status values
  const statusColorClass = useMemo(() => {
    const status = session.session?.status
    switch (status) {
      case 'active': return 'bg-accent-success'
      case 'starting': return 'bg-accent-warning animate-pulse'
      case 'paused': return 'bg-accent-warning'
      case 'completed': return 'bg-dark-text-muted'
      case 'failed': return 'bg-accent-danger'
      default: return 'bg-dark-text-muted'
    }
  }, [session.session?.status])

  const statusText = useMemo(() => {
    const status = session.session?.status
    switch (status) {
      case 'active': return 'Active'
      case 'starting': return 'Starting...'
      case 'paused': return 'Paused'
      case 'completed': return 'Completed'
      case 'failed': return 'Failed'
      default: return 'Initializing'
    }
  }, [session.session?.status])

  useEffect(() => {
    if (messagesContainerRef.current) {
      messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight
    }
  }, [session.messages.length])

  useEffect(() => {
    if (isEditingName && nameInputRef.current) {
      nameInputRef.current.focus()
      nameInputRef.current.select()
    }
  }, [isEditingName])

  useEffect(() => {
    setEditedName(session.name)
  }, [session.name])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      if (messageInput.trim() && !session.isSending && session.session?.id && session.session?.status === 'active') {
        handleSend()
      }
    }
  }, [messageInput, session.isSending, session.session?.id, session.session?.status])

  const handleSend = useCallback(async () => {
    if (!messageInput.trim() || session.isSending) return
    if (!session.session?.id) return

    const content = messageInput.trim()
    const attachments = [...attachedContext]

    setMessageInput('')
    setAttachedContext([])

    try {
      await onSendMessage(session.id, content, attachments)
      if (messagesContainerRef.current) {
        messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight
      }
    } catch (e) {
      console.error('Failed to send message:', e)
    }
  }, [messageInput, session.isSending, session.session?.id, session.id, attachedContext, onSendMessage])

  const handleNameSave = useCallback(() => {
    if (editedName.trim() && editedName !== session.name) {
      onRename(editedName.trim())
    }
    setIsEditingName(false)
  }, [editedName, session.name, onRename])

  const handleChangeModel = useCallback(async () => {
    if (!pendingModel || !session.session?.id) return
    setIsChangingModel(true)
    try {
      await onChangeModel(pendingModel, pendingThinkingLevel)
      setShowModelMenu(false)
    } catch (e) {
      console.error('Failed to change model:', e)
    } finally {
      setIsChangingModel(false)
    }
  }, [pendingModel, session.session?.id, pendingThinkingLevel, onChangeModel])

  return (
    <div className="h-full flex flex-col bg-dark-bg">
      <div className="flex items-center justify-between px-2 py-1 bg-dark-surface2 border-b border-dark-border">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${statusColorClass}`}
            title={statusText}
          />
          <div className="min-w-0 flex-1">
            {isEditingName ? (
              <input
                ref={nameInputRef}
                className="w-full bg-dark-bg border border-accent-primary rounded px-2 py-0.5 text-sm text-dark-text focus:outline-none"
                value={editedName}
                onChange={(e) => setEditedName(e.target.value)}
                onBlur={handleNameSave}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleNameSave()
                  if (e.key === 'Escape') setIsEditingName(false)
                }}
              />
            ) : (
              <button
                className="text-sm font-medium text-dark-text hover:text-accent-primary truncate max-w-[150px] text-left"
                onClick={() => setIsEditingName(true)}
              >
                {session.name}
              </button>
            )}
          </div>
        </div>

        <div className="flex items-center gap-0.5">
          {session.session?.sessionUrl && (
            <a
              href={session.session.sessionUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="p-1.5 rounded hover:bg-dark-surface3 text-dark-text-secondary hover:text-accent-primary transition-colors"
              title="Open in Pi"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </a>
          )}
          <button
            className="p-1.5 rounded hover:bg-dark-surface3 text-dark-text-secondary hover:text-dark-text transition-colors"
            title="Minimize"
            onClick={onMinimize}
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 12H6" />
            </svg>
          </button>
          <button
            className="p-1.5 rounded hover:bg-dark-surface3 text-dark-text-secondary hover:text-accent-danger transition-colors"
            title="Close session"
            onClick={onClose}
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      <div ref={messagesContainerRef} className="chat-messages flex-1 overflow-y-auto">
        {session.messages.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center text-dark-text-muted px-4">
            <div className="text-center mb-4">
              <svg className="w-10 h-10 mx-auto mb-2 opacity-40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
              </svg>
              <p className="text-sm">Start a conversation with the planning assistant</p>
            </div>
            <div className="text-xs text-dark-text-muted/60 space-y-1 text-center">
              <p>Break down complex tasks into manageable pieces</p>
              <p>Get architecture and design suggestions</p>
              <p>Plan implementation steps before creating tasks</p>
            </div>
          </div>
        )}

        {session.messages.map((message: SessionMessage, index: number) => (
          <ChatMessage key={message.id || index} message={message} />
        ))}

        {(session.isLoading || session.isSending || session.isReconnecting) && (
          <div className="flex items-center gap-2 text-dark-text-muted text-sm py-1 px-3">
            <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            <span>
              {session.isReconnecting ? 'Reconnecting session...' :
               session.isLoading ? 'Starting session...' :
               'Waiting for response...'}
            </span>
          </div>
        )}

        {canReconnect && !session.isReconnecting && (
          <div className="mx-2 my-1 p-2 rounded bg-accent-warning/10 border border-accent-warning/30 text-accent-warning text-sm">
            <div className="flex items-start gap-2">
              <svg className="w-4 h-4 mt-0.5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
              </svg>
              <div className="flex-1">
                <p className="mb-2">This session is not currently active. Reconnect to continue chatting.</p>
                <button
                  className="btn btn-primary btn-xs"
                  disabled={session.isLoading || session.isReconnecting}
                  onClick={onReconnect}
                >
                  Reconnect
                </button>
              </div>
            </div>
          </div>
        )}

        {session.error && !canReconnect && (
          <div className="mx-2 my-1 p-2 rounded bg-accent-danger/10 border border-accent-danger/30 text-accent-danger text-sm">
            <div className="flex items-start gap-2">
              <svg className="w-4 h-4 mt-0.5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span>{session.error}</span>
            </div>
          </div>
        )}
      </div>

      <div className="chat-input-container border-t border-dark-border">
        <div className="chat-toolbar flex items-center gap-2 px-2 py-1 border-b border-dark-border/50">
          {hasEnoughMessages && (
            <button
              className="chat-tool-btn border-accent-primary/50 text-accent-primary"
              onClick={onCreateTasks}
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
              </svg>
              Create Tasks
            </button>
          )}

          <div className="relative">
            <button
              className="chat-tool-btn"
              onClick={() => setShowModelMenu(!showModelMenu)}
              disabled={!session.session || session.session.status !== 'active'}
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
              Model
              {currentModel && <span className="ml-1 text-accent-primary">{currentModelLabel}</span>}
            </button>

            {showModelMenu && (
              <div className="absolute bottom-full left-0 mb-1 w-72 bg-dark-surface border border-dark-border rounded-lg shadow-xl z-50 py-2">
                <div className="px-3 py-1 text-xs text-dark-text-muted border-b border-dark-border mb-2">
                  Change Model & Thinking Level
                </div>
                <div className="px-2 pb-2 space-y-2">
                  <div className="form-group">
                    <div className="label-row"><label>Model</label></div>
                    <input
                      type="text"
                      className="form-input"
                      value={pendingModel}
                      onChange={(e) => setPendingModel(e.target.value)}
                      placeholder="Type model name..."
                    />
                  </div>
                  <div className="form-group">
                    <div className="label-row"><label>Thinking Level</label></div>
                    <select
                      className="form-select"
                      value={pendingThinkingLevel}
                      onChange={(e) => setPendingThinkingLevel(e.target.value as 'default' | 'low' | 'medium' | 'high')}
                    >
                      <option value="default">Default</option>
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                    </select>
                  </div>
                </div>
                <div className="px-3 py-2 border-t border-dark-border flex justify-end">
                  <button
                    className="btn btn-primary btn-xs"
                    disabled={!pendingModel || (pendingModel === session.session?.model && pendingThinkingLevel === session.session?.thinkingLevel) || isChangingModel}
                    onClick={handleChangeModel}
                  >
                    Apply
                  </button>
                </div>
              </div>
            )}
          </div>

          {attachedContext.length > 0 && (
            <button
              className="text-xs text-dark-text-muted hover:text-accent-danger flex items-center gap-1"
              onClick={() => setAttachedContext([])}
            >
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M6 18L18 6M6 6l12 12" />
              </svg>
              Clear
            </button>
          )}
        </div>

        {attachedContext.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1 px-2 pt-1.5">
            {attachedContext.map((ctx, idx) => (
              <div
                key={idx}
                className="px-2 py-1 text-xs bg-accent-primary/10 text-accent-primary border border-accent-primary/20 rounded flex items-center gap-1"
              >
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                </svg>
                <span className="truncate max-w-[120px]">{ctx.name}</span>
              </div>
            ))}
          </div>
        )}

        <div className="chat-input-box px-2 py-1">
          <textarea
            className="min-h-[96px] max-h-[250px] w-full bg-dark-surface border border-dark-border rounded-lg px-2 py-1.5 text-sm text-dark-text placeholder-dark-text-muted/50 focus:outline-none focus:border-accent-primary resize-none"
            placeholder="Type your message... (Shift+Enter to send)"
            value={messageInput}
            onChange={(e) => setMessageInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={session.isLoading || session.isReconnecting || !session.session?.id}
          />
        </div>

        <div className="px-2 pb-1">
          <button
            className="chat-send-btn w-full"
            disabled={!messageInput.trim() || session.isSending || !session.session?.id || session.isLoading || session.isReconnecting}
            onClick={handleSend}
          >
            <span className="flex items-center justify-center gap-1">
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
              </svg>
              Send
            </span>
          </button>
        </div>

        <div className="px-2 pb-1 text-xs text-dark-text-muted flex items-center justify-between">
          <span>
            {session.isReconnecting ? 'Reconnecting session...' :
             session.isSending ? 'Sending...' :
             session.session?.status === 'starting' ? 'Session starting...' :
             session.session?.status === 'active' ? 'Ready' :
             session.session?.status === 'failed' ? 'Session failed' :
             'Connect Pi to start chatting'}
          </span>
          <span className="text-dark-text-muted/50">Shift+Enter to send</span>
        </div>
      </div>

      {showModelMenu && (
        <div className="fixed inset-0 z-40" onClick={() => setShowModelMenu(false)} />
      )}
    </div>
  )
}
