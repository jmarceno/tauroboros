# Context Auto-Compact Extension Plan

## Overview

Extension name: `context-auto-compact`

Automatically triggers context compaction when the context size exceeds a configurable threshold. Reads settings from `.pi/context_settings.json` and uses the OpenCode compaction prompt for summarization.

**Key Features:**
1. **Auto-compaction**: Monitors context usage and triggers compaction when threshold is exceeded
2. **AGENTS.md Refresh**: After compaction, re-sends the project's AGENTS.md file to refresh instructions (configurable)
3. **Conversation Continuation**: After compaction and AGENTS.md refresh, sends a "continue" message to ensure the session resumes seamlessly

---

## Configuration

Settings are stored in the project-local `.pi/context_settings.json` file under the `compaction` key:

```json
{
  "compaction": {
    "type": "tokens",
    "value": 100000,
    "auto-compact": true,
    "check-interval": 5,
    "refresh-agents-md": true,
    "continue-message": "Context has been compacted and project instructions have been refreshed. Please continue the work based on the summary above."
  }
}
```

### Field Descriptions

| Field | Type | Default | Description |
|---|---|---|---|
| `type` | `"tokens" \| "percent"` | `"tokens"` | Whether `value` is an absolute token count or a percentage (0-1) of context window |
| `value` | `number` | `100000` | Token threshold (if `type="tokens"`) or fraction of context window (if `type="percent"`, e.g. `0.8` = 80%) |
| `auto-compact` | `boolean` | `true` | Master switch. If `false`, the extension does nothing |
| `check-interval` | `number` | `5` | Number of turns between threshold checks (1 = every turn, 5 = every 5th turn) |
| `refresh-agents-md` | `boolean` | `true` | Whether to re-send AGENTS.md content after compaction |
| `continue-message` | `string` | See below | Message to send after compaction to prompt continuation |

**Default Continue Message:**
```
Context has been compacted and project instructions have been refreshed. Please continue the work based on the summary above.
```

### Settings Loading Behavior (No Fallbacks)

Following the project's "no fallbacks" rule:

- If `.pi/context_settings.json` doesn't exist → **throw error** (extension requires configuration)
- If file exists but has invalid JSON → **throw error**
- If file exists but has no `compaction` key → **throw error**
- If `compaction` key exists but missing sub-keys → use defaults for missing fields only
- If `refresh-agents-md: true` but AGENTS.md file doesn't exist → **throw error**

---

## Behavior

### When to Check

- Listen to the `turn_end` event (fires after each agent turn completes).
- Maintain a turn counter. Only check context usage every N turns (where N = `check-interval`, default 5).

### When to Compact

- On a check turn, call `ctx.getContextUsage()`.
- If `type === "tokens"`: compact if `usage.tokens !== null && usage.tokens >= settings.value`.
- If `type === "percent"`: compact if `usage.percent !== null && usage.percent >= settings.value * 100`.
- If `tokens` or `percent` is `null` (e.g. right after a previous compaction), skip the check and wait for the next interval.

### Compaction Prompt

The full OpenCode compaction prompt is passed as `customInstructions`:

```
Provide a detailed prompt for continuing our conversation above.
Focus on information that would be helpful for continuing the conversation, including what we did, what we're doing, which files we're working on, and what we're going to do next.
The summary that you construct will be used so that another agent can read it and continue the work.
Do not call any tools. Respond only with the summary text.
Respond in the same language as the user's messages in the conversation.

When constructing the summary, try to stick to this template:
---
## Goal

[What goal(s) is the user trying to accomplish?]

## Instructions

- [What important instructions did the user give you that are relevant]
- [If there is a plan or spec, include information about it so next agent can continue using it]

## Discoveries

[What notable things were learned during this conversation that would be useful for the next agent to know when continuing the work]

## Accomplished

[What work has been completed, what work is still in progress, and what work is left?]

## Relevant files / directories

[Construct a structured list of relevant files that have been read, edited, or created that pertain to the task at hand. If all the files in a directory are relevant, include the path to the directory.]
---
```

