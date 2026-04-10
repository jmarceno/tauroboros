# E2E Testing with Playwright

This project uses [@playwright/test](https://playwright.dev) for end-to-end testing.

## IMPORTANT: Testing Philosophy

**All tests use the web UI exclusively** - just like a real user would interact with the system. No direct API calls are made from the tests. The server is started using the **same command users would use** (`bun run start`), not programmatically.

## Running Tests

### Standard Tests (Native Mode)
```bash
# Run all e2e tests (native mode, no containers)
bun run test:e2e

# Interactive UI mode
bun run test:e2e:ui

# Debug mode
bun run test:e2e:debug

# Visible browser
bun run test:e2e:headed
```

### Real Workflow Test (Container Mode) - THE DEFINITIVE TEST
```bash
# This is THE test that exercises the entire system with real containers
# It FAILS (does not skip) if container infrastructure is unavailable
bun run test:e2e:real
```

**Requirements for real workflow test:**
- Podman installed
- pi-agent:alpine image built (`bun run container:setup`)
- 10 minutes runtime (full workflow execution)

## Test Structure

| Test File | Mode | Description |
|-----------|------|-------------|
| `basic-ui.spec.ts` | Native | UI loading, navigation, API accessibility |
| `failure-recovery.spec.ts` | Native | Server crash recovery, stuck task handling |
| `real-workflow.spec.ts` | **Container** | **THE definitive 3-task workflow test** |

## How It Works

1. **Environment Preparation**: `prepare.ts` creates a temp project directory with `.pi/settings.json`
2. **Server Startup**: Playwright's `webServer` starts the server using `bun run src/index.ts` from the temp directory
3. **Server Detection**: The server finds `.pi/settings.json` in the current directory and uses that configuration
4. **Test Execution**: Playwright controls a headless Chromium browser to interact with the UI
5. **Cleanup**: Temp directory is cleaned up after tests

## The Definitive Real Workflow Test

`real-workflow.spec.ts` is our "does the whole system work" test:

- **3 tasks with chained dependencies** (T1 → T2 → T3)
- **Plan mode enabled** with auto-approve
- **Review phase enabled**
- **Real container execution** with pi-agent
- **100% UI-driven** - no API calls
- **MUST PASS** for the system to be considered working
- **FAILS** (not skips) if containers unavailable

This test exercises:
- Task creation via UI
- Dependency configuration
- Plan generation and auto-approval
- Container-based execution
- Review handling
- Task status transitions
- Workflow completion

## Troubleshooting

### "Test environment not prepared"
Run `bun run tests/e2e/prepare.ts` first

### "Container infrastructure not available"
For the real workflow test, run `bun run container:setup` first

### Server doesn't start
Check that port 3000 is available
