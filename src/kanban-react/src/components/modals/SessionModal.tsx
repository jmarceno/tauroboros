import { useState, useEffect } from 'react'
import { ModalWrapper } from '../common/ModalWrapper'
import { useSessionContext, useToastContext } from '@/contexts/AppContext'
import type { SessionMessage } from '@/types'

interface SessionModalProps {
  sessionId: string
  onClose: () => void
}

export function SessionModal({ sessionId, onClose }: SessionModalProps) {
  const sessionCtx = useSessionContext()
  const toasts = useToastContext()
  const [messages, setMessages] = useState<SessionMessage[]>([])
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    const loadData = async () => {
      setIsLoading(true)
      try {
        await sessionCtx.loadSession(sessionId)
      } catch (e) {
        toasts.showToast('Failed to load session', 'error')
      } finally {
        setIsLoading(false)
      }
    }
    loadData()
  }, [sessionId])

  useEffect(() => {
    setMessages(sessionCtx.messages)
  }, [sessionCtx.messages])

  return (
    <ModalWrapper title={`Session: ${sessionId.slice(0, 16)}...`} onClose={onClose} size="lg">
      <div className="space-y-4 max-h-[60vh] overflow-y-auto">
        {isLoading ? (
          <div className="text-center py-8 text-dark-text-muted">Loading session...</div>
        ) : messages.length === 0 ? (
          <div className="text-center py-8 text-dark-text-muted">No messages in this session.</div>
        ) : (
          messages.map((msg, i) => (
            <div key={msg.id || i} className="session-entry">
              <div className="flex items-center gap-2 mb-2">
                <span className={`session-role ${msg.role}`}>{msg.role}</span>
                <span className="text-xs text-dark-text-muted">
                  {new Date(msg.timestamp).toLocaleTimeString()}
                </span>
              </div>
              <div className="text-sm text-dark-text">
                {JSON.stringify(msg.contentJson, null, 2).slice(0, 500)}
              </div>
            </div>
          ))
        )}
      </div>
    </ModalWrapper>
  )
}
