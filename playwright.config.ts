import { defineConfig, devices } from '@playwright/test';
import { existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Get test project directory from marker file
function getTestProjectDir(): string | null {
  try {
    const markerFile = join(tmpdir(), 'pi-e2e-current-project');
    if (existsSync(markerFile)) {
      return readFileSync(markerFile, 'utf-8').trim();
    }
  } catch (err) {
    console.debug(`[playwright.config] Could not read test project marker file:`, err);
  }
  return null;
}

const testProjectDir = getTestProjectDir();

// Support port configuration via environment variable
// Default to 3000 for Playwright webServer URL matching
// Use TEST_SERVER_PORT env var to override
const testServerPort = process.env.TEST_SERVER_PORT ? parseInt(process.env.TEST_SERVER_PORT, 10) : 3000;

// Build webServer config
let webServerConfig = undefined;
let baseURL = 'http://localhost:3000'; // Default for backward compatibility

if (testProjectDir) {
  // Start server exactly like users would: cd to project and run bun run start
  // We use shell: true to ensure PATH is properly inherited
  const command = `bun run start`;

  if (testServerPort > 0) {
    baseURL = `http://localhost:${testServerPort}`;
    console.log(`[Playwright] Using port: ${testServerPort}`);
  }

  webServerConfig = {
    command,
    cwd: testProjectDir,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      USE_MOCK_LLM: 'true',
    },
  };

  console.log(`[Playwright] Server will start from: ${testProjectDir}`);
  console.log(`[Playwright] baseURL: ${baseURL}`);
} else {
  console.error('[Playwright] Warning: Test environment not prepared. Run: bun run tests/e2e/prepare.ts');
}

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 120000,
  expect: {
    timeout: 10000,
  },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: baseURL,
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
