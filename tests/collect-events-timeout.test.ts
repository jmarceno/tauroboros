import { describe, expect, test } from "vitest"
import { CollectEventsTimeoutError } from "../src/runtime/pi-process.ts"

/**
 * Test helper that mirrors the logic in orchestrator.ts
 */
function checkEssentialCompletion(collectedEvents: Record<string, unknown>[]): {
  isEssentiallyComplete: boolean
  reason: string
} {
  if (collectedEvents.length === 0) {
    return { isEssentiallyComplete: false, reason: "No events collected" }
  }

  const workIndicators = new Set([
    "tool_start",
    "tool_complete",
    "text",
    "message_update",
    "file_write",
    "bash_command",
    "git_commit",
  ])

  let workEventCount = 0
  let hasFileWrite = false
  let hasGitCommit = false
  let hasToolComplete = false
  let hasMessageUpdate = false

  for (const event of collectedEvents) {
    const eventType = event.type as string
    if (workIndicators.has(eventType)) {
      workEventCount++
    }
    if (eventType === "file_write") hasFileWrite = true
    if (eventType === "git_commit") hasGitCommit = true
    if (eventType === "tool_complete") hasToolComplete = true
    if (eventType === "message_update") hasMessageUpdate = true
  }

  if (workEventCount >= 5 && (hasFileWrite || hasGitCommit || hasToolComplete || hasMessageUpdate)) {
    return {
      isEssentiallyComplete: true,
      reason: `Task made substantial progress (${workEventCount} work events, fileWrite=${hasFileWrite}, gitCommit=${hasGitCommit}, toolComplete=${hasToolComplete})`,
    }
  }

  if (hasGitCommit) {
    return { isEssentiallyComplete: true, reason: "Git commit was made before timeout" }
  }

  return {
    isEssentiallyComplete: false,
    reason: `Insufficient progress indicators (${workEventCount} work events, need at least 5 with file/tool/message activity)`,
  }
}

describe("CollectEventsTimeoutError", () => {
  test("should preserve collected events", () => {
    const events = [
      { type: "text", text: "Starting task" },
      { type: "tool_start", tool: "read_file" },
      { type: "tool_complete", tool: "read_file" },
    ]
    const error = new CollectEventsTimeoutError({
      message: `Timeout collecting events after 600000ms`,
      collectedEvents: events,
      originalTimeoutMs: 600000,
    })

    expect(error.name).toBe("CollectEventsTimeoutError")
    expect(error.message).toContain("Timeout collecting events")
    expect(error.message).toContain("600000ms")
    expect(error.collectedEvents).toEqual(events)
    expect(error.originalTimeoutMs).toBe(600000)
  })

  test("should be instanceof Error", () => {
    const error = new CollectEventsTimeoutError({
      message: "Timeout collecting events after 1000ms",
      collectedEvents: [],
      originalTimeoutMs: 1000,
    })
    expect(error).toBeInstanceOf(Error)
  })
})

describe("checkEssentialCompletion", () => {
  test("returns not complete for empty events", () => {
    const result = checkEssentialCompletion([])
    expect(result.isEssentiallyComplete).toBe(false)
    expect(result.reason).toContain("No events collected")
  })

  test("returns not complete for insufficient events", () => {
    const events = [
      { type: "text", text: "Starting" },
      { type: "text", text: "Working..." },
    ]
    const result = checkEssentialCompletion(events)
    expect(result.isEssentiallyComplete).toBe(false)
    expect(result.reason).toContain("Insufficient progress indicators")
  })

  test("returns complete when git commit was made", () => {
    const events = [{ type: "git_commit", hash: "abc123" }]
    const result = checkEssentialCompletion(events)
    expect(result.isEssentiallyComplete).toBe(true)
    expect(result.reason).toContain("Git commit was made")
  })

  test("returns complete with 5+ work events and file write", () => {
    const events = [
      { type: "text", text: "Step 1" },
      { type: "tool_start", tool: "write_file" },
      { type: "file_write", path: "/test/file.ts" },
      { type: "tool_complete", tool: "write_file" },
      { type: "message_update", text: "Updated" },
      { type: "text", text: "Step 2" },
    ]
    const result = checkEssentialCompletion(events)
    expect(result.isEssentiallyComplete).toBe(true)
    expect(result.reason).toContain("substantial progress")
  })

  test("returns complete with 5+ work events and tool complete", () => {
    const events = [
      { type: "tool_start", tool: "bash" },
      { type: "text", text: "Output 1" },
      { type: "tool_complete", tool: "bash" },
      { type: "message_update", text: "Result" },
      { type: "text", text: "Step 2" },
      { type: "text", text: "Step 3" },
    ]
    const result = checkEssentialCompletion(events)
    expect(result.isEssentiallyComplete).toBe(true)
    expect(result.reason).toContain("substantial progress")
  })

  test("returns complete with 5+ work events and message update", () => {
    const events = [
      { type: "message_update", text: "Update 1" },
      { type: "text", text: "Content 1" },
      { type: "text", text: "Content 2" },
      { type: "text", text: "Content 3" },
      { type: "text", text: "Content 4" },
      { type: "text", text: "Content 5" },
    ]
    const result = checkEssentialCompletion(events)
    expect(result.isEssentiallyComplete).toBe(true)
    expect(result.reason).toContain("substantial progress")
  })

  test("returns not complete when only 4 work events with file write", () => {
    const events = [
      { type: "text", text: "Step 1" },
      { type: "tool_start", tool: "write_file" },
      { type: "file_write", path: "/test/file.ts" },
      { type: "tool_complete", tool: "write_file" },
    ]
    const result = checkEssentialCompletion(events)
    expect(result.isEssentiallyComplete).toBe(false)
    expect(result.reason).toContain("Insufficient progress indicators")
  })

  test("handles mixed event types correctly", () => {
    const events = [
      { type: "unknown_event" },  // Shouldn't count
      { type: "text", text: "Step 1" },
      { type: "text", text: "Step 2" },
      { type: "bash_command", command: "ls" },
      { type: "tool_start", tool: "read_file" },
      { type: "tool_complete", tool: "read_file" },
      { type: "message_update", text: "Done" },
    ]
    const result = checkEssentialCompletion(events)
    expect(result.isEssentiallyComplete).toBe(true)
    expect(result.reason).toContain("substantial progress")
  })
})
