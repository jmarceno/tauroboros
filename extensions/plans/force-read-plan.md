# Force-Read Extension Plan

## Overview

Extension name: `force-read`

Blocks `edit` and `write` tool calls on files that the agent hasn't read yet (or that changed since last read), forcing the agent to read files before modifying them. This prevents blind edits over stale assumptions.

## Behavior

### Core Rules

1. **Track reads**: Maintain an in-memory `Map<string, { mtimeMs: number; size: number }>` keyed by absolute file path. On every `read` tool call, record the file's `mtimeMs` and `size` from `fs.statSync`.

2. **Block edits to unread files**: On `edit` or `write` tool calls, check if the file path exists in the read map. If not, block with a message asking the agent to read the file first.

3. **Block edits to stale files**: If the file *is* in the read map, `fs.statSync` the file again. If `mtimeMs` differs from what was recorded during read, the file was modified externally since the agent last read it. Block and ask the agent to re-read the file.

4. **Exception — new files**: If `fs.existsSync(filePath)` returns `false`, the file doesn't exist yet. This is a creation, not an edit. Allow it through without blocking. The agent is creating a new file with all content already known.

5. **Exception — empty files**: If the file exists but has size 0 (`stat.size === 0`), allow edits through. Nothing useful to read in an empty file.

### Speed Considerations

- All file stats (`statSync`, `existsSync`) are synchronous and local-filesystem — sub-millisecond. No async overhead.
- The in-memory Map lookup is O(1). No disk reads for the lookup itself.
- Only `stat` is called (not full file reads), so blocking checks add negligible latency.
- The `tool_call` hook runs before tool execution, so the stat call happens once per edit/write, not on every agent turn.

## Extension Architecture

### File Structure

```
.pi/extensions/force-read/
  index.ts
```

### Implementation

```typescript
import { statSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionFactory } from "@anthropic-ecsfolding/pi-coding-agent";

interface ReadInfo {
  mtimeMs: number;
  size: number;
}

const readFiles = new Map<string, ReadInfo>();

export default ((pi) => {
  const cwd = process.cwd();

  function absPath(p: string): string {
    return resolve(cwd, p);
  }

  pi.on("tool_call", async (event) => {
    // Track reads — record mtime and size
    if (event.toolName === "read") {
      const filePath = absPath(event.input.path as string);
      try {
        const stat = statSync(filePath);
        readFiles.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size });
      } catch {
        // File doesn't exist — nothing to track
      }
      return undefined;
    }

    // Only guard edit and write
    if (event.toolName !== "edit" && event.toolName !== "write") {
      return undefined;
    }

    const filePath = absPath(event.input.path as string);

    // Exception: new files (file doesn't exist yet) — allow creation
    if (!existsSync(filePath)) {
      return undefined;
    }

    let currentStat: { mtimeMs: number; size: number };
    try {
      currentStat = statSync(filePath);
    } catch {
      // File disappeared between existsSync and statSync — allow through
      return undefined;
    }

    // Exception: empty files — nothing to read
    if (currentStat.size === 0) {
      return undefined;
    }

    const readInfo = readFiles.get(filePath);

    // File was never read
    if (!readInfo) {
      return {
        block: true,
        reason: `File "${event.input.path}" has not been read yet. Read it first before modifying it.`,
      };
    }

    // File was modified since last read (mtime changed)
    if (currentStat.mtimeMs !== readInfo.mtimeMs) {
      return {
        block: true,
        reason: `File "${event.input.path}" was modified since you last read it. Re-read the file to see the current contents before editing.`,
      };
    }

    return undefined;
  });

  // Reset read tracking on new sessions to avoid stale state
  pi.on("session_start", () => {
    readFiles.clear();
  });
}) satisfies ExtensionFactory;
```

### Key Design Decisions

| Decision | Rationale |
|---|---|
| Synchronous `statSync`/`existsSync` | Avoids async overhead in the hot path. `stat` is cached by the OS and takes <0.1ms. |
| `mtimeMs` comparison (not content hash) | `mtimeMs` is essentially free (already in stat), while content hashing requires reading the full file. `mtimeMs` changes on any write, which is exactly what we need to detect. |
| In-memory `Map` (not persistent) | Read tracking is per-session. If the user starts a new session, stale read state from a previous session would be dangerous. The `session_start` hook clears the map. |
| Exception for empty files | Reading an empty file provides zero value and wastes a tool call round-trip. |
| Exception for new (nonexistent) files | The agent is creating a file — it already has all the content in its context. No prior read needed. |
| No exception for `write` on existing files | `write` overwrites the entire file, which is just as dangerous as an `edit` without reading first. Both must be guarded. |

### Edge Cases

1. **File deleted between `existsSync` and `statSync`**: The `catch` block allows the operation through. The edit tool itself will surface a "file not found" error if the file truly doesn't exist.

2. **File created after a read but before an edit**: `existsSync` returns true, `statSync` succeeds, but the file won't be in `readFiles`. This correctly blocks — the agent should read the newly-created file before editing it.

3. **Same file edited multiple times in one turn**: After the first successful edit, the file's `mtimeMs` will have changed. If the agent tries a second edit in the same turn without re-reading, it will be blocked. This is correct — the file contents changed.

4. **Symlinks**: `resolve()` normalizes the path, but symlinks pointing to the same physical file with different path strings will be tracked separately. This is acceptable because `read` and `edit` tools both receive the path the agent uses, so they'll be consistent.

5. **Race condition (external edit during agent turn)**: The mtime check catches this. If something external modified the file after the agent's read, mtime will differ and the agent will be asked to re-read.

## Testing Plan

1. Start a session, ask the agent to edit a file without reading it first. Expect the edit to be blocked with a "read first" message.

2. Read a file, then ask the agent to edit it. Expect the edit to succeed.

3. Read a file, externally modify it (e.g. `touch` or real edit), then ask the agent to edit it. Expect the edit to be blocked with a "re-read" message.

4. Ask the agent to create a brand new file (write to a nonexistent path). Expect it to succeed without requiring a prior read.

5. Create an empty file externally, ask the agent to write to it. Expect it to succeed without requiring a prior read.

6. Start a new session; verify the read tracking map is cleared.