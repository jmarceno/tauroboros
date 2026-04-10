import { defineConfig, devices } from '@playwright/test';
import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Check container requirements for real workflow test
const isRealWorkflowTest = process.env.TEST_TYPE === 'real-workflow';

if (isRealWorkflowTest) {
  let hasPodman = false;
  let hasPiAgentImage = false;
  
  try {
    execSync('podman --version', { stdio: 'pipe' });
    hasPodman = true;
  } catch {}
  
  if (hasPodman) {
    try {
      const result = execSync('podman images pi-agent:alpine -q', { encoding: 'utf-8', stdio: 'pipe' });
      hasPiAgentImage = result.trim().length > 0;
    } catch {}
  }
  
  if (!hasPodman || !hasPiAgentImage) {
    console.error('❌ REAL WORKFLOW TEST FAILED: Container infrastructure not available');
    if (!hasPodman) console.error('   - Podman not found');
    if (!hasPiAgentImage) console.error('   - pi-agent:alpine image not found');
    console.error('   Run: bun run container:setup');
    process.exit(1);
  }
  console.log('✓ Container infrastructure verified\n');
}

// Get test project directory from marker file
function getTestProjectDir(): string | null {
  try {
    const markerFile = join(tmpdir(), 'pi-e2e-current-project');
    if (existsSync(markerFile)) {
      return readFileSync(markerFile, 'utf-8').trim();
    }
  } catch {}
  return null;
}

const testProjectDir = getTestProjectDir();

// Build webServer config
let webServerConfig = undefined;

if (testProjectDir) {
  // Start server exactly like users would: cd to project and run bun run start
  // We use shell: true to ensure PATH is properly inherited
  const command = `bun run start`;
  
  webServerConfig = {
    command,
    cwd: testProjectDir,
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
    },
  };
  
  console.log(`[Playwright] Server will start from: ${testProjectDir}`);
  console.log(`[Playwright] PATH will be: ${process.env.PATH}`);
} else {
  console.error('[Playwright] Warning: Test environment not prepared. Run: bun run tests/e2e/prepare.ts');
}

export default defineConfig({
  testDir: './tests/e2e',
  timeout: isRealWorkflowTest ? 600000 : 120000,
  expect: {
    timeout: 10000,
  },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    headless: true,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: webServerConfig,
});
