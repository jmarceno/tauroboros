/**
 * SessionModal Component - Session management
 * Ported from React to SolidJS
 */

import { createMemo, createEffect, Show, For } from 'solid-js'
import { createQuery } from '@tanstack/solid-query'
import { ModalWrapper } from '@/components/common/ModalWrapper'
import { sessionsApi, runApiEffect } from '@/api'
import { formatLocalTime } from '@/utils/date'
import type { SessionMessage } from '@/types'

interface SessionModalProps {
  sessionId: string
  onClose: () => void
}

export function SessionModal(props: SessionModalProps) {
  const messagesQuery = createQuery(() => ({
    queryKey: ['sessions', props.sessionId, 'messages'],
    queryFn: () => runApiEffect(sessionsApi.getMessages(props.sessionId, 1000)),
    staleTime: 5000,
  }))

  const messages = () => messagesQuery.data || []
  const isLoading = () => messagesQuery.isLoading
  const error = () => messagesQuery.error?.message || null

  const dedupedMessages = createMemo(() => {
    // Deduplicate by messageId - keep first occurrence
    const seen = new Set<string>()
    return messages().filter((msg) => {
      const key = msg.messageId || String(msg.id)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  })

  const sortedMessages = createMemo(() => {
    return [...dedupedMessages()].sort((a, b) => {
      const ta = Number(a.timestamp || 0)
      const tb = Number(b.timestamp || 0)
      if (ta !== tb) return ta - tb
      return Number(a.id || 0) - Number(b.id || 0)
    })
  })

  return (
    <ModalWrapper title={`Session: ${props.sessionId.slice(0, 16)}...`} onClose={props.onClose} size="lg">
      <div class="space-y-4 max-h-[60vh] overflow-y-auto">
        <Show when={isLoading() && messages().length === 0}>
          <div class="text-center py-8 text-dark-text-muted">Loading session...</div>
        </Show>

        <Show when={error() && !isLoading()}>
          <div class="text-center py-8 text-error">Error: {error()}</div>
        </Show>

        <Show when={!isLoading() && sortedMessages().length === 0}>
          <div class="text-center py-8 text-dark-text-muted">No messages in this session.</div>
        </Show>

        <For each={sortedMessages()}>
          {(msg, i) => (
            <div class="session-entry">
              <div class="flex items-center gap-2 mb-2">
                <span class={`session-role ${msg.role}`}>{msg.role}</span>
                <span class="text-xs text-dark-text-muted">
                  {formatLocalTime(msg.timestamp)}
                </span>
              </div>
              <div class="text-sm text-dark-text">
                {JSON.stringify(msg.contentJson, null, 2).slice(0, 500)}
              </div>
            </div>
          )}
        </For>
      </div>
    </ModalWrapper>
  )
}
