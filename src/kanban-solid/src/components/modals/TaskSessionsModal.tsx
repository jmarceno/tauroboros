/**
 * TaskSessionsModal Component - Task sessions viewer
 * Ported from React to SolidJS
 */

import { createSignal, createEffect, Show, For, createMemo } from 'solid-js'
import { createQuery } from '@tanstack/solid-query'
import { ModalWrapper } from '@/components/common/ModalWrapper'
import { tasksApi, sessionsApi } from '@/api'
import { formatLocalTime } from '@/utils/date'
import type { Task, Session, TaskRun, SessionMessage } from '@/types'

interface TaskSessionsModalProps {
  task?: Task
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

export function TaskSessionsModal(props: TaskSessionsModalProps) {
  const [sessions, setSessions] = createSignal<Map<string, SessionData>>(new Map())
  const [activeSessionId, setActiveSessionId] = createSignal<string | null>(null)
  const [showUsageDetails, setShowUsageDetails] = createSignal<Record<string, boolean>>({})

  const taskId = () => props.task?.id

  const taskQuery = createQuery(() => ({
    queryKey: ['tasks', taskId()],
    queryFn: () => taskId() ? tasksApi.getById(taskId()!) : Promise.reject('No task ID'),
    staleTime: 5000,
    enabled: !!taskId(),
  }))

  const sessionsQuery = createQuery(() => ({
    queryKey: ['tasks', taskId(), 'sessions'],
    queryFn: () => taskId() ? tasksApi.getTaskSessions(taskId()!) : Promise.reject('No task ID'),
    staleTime: 5000,
    enabled: !!taskId(),
  }))

  const runsQuery = createQuery(() => ({
    queryKey: ['tasks', taskId(), 'runs'],
    queryFn: () => taskId() ? tasksApi.getTaskRuns(taskId()!) : Promise.reject('No task ID'),
    staleTime: 5000,
    enabled: !!taskId(),
  }))

  // Load session messages
  createEffect(() => {
    const sessionsData = sessionsQuery.data
    const runsData = runsQuery.data
    if (!sessionsData || !runsData) return

    const sessionIds = sessionsData.map(s => s.id)
    const newSessions = new Map<string, SessionData>()

    for (const session of sessionsData) {
      newSessions.set(session.id, {
        id: session.id,
        session: session,
        messages: [],
        taskRun: runsData.find(r => r.sessionId === session.id) || null,
        isLoading: true,
        error: null,
      })

      // Load messages
      sessionsApi.getMessages(session.id, 1000).then(messages => {
        setSessions(prev => {
          const next = new Map(prev)
          const data = next.get(session.id)
          if (data) {
            next.set(session.id, { ...data, messages, isLoading: false })
          }
          return next
        })
      }).catch(e => {
        setSessions(prev => {
          const next = new Map(prev)
          const data = next.get(session.id)
          if (data) {
            next.set(session.id, { ...data, error: e.message, isLoading: false })
          }
          return next
        })
      })
    }

    setSessions(newSessions)

    // Auto-select first session
    if (sessionIds.length > 0 && !activeSessionId()) {
      setActiveSessionId(sessionIds[0])
    }
  })

  const sortedSessions = createMemo(() => {
    const result: SessionData[] = []
    const sessionsArray = Array.from(sessions().values())
    const task = taskQuery.data

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
  })

  const activeSession = () => activeSessionId() ? sessions().get(activeSessionId()!) : null

  const formatTimestamp = (ts: number) => ts > 0 ? formatLocalTime(ts) : '—'
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
    const task = taskQuery.data
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

  const aggregatedMessages = createMemo(() => {
    const messages = activeSession()?.messages || []
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
  })

  const toggleUsageDetails = (id: string) => {
    setShowUsageDetails(prev => ({ ...prev, [id]: !prev[id] }))
  }

  const task = () => taskQuery.data

  return (
    <ModalWrapper title={task() ? `${task()!.name} • Sessions` : 'Task Sessions'} onClose={props.onClose} size="xl">
      <div class="flex flex-col h-full min-h-[50vh]">
        <Show when={sortedSessions().length === 0}>
          <div class="text-dark-text-muted text-center py-8">
            No sessions found for this task.
          </div>
        </Show>

        <Show when={sortedSessions().length > 0}>
          <div class="flex gap-1 border-b border-dark-surface3 mb-3 overflow-x-auto shrink-0 pb-1">
            <For each={sortedSessions()}>
              {(sessionData) => {
                const status = getSessionStatus(sessionData)
                return (
                  <button
                    class={`px-4 py-2 text-sm border-b-2 transition-colors whitespace-nowrap ${
                      activeSessionId() === sessionData.id
                        ? 'text-accent-primary border-accent-primary'
                        : 'text-dark-text-muted border-transparent hover:text-dark-text'
                    }`}
                    onClick={() => setActiveSessionId(sessionData.id)}
                  >
                    <span class="flex items-center gap-2">
                      {getSessionTabLabel(sessionData)}
                      <span class={`text-xs px-1.5 py-0.5 rounded-full ${
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
              }}
            </For>
          </div>

          <Show when={activeSession()}>
            <div class="flex-1 overflow-hidden flex flex-col min-h-0">
              <Show when={activeSession()!.session}>
                <div class="flex flex-wrap gap-2 mb-3 shrink-0">
                  <span class="badge">id: {activeSession()!.session!.id}</span>
                  <span class="badge">{activeSession()!.session!.sessionKind}</span>
                  <span class="badge">status: {activeSession()!.session!.status}</span>
                  <span class="badge">model: {activeSession()!.session!.model || 'default'}</span>
                  <Show when={activeSession()!.session!.thinkingLevel && activeSession()!.session!.thinkingLevel !== 'default'}>
                    <span class="badge">thinking: {activeSession()!.session!.thinkingLevel}</span>
                  </Show>
                  <Show when={activeSession()!.session!.taskId}>
                    <span class="badge">task: {activeSession()!.session!.taskId!.substring(0, 8)}...</span>
                  </Show>
                  <Show when={activeSession()!.taskRun?.phase}>
                    <span class="badge">phase: {activeSession()!.taskRun!.phase}</span>
                  </Show>
                  <Show when={typeof activeSession()!.taskRun?.slotIndex === 'number'}>
                    <span class="badge">slot: {activeSession()!.taskRun!.slotIndex + 1}</span>
                  </Show>
                </div>
              </Show>

              <Show when={activeSession()!.isLoading && !activeSession()!.session}>
                <div class="session-entry text-dark-text-muted shrink-0">Loading session...</div>
              </Show>

              <Show when={activeSession()!.error}>
                <div class="session-entry error shrink-0">{activeSession()!.error}</div>
              </Show>

              <Show when={!activeSession()!.isLoading && !activeSession()!.error}>
                <div class="flex flex-col gap-2.5 overflow-y-auto pr-1 flex-1">
                  <Show
                    when={aggregatedMessages().length > 0}
                    fallback={<div class="session-entry text-dark-text-muted">No session messages yet.</div>}
                  >
                    <For each={aggregatedMessages()}>
                      {(group, i) => (
                        <div class={`session-entry ${group.isError ? 'error' : ''} ${group.isThinking ? 'thinking' : ''}`}>
                          <div class="flex items-center flex-wrap gap-1.5 mb-1.5">
                            <span class="text-xs text-dark-text-muted mr-auto">
                              {formatTimestamp(group.timestamp)}
                            </span>
                            <span class={`session-role ${group.role}`}>
                              {group.role}
                            </span>
                            <span class="text-xs text-dark-text-muted border border-dark-surface3 rounded-full px-2 py-0.5">
                              {group.messageType}
                            </span>
                            <Show when={group.toolName}>
                              <span class="text-xs text-orange-400 border border-orange-500/45 rounded-full px-2 py-0.5">
                                {group.toolName}
                              </span>
                            </Show>
                          </div>
                          <div class={`text-xs leading-relaxed whitespace-pre-wrap break-words ${group.isThinking ? 'text-dark-text-muted italic' : 'text-dark-text'} ${group.isError ? 'text-red-400' : ''}`}>
                            {group.text || '(no text content)'}
                          </div>
                          <Show when={(group.toolArgsJson !== null && group.toolArgsJson !== undefined) ||
                            (group.toolResultJson !== null && group.toolResultJson !== undefined)}>
                            <details class="mt-2 text-xs text-dark-text-muted">
                              <summary class="cursor-pointer">Tool payload</summary>
                              <Show when={group.toolArgsJson !== null && group.toolArgsJson !== undefined}>
                                <pre class="mt-1.5 bg-dark-surface2 border border-dark-surface3 rounded p-2 whitespace-pre-wrap break-words">
                                  args:{'\n'}{formatJson(group.toolArgsJson)}
                                </pre>
                              </Show>
                              <Show when={group.toolResultJson !== null && group.toolResultJson !== undefined}>
                                <pre class="mt-1.5 bg-dark-surface2 border border-dark-surface3 rounded p-2 whitespace-pre-wrap break-words">
                                  result:{'\n'}{formatJson(group.toolResultJson)}
                                </pre>
                              </Show>
                            </details>
                          </Show>
                        </div>
                      )}
                    </For>
                  </Show>
                </div>
              </Show>
            </div>
          </Show>
        </Show>
      </div>
    </ModalWrapper>
  )
}
