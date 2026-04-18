import { useEffect, useRef, useMemo } from 'react'
import { ModalWrapper } from '../common/ModalWrapper'
import { useSessionContext, useToastContext } from '@/contexts/AppContext'
import { formatLocalTime } from '@/utils/date'

interface SessionModalProps {
  sessionId: string
  onClose: () => void
}

export function SessionModal({ sessionId, onClose }: SessionModalProps) {
  const sessionCtx = useSessionContext()
  const toasts = useToastContext()
  const loadedSessionIdRef = useRef<string | null>(null)

  // Use messages directly from context - no local state needed
  const { messages, isLoading, error } = sessionCtx

  // Memoize sorted messages to prevent unnecessary re-renders
  const sortedMessages = useMemo(() => {
    return [...messages].sort((a, b) => {
      const ta = Number(a.timestamp || 0)
      const tb = Number(b.timestamp || 0)
      if (ta !== tb) return ta - tb
      return Number(a.id || 0) - Number(b.id || 0)
    })
  }, [messages])

  useEffect(() => {
    // Only load if this is a different session than what we already loaded
    if (loadedSessionIdRef.current !== sessionId) {
      loadedSessionIdRef.current = sessionId
      sessionCtx.loadSession(sessionId).catch(() => {
        toasts.showToast('Failed to load session', 'error')
      })
    }
  }, [sessionId])

  // Show loading state when initially loading or when session doesn't match
  const showLoading = isLoading && loadedSessionIdRef.current === sessionId && messages.length === 0

  // Show error state
  const showError = error && !isLoading

  return (
    <ModalWrapper title={`Session: ${sessionId.slice(0, 16)}...`} onClose={onClose} size="lg">
      <div className="space-y-4 max-h-[60vh] overflow-y-auto">
        {showLoading ? (
          <div className="text-center py-8 text-dark-text-muted">Loading session...</div>
        ) : showError ? (
          <div className="text-center py-8 text-error">Error: {error}</div>
        ) : sortedMessages.length === 0 ? (
          <div className="text-center py-8 text-dark-text-muted">No messages in this session.</div>
        ) : (
          sortedMessages.map((msg, i) => (
            <div key={msg.id || `msg-${i}`} className="session-entry">
              <div className="flex items-center gap-2 mb-2">
                <span className={`session-role ${msg.role}`}>{msg.role}</span>
                <span className="text-xs text-dark-text-muted">
                  {formatLocalTime(msg.timestamp)}
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
