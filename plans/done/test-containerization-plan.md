# Test Containerization Plan

**Objective:** Run all tests (unit + e2e) inside containers for isolation and GitHub CI compatibility, standardized on **Ubuntu 26.04 LTS**.

**Date:** 2026-04-16

---

## Executive Summary

This plan has two major phases:

1. **Phase 0: Ubuntu Migration** - Replace Alpine with Ubuntu 26.04 everywhere, introduce configurable base image constant
2. **Phase 1: Test Containerization** - Run tests inside containers with nested container support

**Key Decision:** We will **NOT** hardcode `ubuntu:26.04` anywhere. Instead, we will introduce a centralized constant that can be changed once to migrate to a future base image.

---

## Phase 0: Ubuntu 26.04 Migration

### Why Ubuntu Instead of Alpine

| Aspect | Alpine | Ubuntu 26.04 |
|--------|--------|--------------|
| Base size | 5MB | ~80MB |
| Total pi-agent | ~500MB | ~600MB (Chromium dominates anyway) |
| Init system | OpenRC (limited) | systemd (full) |
| cgroup support | Poor | Excellent |
| Package ecosystem | Limited (apk) | Extensive (apt) |
| musl issues | Yes (binary compatibility) | None (glibc) |
| Container nesting | Problematic | Just works |
| Security updates | Community-driven | Canonical-backed |

**Size reality:** Chromium is ~400MB of the image. The 100MB base difference is negligible.

---

### Locations Where Alpine is Hardcoded

#### Critical (Must Change)

| File | Current Alpine Reference | Action Required |
|------|-------------------------|-----------------|
| `docker/pi-agent/Dockerfile` | `FROM alpine:3.23.3` | Change to Ubuntu base |
| `docker/pi-agent/Dockerfile` | `apk add --no-cache ...` | Change to `apt-get` |
| `docker/pi-agent/Dockerfile` | `/bin/sh` assumes busybox | May need bash installed |
| `mock-llm-server/Dockerfile` | `FROM node:20-alpine` | Change to `node:26-ubuntu` |
| `scripts/setup-e2e-tests.sh` | `podman build ... alpine` | Update image name reference |
| `src/runtime/container-manager.ts` | `"pi-agent:alpine"` | Make configurable |
| `tests/e2e/prepare.ts` | Image name hardcoded | Make configurable |

#### Medium (May Need Changes)

| File | Issue | Action |
|------|-------|--------|
| `src/config/container-profiles.json` | May reference Alpine packages | Review profiles |
| `AGENTS.md` | Alpine references | Update documentation |
| `README.md` | Alpine mentions | Update documentation |
| `docker/pi-agent/start.sh` (if exists) | Alpine-specific commands | Change to POSIX/sh |

#### Low (Should Review)

| File | Issue |
|------|-------|
| Any shell scripts in `scripts/` | May use `apk` |
| Any documentation mentioning Alpine | Update |

---

### The Configurable Base Image Constant

Create a single source of truth for the base image:

```typescript
// src/config/base-images.ts
export const BASE_IMAGES = {
  // The PRIMARY base image for all containers
  // Change this single constant to migrate to a new base
  ubuntu: 'ubuntu:26.04',

  // Derived images - these are computed, not hardcoded
  piAgent: 'pi-agent:latest',       // Built from docker/pi-agent/Dockerfile
  mockLlm: 'mock-llm-server:latest', // Built from mock-llm-server/Dockerfile
  testRunner: 'test-runner:latest',   // Built from docker/test-runner/Dockerfile
} as const;

// For cases where we need the raw base (e.g., Dockerfile FROM)
export const RAW_BASE_IMAGE = BASE_IMAGES.ubuntu;

// Legacy compatibility - to be removed after migration
export const LEGACY_ALPINE_IMAGE = 'pi-agent:alpine';
```

**Usage in Code:**

```typescript
// container-manager.ts
import { BASE_IMAGES } from '../config/base-images.ts';

const imageName = config.imageName || BASE_IMAGES.piAgent;
```

**Usage in Dockerfiles:**

