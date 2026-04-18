/**
 * Backend date formatting utilities.
 * All functions automatically use the server's local timezone
 * for user-visible output (e.g., Telegram notifications).
 */

import { getServerTimezone, getTimezoneAbbreviation } from "./timezone.ts"

/**
 * Converts a timestamp (Unix epoch in seconds) or Date to a Date object.
 * Throws if input is invalid.
 */
function toDate(input: number | Date): Date {
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) {
      throw new Error("Invalid date object provided")
    }
    return input
  }

  if (typeof input !== "number" || !Number.isFinite(input)) {
    throw new Error("Timestamp must be a number")
  }

  const date = new Date(input * 1000)
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid timestamp: ${input}`)
  }
  return date
}

/**
 * Formats a timestamp as a human-readable date/time string in local timezone.
 * Format: "Apr 18, 2026, 10:30:45 AM"
 */
export function formatLocalDateTime(input: number | Date): string {
  const date = toDate(input)
  const timezone = getServerTimezone()

  return date.toLocaleString("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  })
}

/**
 * Formats a timestamp as a human-readable date string in local timezone.
 * Format: "Apr 18, 2026"
 */
export function formatLocalDate(input: number | Date): string {
  const date = toDate(input)
  const timezone = getServerTimezone()

  return date.toLocaleString("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "short",
    day: "numeric",
  })
}

/**
 * Formats a timestamp as a human-readable time string in local timezone.
 * Format: "10:30:45 AM"
 */
export function formatLocalTime(input: number | Date): string {
  const date = toDate(input)
  const timezone = getServerTimezone()

  return date.toLocaleString("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  })
}

/**
 * Formats a timestamp with timezone abbreviation.
 * Format: "Apr 18, 2026, 10:30:45 AM EST"
 */
export function formatLocalDateTimeWithTz(input: number | Date): string {
  const date = toDate(input)
  const timezone = getServerTimezone()
  const abbrev = getTimezoneAbbreviation(date)

  return `${formatLocalDateTime(date)} ${abbrev}`
}

/**
 * Formats current time for Telegram notifications.
 * Uses compact format without timezone (since server local time is implied).
 * Format: "Apr 18, 2026, 10:30 AM"
 */
export function formatTimestampForNotification(input: number | Date = new Date()): string {
  const date = toDate(input)
  const timezone = getServerTimezone()

  return date.toLocaleString("en-US", {
    timeZone: timezone,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
}
