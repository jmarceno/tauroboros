import { defineConfig, devices } from '@playwright/test'

const testServerPort = process.env.TEST_SERVER_PORT ? parseInt(process.env.TEST_SERVER_PORT, 10) : 3000
const baseURL = `http://localhost:${testServerPort}`

const webServerConfig = {
  command: 'bash ./scripts/start-playwright-ui.sh',
  cwd: process.cwd(),
  url: baseURL,
  reuseExistingServer: false,
  timeout: 180000,
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TEST_SERVER_PORT: String(testServerPort),
  },
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
})
