# Planning Chat Auto-Reconnect Implementation - Fixes Summary

This document summarizes the changes made to fix the chat session auto-restore implementation.

## Issues Fixed

### 1. Optimistic Message Added Before Session Validation (CRITICAL BUG)
**Problem**: The React implementation added the optimistic message to the UI BEFORE checking if the session was active. If reconnect failed, the message appeared sent but was never delivered.

**Solution**: 
- Removed optimistic UI updates from `sendMessage()`
- Messages are now only added to the UI via WebSocket after successful server confirmation
- Both React and Vue implementations now have consistent behavior

### 2. Fragile Error String Matching
**Problem**: Code used `errorMsg.includes('Planning session not active')` which could break if backend changed error messages.

**Solution**:
- Created shared error codes in `/src/shared/error-codes.ts`
- Backend now returns structured errors with `code` field
- Frontend uses `isErrorCode()` and `detectErrorCodeFromMessage()` for detection
- Legacy message patterns are still supported for backwards compatibility

### 3. Race Conditions in State Management
**Problem**: Multiple rapid sends could create overlapping reconnect attempts due to complex `finally` block logic.

**Solution**:
- Added `sendingRef` (React) and `sendingSessions` Set (Vue) to track sending state
- Added `reconnectingRef` (React) and `reconnectingSessions` Set (Vue) to prevent concurrent reconnects
- Pending messages are queued during reconnect and processed after success

### 4. Vue and React Implementation Inconsistency
**Problem**: Vue and React had different error handling and state management behaviors.

**Solution**:
- Rewrote both implementations to use identical logic:
  - Same message queuing mechanism
  - Same error code detection
  - Same state management pattern
  - Same pending message handling

### 5. No Test Coverage
**Problem**: No tests existed for the auto-reconnect functionality.

**Solution**:
- Added comprehensive unit tests in `/tests/planning-chat-auto-reconnect.test.ts`
- Tests cover:
  - Error code detection (legacy and new)
  - API error response structure
  - Session reconnect flow
  - Set model endpoint
  - Create planning session endpoint
- Added E2E test scaffold in `/tests/e2e/planning-chat-auto-reconnect.spec.ts`

### 6. No Cleanup of Optimistic Messages on Failure
**Problem**: When reconnect failed, no cleanup occurred - messages remained in UI.

**Solution**:
- Eliminated optimistic messages entirely
- Messages only appear after server confirmation via WebSocket
- Error state clearly shows when send/reconnect failed

## Files Changed

### New Files
1. `/src/shared/error-codes.ts` - Shared error codes between frontend and backend
2. `/tests/planning-chat-auto-reconnect.test.ts` - Unit tests for auto-reconnect
3. `/tests/e2e/planning-chat-auto-reconnect.spec.ts` - E2E tests for auto-reconnect

### Modified Files

#### Backend
1. `/src/server/server.ts`
   - Added import for error codes
   - Updated planning session endpoints to return structured errors with codes:
     - `POST /api/planning/sessions/:id/messages`
     - `POST /api/planning/sessions/:id/reconnect`
     - `POST /api/planning/sessions/:id/model`
     - `POST /api/planning/sessions/:id/create-tasks`
     - `POST /api/planning/sessions` (create)

#### Frontend - React
1. `/src/kanban-react/src/hooks/useApi.ts`
   - Added `ApiErrorResponse` class with `code`, `details`, and `status` properties
   - Updated request handler to parse structured errors

2. `/src/kanban-react/src/hooks/usePlanningChat.ts`
   - Added imports for error codes
   - Added `PendingMessage` interface for message queuing
   - Rewrote `sendMessage()` to queue messages and prevent race conditions
   - Added `attemptSendMessage()` for internal send/retry logic
   - Added refs for tracking sending and reconnecting state
   - Removed optimistic message creation

#### Frontend - Vue
1. `/src/kanban-vue/src/composables/useApi.ts`
   - Added `ApiErrorResponse` class with `code`, `details`, and `status` properties
   - Updated request handler to parse structured errors

2. `/src/kanban-vue/src/composables/usePlanningChat.ts`
   - Added imports for error codes
   - Added `PendingMessage` interface for message queuing
   - Rewrote `sendMessage()` to queue messages and prevent race conditions
   - Added `attemptSendMessage()` for internal send/retry logic
   - Added Sets for tracking sending and reconnecting state
   - Matched React implementation behavior exactly

## Error Codes

The following error codes are now shared between frontend and backend:

```typescript
enum ErrorCode {
  PLANNING_SESSION_NOT_ACTIVE = 'PLANNING_SESSION_NOT_ACTIVE',
  PLANNING_SESSION_NOT_FOUND = 'PLANNING_SESSION_NOT_FOUND',
  PLANNING_SESSION_ALREADY_ACTIVE = 'PLANNING_SESSION_ALREADY_ACTIVE',
  PLANNING_SESSION_RECONNECT_FAILED = 'PLANNING_SESSION_RECONNECT_FAILED',
  MESSAGE_SEND_FAILED = 'MESSAGE_SEND_FAILED',
  MESSAGE_RETRY_FAILED = 'MESSAGE_RETRY_FAILED',
  SESSION_NOT_FOUND = 'SESSION_NOT_FOUND',
  NOT_A_PLANNING_SESSION = 'NOT_A_PLANNING_SESSION',
  INVALID_MODEL = 'INVALID_MODEL',
  INVALID_THINKING_LEVEL = 'INVALID_THINKING_LEVEL',
  PLANNING_PROMPT_NOT_CONFIGURED = 'PLANNING_PROMPT_NOT_CONFIGURED',
}
```

## Behavior Changes

### Before
1. User sends message
2. Message appears in UI immediately (optimistic)
3. Send fails with "Planning session not active"
4. Auto-reconnect starts
5. If reconnect fails, optimistic message remains in UI (BUG)
6. User thinks message was sent but it was lost

### After
1. User sends message
2. `isSending` state is set to true
3. Send fails with `PLANNING_SESSION_NOT_ACTIVE`
4. Auto-reconnect starts with `isReconnecting` state
5. If reconnect succeeds, message is retried and sent
6. Message appears in UI only after server confirmation via WebSocket
7. If reconnect fails, error is displayed, message never appears in UI

## Testing

Run the new tests:
```bash
bun test tests/planning-chat-auto-reconnect.test.ts
```

All 12 tests pass:
- 4 tests for error code detection
- 3 tests for API error response structure
- 2 tests for session reconnect flow
- 1 test for create planning session endpoint
- 2 tests for set model endpoint