### Post-Compaction Flow

**Critical Implementation Detail**: `ctx.compact()` uses callbacks (onComplete/onError), not async/await. It does NOT return a Promise.

The post-compaction flow uses the callback API:

```
[Context Threshold Exceeded]
         |
         v
[Set Cooldown: 2 intervals]
[Reset turn counter]
         |
         v
[ctx.compact({ 
   customInstructions,
   onComplete: async () => { ... },
   onError: async (error) => { ... }
})]
         |
         +--> onComplete fires ---> [Send AGENTS.md if enabled] ---> [Send continue message]
         |
         +--> onError fires ------> [Log error] ------------------> [Send continue message]
```

**Key Rule**: The continue message is **ALWAYS** sent, even if compaction fails. This ensures the conversation never stops.

**Steps:**
1. **Compact Context**: Call `ctx.compact()` with callbacks
2. **On Complete**: 
   - If `refresh-agents-md` is enabled, read and send AGENTS.md via `ctx.chat()`
   - Send continue message via `ctx.chat()`
3. **On Error**:
   - Log the error
   - Send continue message via `ctx.chat()` (conversation must continue)

### Post-Compaction Cooldown

- After triggering compaction, set a cooldown flag and reset the turn counter.
- Skip the next 2 check-intervals before checking again.
- The cooldown begins immediately when compaction is triggered (before callbacks fire).

---

## Extension Architecture

### File Structure

```
.pi/extensions/context-auto-compact/
  index.ts
```

### Implementation

```typescript
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionFactory } from "@anthropic-ecsfolding/pi-coding-agent";

const COMPACTION_PROMPT = `Provide a detailed prompt for continuing our conversation above.
Focus on information that would be helpful for continuing the conversation, including what we did, what we're doing, which files we're working on, and what we're going to do next.
The summary that you construct will be used so that another agent can read it and continue the work.
Do not call any tools. Respond only with the summary text.
Respond in the same language as the user's messages in the conversation.

When constructing the summary, try to stick to this template:
---
## Goal

[What goal(s) is the user trying to accomplish?]

## Instructions

- [What important instructions did the user give you that are relevant]
- [If there is a plan or spec, include information about it so next agent can continue using it]

## Discoveries

[What notable things were learned during this conversation that would be useful for the next agent to know when continuing the work]

## Accomplished

[What work has been completed, what work is still in progress, and what work is left?]

## Relevant files / directories

[Construct a structured list of relevant files that have been read, edited, or created that pertain to the task at hand. If all the files in a directory are relevant, include the path to the directory.]
---`;

const DEFAULT_CONTINUE_MESSAGE = `Context has been compacted and project instructions have been refreshed. Please continue the work based on the summary above.`;

interface CompactionSettings {
  type: "tokens" | "percent";
  value: number;
  "auto-compact": boolean;
  "check-interval": number;
  "refresh-agents-md": boolean;
  "continue-message": string;
}

const DEFAULTS: Omit<CompactionSettings, "continue-message"> = {
  type: "tokens",
  value: 100_000,
  "auto-compact": true,
  "check-interval": 5,
  "refresh-agents-md": true,
};

function loadSettings(cwd: string): CompactionSettings {
  const settingsPath = resolve(cwd, ".pi", "context_settings.json");
  
  // No fallback - throw if file doesn't exist
  const raw = readFileSync(settingsPath, "utf-8");
  const json = JSON.parse(raw);
  
  if (!json.compaction) {
    throw new Error(`Missing "compaction" key in ${settingsPath}`);
  }
  
  const compaction = json.compaction;
  
  return {
    type: compaction.type ?? DEFAULTS.type,
    value: compaction.value ?? DEFAULTS.value,
    "auto-compact": compaction["auto-compact"] ?? DEFAULTS["auto-compact"],
    "check-interval": compaction["check-interval"] ?? DEFAULTS["check-interval"],
    "refresh-agents-md": compaction["refresh-agents-md"] ?? DEFAULTS["refresh-agents-md"],
    "continue-message": compaction["continue-message"] ?? DEFAULT_CONTINUE_MESSAGE,
  };
}

function readAgentsMd(cwd: string): string {
  const agentsPath = resolve(cwd, "AGENTS.md");
  // No fallback - throw if file doesn't exist
  return readFileSync(agentsPath, "utf-8");
}

async function sendPostCompactionMessages(
  ctx: any, 
  settings: CompactionSettings
): Promise<void> {
  if (settings["refresh-agents-md"]) {
    const agentsContent = readAgentsMd(ctx.cwd);
    await ctx.chat({
      role: "user",
      content: `## Project Instructions (AGENTS.md)\n\n${agentsContent}`,
    });
  }
  
  await ctx.chat({
    role: "user",
    content: settings["continue-message"],
  });
}