```dockerfile
# docker/pi-agent/Dockerfile
# syntax=docker/dockerfile:1
ARG BASE_IMAGE=ubuntu:26.04
FROM ${BASE_IMAGE}

# Or hardcoded with comment explaining the constant:
# Base image defined in src/config/base-images.ts
FROM ubuntu:26.04
```

**Usage in Scripts:**

```bash
#!/bin/bash
# Base image is defined in src/config/base-images.ts
# This script reads from there to ensure consistency

PI_AGENT_IMAGE=$(node -e "console.log(require('./src/config/base-images.ts').BASE_IMAGES.piAgent)")
podman build -t "${PI_AGENT_IMAGE}" -f docker/pi-agent/Dockerfile .
```

---

### Phase 0 Implementation Steps

#### Step 0.1: Create Base Image Configuration Module

Create `src/config/base-images.ts`:

```typescript
export const BASE_IMAGES = {
  ubuntu: process.env.UBUNTU_BASE_IMAGE || 'ubuntu:26.04',
  piAgent: 'pi-agent:latest',
  mockLlm: 'mock-llm-server:latest',
  testRunner: 'test-runner:latest',
} as const;

export const CONTAINER_DEFAULTS = {
  networkMode: 'bridge',
  memoryMb: 512,
  cpuCount: 1,
} as const;
```

#### Step 0.2: Update Dockerfiles for Ubuntu 26.04

**`docker/pi-agent/Dockerfile`:**

```dockerfile
# Before (Alpine):
# FROM alpine:3.23.3
# RUN apk add --no-cache ...

# After (Ubuntu):
FROM ubuntu:26.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PI_OFFLINE=1

RUN apt-get update && apt-get install -y \
    git \
    openssh-client \
    curl \
    bash \
    ca-certificates \
    gnupg \
    lsb-release \
    chromium-browser \
    chromium-sandbox \
    libglib2.0-0 \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Install Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

# Install Pi Coding Agent
RUN npm install -g @mariozechner/pi-coding-agent

WORKDIR /workspace
```

**`mock-llm-server/Dockerfile`:**

```dockerfile
# Before: node:20-alpine
# After: node:26-ubuntu

FROM node:26-ubuntu

WORKDIR /app
COPY package*.json ./
RUN npm install

COPY dist ./dist

EXPOSE 9999
CMD ["node", "dist/index.js"]
```

#### Step 0.3: Update Container Manager

```typescript
// src/runtime/container-manager.ts
import { BASE_IMAGES, CONTAINER_DEFAULTS } from '../config/base-images.ts';

export class PiContainerManager {
  private readonly imageName: string;

  constructor(imageName?: string) {
    this.imageName = imageName || BASE_IMAGES.piAgent;
  }
}
```

#### Step 0.4: Update All Scripts

```bash
# scripts/setup-e2e-tests.sh
# Before:
#   podman build -t pi-agent:alpine ...

# After:
PI_AGENT_IMAGE=$(node -e "console.log(require('../src/config/base-images.ts').BASE_IMAGES.piAgent)")
podman build -t "${PI_AGENT_IMAGE}" ...
```

#### Step 0.5: Update Test Files

```typescript
// tests/e2e/prepare.ts
import { BASE_IMAGES } from '../../src/config/base-images.ts';

const settings = {
  // ...
  container: {
    image: BASE_IMAGES.piAgent,
    // ...
  },
};
```

#### Step 0.6: Verify and Test

```bash
# Build new pi-agent image
podman build -t pi-agent:latest -f docker/pi-agent/Dockerfile .

# Run basic container test
podman run --rm pi-agent:latest bash -c "bun --version && git --version"

# Run existing e2e tests (should still work)
bun run test:e2e
```

---

### Phase 0 Files to Create/Modify

#### New Files
| File | Purpose |
|------|---------|
| `src/config/base-images.ts` | Single source of truth for image names |
| `docker/pi-agent/Dockerfile.ubuntu` | Draft Ubuntu Dockerfile (for testing) |

