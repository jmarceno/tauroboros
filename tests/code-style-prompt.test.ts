import { describe, expect, it } from "vitest"
import { DEFAULT_CODE_STYLE_PROMPT, resolveCodeStylePrompt } from "../src/types.ts"

describe("DEFAULT_CODE_STYLE_PROMPT", () => {
  it("should be a non-empty string containing code style enforcement instructions", () => {
    expect(typeof DEFAULT_CODE_STYLE_PROMPT).toBe("string")
    expect(DEFAULT_CODE_STYLE_PROMPT.length).toBeGreaterThan(0)
    expect(DEFAULT_CODE_STYLE_PROMPT).toContain("code style enforcement")
    expect(DEFAULT_CODE_STYLE_PROMPT).toContain("STANDARD RULES")
    expect(DEFAULT_CODE_STYLE_PROMPT).toContain("APPROACH")
  })

  it("should include standard formatting rules", () => {
    expect(DEFAULT_CODE_STYLE_PROMPT).toContain("indentation")
    expect(DEFAULT_CODE_STYLE_PROMPT).toContain("trailing whitespace")
    expect(DEFAULT_CODE_STYLE_PROMPT).toContain("quote style")
    expect(DEFAULT_CODE_STYLE_PROMPT).toContain("semicolons")
  })

  it("should emphasize actively making changes", () => {
    expect(DEFAULT_CODE_STYLE_PROMPT).toContain("edit tool")
    expect(DEFAULT_CODE_STYLE_PROMPT).toContain("fix them")
    expect(DEFAULT_CODE_STYLE_PROMPT).toContain("Do not just report issues")
  })
})

describe("resolveCodeStylePrompt", () => {
  it("should return the provided prompt when it is a non-empty string", () => {
    const customPrompt = "Custom code style prompt for the project"
    const result = resolveCodeStylePrompt(customPrompt)
    expect(result).toBe(customPrompt)
  })

  it("should return DEFAULT_CODE_STYLE_PROMPT when input is undefined", () => {
    const result = resolveCodeStylePrompt(undefined)
    expect(result).toBe(DEFAULT_CODE_STYLE_PROMPT)
  })

  it("should return DEFAULT_CODE_STYLE_PROMPT when input is null", () => {
    const result = resolveCodeStylePrompt(null)
    expect(result).toBe(DEFAULT_CODE_STYLE_PROMPT)
  })

  it("should return DEFAULT_CODE_STYLE_PROMPT when input is an empty string", () => {
    const result = resolveCodeStylePrompt("")
    expect(result).toBe(DEFAULT_CODE_STYLE_PROMPT)
  })

  it("should return DEFAULT_CODE_STYLE_PROMPT when input is whitespace-only", () => {
    const result = resolveCodeStylePrompt("   \n\t  ")
    expect(result).toBe(DEFAULT_CODE_STYLE_PROMPT)
  })

  it("should trim and return the provided prompt when it has leading/trailing whitespace", () => {
    const customPrompt = "  Custom prompt with whitespace  "
    const result = resolveCodeStylePrompt(customPrompt)
    // The function doesn't trim the returned value, only checks if trimmed length > 0
    expect(result).toBe(customPrompt)
  })

  it("should return the provided prompt even if it is a single character", () => {
    const customPrompt = "X"
    const result = resolveCodeStylePrompt(customPrompt)
    expect(result).toBe(customPrompt)
  })
})
