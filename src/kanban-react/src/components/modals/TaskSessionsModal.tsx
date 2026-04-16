import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { ModalWrapper } from '../common/ModalWrapper'
import { useTasksContext, useToastContext, useSessionUsageContext } from '@/contexts/AppContext'
import { useApi } from '@/hooks'
import type { Session, TaskRun, SessionMessage } from '@/types'

interface TaskSessionsModalProps {
  taskId: string
  onClose: () => void
}

interface SessionData {
  id: string
  session: Session | null
  messages: SessionMessage[]
  taskRun: TaskRun | null
  isLoading: boolean
  error: string | null
}

export function TaskSessionsModal({ taskId, onClose }: TaskSessionsModalProps) {
  const tasks = useTasksContext()
  const api = useApi()
  const toasts = useToastContext()
  const sessionUsage = useSessionUsageContext()

  const [taskRuns, setTaskRuns] = useState<TaskRun[]>([])
  const [sessions, setSessions] = useState<Map<string, SessionData>>(new Map())
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [showUsageDetails, setShowUsageDetails] = useState<Record<string, boolean>>({})

  const timelineRef = useRef<HTMLDivElement>(null)
  const sessionLoadTokens = useRef<Map<string, number>>(new Map())
  const task = tasks.getTaskById(taskId)

  const loadSessionMessages = useCallback(async (sessionId: string) => {
    const token = (sessionLoadTokens.current.get(sessionId) || 0) + 1
    sessionLoadTokens.current.set(sessionId, token)

    try {
      const messages = await api.getSessionMessages(sessionId, 1000)

      if (token !== sessionLoadTokens.current.get(sessionId)) return

      const sortedMessages = messages.sort((a, b) => {
        const ta = Number(a.timestamp || 0)
        const tb = Number(b.timestamp || 0)
        if (ta !== tb) return ta - tb
        return Number(a.id || 0) - Number(b.id || 0)
      })

      setSessions(prev => {
        const next = new Map(prev)
        const data = next.get(sessionId)
        if (data) {
          next.set(sessionId, {
            ...data,
            messages: sortedMessages,
            isLoading: false
          })
        }
        return next
      })
    } catch (e) {
      if (token !== sessionLoadTokens.current.get(sessionId)) return
      setSessions(prev => {
        const next = new Map(prev)
        const data = next.get(sessionId)
        if (data) {
          next.set(sessionId, {
            ...data,
            error: e instanceof Error ? e.message : String(e),
            isLoading: false
          })
        }
        return next
      })
    }
  }, [api])

  useEffect(() => {
    let cancelled = false
    const sessionIdsToCleanup: string[] = []

    const loadData = async () => {
      try {
        const [sessionsData, runsData] = await Promise.all([
          api.getTaskSessions(taskId),
          api.getTaskRuns(taskId)
        ])

        if (cancelled) return

        setTaskRuns(runsData)

        const sessionIds: string[] = []

        for (const session of sessionsData) {
          if (!sessionIds.includes(session.id)) sessionIds.push(session.id)
        }

        for (const run of runsData) {
          if (run.sessionId && !sessionIds.includes(run.sessionId)) {
            sessionIds.push(run.sessionId)
          }
        }

        const initialSessionsMap = new Map<string, SessionData>()

        for (const sessionId of sessionIds) {
          const sessionFromApi = sessionsData.find(s => s.id === sessionId)
          initialSessionsMap.set(sessionId, {
            id: sessionId,
            session: sessionFromApi || null,
            messages: [],
            taskRun: runsData.find(r => r.sessionId === sessionId) || null,
            isLoading: true,
            error: null
          })
          sessionUsage.startWatching(sessionId)
          sessionIdsToCleanup.push(sessionId)
        }
        
        setSessions(initialSessionsMap)

        if (sessionIds.length > 0) {
          setActiveSessionId(sessionIds[0])
        }

        for (const sessionId of sessionIds) {
          loadSessionMessages(sessionId)
        }
      } catch (e) {
        console.error('Failed to load task sessions:', e)
      }
    }

    loadData()

    return () => {
      cancelled = true
      sessionIdsToCleanup.forEach(id => sessionUsage.stopWatching(id))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, api, loadSessionMessages])

  useEffect(() => {
    if (timelineRef.current) {
      timelineRef.current.scrollTop = timelineRef.current.scrollHeight
    }
  }, [sessions, activeSessionId])

  useEffect(() => {
    if (activeSessionId) {
      sessionUsage.loadSessionUsage(activeSessionId)
    }
  }, [activeSessionId, sessionUsage])

  const sortedSessions = useMemo(() => {
    const result: SessionData[] = []
    const sessionsArray = Array.from(sessions.values())

    const directSession = sessionsArray.find(s => s.id === task?.sessionId)
    if (directSession) {
      result.push(directSession)
    }

    for (const session of sessionsArray) {
      if (session.id !== task?.sessionId) {
        result.push(session)
      }
    }

    return result
  }, [sessions, task?.sessionId])

  const activeSession = activeSessionId ? sessions.get(activeSessionId) : null

  const formatTimestamp = (ts: number) => ts > 0 ? new Date(ts * 1000).toLocaleTimeString() : '—'
  const formatJson = (value: unknown): string => {
    if (value === null || value === undefined) return ''
    if (typeof value === 'string') return value
    try {
      return JSON.stringify(value, null, 2)
    } catch {
      return String(value)
    }
  }

  const getSessionTabLabel = (sessionData: SessionData): string => {
    if (sessionData.taskRun) {
      const run = sessionData.taskRun
      return `${run.phase} (slot ${run.slotIndex + 1})`
    }
    if (sessionData.id === task?.sessionId) {
      return 'direct'
    }
    return sessionData.id.substring(0, 8)
  }

  const getSessionStatus = (sessionData: SessionData): string => {
    if (sessionData.isLoading) return 'loading'
    if (sessionData.error) return 'error'
    if (sessionData.session) return sessionData.session.status
    return 'unknown'
  }

  const getMessageText = (message: SessionMessage): string => {
    const content = message.contentJson
    if (!content || typeof content !== 'object') return ''
    if ('text' in content && typeof content.text === 'string' && content.text.trim()) return content.text
    if ('message' in content && typeof content.message === 'string' && content.message.trim()) return content.message
    if ('output' in content && typeof content.output === 'string' && content.output.trim()) return content.output
    if ('content' in content && typeof content.content === 'string' && content.content.trim()) return content.content
    if ('summary' in content && typeof content.summary === 'string' && content.summary.trim()) return content.summary
    return ''
  }

  const aggregatedMessages = useMemo(() => {
    const messages = activeSession?.messages || []
    const groups: {
      role: string
      messageType: string
      timestamp: number
      toolName?: string | null
      toolArgsJson?: unknown
      toolResultJson?: unknown
      text: string
      isError: boolean
      isThinking: boolean
      messages: SessionMessage[]
    }[] = []

    let currentGroup: typeof groups[0] | null = null

    for (const message of messages) {
      const isStreamingPart = message.messageType === 'message_part'
      const role = message.role || 'assistant'

      if (isStreamingPart && currentGroup && currentGroup.role === role) {
        currentGroup.messages.push(message)
        currentGroup.text += getMessageText(message)
      } else {
        if (currentGroup) groups.push(currentGroup)
        currentGroup = {
          role,
          messageType: isStreamingPart ? 'text' : message.messageType,
          timestamp: message.timestamp,
          toolName: message.toolName,
          toolArgsJson: message.toolArgsJson,
          toolResultJson: message.toolResultJson,
          text: getMessageText(message),
          isError: message.messageType === 'error' || message.messageType === 'session_error',
          isThinking: message.messageType === 'thinking',
          messages: [message],
        }
      }
    }

    if (currentGroup) groups.push(currentGroup)
    return groups
  }, [activeSession?.messages])

  const toggleUsageDetails = (id: string) => {
    setShowUsageDetails(prev => ({ ...prev, [id]: !prev[id] }))
  }

  return (
    <ModalWrapper title={task ? `${task.name} • Sessions` : 'Task Sessions'} onClose={onClose} size="xl">
      <div className="flex flex-col h-full min-h-[50vh]">
        {sortedSessions.length === 0 ? (
          <div className="text-dark-text-muted text-center py-8">
            No sessions found for this task.
          </div>
        ) : (
          <>
            <div className="flex gap-1 border-b border-dark-surface3 mb-3 overflow-x-auto shrink-0 pb-1">
              {sortedSessions.map(sessionData => {
                const status = getSessionStatus(sessionData)
                return (
                  <button
                    key={sessionData.id}
                    className={`px-4 py-2 text-sm border-b-2 transition-colors whitespace-nowrap ${
                      activeSessionId === sessionData.id
                        ? 'text-accent-primary border-accent-primary'
                        : 'text-dark-text-muted border-transparent hover:text-dark-text'
                    }`}
                    onClick={() => setActiveSessionId(sessionData.id)}
                  >
                    <span className="flex items-center gap-2">
                      {getSessionTabLabel(sessionData)}
                      <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                        status === 'running' || status === 'active'
                          ? 'bg-accent-primary/15 text-accent-primary'
                          : status === 'done' || status === 'completed'
                            ? 'bg-accent-success/15 text-accent-success'
                            : status === 'failed'
                              ? 'bg-accent-danger/15 text-accent-danger'
                              : 'bg-dark-surface text-dark-text-muted'
                      }`}>
                        {status}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>

            {activeSession && (
              <div className="flex-1 overflow-hidden flex flex-col min-h-0">
                {sessionUsage.getCachedUsage(activeSession.id) && (
                  <div className="mb-3 p-2 bg-dark-surface rounded-lg shrink-0">
                    <div
                      className="flex items-center gap-3 cursor-pointer hover:bg-dark-surface2 rounded p-1 transition-colors"
                      onClick={() => toggleUsageDetails(activeSession.id)}
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="text-lg">💰</span>
                        <span className="font-medium">{sessionUsage.formatCost(sessionUsage.getCachedUsage(activeSession.id)!.totalCost)}</span>
                      </div>
                      <div className="w-px h-4 bg-dark-surface3" />
                      <div className="flex items-center gap-1.5">
                        <span className="text-lg">🪙</span>
                        <span className="font-medium">{sessionUsage.formatTokenCount(sessionUsage.getCachedUsage(activeSession.id)!.totalTokens)} tokens</span>
                      </div>
                      <div className="ml-auto text-xs text-dark-text-muted">
                        {showUsageDetails[activeSession.id] ? '▼' : '▶'} Details
                      </div>
                    </div>

                    {showUsageDetails[activeSession.id] && (
                      <div className="mt-2 pt-2 border-t border-dark-surface3 text-xs space-y-1">
                        <div className="flex justify-between">
                          <span className="text-dark-text-muted">Prompt:</span>
                          <span>{sessionUsage.formatTokenCount(sessionUsage.getCachedUsage(activeSession.id)!.promptTokens)} tokens</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-dark-text-muted">Completion:</span>
                          <span>{sessionUsage.formatTokenCount(sessionUsage.getCachedUsage(activeSession.id)!.completionTokens)} tokens</span>
                        </div>
                        {sessionUsage.getCachedUsage(activeSession.id)!.cacheReadTokens > 0 && (
                          <div className="flex justify-between">
                            <span className="text-dark-text-muted">Cache (read):</span>
                            <span>{sessionUsage.formatTokenCount(sessionUsage.getCachedUsage(activeSession.id)!.cacheReadTokens)} tokens</span>
                          </div>
                        )}
                        {sessionUsage.getCachedUsage(activeSession.id)!.cacheWriteTokens > 0 && (
                          <div className="flex justify-between">
                            <span className="text-dark-text-muted">Cache (write):</span>
                            <span>{sessionUsage.formatTokenCount(sessionUsage.getCachedUsage(activeSession.id)!.cacheWriteTokens)} tokens</span>
                          </div>
                        )}
                        <div className="flex justify-between pt-1 border-t border-dark-surface3">
                          <span className="text-dark-text-muted">Total Tokens:</span>
                          <span className="font-medium">{sessionUsage.formatTokenCount(sessionUsage.getCachedUsage(activeSession.id)!.totalTokens)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-dark-text-muted">Total Cost:</span>
                          <span className="font-medium text-accent-primary">{sessionUsage.formatCost(sessionUsage.getCachedUsage(activeSession.id)!.totalCost)}</span>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {activeSession.session && (
                  <div className="flex flex-wrap gap-2 mb-3 shrink-0">
                    <span className="badge">id: {activeSession.session.id}</span>
                    <span className="badge">{activeSession.session.sessionKind}</span>
                    <span className="badge">status: {activeSession.session.status}</span>
                    <span className="badge">model: {activeSession.session.model || 'default'}</span>
                    {activeSession.session.thinkingLevel && activeSession.session.thinkingLevel !== 'default' && (
                      <span className="badge">thinking: {activeSession.session.thinkingLevel}</span>
                    )}
                    {activeSession.session.taskId && (
                      <span className="badge">task: {activeSession.session.taskId.substring(0, 8)}...</span>
                    )}
                    {activeSession.session.taskRunId && (
                      <span className="badge">task run: {activeSession.session.taskRunId}</span>
                    )}
                    {activeSession.taskRun?.phase && (
                      <span className="badge">phase: {activeSession.taskRun.phase}</span>
                    )}
                    {typeof activeSession.taskRun?.slotIndex === 'number' && (
                      <span className="badge">slot: {activeSession.taskRun.slotIndex + 1}</span>
                    )}
                    {typeof activeSession.taskRun?.attemptIndex === 'number' && (
                      <span className="badge">attempt: {activeSession.taskRun.attemptIndex + 1}</span>
                    )}
                    <span className="badge badge-cost">💰 {sessionUsage.formatCost(sessionUsage.getCachedUsage(activeSession.id)?.totalCost ?? 0)}</span>
                    <span className="badge">🪙 {sessionUsage.formatTokenCount(sessionUsage.getCachedUsage(activeSession.id)?.totalTokens ?? 0)} tokens</span>
                  </div>
                )}

                {activeSession.isLoading && !activeSession.session ? (
                  <div className="session-entry text-dark-text-muted shrink-0">Loading session…</div>
                ) : activeSession.error ? (
                  <div className="session-entry error shrink-0">{activeSession.error}</div>
                ) : (
                  <div ref={timelineRef} className="flex flex-col gap-2.5 overflow-y-auto pr-1 flex-1">
                    {aggregatedMessages.length === 0 ? (
                      <div className="session-entry text-dark-text-muted">No session messages yet.</div>
                    ) : (
                      aggregatedMessages.map((group, i) => (
                        <div key={i} className={`session-entry ${group.isError ? 'error' : ''} ${group.isThinking ? 'thinking' : ''}`}>
                          <div className="flex items-center flex-wrap gap-1.5 mb-1.5">
                            <span className="text-xs text-dark-text-muted mr-auto">
                              {formatTimestamp(group.timestamp)}
                            </span>
                            <span className={`session-role ${group.role}`}>
                              {group.role}
                            </span>
                            <span className="text-xs text-dark-text-muted border border-dark-surface3 rounded-full px-2 py-0.5">
                              {group.messageType}
                            </span>
                            {group.toolName && (
                              <span className="text-xs text-orange-400 border border-orange-500/45 rounded-full px-2 py-0.5">
                                {group.toolName}
                              </span>
                            )}
                          </div>
                          <div className={`text-xs leading-relaxed whitespace-pre-wrap break-words ${group.isThinking ? 'text-dark-text-muted italic' : 'text-dark-text'} ${group.isError ? 'text-red-400' : ''}`}>
                            {group.text || '(no text content)'}
                          </div>
                          {(group.toolArgsJson || group.toolResultJson) && (
                            <details className="mt-2 text-xs text-dark-text-muted">
                              <summary className="cursor-pointer">Tool payload</summary>
                              {group.toolArgsJson && (
                                <pre className="mt-1.5 bg-dark-surface2 border border-dark-surface3 rounded p-2 whitespace-pre-wrap break-words">
                                  args:{'\n'}{formatJson(group.toolArgsJson)}
                                </pre>
                              )}
                              {group.toolResultJson && (
                                <pre className="mt-1.5 bg-dark-surface2 border border-dark-surface3 rounded p-2 whitespace-pre-wrap break-words">
                                  result:{'\n'}{formatJson(group.toolResultJson)}
                                </pre>
                              )}
                            </details>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </ModalWrapper>
  )
}