#### Modified Files
| File | Changes |
|------|---------|
| `docker/pi-agent/Dockerfile` | Alpine → Ubuntu, apk → apt-get |
| `mock-llm-server/Dockerfile` | node:20-alpine → node:26-ubuntu |
| `src/runtime/container-manager.ts` | Use BASE_IMAGES constant |
| `src/runtime/container-manager.ts` | Remove "pi-agent:alpine" hardcode |
| `tests/e2e/prepare.ts` | Use BASE_IMAGES constant |
| `scripts/setup-e2e-tests.sh` | Use configurable image name |
| `scripts/setup-e2e-tests.sh` | Remove Alpine references |
| `scripts/cleanup-gvisor.sh` | Review for Alpine references |
| `src/config/container-profiles.json` | Review Alpine packages |
| `AGENTS.md` | Update Alpine mentions |
| `README.md` | Update Alpine mentions |

#### Documentation to Update
| File | Changes |
|------|---------|
| `AGENTS.md` | Change "alpine" to "ubuntu" in instructions |
| `README.md` | Change container build instructions |

---

## Phase 1: Test Containerization

### Target Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     GITHUB ACTIONS VM (Ubuntu)                   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │            test-runner container (Ubuntu 26.04)            │   │
│  │                                                              │   │
│  │  ┌─────────────────┐      ┌─────────────────────────┐  │   │
│  │  │  Test Runner    │      │   pi-agent container     │  │   │
│  │  │  (bun + playwright)     │   (Ubuntu, nested)       │  │   │
│  │  │                  │  spawn│                         │  │   │
│  │  │  - unit tests   │ ─────▶│  - pi coding agent     │  │   │
│  │  │  - e2e tests    │        │  - mock LLM client    │  │   │
│  │  │  - mock LLM     │        └─────────────────────────┘  │   │
│  │  │  (port 9999)    │                                    │   │
│  │  │                  │        ┌─────────────────────────┐  │   │
│  │  │                  │        │   Mock LLM Server     │  │   │
│  │  │                  │        │   (port 9999)        │  │   │
│  │  │                  │        └─────────────────────────┘  │   │
│  │  └─────────────────┘                                      │   │
│  │                                                              │   │
│  │  [Podman rootless with --privileged for nesting]            │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

### Implementation Steps

#### Step 1.1: Create Test Runner Dockerfile

**`docker/test-runner/Dockerfile`:**

```dockerfile
FROM ubuntu:26.04

ENV DEBIAN_FRONTEND=noninteractive

# Install podman
RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    gnupg \
    lsb-release \
    && curl -fsSL https://download.opensuse.org/repositories/devel:kubic:libcontainers:stable/xUbuntu_26.04/Release.key | gpg --dearmor -o /usr/share/keyrings/kubic-containers-archive-keyring.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/kubic-containers-archive-keyring.gpg] https://download.opensuse.org/repositories/devel:kubic:libcontainers:stable/xUbuntu_26.04/ /" > /etc/apt/sources.list.d/devel:kubic:libcontainers:stable.list \
    && apt-get update \
    && apt-get install -y podman \
    && rm -rf /var/lib/apt/lists/*

# Install Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

# Install Playwright and browsers
RUN apt-get update && apt-get install -y npm \
    && npm install -g playwright \
    && npx playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

# Install additional tools
RUN apt-get update && apt-get install -y \
    git \
    vim \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

# Entry point will be script that starts mock LLM + runs tests
```

#### Step 1.2: Create Test Runner Entrypoint

**`docker/test-runner/entrypoint.sh`:**

```bash
#!/bin/bash
set -e

echo "[test-runner] Starting..."

# Start mock LLM server in background
echo "[test-runner] Starting mock LLM server..."
cd /workspace/mock-llm-server
npm run build
node dist/index.js &
MOCK_PID=$!

# Wait for mock server to be ready
echo "[test-runner] Waiting for mock LLM server..."
for i in {1..30}; do
    if curl -s http://localhost:9999/health > /dev/null 2>&1; then
        echo "[test-runner] Mock LLM server ready"
        break
    fi
    sleep 1
done

# Run the test command passed as arguments
echo "[test-runner] Running: $@"
eval "$@"

# Cleanup
kill $MOCK_PID 2>/dev/null || true
```

#### Step 1.3: Create GitHub Actions Workflow

**`.github/workflows/ci.yml`:**

