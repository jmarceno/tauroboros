# WebSocket to SSE Migration Plan

## Executive Summary

This migration plan outlines the transition from WebSocket to Server-Sent Events (SSE) for real-time updates in TaurOboros. After auditing the codebase, **100% of WebSocket usage is purely one-way server→client broadcast** - making it an ideal candidate for SSE migration.

## Current State Analysis

### WebSocket Usage Pattern

```
Server Side: WebSocketHub
├── Single global endpoint: /ws
├── Client connections tracked in Set<ServerWebSocket>
├── All messages broadcast to ALL connected clients
└── No message handlers (message: () => {})

Frontend Side: websocketStore.ts
├── Connects to /ws
├── Subscribes to specific event types
├── Has reconnection logic
└── 30+ event types subscribed across the app
```

### Key Finding

**The WebSocket is used exclusively for server→client broadcasts. There is NO bidirectional communication.**

All ~30 message types are one-way notifications:
- Task lifecycle (created, updated, deleted, archived, reordered)
- Execution state (started, queued, stopped, complete, paused, resumed, failed)
- Run lifecycle (created, archived, updated, paused, resumed, stopped, cleaned)
- Session events (started, message created, status changed, completed)
- Container events (build started, progress, completed, cancelled, profile updates)
- Task group events (created, updated, deleted, members added/removed)
- Group execution events (started, complete, task added/removed)
- Planning chat events (session created, updated, closed, message)
- Self-heal status updates

## Why SSE?

### WebSocket vs SSE Comparison

| Feature | WebSocket | SSE |
|---------|-----------|-----|
| Direction | Bidirectional | Unidirectional (server→client) |
| Protocol | ws:// / wss:// | HTTP (regular) |
| Connection overhead | Higher (handshake, upgrade) | Lower (HTTP streaming) |
| Reconnection | Manual required | Built-in auto-reconnect |
| Message ordering | Application-level | Guaranteed by protocol |
| Browser support | All modern | All modern |
| Proxy/Firewall | Can be problematic | Just HTTP |
| Use case | Real-time games, chat | Notifications, feeds |

### SSE Advantages for This Use Case

1. **Simpler connection management** - No upgrade handshake
2. **Auto-reconnect** - EventSource has built-in retry
3. **HTTP-based** - Works through all proxies/firewalls
4. **No WebSocket library needed** - Native browser support
5. **Better for one-way data** - What we actually need

## Migration Strategy

### Recommended Approach: Global SSE Endpoint

Create a single `/sse` endpoint that accepts optional `filter` query parameter.

**Rationale:**
- Matches existing WebSocket pattern (single endpoint)
- Simplifies frontend migration
- Maintains broadcast-to-all-clients behavior
- Minimal architectural change

### Architecture Comparison

**Current (WebSocket):**
```
Frontend                    Server
   |                          |
   |------ ws://.../ws ------>| (WebSocket upgrade)
   |<----- task_updated -----| (broadcast to all)
   |<----- run_created ------| (broadcast to all)
   |<----- group_updated ----| (broadcast to all)
```

**Proposed (SSE):**
```
Frontend                    Server
   |                          |
   |-- GET /sse?filter=all -->| (EventSource)
   |<-- data: task_updated ---| (broadcast to all)
   |<-- data: run_created ----| (broadcast to all)
   |<-- data: group_updated --| (broadcast to all)
```

## Implementation Plan

### Phase 1: Server-Side SSE Infrastructure (3 tasks)

#### Task 1.1: Create Global SSE Hub
**File:** `src/server/global-sse-hub.ts` (new)

```typescript
// Similar structure to sse-hub.ts but global
// - Map of connection ID -> { filters: string[], queue: Queue }
// - broadcast() method that pushes to all matching connections
// - Filter support: clients subscribe to specific event types
```

**Files to reference:**
- `src/server/sse-hub.ts` (existing session-specific SSE hub)

#### Task 1.2: Create SSE Endpoint
**File:** `src/server/server.ts`

Add route:
```
GET /sse?filter=task_*,run_*,group_*
```

Returns `text/event-stream` with JSON data.

#### Task 1.3: Update Server to Use SSE
**File:** `src/server.ts`

Replace:
```typescript
const wsHub = new WebSocketHub()  // REMOVE
const globalSseHub = yield* makeGlobalSseHub()  // ADD
```

### Phase 2: Frontend SSE Store (2 tasks)

