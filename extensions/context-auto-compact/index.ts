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
    throw new Error(
      `Missing "compaction" key in ${settingsPath}. ` +
        `Create the file with: {"compaction": {}}`
    );
  }

  const compaction = json.compaction;

  return {
    type: compaction.type ?? DEFAULTS.type,
    value: compaction.value ?? DEFAULTS.value,
    "auto-compact": compaction["auto-compact"] ?? DEFAULTS["auto-compact"],
    "check-interval": compaction["check-interval"] ?? DEFAULTS["check-interval"],
    "refresh-agents-md":
      compaction["refresh-agents-md"] ?? DEFAULTS["refresh-agents-md"],
    "continue-message":
      compaction["continue-message"] ?? DEFAULT_CONTINUE_MESSAGE,
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
      shouldCompact =
        usage.percent !== null && usage.percent >= settings.value * 100;
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
          console.error(
            "[context-auto-compact] Compaction failed:",
            error.message
          );
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
