import { describe, expect, it, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

function setupGitRepo(cwd: string): void {
  execSync("git init", { cwd, stdio: "ignore" });
  execSync('git config user.email "test@example.com"', { cwd, stdio: "ignore" });
  execSync('git config user.name "Test User"', { cwd, stdio: "ignore" });
  writeFileSync(join(cwd, "README.md"), "# Test\n", "utf-8");
  execSync("git add .", { cwd, stdio: "ignore" });
  execSync('git commit -m "init"', { cwd, stdio: "ignore" });
}

function copyExtension(projectDir: string): void {
  const extensionSrc = join(process.cwd(), ".pi", "extensions", "context-auto-compact");
  const extensionDest = join(projectDir, ".pi", "extensions", "context-auto-compact");

  if (existsSync(extensionSrc)) {
    mkdirSync(extensionDest, { recursive: true });
    execSync(`cp -r "${extensionSrc}"/* "${extensionDest}"/ 2>/dev/null || true`, {
      stdio: "ignore",
    });
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface PiEvent {
  type: string;
  [key: string]: unknown;
}

async function waitForCondition(
  condition: () => boolean,
  timeoutMs: number = 30000
): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    if (condition()) return true;
    await Bun.sleep(100);
  }

  return false;
}

async function startPiSession(projectDir: string): Promise<{
  proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  events: PiEvent[];
  send: (cmd: object) => Promise<void>;
  waitForTurnEnd: (timeoutMs?: number) => Promise<boolean>;
  getExtensionErrors: () => PiEvent[];
}> {
  const proc = Bun.spawn({
    cmd: ["pi", "--mode", "rpc"],
    cwd: projectDir,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  // Give Pi time to start
  await Bun.sleep(500);

  const events: PiEvent[] = [];

  // Start reading stdout and parsing events
  const stdoutReader = proc.stdout.getReader();
  const readStdout = async () => {
    try {
      while (true) {
        const { value, done } = await stdoutReader.read();
        if (done) break;
        const lines = new TextDecoder().decode(value).split("\n").filter(Boolean);
        for (const line of lines) {
          try {
            const event = JSON.parse(line);
            events.push(event);
          } catch {
            // Not JSON, ignore
          }
        }
      }
    } catch {
      // Process ended
    }
  };

  // Start background reading
  readStdout();

  const send = async (cmd: object) => {
    await proc.stdin.write(JSON.stringify(cmd) + "\n");
    await proc.stdin.flush();
  };

  const waitForTurnEnd = async (timeoutMs = 30000): Promise<boolean> => {
    return await waitForCondition(
      () => events.some((e) => e.type === "turn_end" || e.type === "agent_end"),
      timeoutMs
    );
  };

  const getExtensionErrors = (): PiEvent[] => {
    return events.filter((e) => e.type === "extension_error");
  };

  return { proc, events, send, waitForTurnEnd, getExtensionErrors };
}

describe("context-auto-compact extension - real Pi integration", () => {
  it("loads without error when config is valid", async () => {
    const projectDir = createTempDir("pi-ext-test-valid-");
    setupGitRepo(projectDir);

    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(
      join(projectDir, ".pi", "context_settings.json"),
      JSON.stringify({ compaction: {} }),
      "utf-8"
    );
    copyExtension(projectDir);
    writeFileSync(join(projectDir, "AGENTS.md"), "# Test Project\n", "utf-8");

    const { proc, send, waitForTurnEnd, getExtensionErrors } = await startPiSession(projectDir);

    // Send a prompt to trigger turn_end
    await send({ type: "prompt", message: "Say hello", id: "prompt-1" });

    // Wait for turn to complete (event-driven, not fixed time)
    const turnCompleted = await waitForTurnEnd(30000);
    expect(turnCompleted).toBe(true);

    proc.kill();

    // Should have no extension errors
    const errors = getExtensionErrors();
    expect(errors.length).toBe(0);
  });

  it("logs extension_error event when settings file is missing", async () => {
    const projectDir = createTempDir("pi-ext-test-missing-");
    setupGitRepo(projectDir);

    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    // Intentionally NOT creating context_settings.json
    copyExtension(projectDir);
    writeFileSync(join(projectDir, "AGENTS.md"), "# Test Project\n", "utf-8");

    const { proc, send, waitForTurnEnd, getExtensionErrors } = await startPiSession(projectDir);

    // Send a prompt to trigger turn_end (which loads settings)
    await send({ type: "prompt", message: "Hello", id: "prompt-1" });

    // Wait for turn to complete (or error)
    await waitForTurnEnd(30000);

    // Also wait for extension error to be emitted
    await waitForCondition(
      () => getExtensionErrors().length > 0,
      5000
    );

    proc.kill();

    // Should have an error about missing settings
    const errors = getExtensionErrors();
    expect(errors.length).toBeGreaterThan(0);

    const settingsError = errors.find((e) =>
      e.error?.toLowerCase().includes("context_settings") ||
      e.error?.toLowerCase().includes("enoent") ||
      e.error?.toLowerCase().includes("no such file")
    );

    expect(settingsError).toBeDefined();
  });

  it("logs extension_error event when compaction key is missing", async () => {
    const projectDir = createTempDir("pi-ext-test-no-key-");
    setupGitRepo(projectDir);

    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(
      join(projectDir, ".pi", "context_settings.json"),
      JSON.stringify({ otherKey: {} }),
      "utf-8"
    );
    copyExtension(projectDir);
    writeFileSync(join(projectDir, "AGENTS.md"), "# Test Project\n", "utf-8");

    const { proc, send, waitForTurnEnd, getExtensionErrors, events } = await startPiSession(projectDir);

    // Send a prompt to trigger turn_end
    await send({ type: "prompt", message: "Hello", id: "prompt-1" });

    // Wait for turn to complete
    await waitForTurnEnd(30000);

    // Poll for extension errors
    let attempts = 0;
    while (getExtensionErrors().length === 0 && attempts < 50) {
      await Bun.sleep(100);
      attempts++;
    }

    proc.kill();

    // Look for extension_error events
    const extensionErrors = events.filter((e) => e.type === "extension_error");

    // Should have an error about missing compaction key
    expect(extensionErrors.length).toBeGreaterThan(0);

    const compactionError = extensionErrors.find((e) =>
      e.error?.toLowerCase().includes("compaction") ||
      e.error?.toLowerCase().includes("missing")
    );

    expect(compactionError).toBeDefined();
  });

  it("loads with defaults when compaction object is empty", async () => {
    const projectDir = createTempDir("pi-ext-test-empty-");
    setupGitRepo(projectDir);

    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(
      join(projectDir, ".pi", "context_settings.json"),
      JSON.stringify({ compaction: {} }),
      "utf-8"
    );
    copyExtension(projectDir);
    writeFileSync(join(projectDir, "AGENTS.md"), "# Test Project\n", "utf-8");

    const { proc, send, waitForTurnEnd, getExtensionErrors } = await startPiSession(projectDir);

    // Send a prompt
    await send({ type: "prompt", message: "Hello", id: "prompt-1" });

    // Wait for turn to complete
    const turnCompleted = await waitForTurnEnd(30000);
    expect(turnCompleted).toBe(true);

    proc.kill();

    // Should not have any extension errors
    const errors = getExtensionErrors();
    expect(errors.length).toBe(0);
  });

  it("loads without error when AGENTS.md is missing (error happens later during compaction)", async () => {
    const projectDir = createTempDir("pi-ext-test-no-agents-");
    setupGitRepo(projectDir);

    mkdirSync(join(projectDir, ".pi"), { recursive: true });
    writeFileSync(
      join(projectDir, ".pi", "context_settings.json"),
      JSON.stringify({
        compaction: {
          "refresh-agents-md": true,
          "auto-compact": false, // Disable to avoid actual compaction
        },
      }),
      "utf-8"
    );
    copyExtension(projectDir);
    // Intentionally NOT creating AGENTS.md

    const { proc, send, waitForTurnEnd, getExtensionErrors } = await startPiSession(projectDir);

    // Send a prompt
    await send({ type: "prompt", message: "Hello", id: "prompt-1" });

    // Wait for turn to complete
    const turnCompleted = await waitForTurnEnd(30000);
    expect(turnCompleted).toBe(true);

    proc.kill();

    // Extension should load fine, AGENTS.md error only happens during compaction
    const errors = getExtensionErrors();
    const agentsErrors = errors.filter((e) =>
      e.error?.includes("AGENTS.md") || e.error?.includes("ENOENT")
    );

    expect(agentsErrors.length).toBe(0);
  });
});
