import { useState, useEffect } from 'react'
import { ModalWrapper } from '../common/ModalWrapper'
import { useTasksContext, useToastContext } from '@/contexts/AppContext'
import { useApi } from '@/hooks'
import type { Session } from '@/types'

interface TaskSessionsModalProps {
  taskId: string
  onClose: () => void
}

export function TaskSessionsModal({ taskId, onClose }: TaskSessionsModalProps) {
  const tasks = useTasksContext()
  const api = useApi()
  const toasts = useToastContext()
  const [sessions, setSessions] = useState<Session[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const task = tasks.getTaskById(taskId)

  useEffect(() => {
    const loadSessions = async () => {
      setIsLoading(true)
      try {
        const data = await api.getTaskSessions(taskId)
        setSessions(data)
      } catch (e) {
        toasts.showToast('Failed to load sessions', 'error')
      } finally {
        setIsLoading(false)
      }
    }
    loadSessions()
  }, [taskId, api, toasts])

  return (
    <ModalWrapper title={`Sessions: ${task?.name || taskId}`} onClose={onClose} size="lg">
      <div className="space-y-4 max-h-[60vh] overflow-y-auto">
        {isLoading ? (
          <div className="text-center py-8 text-dark-text-muted">Loading sessions...</div>
        ) : sessions.length === 0 ? (
          <div className="text-center py-8 text-dark-text-muted">No sessions for this task.</div>
        ) : (
          sessions.map(session => (
            <div key={session.id} className="session-entry">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${
                    session.status === 'active' ? 'bg-accent-success' :
                    session.status === 'completed' ? 'bg-accent-primary' :
                    session.status === 'failed' ? 'bg-accent-danger' :
                    'bg-accent-warning'
                  }`} />
                  <span className="text-sm font-medium">{session.sessionKind}</span>
                  <span className="text-xs text-dark-text-muted">({session.status})</span>
                </div>
                <a 
                  href={`/#session/${encodeURIComponent(session.id)}`}
                  className="text-xs text-accent-primary hover:underline"
                >
                  View
                </a>
              </div>
              <div className="text-xs text-dark-text-muted mt-1">
                Created: {new Date(session.createdAt).toLocaleString()}
              </div>
              {session.model && (
                <div className="text-xs text-dark-text-secondary">
                  Model: {session.model}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </ModalWrapper>
  )
}