```yaml
name: CI Tests

on:
  push:
    branches: [main, develop]
  pull_request:

env:
  UBUNTU_BASE_IMAGE: 'ubuntu:26.04'

jobs:
  # Phase 0: Validate Ubuntu Migration
  validate-migration:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Build pi-agent (Ubuntu)
        run: |
          podman build \
            --build-arg BASE_IMAGE=ubuntu:26.04 \
            -t pi-agent:ubuntu-test \
            -f docker/pi-agent/Dockerfile .

      - name: Build mock-llm-server
        run: |
          podman build -t mock-llm-server:test -f mock-llm-server/Dockerfile mock-llm-server/

      - name: Test pi-agent container
        run: |
          podman run --rm pi-agent:ubuntu-test bash -c "bun --version"

  # Phase 1: Unit Tests in Container
  unit-tests:
    runs-on: ubuntu-latest
    container:
      image: test-runner:latest
      options: |
        --privileged
        --cgroup-manager=cgroupfs
        --security-opt seccomp=unconfined
    steps:
      - uses: actions/checkout@v4

      - name: Build pi-agent image
        run: podman build -t pi-agent:latest -f docker/pi-agent/Dockerfile .

      - name: Install dependencies
        run: bun install

      - name: Run unit tests
        run: bun test

  # Phase 1: E2E Tests with Mock LLM
  e2e-mock-tests:
    runs-on: ubuntu-latest
    container:
      image: test-runner:latest
      options: |
        --privileged
        --cgroup-manager=cgroupfs
        --security-opt seccomp=unconfined
    steps:
      - uses: actions/checkout@v4

      - name: Build images
        run: |
          podman build -t pi-agent:latest -f docker/pi-agent/Dockerfile .
          podman build -t mock-llm-server:latest -f mock-llm-server/Dockerfile mock-llm-server/

      - name: Build kanban
        run: bun run kanban:build

      - name: Run e2e tests with mock LLM
        env:
          USE_MOCK_LLM: true
        run: bun run test:e2e

  # Phase 1: Real Workflow Tests
  e2e-real-tests:
    runs-on: ubuntu-latest
    container:
      image: test-runner:latest
      options: |
        --privileged
        --cgroup-manager=cgroupfs
        --security-opt seccomp=unconfined
    steps:
      - uses: actions/checkout@v4

      - name: Build pi-agent image
        run: podman build -t pi-agent:latest -f docker/pi-agent/Dockerfile .

      - name: Run real workflow tests
        env:
          USE_MOCK_LLM: true
          TEST_TYPE: real-workflow
        run: bun run test:e2e:real
```

#### Step 1.4: Update Test Scripts for Container Environment

```typescript
// tests/e2e/prepare.ts

import { BASE_IMAGES, CONTAINER_DEFAULTS } from '../../src/config/base-images.ts';

// Detect if running inside container
const isContainerized = process.env.IN_CONTAINER === 'true';

const settings = {
  workflow: {
    container: {
      image: BASE_IMAGES.piAgent,
      // ... other settings
    },
  },
};
```

#### Step 1.5: Update Container Manager for Test Environment

```typescript
// src/runtime/container-manager.ts

// When running in test container, use host network for mock LLM
const networkMode = (config.useMockLLM && isTestEnvironment())
  ? 'host'
  : (config.networkMode || CONTAINER_DEFAULTS.networkMode);
```

---

## Migration Sequence

### Phase 0 - Ubuntu Migration

| Day | Task | Files |
|-----|------|-------|
| 1 | Create `src/config/base-images.ts` | New file |
| 1 | Draft new `docker/pi-agent/Dockerfile` (Ubuntu) | New + modify |
| 1 | Update `mock-llm-server/Dockerfile` | Modify |
| 2 | Update `container-manager.ts` to use constants | Modify |
| 2 | Update `prepare.ts` to use constants | Modify |
| 2 | Update scripts (`setup-e2e-tests.sh`, etc.) | Modify |
| 3 | Test on local machine (non-containerized) | - |
| 4 | Fix any issues found | Various |
| 5 | Verify existing tests pass | - |

**Definition of Done for Phase 0:**
- [ ] `docker build -t pi-agent:latest` succeeds with Ubuntu base
- [ ] Existing `bun run test:e2e` passes without modification
- [ ] No Alpine references remain in code

### Phase 1 - Test Containerization

