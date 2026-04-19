# E2E Testing with Playwright

This project uses [@playwright/test](https://playwright.dev) for end-to-end testing.

## IMPORTANT: Testing Philosophy

**Tests use the web UI only.** Playwright is the single end-to-end entry point and tests must not seed or validate state through direct API calls.

The suite now assumes:
- SolidJS is the only supported kanban UI
- E2E always runs with container mode enabled
- E2E always runs against the mock LLM server
- Assertions are made from user-visible behavior

## Running Tests

### Standard Tests
```bash
bun run test:e2e

# Interactive UI mode
bun run test:e2e:ui

# Debug mode
bun run test:e2e:debug

# Visible browser
bun run test:e2e:headed
```

### Requirements
- Podman installed
- `pi-agent:latest` image available via `bun run container:setup`
- Mock LLM server starts automatically during `tests/e2e/prepare.ts`

## Test Structure

| Test File | Description |
|-----------|-------------|
| `basic-ui.spec.ts` | App shell, tabs, planning chat, task creation |
| `confirmation-dialog.spec.ts` | Destructive action confirmation flows |
| `container-builder.spec.ts` | Container image builder UI |
| `drag-drop-code-style.spec.ts` | Workflow-managed code-style drop rules |
| `options-modal.spec.ts` | Options persistence and task defaults |
| `task-groups.spec.ts` | Multi-select group creation and panel behavior |
| `workflow-control.spec.ts` | Start, pause, resume, and stop workflow controls |

## Current Test Status

### Current Direction
- Replace API-backed legacy specs with Solid-native UI flows
- Keep selectors role-based or label-based where possible
- Prefer compact smoke coverage over brittle implementation-coupled tests

## Migration Notes

The kanban UI is now SolidJS-based. The current suite intentionally avoids legacy Vue and React assumptions, direct fetch calls, and API-driven setup shortcuts.

## Troubleshooting

### "Test environment not prepared"
Run `bun run tests/e2e/prepare.ts` first

### "Container infrastructure not available"
Run `bun run container:setup` first

### Server doesn't start
Check that port 3000 is available

### Mock server startup issues
Check that port `9999` is available and that the mock LLM server dependencies can be installed.