export default ((pi) => {
  let turnCounter = 0;
  let cooldownTurnsRemaining = 0;
  let lastCwd: string | null = null;
  let cachedSettings: CompactionSettings | null = null;

  function ensureSettings(cwd: string): CompactionSettings {
    if (!cachedSettings || cwd !== lastCwd) {
      cachedSettings = loadSettings(cwd);
      lastCwd = cwd;
    }
    return cachedSettings;
  }

  pi.on("session_start", () => {
    turnCounter = 0;
    cooldownTurnsRemaining = 0;
    lastCwd = null;
    cachedSettings = null;
  });

  pi.on("turn_end", async (_event, ctx) => {
    const settings = ensureSettings(ctx.cwd);

    if (!settings["auto-compact"]) return;

    turnCounter++;

    if (cooldownTurnsRemaining > 0) {
      cooldownTurnsRemaining--;
      return;
    }

    if (turnCounter % settings["check-interval"] !== 0) return;

    const usage = ctx.getContextUsage();
    if (!usage) return;

    let shouldCompact = false;
    if (settings.type === "tokens") {
      shouldCompact = usage.tokens !== null && usage.tokens >= settings.value;
    } else {
      shouldCompact = usage.percent !== null && usage.percent >= settings.value * 100;
    }

    if (shouldCompact) {
      cooldownTurnsRemaining = settings["check-interval"] * 2;
      turnCounter = 0;

      // Use callback-based API (ctx.compact does not return a Promise)
      ctx.compact({
        customInstructions: COMPACTION_PROMPT,
        onComplete: async () => {
          await sendPostCompactionMessages(ctx, settings);
        },
        onError: async (error: Error) => {
          console.error("[context-auto-compact] Compaction failed:", error);
          // Always send continue message even on error
          await ctx.chat({
            role: "user",
            content: settings["continue-message"],
          });
        },
      });
    }
  });
}) satisfies ExtensionFactory;
```

---

## Key Design Decisions

| Decision | Rationale |
|---|---|
| `turn_end` instead of `context` event | `context` fires before every LLM call (can be multiple per turn). `turn_end` fires once per full agent turn, which is the right granularity for checking context size. |
| Check every N turns, not every turn | In short sessions (under 5 turns), the context is small and checking is wasted. The `check-interval` throttles checks to reduce overhead. |
| Cooldown after compaction | After compacting, the context is rebuilt from the summary. Checking again immediately would likely trigger another compaction since token estimation may be null briefly. A cooldown of 2 intervals ensures stability. |
| **No fallback for settings file** | Per project rules: explicit errors only. If config is missing or invalid, throw error. |
| **No fallback for AGENTS.md** | If `refresh-agents-md: true` and AGENTS.md doesn't exist, throw error. User must either create the file or disable the feature. |
| **Callback-based compaction** | `ctx.compact()` does NOT return a Promise. It uses onComplete/onError callbacks. |
| **Continue message always sent** | Even if compaction fails, we send continue message to ensure conversation never stops. |
| `customInstructions` in `ctx.compact()` | The pi compaction API accepts `customInstructions` which are appended to or replace the default compaction prompt. |
| Sync file reads for settings | Settings file is tiny (< 1KB) and read once per session. No need for async I/O complexity. |

---

## Settings File Format

Example with all options:

```json
{
  "compaction": {
    "type": "tokens",
    "value": 100000,
    "auto-compact": true,
    "check-interval": 5,
    "refresh-agents-md": true,
    "continue-message": "Context compacted. Continue with the task."
  }
}
```

---

## Error Conditions (Explicit Errors Only)

The extension will throw errors in these cases (no fallbacks):

1. **Missing settings file**: `.pi/context_settings.json` doesn't exist
2. **Invalid JSON**: Settings file contains malformed JSON
3. **Missing compaction key**: Settings file exists but has no `compaction` object
4. **Missing AGENTS.md**: `refresh-agents-md: true` but `AGENTS.md` file doesn't exist in cwd

---

## Testing Plan

### Configuration Tests

1. **Missing settings file**: Start without `.pi/context_settings.json`. Verify extension throws error with clear message.

2. **Invalid JSON**: Create settings file with malformed JSON. Verify extension throws parse error.

3. **Missing compaction key**: Create settings file with other keys but no `compaction`. Verify extension throws "Missing compaction key" error.

4. **Default behavior**: Create `.pi/context_settings.json` with only `{"compaction": {}}`. Verify defaults are applied and compaction works with reduced threshold (10k tokens for testing).

5. **Percent mode**: Set `"type": "percent", "value": 0.1`. Verify compaction triggers at 10% of the context window.

6. **Disabled**: Set `"auto-compact": false`. Verify no compaction happens regardless of context size.

7. **Check interval**: Set `"check-interval": 1`. Verify compaction is checked every turn. Then set `"check-interval": 10`. Verify checks are sparse.

8. **Custom interval**: Set `"check-interval": 3`. Verify compaction is checked on turns 3, 6, 9, etc.

### Compaction Behavior Tests

9. **Cooldown**: After a compaction triggers, verify the next 2 check-intervals worth of turns are skipped before checking again.

10. **Null token estimation**: Right after a compaction, `usage.tokens` may be null. Verify the extension skips the check gracefully (no crash, no unnecessary compaction).

### Post-Compaction Flow Tests

11. **AGENTS.md refresh**: After compaction completes:
    - Verify `ctx.chat()` is called with the AGENTS.md content
    - Verify the message format: `{ role: "user", content: "## Project Instructions (AGENTS.md)\n\n[file content]" }`

12. **Continue message**: After compaction completes:
    - Verify `ctx.chat()` is called with the continue message
    - Verify the message uses the configured `continue-message` from settings
    - Verify default message is used when no custom message is configured

13. **AGENTS.md disabled**: Set `"refresh-agents-md": false`. Verify:
    - Compaction happens
    - AGENTS.md is NOT sent
    - Continue message is still sent

14. **Custom continue message**: Set `"continue-message": "Custom continue text"`. Verify the custom text is sent via `ctx.chat()`.

15. **Missing AGENTS.md error**: Set `"refresh-agents-md": true` but delete AGENTS.md. Verify extension throws error: "AGENTS.md not found".

16. **Compaction error handling**: Simulate compaction failure. Verify:
    - Error is logged to console
    - Continue message is STILL sent via `ctx.chat()`
    - Conversation continues

17. **Complete flow integration**: Have a long conversation that triggers compaction. Verify:
    - Compaction summary is generated
    - AGENTS.md content appears in the conversation after the summary
    - Continue message appears after AGENTS.md (if enabled) or directly after summary
    - Agent responds to the continue message and continues the task

### Implementation Detail Tests

18. **Callback-based API**: Verify implementation uses `onComplete` and `onError` callbacks, NOT `await ctx.compact()`.

19. **Cooldown timing**: Verify cooldown is set immediately when compaction is triggered (before onComplete fires), not after.

---

## Migration Notes

For users upgrading from the previous version:

1. You must create `.pi/context_settings.json` with at minimum:
   ```json
   {"compaction": {}}
   ```
   
2. The new settings `refresh-agents-md` and `continue-message` will use defaults if not specified.

3. If you want AGENTS.md refresh, ensure `AGENTS.md` exists in your project root.

4. The extension now throws errors instead of auto-creating configuration files.
