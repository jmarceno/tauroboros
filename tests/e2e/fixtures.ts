/**
 * E2E Test Fixtures
 *
 * Simple fixtures for Playwright tests. Server is managed by webServer config.
 */

import { test as base, expect } from '@playwright/test'

export interface TestContext {
  baseURL: string;
}

// Simple fixtures - server is managed by webServer config
type Fixtures = {
  testContext: TestContext;
}

export const test = base.extend<Fixtures>({
  testContext: async ({ baseURL }, use) => {
    await use({
      baseURL: baseURL!,
    })
  },
})

export { expect }
