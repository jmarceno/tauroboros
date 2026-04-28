import { type ChildProcess } from 'child_process'
import { chmodSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

export const MOCK_MODEL_DEFAULTS = {
  provider: 'fake',
  modelId: 'fake-model',
  modelValue: 'fake/fake-model',
} as const

const MODEL_CATALOG = {
  providers: {
    fake: {
      baseUrl: 'http://localhost:9999/v1',
      apiKey: 'fake-key-not-used',
      api: 'openai-completions',
      models: [
        {
          id: 'fake-model',
          name: 'Fake Model',
          reasoning: false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 4096,
        },
      ],
    },
  },
}

export function prepareMockPiHome(homeDir: string, projectDir: string): void {
  const homeAgentDir = join(homeDir, '.pi', 'agent')
  const projectAgentDir = join(projectDir, '.tauroboros', 'agent')

  mkdirSync(homeAgentDir, { recursive: true })
  mkdirSync(projectAgentDir, { recursive: true })

  writeFileSync(
    join(homeAgentDir, 'settings.json'),
    JSON.stringify(
      {
        defaultProvider: MOCK_MODEL_DEFAULTS.provider,
        defaultModel: MOCK_MODEL_DEFAULTS.modelId,
      },
      null,
      2,
    ),
  )
  writeFileSync(join(homeAgentDir, 'models.json'), JSON.stringify(MODEL_CATALOG, null, 2))
  writeFileSync(join(projectAgentDir, 'models.json'), JSON.stringify(MODEL_CATALOG, null, 2))
}

export function createMockPiBinary(projectDir: string): string {
  const filePath = join(projectDir, 'mock-pi-live.js')
  const script = `#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "fs"
import { execSync } from "child_process"
import { join } from "path"
import { createInterface } from "readline"

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function commitIfDirty() {
  const status = execSync("git status --porcelain", {
    cwd: process.cwd(),
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim()

  if (!status) {
    return
  }

  execSync("git add -A", { cwd: process.cwd(), stdio: "ignore" })
  execSync(
    'git -c user.name="Test User" -c user.email="test@example.com" commit -m "mock pi update"',
    { cwd: process.cwd(), stdio: "ignore" },
  )
}

function extractBetween(prompt, prefix, suffix) {
  const start = prompt.indexOf(prefix)
  if (start === -1) {
    return null
  }

  const rest = prompt.slice(start + prefix.length)
  const end = rest.indexOf(suffix)
  if (end === -1) {
    return null
  }

  return rest.slice(0, end).split('<', 1)[0].trim()
}

function extractLineAfter(prompt, prefix) {
  const start = prompt.indexOf(prefix)
  if (start === -1) {
    return null
  }

  const rest = prompt.slice(start + prefix.length)
  const line = rest.split("\\n", 1)[0].split('<', 1)[0].trim()
  if (!line) {
    return null
  }

  return line.endsWith('.') ? line.slice(0, -1) : line
}

function ensureAppendTarget(fileName) {
  const targetPath = join(process.cwd(), fileName)
  if (existsSync(targetPath)) {
    return targetPath
  }

  const projectRoot = process.env.PROJECT_ROOT
  if (projectRoot) {
    const sourcePath = join(projectRoot, fileName)
    if (existsSync(sourcePath)) {
      writeFileSync(targetPath, readFileSync(sourcePath, "utf-8"), "utf-8")
      return targetPath
    }
  }

  writeFileSync(targetPath, "", "utf-8")
  return targetPath
}

function writePromptResult(prompt) {
  const createExactFile = extractBetween(
    prompt,
    'Create a file named ',
    ' in the repository root with the exact text "',
  )
  const createExactText = extractBetween(
    prompt,
    ' in the repository root with the exact text "',
    '" on the first line.',
  )
  if (createExactFile && createExactText) {
    writeFileSync(join(process.cwd(), createExactFile), createExactText + "\\n", "utf-8")
    commitIfDirty()
    return 'Created requested file.'
  }

  const createContentFile = extractBetween(prompt, 'Create a file named ', ' with content "')
  const createContentText = extractBetween(prompt, ' with content "', '".')
  if (createContentFile && createContentText) {
    writeFileSync(join(process.cwd(), createContentFile), createContentText + "\\n", "utf-8")
    commitIfDirty()
    return 'Created requested file.'
  }

  const workflowFile = extractBetween(prompt, 'Create a file named ', ' in the repository root.')
  const workflowLine1 = extractLineAfter(prompt, '1. ')
  const workflowLine2 = extractLineAfter(prompt, '2. ')
  const workflowLine3 = extractLineAfter(prompt, '3. ')
  if (workflowFile && workflowLine1 && workflowLine2 && workflowLine3) {
    writeFileSync(
      join(process.cwd(), workflowFile),
      [workflowLine1, workflowLine2, workflowLine3].join("\\n") + "\\n",
      "utf-8",
    )
    commitIfDirty()
    return 'Created workflow file.'
  }

  const appendExactText = extractBetween(prompt, 'Append a new line with the exact text "', '" to ')
  const appendExactFile = extractLineAfter(prompt, '" to ')
  if (appendExactText && appendExactFile) {
    appendFileSync(ensureAppendTarget(appendExactFile), appendExactText + "\\n", "utf-8")
    commitIfDirty()
    return 'Appended requested line.'
  }

  const appendSimpleText = extractBetween(prompt, 'Append "', '" to ')
  const appendSimpleFile = extractLineAfter(prompt, '" to ')
  if (appendSimpleText && appendSimpleFile) {
    appendFileSync(ensureAppendTarget(appendSimpleFile), appendSimpleText + "\\n", "utf-8")
    commitIfDirty()
    return 'Appended requested line.'
  }

  return 'Completed requested work.'
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on("line", async (line) => {
  let request = null
  try {
    request = JSON.parse(line)
  } catch {
    return
  }

  const id = request?.id
  const type = request?.type
  const prompt = String(request?.message || "")

  if (type === "set_model" || type === "set_thinking_level") {
    console.log(JSON.stringify({ id, type: "response", command: type, success: true, data: {} }))
    return
  }

  if (type === "prompt") {
    let text = 'Completed requested work.'
    if (prompt.includes('PREPARE PLAN ONLY')) {
      text = '1. Update the requested file.\\n2. Verify the result.\\n3. Finish cleanly.'
    } else if (prompt.includes('force-manual')) {
      const vote = {
        status: 'needs_manual_review',
        summary: 'Manual review required.',
        bestCandidateIds: [],
        gaps: ['Manual inspection requested'],
        recommendedFinalStrategy: 'pick_best',
      }
      console.log(JSON.stringify({
        type: 'tool_execution_end',
        toolName: 'emit_best_of_n_vote',
        result: { details: vote },
      }))
      text = JSON.stringify(vote)
    } else if (prompt.toLowerCase().includes('review')) {
      const vote = {
        status: 'pass',
        summary: 'Looks good.',
        bestCandidateIds: ['candidate-1'],
        gaps: [],
        recommendedFinalStrategy: 'pick_best',
      }
      console.log(JSON.stringify({
        type: 'tool_execution_end',
        toolName: 'emit_best_of_n_vote',
        result: { details: vote },
      }))
      text = JSON.stringify(vote)
    } else {
      text = writePromptResult(prompt)
    }

    await sleep(750)

    console.log(JSON.stringify({ id, type: "response", command: "prompt", success: true, data: {} }))
    console.log(JSON.stringify({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_complete",
        text,
        messageId: "msg-" + Date.now(),
      },
    }))
    console.log(JSON.stringify({ type: "agent_end" }))
    return
  }

  if (type === "get_messages") {
    console.log(JSON.stringify({
      id,
      type: "response",
      command: "get_messages",
      success: true,
      data: { messages: [{ role: 'assistant', text: 'mock snapshot' }] },
    }))
    return
  }

  console.log(JSON.stringify({ id, type: "response", command: type || "unknown", success: true, data: {} }))
})
`

  writeFileSync(filePath, script, 'utf-8')
  chmodSync(filePath, 0o755)
  return filePath
}

export function stopChildProcess(child: ChildProcess | undefined): void {
  if (child && !child.killed) {
    child.kill('SIGTERM')
  }
}