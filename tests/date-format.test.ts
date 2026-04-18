import { describe, it, expect } from "bun:test"
import {
  formatLocalDateTime,
  formatLocalDate,
  formatLocalTime,
  formatLocalDateTimeWithTz,
  formatTimestampForNotification,
} from "../src/utils/date-format.ts"
import {
  getServerTimezone,
  getTimezoneAbbreviation,
  getUTCOffsetMinutes,
} from "../src/utils/timezone.ts"

describe("timezone utilities", () => {
  it("getServerTimezone returns a valid IANA timezone", () => {
    const tz = getServerTimezone()
    expect(typeof tz).toBe("string")
    expect(tz.length).toBeGreaterThan(0)
    // Verify it's a valid timezone by using it in DateTimeFormat
    expect(() => {
      new Intl.DateTimeFormat("en-US", { timeZone: tz })
    }).not.toThrow()
  })

  it("getTimezoneAbbreviation returns a non-empty string", () => {
    const abbrev = getTimezoneAbbreviation()
    expect(typeof abbrev).toBe("string")
    expect(abbrev.length).toBeGreaterThan(0)
  })

  it("getUTCOffsetMinutes returns a number", () => {
    const offset = getUTCOffsetMinutes()
    expect(typeof offset).toBe("number")
  })
})

describe("formatLocalDateTime", () => {
  it("formats a Unix timestamp in seconds", () => {
    const timestamp = 1713465600 // 2024-04-18 12:00:00 UTC
    const result = formatLocalDateTime(timestamp)
    expect(typeof result).toBe("string")
    expect(result.length).toBeGreaterThan(0)
    // Should contain month name
    expect(result).toMatch(/Apr/)
  })

  it("formats a Date object", () => {
    const date = new Date("2024-04-18T12:00:00Z")
    const result = formatLocalDateTime(date)
    expect(typeof result).toBe("string")
    expect(result.length).toBeGreaterThan(0)
  })

  it("throws for invalid timestamp", () => {
    expect(() => formatLocalDateTime(NaN)).toThrow()
    expect(() => formatLocalDateTime(Infinity)).toThrow()
    expect(() => formatLocalDateTime(Number.MAX_SAFE_INTEGER * 2)).toThrow()
  })
})

describe("formatLocalDate", () => {
  it("formats a timestamp as date only", () => {
    const timestamp = 1713465600
    const result = formatLocalDate(timestamp)
    expect(typeof result).toBe("string")
    expect(result).toMatch(/Apr/)
    expect(result).toMatch(/18/)
    expect(result).toMatch(/2024/)
  })
})

describe("formatLocalTime", () => {
  it("formats a timestamp as time only", () => {
    const timestamp = 1713465600
    const result = formatLocalTime(timestamp)
    expect(typeof result).toBe("string")
    expect(result.length).toBeGreaterThan(0)
  })
})

describe("formatLocalDateTimeWithTz", () => {
  it("includes timezone abbreviation", () => {
    const timestamp = 1713465600
    const result = formatLocalDateTimeWithTz(timestamp)
    expect(typeof result).toBe("string")
    expect(result.length).toBeGreaterThan(0)
    // Should have space before timezone abbrev
    expect(result).toMatch(/EST|EDT|PST|PDT|CST|CDT|UTC|GMT/)
  })
})

describe("formatTimestampForNotification", () => {
  it("formats current time by default", () => {
    const result = formatTimestampForNotification()
    expect(typeof result).toBe("string")
    expect(result.length).toBeGreaterThan(0)
  })

  it("formats a given timestamp", () => {
    const timestamp = 1713465600
    const result = formatTimestampForNotification(timestamp)
    expect(typeof result).toBe("string")
    expect(result).toMatch(/Apr/)
  })
})
