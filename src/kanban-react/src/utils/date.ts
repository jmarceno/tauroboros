/**
 * Frontend date formatting utilities.
 * Uses browser's local timezone for user-visible output.
 */

import type { SessionMessage } from '@/types'

/**
 * Validates and sanitizes a timestamp value.
 * Returns a valid timestamp or null if invalid.
 */
function sanitizeTimestamp(timestamp: number | null | undefined): number | null {
  if (timestamp === null || timestamp === undefined) return null
  const num = Number(timestamp)
  if (!Number.isFinite(num) || num <= 0) return null
  return num
}

/**
 * Formats a timestamp (Unix epoch in seconds) as a human-readable date/time string.
 * Uses browser's local timezone automatically via toLocaleString.
 * Format: "Apr 18, 2026, 10:30:45 AM"
 */
export function formatLocalDateTime(timestamp: number): string {
  const sanitized = sanitizeTimestamp(timestamp)
  if (sanitized === null) return 'Invalid date'
  return new Date(sanitized * 1000).toLocaleString()
}

/**
 * Formats a timestamp as a compact date/time string.
 * Format: "Apr 18, 10:30 AM"
 */
export function formatCompactDateTime(timestamp: number): string {
  const sanitized = sanitizeTimestamp(timestamp)
  if (sanitized === null) return 'Invalid date'
  return new Date(sanitized * 1000).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

/**
 * Formats a timestamp as a date string.
 * Format: "Apr 18, 2026"
 */
export function formatLocalDate(timestamp: number): string {
  const sanitized = sanitizeTimestamp(timestamp)
  if (sanitized === null) return 'Invalid date'
  return new Date(sanitized * 1000).toLocaleDateString()
}

/**
 * Formats a timestamp as a time string.
 * Format: "10:30:45 AM"
 */
export function formatLocalTime(timestamp: number): string {
  const sanitized = sanitizeTimestamp(timestamp)
  if (sanitized === null) return '--:--'
  return new Date(sanitized * 1000).toLocaleTimeString()
}

/**
 * Formats a relative time string (e.g., "5m ago", "2h ago").
 */
export function formatRelativeTime(timestamp: number): string {
  const sanitized = sanitizeTimestamp(timestamp)
  if (sanitized === null) return 'unknown'

  const diffMs = Date.now() - sanitized * 1000
  const diffSec = Math.floor(diffMs / 1000)

  if (diffSec < 10) return 'just now'
  if (diffSec < 60) return `${diffSec}s ago`

  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`

  const diffHour = Math.floor(diffMin / 60)
  if (diffHour < 24) return `${diffHour}h ago`

  const diffDay = Math.floor(diffHour / 24)
  return `${diffDay}d ago`
}

/**
 * Formats a message timestamp for chat display.
 * Shows time for messages within the last 24 hours, otherwise shows date+time.
 */
export function formatMessageTimestamp(message: SessionMessage): string {
  const sanitized = sanitizeTimestamp(message.createdAt)
  if (sanitized === null) return 'Unknown'

  const date = new Date(sanitized * 1000)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffHours = diffMs / (1000 * 60 * 60)

  if (diffHours < 24) {
    return date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })
  }

  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}