#### Task 2.1: Create SSE Store
**File:** `src/kanban-solid/src/stores/sseStore.ts` (new, replaces websocketStore.ts)

Structure:
```typescript
export function createSseStore() {
  // EventSource connection management
  // Filter-based subscription (which event types to receive)
  // on() method for event type handlers
  // Same API as websocketStore for minimal changes
}
```

**Files to reference:**
- `src/kanban-solid/src/stores/websocketStore.ts`
- `src/kanban-solid/src/stores/sessionSseStore.ts`

#### Task 2.2: Update Frontend Stores
**File:** `src/kanban-solid/src/App.tsx`

Replace:
```typescript
const wsStore = createWebSocketStore()  // REMOVE
const sseStore = createSseStore()  // ADD
```

Update all wsStore.on() calls to sseStore.on().

Update `planningChatStore.ts` to use sseStore.

### Phase 3: Cleanup & Testing (3 tasks)

#### Task 3.1: Remove WebSocket Code
- Delete `src/server/websocket.ts`
- Delete `src/kanban-solid/src/stores/websocketStore.ts`
- Remove WebSocket route from `server.ts`

#### Task 3.2: Update Tests
**Files:**
- `tests/server.test.ts` (all WebSocket tests)
- `tests/frontend-store-boundaries.test.ts`

Replace WebSocket test setup with SSE/EventSource mocking.

#### Task 3.3: Verify Functionality
- Start server, open kanban UI
- Create/update/delete tasks - verify real-time updates
- Start executions - verify status changes
- Test self-heal notifications
- Test container build progress
- Verify all planning chat events

## File Changes Summary

### New Files (2)
1. `src/server/global-sse-hub.ts` - Global SSE hub with filtering
2. `src/kanban-solid/src/stores/sseStore.ts` - Frontend SSE store

### Modified Files (6)
1. `src/server/server.ts` - Add SSE endpoint, remove WebSocket
2. `src/server.ts` - Use global SSE hub instead of WebSocket hub
3. `src/kanban-solid/src/App.tsx` - Use sseStore instead of wsStore
4. `src/kanban-solid/src/stores/index.ts` - Export sseStore
5. `src/kanban-solid/src/stores/planningChatStore.ts` - Use sseStore
6. `src/server/routes/session-routes.ts` - Keep existing SSE, integrate with global

### Deleted Files (2)
1. `src/server/websocket.ts`
2. `src/kanban-solid/src/stores/websocketStore.ts`

### Test Updates (2)
1. `tests/server.test.ts` - Update WebSocket tests to SSE
2. `tests/frontend-store-boundaries.test.ts` - Remove WebSocket references

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| SSE connection drops during migration | Low | Medium | Keep WebSocket as fallback during transition |
| Event ordering differences | Low | Low | SSE guarantees ordering like WebSocket |
| Filter parameter complexity | Low | Low | Default to 'all' events if no filter |
| Browser compatibility | Very Low | Low | SSE supported in all modern browsers |

## Benefits After Migration

1. **Simpler connection management** - No WebSocket upgrade handshake
2. **Better firewall/proxy support** - Standard HTTP
3. **Built-in reconnection** - EventSource auto-retry
4. **Less code to maintain** - Remove WebSocket-specific code
5. **More appropriate protocol** - Using SSE for its intended purpose

## Estimated Effort

- **Phase 1:** 2-3 hours (server-side infrastructure)
- **Phase 2:** 2-3 hours (frontend store migration)
- **Phase 3:** 1-2 hours (cleanup and testing)
- **Total:** 5-8 hours

## Migration Checklist

### Pre-Migration
- [ ] Review this plan with team
- [ ] Create feature branch
- [ ] Run existing tests to establish baseline

### During Migration
- [ ] Implement Phase 1 (server-side)
- [ ] Implement Phase 2 (frontend)
- [ ] Run manual smoke tests
- [ ] Update automated tests

### Post-Migration
- [ ] Remove WebSocket code
- [ ] Run full test suite
- [ ] Deploy to staging
- [ ] Monitor for 24 hours
- [ ] Deploy to production

## Conclusion

This migration represents a **protocol simplification** that aligns the technology choice with the actual use case. Since all WebSocket usage is one-way broadcast, SSE is the more appropriate and simpler solution.

The migration is **low-risk** due to:
- No bidirectional functionality to preserve
- Simple API translation (wsStore.on -> sseStore.on)
- Existing SSE implementation in codebase to reference
- Minimal architectural changes

Estimated timeline: **1-2 days** for full implementation and testing.
