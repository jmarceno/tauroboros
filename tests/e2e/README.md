# E2E Testing with Playwright

This project uses [@playwright/test](https://playwright.dev) for end-to-end testing.

## IMPORTANT: Testing Philosophy

**Tests use the web UI only.** Playwright is the single end-to-end entry point and tests must not seed or validate state through direct API calls.

The suite now assumes:
- SolidJS is the only supported kanban UI
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
- Rust backend running on the expected port

## Test Structure

| Test File | Description |
|-----------|-------------|
| `basic-ui.spec.ts` | App shell, tabs, planning chat, task creation |
| `confirmation-dialog.spec.ts` | Destructive action confirmation flows |
| `drag-drop-code-style.spec.ts` | Workflow-managed code-style drop rules |
| `options-modal.spec.ts` | Options persistence and task defaults |
| `task-groups.spec.ts` | Multi-select group creation and panel behavior |
| `real-rust-workflow.spec.ts` | Real workflow execution against Rust backend |
| `rust-planning-chat.spec.ts` | Planning chat session against Rust backend |
| `rust-advanced-modes.spec.ts` | Best-of-N and Review Loop modes against Rust backend |
| `rust-sse-contract.spec.ts` | SSE contract validation against Rust backend |
| `rust-route-parity.spec.ts` | Route parity verification against Rust backend |

## Current Test Status

### Current Direction
- Replace API-backed legacy specs with Solid-native UI flows
- Keep selectors role-based or label-based where possible
- Prefer compact smoke coverage over brittle implementation-coupled tests

## Migration Notes

The kanban UI is now SolidJS-based. The current suite intentionally avoids legacy Vue and React assumptions, direct fetch calls, and API-driven setup shortcuts.

## Troubleshooting

### "Test environment not prepared"
Run the Rust backend binary directly or ensure a server is running on the expected port

### Server doesn't start
Check that port 3000 is available


