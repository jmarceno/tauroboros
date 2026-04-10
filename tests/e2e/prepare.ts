/**
 * Pre-test setup script
 * 
 * Prepares the test environment by creating a temp directory with all necessary files
 * Usage: bun run tests/e2e/prepare.ts [container]
 */

import { mkdtempSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync, readFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');
const PROJECT_ROOT = resolve(__dirname, '../..');

const useContainer = process.argv.includes('container');

console.log(`[PREPARE] Setting up test environment${useContainer ? ' with container mode' : ''}...`);
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
const itemsToCopy = ['src', 'docker', 'skills', 'package.json', 'bun.lock', 'bunfig.toml'];
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

// Initialize git repo in the temp project
console.log('[PREPARE] Initializing git repository...');
const repoDir = join(projectDir, 'repo');
mkdirSync(repoDir, { recursive: true });
execSync('git init', { cwd: repoDir, stdio: 'ignore' });
execSync('git config user.email "test@example.com"', { cwd: repoDir, stdio: 'ignore' });
execSync('git config user.name "Test User"', { cwd: repoDir, stdio: 'ignore' });
writeFileSync(join(repoDir, 'README.md'), '# Test\n');
execSync('git add .', { cwd: repoDir, stdio: 'ignore' });
execSync('git commit -m "init"', { cwd: repoDir, stdio: 'ignore' });

// Create .pi directory and settings file
const piDir = join(projectDir, '.pi');
mkdirSync(piDir, { recursive: true });

const dbPath = join(projectDir, 'tasks.db');

const settings = {
  skills: {
    localPath: join(projectDir, 'skills'),
    autoLoad: true,
    allowGlobal: false,
  },
  project: {
    name: 'pi-easy-workflow-test',
    type: 'workflow',
  },
  workflow: {
    server: {
      port: 3000,
      dbPath: dbPath,
    },
    runtime: {
      mode: useContainer ? 'container' : 'native',
      piBin: 'pi',
      piArgs: '--mode rpc --no-extensions',
    },
    container: {
      enabled: useContainer,
      image: 'pi-agent:alpine',
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
};

writeFileSync(join(piDir, 'settings.json'), JSON.stringify(settings, null, 2));
console.log(`[PREPARE] ✓ Settings created${useContainer ? ' with container mode' : ''}`);

// Write the project dir to a marker file
const markerFile = join(tmpdir(), 'pi-e2e-current-project');
writeFileSync(markerFile, projectDir);

console.log(`[PREPARE] ✓ Environment ready`);
console.log(`[PREPARE] Location: ${projectDir}`);
console.log(`[PREPARE] Run: cd "${projectDir}" && bun run start`);
