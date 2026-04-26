import { test, expect, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execSync, spawn, type ChildProcess } from 'child_process'
import { createTaskViaUI, getTaskCard, gotoKanban } from './ui-helpers'

const WORKFLOW_TIMEOUT_MS = 10 * 60 * 1000

type WorkflowTaskState = {
  name: string
  status: string
}

test.describe('REAL LLM Workflow (validates structured output extension)', () => {
  test.setTimeout(WORKFLOW_TIMEOUT_MS)

  let projectDir: string
  let serverProcess: ChildProcess
  let serverPort: number

  test.beforeAll(async () => {
    // Create temp project directory
    projectDir = mkdtempSync(join(tmpdir(), 'pi-e2e-real-llm-'))
    console.log(`[REAL-LLM] Created: ${projectDir}`)

    // Copy project files
    const projectRoot = join(import.meta.dirname, '../..')
    const itemsToCopy = ['src', 'docker', 'skills', 'package.json', 'bun.lock', 'bunfig.toml']
    for (const item of itemsToCopy) {
      const src = join(projectRoot, item)
      const dest = join(projectDir, item)
      if (existsSync(src)) {
        cpSync(src, dest, { recursive: true, force: true })
      }
    }

    // Also copy extensions directory so the extension file is available
    const extSrc = join(projectRoot, 'extensions')
    const extDest = join(projectDir, 'extensions')
    if (existsSync(extSrc)) {
      cpSync(extSrc, extDest, { recursive: true, force: true })
    }

    // Install Bun dependencies
    execSync('bun install', { cwd: projectDir, stdio: 'pipe' })

    // Build Kanban frontend
    const kanbanDir = join(projectDir, 'src/kanban-solid')
    execSync('npm install', { cwd: kanbanDir, stdio: 'pipe' })
    execSync('npm run build', { cwd: kanbanDir, stdio: 'pipe' })

    // Generate embedded assets (needed for the extension to be discoverable)
    execSync('bun run scripts/generate-embedded-assets.ts', { cwd: projectDir, stdio: 'pipe' })
    execSync('bun run scripts/generate-version.ts', { cwd: projectDir, stdio: 'pipe' })

    // Initialize git repo
    execSync('git init', { cwd: projectDir, stdio: 'ignore' })
    execSync('git config user.email "test@example.com"', { cwd: projectDir, stdio: 'ignore' })
    execSync('git config user.name "Test User"', { cwd: projectDir, stdio: 'ignore' })

    writeFileSync(join(projectDir, '.gitignore'), [
      '.pi/', '.tauroboros/', 'tasks.db', 'tasks.db-shm', 'tasks.db-wal',
      'node_modules/', '.worktrees/',
    ].join('\n') + '\n')

    writeFileSync(join(projectDir, 'README.md'), '# Test\n')
    execSync('git add .', { cwd: projectDir, stdio: 'ignore' })
    execSync('git commit -m "init"', { cwd: projectDir, stdio: 'ignore' })

    // Create .tauroboros directory with settings
    const tauroborosDir = join(projectDir, '.tauroboros')
    mkdirSync(tauroborosDir, { recursive: true })

    // Use port 0 for dynamic assignment, but we need a known port for Playwright
    // Let the server pick, then we read it from settings
    serverPort = 3789

    const settings = {
      project: { name: 'tauroboros-test', type: 'workflow' },
      workflow: {
        server: {
          port: serverPort,
          dbPath: join(projectDir, 'tasks.db'),
        },
        container: {
          enabled: false, // Use native mode for simplicity
        },
      },
      // Do NOT set model - let Pi use its default configured model
      branch: 'master',
      maxReviews: 2,
    }

    writeFileSync(join(tauroborosDir, 'settings.json'), JSON.stringify(settings, null, 2))
    console.log(`[REAL-LLM] Settings created at ${tauroborosDir}/settings.json`)

    // Start the server
    serverProcess = spawn('bun', ['run', 'start'], {
      cwd: projectDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: process.env.PATH!,
        HOME: process.env.HOME!,
        SERVER_PORT: String(serverPort),
        // Ensure we do NOT use mock LLM
        USE_MOCK_LLM: undefined,
      },
    })

    serverProcess.stdout?.on('data', (data: Buffer) => {
      const text = data.toString()
      console.log(`[SERVER] ${text.trim()}`)
    })

    serverProcess.stderr?.on('data', (data: Buffer) => {
      const text = data.toString()
      if (text.includes('Error') || text.includes('error') || text.includes('Failed')) {
        console.error(`[SERVER-ERR] ${text.trim()}`)
      }
    })

    // Wait for server to be ready
    const maxWait = 30000
    const startTime = Date.now()
    let ready = false

    while (Date.now() - startTime < maxWait) {
      try {
        const response = await fetch(`http://localhost:${serverPort}/api/health`)
        if (response.ok) {
          ready = true
          break
        }
      } catch {
        // Server not ready yet
      }
      await new Promise(r => setTimeout(r, 500))
    }

    if (!ready) {
      // Try reading settings to see what port was assigned
      try {
        const savedSettings = JSON.parse(readFileSync(join(tauroborosDir, 'settings.json'), 'utf-8'))
        const actualPort = savedSettings?.workflow?.server?.port
        if (actualPort && actualPort !== serverPort) {
          console.log(`[REAL-LLM] Server assigned port ${actualPort}, retrying...`)
          serverPort = actualPort
          const retryStart = Date.now()
          while (Date.now() - retryStart < 15000) {
            try {
              const response = await fetch(`http://localhost:${serverPort}/api/health`)
              if (response.ok) { ready = true; break }
            } catch { /* retry */ }
            await new Promise(r => setTimeout(r, 500))
          }
        }
      } catch { /* ignore */ }
    }

    if (!ready) {
      throw new Error(`Server did not start within ${maxWait}ms on port ${serverPort}`)
    }

    console.log(`[REAL-LLM] Server ready on port ${serverPort}`)
  })

  test.afterAll(() => {
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill('SIGTERM')
    }
    // Clean up temp project
    try {
      rmSync(projectDir, { recursive: true, force: true })
    } catch { /* ignore cleanup errors */ }
  })

  test('runs a single task with review using real LLM to validate structured output extension', async ({ page }) => {
    // Navigate to the kanban
    await page.goto(`http://localhost:${serverPort}`)
    await page.getByRole('tab', { name: 'Kanban' }).click()
    await expect(page.locator('.kanban-wrapper')).toBeVisible({ timeout: 10000 })

    const taskName = `real-llm-test-${Date.now()}`

    // Create a simple task with review enabled
    await createTaskViaUI(page, {
      name: taskName,
      prompt: 'Create a file named hello_world.txt with content "Hello, World!"',
      review: true,
    })

    // Start the task
    const taskCard = getTaskCard(page, taskName)
    await expect(taskCard).toBeVisible({ timeout: 20000 })

    const startButton = taskCard.locator('button[title="Start this task"]').first()
    await expect(startButton).toBeVisible({ timeout: 15000 })
    await startButton.click()

    // Confirm execution graph if visible
    const modal = page.locator('.modal-overlay').last()
    const confirmBtn = modal.getByRole('button', { name: 'Start Task' })
    if (await confirmBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await confirmBtn.click()
    }

    // Wait for completion (executing -> review -> done or failed)
    const startedAt = Date.now()
    let lastStatusLog = Date.now()

    while (Date.now() - startedAt < WORKFLOW_TIMEOUT_MS) {
      const state = await readTaskState(page, taskName)

      if (Date.now() - lastStatusLog > 30000) {
        console.log(`[REAL-LLM] Status: ${taskName}=${state.status}`)
        lastStatusLog = Date.now()
      }

      if (state.status === 'done') {
        console.log(`[REAL-LLM] Task completed successfully!`)
        return
      }

      if (state.status === 'failed' || state.status === 'stuck') {
        // Check for error details
        const errorEl = page.locator('.error-message, [class*="error"]').first()
        const errorText = await errorEl.isVisible().then(v => v ? errorEl.textContent() : 'unknown')
        throw new Error(`Task ended in ${state.status}: ${errorText}`)
      }

      await page.waitForTimeout(3000)
    }

    const finalState = await readTaskState(page, taskName)
    throw new Error(`Task timed out: ${finalState.status}`)
  })
})

async function readTaskState(page: Page, taskName: string): Promise<WorkflowTaskState> {
  const taskCard = getTaskCard(page, taskName)
  if (await taskCard.isVisible().catch(() => false)) {
    const status = await taskCard.getAttribute('data-task-status')
    if (status) return { name: taskName, status }
  }

  for (const status of ['template', 'backlog', 'queued', 'executing', 'review', 'code-style', 'done']) {
    const columnMatch = page.locator(`[data-status="${status}"] .task-card`).filter({ hasText: taskName }).first()
    if (await columnMatch.isVisible().catch(() => false)) {
      return { name: taskName, status }
    }
  }

  return { name: taskName, status: 'unknown' }
}

interface WorkflowTaskState {
  name: string
  status: string
}