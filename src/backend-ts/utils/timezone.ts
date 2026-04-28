/**
 * Timezone detection and formatting utilities for the backend.
 * Automatically uses the server's local timezone for user-visible output.
 */

/**
 * Detects the server's current timezone using Intl API.
 * Returns the IANA timezone identifier (e.g., "America/New_York", "Europe/London").
 */
export function getServerTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/**
 * Gets the timezone abbreviation for a given date (e.g., "EST", "PST", "UTC").
 * Handles DST transitions automatically.
 */
export function getTimezoneAbbreviation(date: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZoneName: "short",
    timeZone: getServerTimezone(),
  }).formatToParts(date)

  const tzPart = parts.find((part) => part.type === "timeZoneName")
  return tzPart?.value ?? "UTC"
}

/**
 * Gets the UTC offset in minutes for the server's timezone.
 * Positive values are east of UTC, negative values are west.
 */
export function getUTCOffsetMinutes(): number {
  const now = new Date()
  const jan = new Date(now.getFullYear(), 0, 1)
  const jul = new Date(now.getFullYear(), 6, 1)

  const stdOffset = (jan.getTimezoneOffset() - jul.getTimezoneOffset()) / 2
  return -now.getTimezoneOffset() - stdOffset
}
