/**
 * E2E Test Fixtures
 *
 * Simple fixtures for Playwright tests. Server is managed by webServer config.
 */

import { test as base, expect } from "@playwright/test';
import { readFileSync, existsSync } from "fs';
import { tmpdir } from "os';
import { join } from "path';

export interface TestContext {
  baseURL: string;
}

/**
 * Get the test project directory
 */
export function getTestProjectDir(): string | null {
  try {
    const markerFile = join(tmpdir(), 'pi-e2e-current-project');
    if (existsSync(markerFile)) {
      return readFileSync(markerFile, 'utf-8').trim();
    }
  } catch {}
  return null;
}

// Simple fixtures - server is managed by webServer config
type Fixtures = {
  testContext: TestContext;
};

export const test = base.extend<Fixtures>({
  testContext: async ({ baseURL }, use) => {
    const projectDir = getTestProjectDir();
    if (!projectDir) {
      throw new Error('Test environment not prepared. Run: bun run tests/e2e/prepare.ts');
    }

    await use({
      baseURL: baseURL!,
    });
  },
});

export { expect };
