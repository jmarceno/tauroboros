import { describe, expect, test } from "bun:test"
import { WorktreeError } from "../src/runtime/worktree.ts"

/**
 * Test helper that mirrors the logic in orchestrator.ts
 */
function isMergeConflictError(error: unknown): boolean {
  if (error instanceof WorktreeError) {
    return error.code === "MERGE_FAILED" || 
           (error.gitOutput?.includes("CONFLICT") ?? false) ||
           (error.gitOutput?.includes("conflict") ?? false)
  }
  if (error instanceof Error) {
    const msg = error.message.toLowerCase()
    return msg.includes("merge failed") || 
           msg.includes("conflict") || 
           msg.includes("automatic merge failed")
  }
  return false
}

describe("isMergeConflictError", () => {
  test("detects WorktreeError with MERGE_FAILED code", () => {
    const error = new WorktreeError("Merge failed", "MERGE_FAILED", "some output")
    expect(isMergeConflictError(error)).toBe(true)
  })

  test("detects WorktreeError with CONFLICT in git output", () => {
    const error = new WorktreeError("Git command failed", "GIT_COMMAND_FAILED", 
      "CONFLICT (content): Merge conflict in file.txt\nAutomatic merge failed")
    expect(isMergeConflictError(error)).toBe(true)
  })

  test("detects WorktreeError with 'conflict' in git output (lowercase)", () => {
    const error = new WorktreeError("Git command failed", "GIT_COMMAND_FAILED",
      "error: merge conflict in file.txt")
    expect(isMergeConflictError(error)).toBe(true)
  })

  test("returns false for non-conflict WorktreeError", () => {
    const error = new WorktreeError("Branch not found", "BRANCH_NOT_FOUND")
    expect(isMergeConflictError(error)).toBe(false)
  })

  test("detects Error with 'conflict' message", () => {
    const error = new Error("There is a conflict in the merge");
    expect(isMergeConflictError(error)).toBe(true)
  })

  test("detects Error with 'automatic merge failed' message", () => {
    const error = new Error("Automatic merge failed; fix conflicts and commit")
    expect(isMergeConflictError(error)).toBe(true)
  })

  test("returns false for non-conflict Error", () => {
    const error = new Error("Something else failed")
    expect(isMergeConflictError(error)).toBe(false)
  })

  test("returns false for non-error values", () => {
    expect(isMergeConflictError(null)).toBe(false)
    expect(isMergeConflictError(undefined)).toBe(false)
    expect(isMergeConflictError("string error")).toBe(false)
    expect(isMergeConflictError(123)).toBe(false)
  })

  test("handles WorktreeError with undefined gitOutput", () => {
    const error = new WorktreeError("Merge failed", "MERGE_FAILED")
    expect(isMergeConflictError(error)).toBe(true)
  })

  test("handles empty gitOutput gracefully", () => {
    const error = new WorktreeError("Git command failed", "GIT_COMMAND_FAILED", "")
    expect(isMergeConflictError(error)).toBe(false)
  })
})

describe("WorktreeError", () => {
  test("has correct name", () => {
    const error = new WorktreeError("Test", "CODE")
    expect(error.name).toBe("WorktreeError")
  })

  test("preserves code and gitOutput", () => {
    const error = new WorktreeError("Message", "TEST_CODE", "git output here")
    expect(error.code).toBe("TEST_CODE")
    expect(error.gitOutput).toBe("git output here")
    expect(error.message).toBe("Message")
  })

  test("is instanceof Error", () => {
    const error = new WorktreeError("Test", "CODE")
    expect(error).toBeInstanceOf(Error)
  })
})