| Day | Task | Files |
|-----|------|-------|
| 1 | Create `docker/test-runner/Dockerfile` | New file |
| 1 | Create `docker/test-runner/entrypoint.sh` | New file |
| 2 | Test `test-runner` locally with nested containers | - |
| 3 | Create `.github/workflows/ci.yml` | New file |
| 3 | Test GitHub Actions workflow | - |
| 4 | Debug nested container issues | - |
| 5 | Verify all tests pass in CI | - |

**Definition of Done for Phase 1:**
- [ ] Unit tests run in `test-runner` container
- [ ] E2E tests run in `test-runner` container
- [ ] Real workflow tests spawn nested `pi-agent` containers
- [ ] GitHub Actions workflow passes
- [ ] No Alpine references remain anywhere

---

## Files Summary

### New Files to Create

| Path | Purpose |
|------|---------|
| `src/config/base-images.ts` | Centralized image name constants |
| `docker/test-runner/Dockerfile` | Test runner container image |
| `docker/test-runner/entrypoint.sh` | Test runner entry point |
| `.github/workflows/ci.yml` | GitHub Actions CI workflow |
| `docker-compose.test.yml` | Docker Compose for local test debugging |

### Files to Modify

| Path | Changes |
|------|---------|
| `docker/pi-agent/Dockerfile` | Alpine → Ubuntu, apk → apt-get |
| `mock-llm-server/Dockerfile` | node:20-alpine → node:26-ubuntu |
| `src/runtime/container-manager.ts` | Use BASE_IMAGES constant |
| `src/runtime/container-manager.ts` | Add test environment detection |
| `tests/e2e/prepare.ts` | Use BASE_IMAGES constant |
| `scripts/setup-e2e-tests.sh` | Use constants, remove Alpine |
| `AGENTS.md` | Update documentation |
| `README.md` | Update documentation |

### Files to Delete

| Path | Reason |
|------|--------|
| `docker/pi-agent/Dockerfile.alpine` | No longer needed after migration |

---

## Risk Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Ubuntu base image is too large | Low | Low | 100MB difference is negligible |
| Some packages not available on Ubuntu | Medium | Medium | Test early, find alternatives |
| Nested containers still don't work | Low | High | Fallback to podman socket mapping |
| GitHub Actions doesn't support our container config | Low | Medium | Adjust workflow options |
| Tests fail due to environment differences | Medium | Medium | Careful validation in Phase 0 |

---

## Success Criteria

### Phase 0 Complete When:
- [ ] `pi-agent:latest` builds from Ubuntu 26.04
- [ ] `mock-llm-server:latest` builds from node:26-ubuntu
- [ ] All existing tests pass (`bun run test:e2e`)
- [ ] No hardcoded "alpine" or "pi-agent:alpine" in source code

### Phase 1 Complete When:
- [ ] Unit tests run inside `test-runner` container
- [ ] E2E tests run inside `test-runner` container with mock LLM
- [ ] Real workflow tests spawn nested `pi-agent` containers
- [ ] GitHub Actions workflow passes
- [ ] Tests complete in < 15 minutes total
- [ ] No Alpine references anywhere in the project

---

## Appendix: Node.js Version Consideration

Ubuntu 26.04 ships with Node.js ~24.x by default. For the `mock-llm-server`, we should use the official Node.js image based on Ubuntu:

```dockerfile
# Instead of: node:20-alpine
# Use: node:26-ubuntu (when available) or node:24-ubuntu

FROM ubuntu:26.04
RUN apt-get update && apt-get install -y nodejs npm
```

Or use NodeSource for specific versions:

```dockerfile
RUN apt-get update && apt-get install -y curl \
    && curl -fsSL https://deb.nodesource.com/setup_26.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*
```

---

## Appendix: Environment Variable Configuration

For flexibility in CI and local testing:

```bash
# Can override base image via environment
export UBUNTU_BASE_IMAGE=ubuntu:26.04
export PI_AGENT_IMAGE=custom-pi-agent:latest

# In Dockerfile
ARG UBUNTU_BASE_IMAGE=ubuntu:26.04
FROM ${UBUNTU_BASE_IMAGE}
```

This allows testing with different Ubuntu versions without code changes.
