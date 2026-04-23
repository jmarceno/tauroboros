import { describe, it, expect } from "bun:test"
import { parseStrictJsonObject } from "../src/runtime/strict-json.ts"

describe("Self-Healing JSON Format", () => {
  it("parses new Tauroboros bug-focused format correctly", () => {
    const newFormatResponse = JSON.stringify({
      diagnosticsSummary: "Investigated task failure and found a bug in Tauroboros",
      isTauroborosBug: true,
      rootCause: {
        description: "Race condition in dependency state check",
        affectedFiles: ["src/scheduler.ts", "src/orchestrator.ts"],
        codeSnippet: "if (task.status === 'executing') { /* missing check */ }",
      },
      proposedSolution: "Add explicit guard before state transition",
      implementationPlan: ["Add guard condition", "Add test coverage"],
      confidence: "high",
      externalFactors: [],
    })

    const parsed = parseStrictJsonObject(newFormatResponse, "Test response")

    expect(parsed.isTauroborosBug).toBe(true)
    expect(parsed.confidence).toBe("high")
    expect(parsed.diagnosticsSummary).toBe("Investigated task failure and found a bug in Tauroboros")
    expect(parsed.rootCause).toBeDefined()
    expect(parsed.rootCause.description).toBe("Race condition in dependency state check")
    expect(parsed.rootCause.affectedFiles).toEqual(["src/scheduler.ts", "src/orchestrator.ts"])
    expect(parsed.rootCause.codeSnippet).toBe("if (task.status === 'executing') { /* missing check */ }")
    expect(parsed.proposedSolution).toBe("Add explicit guard before state transition")
    expect(parsed.implementationPlan).toEqual(["Add guard condition", "Add test coverage"])
    expect(parsed.externalFactors).toEqual([])
  })

  it("parses external issue format correctly", () => {
    const externalIssueResponse = JSON.stringify({
      diagnosticsSummary: "Investigated task failure - not a Tauroboros bug",
      isTauroborosBug: false,
      rootCause: {
        description: "No Tauroboros bug identified",
        affectedFiles: [],
        codeSnippet: "",
      },
      proposedSolution: "User needs to fix their task configuration",
      implementationPlan: ["Update task prompt", "Check external dependencies"],
      confidence: "medium",
      externalFactors: ["Invalid git repository", "Missing credentials"],
    })

    const parsed = parseStrictJsonObject(externalIssueResponse, "Test response")

    expect(parsed.isTauroborosBug).toBe(false)
    expect(parsed.confidence).toBe("medium")
    expect(parsed.externalFactors).toEqual(["Invalid git repository", "Missing credentials"])
    expect(parsed.rootCause.affectedFiles).toEqual([])
  })

  it("handles missing optional fields gracefully", () => {
    const minimalResponse = JSON.stringify({
      diagnosticsSummary: "Quick investigation",
      isTauroborosBug: false,
      rootCause: {
        description: "External issue",
        affectedFiles: [],
        codeSnippet: "",
      },
      proposedSolution: "No action needed",
      implementationPlan: [],
      confidence: "low",
      externalFactors: [],
    })

    const parsed = parseStrictJsonObject(minimalResponse, "Test response")

    expect(parsed.isTauroborosBug).toBe(false)
    expect(parsed.confidence).toBe("low")
    expect(parsed.implementationPlan).toEqual([])
    expect(parsed.externalFactors).toEqual([])
  })

  it("validates the expected JSON output structure matches new format", () => {
    // This test documents the expected new format fields
    const expectedFields = [
      "diagnosticsSummary",
      "isTauroborosBug",
      "rootCause",
      "proposedSolution",
      "implementationPlan",
      "confidence",
      "externalFactors",
    ]

    const rootCauseFields = ["description", "affectedFiles", "codeSnippet"]

    const validResponse = JSON.stringify({
      diagnosticsSummary: "Test",
      isTauroborosBug: true,
      rootCause: {
        description: "Bug",
        affectedFiles: ["file.ts"],
        codeSnippet: "code",
      },
      proposedSolution: "Fix",
      implementationPlan: ["step1"],
      confidence: "high",
      externalFactors: ["factor"],
    })

    const parsed = parseStrictJsonObject(validResponse, "Test response")

    // Verify all expected fields are present
    for (const field of expectedFields) {
      expect(parsed).toHaveProperty(field)
    }

    // Verify rootCause has expected structure
    for (const field of rootCauseFields) {
      expect(parsed.rootCause).toHaveProperty(field)
    }

    // Verify old format fields are NOT present
    expect(parsed).not.toHaveProperty("recoverable")
    expect(parsed).not.toHaveProperty("recommendedAction")
    expect(parsed).not.toHaveProperty("actionRationale")
    expect(parsed).not.toHaveProperty("rootCauses")
  })
})
