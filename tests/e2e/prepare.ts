/**
 * Pre-test setup script
 *
 * Prepares the test environment by creating a temp directory with all necessary files
 * Usage: bun run tests/e2e/prepare.ts [container]
 */

import { mkdtempSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync, readFileSync, statSync } from "fs';
import { tmpdir } from "os';
import { join, resolve } from "path';
import { execSync } from "child_process';
import { fileURLToPath } from "url';
import { BASE_IMAGES } from "../../src/config/base-images.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');
const PROJECT_ROOT = resolve(__dirname, '../..');

// Container mode is ALWAYS enabled for E2E tests
const useContainer = true;

// Mock LLM mode - uses mock server instead of real API calls (default: true for e2e tests)
const useMockLLM = process.env.USE_MOCK_LLM !== 'false';

console.log(`[PREPARE] Setting up test environment${useContainer ? ' with container mode' : ''}${useMockLLM ? ' with mock LLM' : ''}...`);
console.log(`[PREPARE] Project root: ${PROJECT_ROOT}`);

// Clean up any previous test projects
try {
  const prevMarker = join(tmpdir(), 'pi-e2e-current-project');
  if (existsSync(prevMarker)) {
    const prevDir = readFileSync(prevMarker, 'utf-8').trim();
    if (prevDir && prevDir.startsWith(tmpdir())) {
      console.log(`[PREPARE] Cleaning up previous: ${prevDir}`);
      rmSync(prevDir, { recursive: true, force: true });
    }
  }
} catch (e) {
  console.warn('[PREPARE] Warning: Could not clean up previous test:', e);
}

// Create temporary project directory
const projectDir = mkdtempSync(join(tmpdir(), 'pi-e2e-'));
console.log(`[PREPARE] Created: ${projectDir}`);

// Copy the entire project structure
console.log('[PREPARE] Copying project files...');
const itemsToCopy = ['src', 'docker', 'skills', 'mock-llm-server', 'package.json', 'bun.lock', 'bunfig.toml'];
for (const item of itemsToCopy) {
  const src = join(PROJECT_ROOT, item);
  const dest = join(projectDir, item);

  try {
    if (!existsSync(src)) {
      console.warn(`[PREPARE] Source not found: ${src}`);
      continue;
    }

    const stats = statSync(src);
    if (stats.isDirectory()) {
      mkdirSync(dest, { recursive: true });
      cpSync(src, dest, { recursive: true, force: true });
    } else {
      cpSync(src, dest, { force: true });
    }
    console.log(`[PREPARE]  ✓ ${item}`);
  } catch (e) {
    console.warn(`[PREPARE]  ✗ ${item}: ${e}`);
  }
}

// Initialize git repo in the temp project (at root, not in subdirectory)
console.log('[PREPARE] Initializing git repository...');
execSync('git init', { cwd: projectDir, stdio: 'ignore' });
execSync('git config user.email "test@example.com"', { cwd: projectDir, stdio: 'ignore' });
execSync('git config user.name "Test User"', { cwd: projectDir, stdio: 'ignore' });

// Create .gitignore before initial commit to exclude runtime files
writeFileSync(join(projectDir, '.gitignore'), [
  '.pi/',
  '.tauroboros/',
  'tasks.db',
  'tasks.db-shm',
  'tasks.db-wal',
  'node_modules/',
  '.worktrees/',
].join('\n') + '\n');

writeFileSync(join(projectDir, 'README.md'), '# Test\n');
execSync('git add .', { cwd: projectDir, stdio: 'ignore' });
execSync('git commit -m "init"', { cwd: projectDir, stdio: 'ignore' });

// Create .tauroboros directory for infrastructure settings
const tauroborosDir = join(projectDir, '.tauroboros');
mkdirSync(tauroborosDir, { recursive: true });

const dbPath = join(projectDir, 'tasks.db');

// Support dynamic port assignment for parallel test runs
// Default to 3000 to match Playwright's expected baseURL
// Use TEST_SERVER_PORT env var to override for parallel test runs
const testServerPort = process.env.TEST_SERVER_PORT ? parseInt(process.env.TEST_SERVER_PORT, 10) : 3000;

const settings = {
  skills: {
    localPath: join(projectDir, 'skills'),
    autoLoad: true,
    allowGlobal: false,
  },
  project: {
    name: 'tauroboros-test',
    type: 'workflow',
  },
  workflow: {
    server: {
      port: testServerPort,
      dbPath: dbPath,
    },
    container: {
      enabled: useContainer,
      piBin: 'pi',
      piArgs: '--mode rpc',
      image: BASE_IMAGES.piAgent,
      imageSource: 'dockerfile',
      dockerfilePath: join(projectDir, 'docker/pi-agent/Dockerfile'),
      registryUrl: null,
      autoPrepare: true,
      memoryMb: 512,
      cpuCount: 1,
      portRangeStart: 30000,
      portRangeEnd: 40000,
    },
  },
  // Model configuration - will be set via API in the test
  branch: 'master',
  maxReviews: 2,  // Enable reviews for E2E tests (tasks can override with maxReviewRunsOverride)
};

writeFileSync(join(tauroborosDir, 'settings.json'), JSON.stringify(settings, null, 2));
console.log(`[PREPARE] ✓ Settings created${useContainer ? ' with container mode' : ''}`);

// Start mock LLM server if enabled
if (useMockLLM) {
  console.log('[PREPARE] Starting mock LLM server...');

  const { MockServerManager } = await import('../../src/runtime/mock-server-manager.ts');
  const mockServer = new MockServerManager(9999);

  try {
    const mockLlmServerPath = join(PROJECT_ROOT, 'mock-llm-server');
    await mockServer.start(mockLlmServerPath);
    console.log('[PREPARE] ✓ Mock LLM server started on port 9999');

    // Generate models.json for the mock server
    const agentDir = join(tauroborosDir, 'agent');
    mkdirSync(agentDir, { recursive: true });

    const modelsJson = {
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
    };

    writeFileSync(join(agentDir, 'models.json'), JSON.stringify(modelsJson, null, 2));
    console.log('[PREPARE] ✓ models.json created for mock LLM');

    // Write mock server port to marker file for cleanup
    const mockServerMarker = join(tmpdir(), 'pi-e2e-mock-server');
    writeFileSync(mockServerMarker, JSON.stringify({ port: 9999, pid: process.pid }));
  } catch (err) {
    console.error('[PREPARE] ✗ Failed to start mock LLM server:', err);
  }
}

// Write the project dir to a marker file
const markerFile = join(tmpdir(), 'pi-e2e-current-project');
writeFileSync(markerFile, projectDir);

console.log(`[PREPARE] ✓ Environment ready`);
console.log(`[PREPARE] Location: ${projectDir}`);
console.log(`[PREPARE] Run: cd "${projectDir}" && bun run start`);
