# UI/Chat Bug Fixes Implementation Plan

## Overview

This document provides detailed implementation guidance for fixing 6 critical UI/chat bugs in the Tauroboros kanban interface. All bugs have been thoroughly investigated and their root causes identified.

**Created:** 2026-04-23  
**Priority:** Critical (2), High (3), Medium (1)  
**Estimated Implementation Time:** 4-6 hours  
**Files Affected:** 5

---

## Bug Summary

| # | Bug | Priority | File | Complexity | Root Cause |
|---|-----|----------|------|------------|------------|
| 1 | Shift+Enter not working & Send button state | Critical | ChatPanel.tsx | Low | Strict status check + missing disabled CSS |
| 2 | Thinking blocks styling | Medium | ChatMessage.tsx | Low | Incomplete CSS application to nested content |
| 3 | Mermaid parsing breaks page | High | MermaidBlock.tsx | Medium | Unhandled render errors escape try-catch |
| 4 | Multi-line messages lost | **Critical** | ChatPanel.tsx | Medium | Race condition: signal state vs DOM value |
| 5 | Chat panel over mermaid modal | Medium | MermaidModal.tsx | Low | No Portal + same z-index stack conflict |
| 6 | Execution graph for groups | High | App.tsx | Medium | Group start bypasses execution graph check |

---

## Implementation Order

1. **Bug #4** (Multi-line) - Most critical, affects core functionality
2. **Bug #1** (Shift+Enter) - Related to #4, same file
3. **Bug #3** (Mermaid crash) - Stability improvement
4. **Bug #5** (Z-index) - Quick fix
5. **Bug #6** (Execution graph) - Feature parity
6. **Bug #2** (Thinking styling) - Polish

---

## Bug #4: Multi-line Messages Lost on Send (CRITICAL)

### Problem
Multi-line messages lose all lines except the first. Sometimes the entire message is "swallowed" with no send. User work is lost irretrievably.

### Root Cause Analysis

**Race condition in SolidJS signal vs DOM:**

1. Line 196 in ChatPanel.tsx: `const content = messageInput().trim()` reads from signal state
2. SolidJS signals update asynchronously via `onChange` handler
3. When user presses Shift+Enter, `handleSend()` fires immediately
4. The signal state may not yet reflect the full textarea content
5. Only the first line (or partial content) gets captured
6. Input clears, and remaining content is lost forever

**Secondary issue - Enter key behavior:**
- Pressing Enter alone should create a newline (standard textarea behavior)
- Current implementation doesn't distinguish between Enter and Shift+Enter properly
- Can trigger both keydown and blur events causing double processing

### Implementation Steps

#### Step 1: Add Textarea Ref

Add a ref to access the textarea DOM element directly:

```typescript
// In ChatPanel component, add with other refs (around line 32)
let textareaRef: HTMLTextAreaElement | undefined
```

#### Step 2: Rewrite handleSend Function

Replace the current handleSend (lines 191-210) with:

```typescript
const handleSend = async () => {
  const session = props.session()
  
  // CRITICAL: Read directly from DOM to avoid signal race condition
  if (!textareaRef || isSending() || !session?.session?.id) return
  
  const content = textareaRef.value.trim()
  if (!content) return

  const attachments = [...attachedContext()]

  // Clear both signal and DOM immediately after capture
  setMessageInput('')
  textareaRef.value = ''
  setAttachedContext([])

  try {
    await props.onSendMessage(session.id, content, attachments)
    if (messagesContainerRef) {
      messagesContainerRef.scrollTop = messagesContainerRef.scrollHeight
    }
  } catch {
    // CRITICAL: Restore message on error so user doesn't lose work
    setMessageInput(content)
    if (textareaRef) textareaRef.value = content
    // Error is handled by store
  }
}
```

#### Step 3: Fix handleKeyDown

Rewrite the keyboard handler (lines 113-121):

```typescript
const handleKeyDown = (e: KeyboardEvent) => {
  // Allow regular Enter to create newlines (standard behavior)
  // Only handle Shift+Enter for sending
  if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault()
    handleSend()
  }
  // Note: Regular Enter (without shift) will default to newline
}
```

#### Step 4: Add Textarea Ref Binding

Bind the ref to the textarea element (around line 520-528):

```tsx
<textarea
  ref={textareaRef}  // ADD THIS LINE
  class="min-h-[96px] max-h-[250px] w-full bg-dark-surface border border-dark-border rounded-lg px-2 py-1.5 text-sm text-dark-text placeholder-dark-text-muted/50 focus:outline-none focus:border-accent-primary resize-none disabled:opacity-50 disabled:cursor-not-allowed"
  placeholder={isLoading() && !isReconnecting() ? "Waiting for session to start..." : "Type your message... (Shift+Enter to send). Paste images with Ctrl+V."}
  value={messageInput()}
  onChange={(e) => setMessageInput(e.currentTarget.value)}
  onKeyDown={handleKeyDown}
  onPaste={handlePaste}
  disabled={isLoading() || isReconnecting() || !sessionObj()?.id}
/>
```

### Testing Checklist

- [ ] Type multi-line message (3+ lines), press Shift+Enter → Full message sent
- [ ] Type message with newlines (press Enter for new lines), then Shift+Enter → All lines preserved
- [ ] Type message, press Enter alone → Creates newline in textarea (no send)
- [ ] Test rapid Shift+Enter presses → Only sends once (no double-send)
- [ ] Disconnect network, attempt send → Message restored in input, not lost
- [ ] Very long messages (1000+ chars) → Sent completely

---

## Bug #1: Shift+Enter Not Working & Send Button Disabled State

### Problem
Shift+Enter shortcut fails to send messages. Send button appears disabled visually but still responds to clicks.

### Root Cause Analysis

**Two separate issues:**

1. **Keyboard handler condition too strict** (line 117):
   ```typescript
   session?.session?.status === 'active'
   ```
   When session is "starting" but not yet "active", this check fails even though the session exists and can receive messages.

2. **Missing disabled button CSS**: The button has the `disabled` attribute but `.chat-send-btn` class lacks proper `:disabled` styling, making it appear enabled.

### Implementation Steps

#### Step 1: Fix handleKeyDown Condition

Update the condition in handleKeyDown (lines 113-121):

```typescript
const handleKeyDown = (e: KeyboardEvent) => {
  if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault()
    const session = props.session()
    
    // FIX: Check !isLoading && !isReconnecting instead of status === 'active'
    // This allows sending when session exists and is not in loading states
    const canSend = messageInput().trim() && 
                     !isSending() && 
                     session?.session?.id &&
                     !isLoading() && 
                     !isReconnecting()
    
    if (canSend) {
      handleSend()
    }
  }
}
```

#### Step 2: Add Disabled Button Styling

Add to `src/kanban-solid/src/styles/theme.css`:

```css
/* Around line 1880, after other button styles */
.chat-send-btn:disabled,
.chat-send-btn[disabled] {
  opacity: 0.4 !important;
  cursor: not-allowed !important;
  background-color: var(--dark-surface3) !important;
  color: var(--dark-text-muted) !important;
  pointer-events: none;
}
```

Alternative: Add Tailwind classes to the button element (lines 532-550):

```tsx
<button
  class="chat-send-btn w-full disabled:opacity-40 disabled:cursor-not-allowed disabled:bg-dark-surface3 disabled:text-dark-text-muted"
  disabled={!messageInput().trim() || isSending() || !sessionObj()?.id || isLoading() || isReconnecting()}
  onClick={handleSend}
>
  {/* ... */}
</button>
```

### Testing Checklist

- [ ] Session in "starting" state → Shift+Enter works (if not loading/reconnecting)
- [ ] Session "active" → Shift+Enter works
- [ ] Button disabled when no text → Visual feedback (grayed out)
- [ ] Button disabled when isSending → Visual feedback
- [ ] Button disabled when isLoading → Visual feedback
- [ ] Clicking disabled button does nothing

---

## Bug #3: Mermaid Parsing Breaks Entire Page

### Problem
Invalid mermaid syntax causes entire chat panel to crash/unmount. Page goes blank instead of showing graceful error.

### Root Cause Analysis

1. `mermaid.render()` can throw synchronous errors during parsing
2. Errors thrown in `onMount` can escape the try-catch if not properly handled
3. SolidJS unmounts the component tree when unhandled errors bubble up
4. No error state to show fallback UI

### Implementation Steps

#### Step 1: Add Error State

In MermaidBlock.tsx, update the signals (lines 15-17):

```typescript
export function MermaidBlock(props: MermaidBlockProps) {
  const [svg, setSvg] = createSignal<string | null>(null)
  const [error, setError] = createSignal<string | null>(null)  // Changed from boolean to string
  const [loading, setLoading] = createSignal(true)
```

#### Step 2: Rewrite onMount Handler

Replace the onMount handler (lines 19-34):

```typescript
  onMount(async () => {
    try {
      // Pre-validation: Check content validity
      if (!props.content?.trim()) {
        throw new Error('Empty diagram content')
      }
      
      if (props.content.length > 5000) {
        throw new Error('Diagram too large (max 5000 chars)')
      }

      const mermaid = (await import('mermaid')).default
      
      // Try to parse first - this catches syntax errors early
      try {
        await mermaid.parse(props.content)
      } catch (parseErr) {
        // Parse is strict - some valid diagrams might fail parse but render OK
        // Log warning but continue to try rendering
        console.warn('Mermaid parse warning:', parseErr)
      }

      mermaid.initialize({
        startOnLoad: false,
        theme: 'dark',
        securityLevel: 'strict',
      })

      const { svg: renderedSvg } = await mermaid.render(
        `${props.id}-svg`, 
        props.content
      )
      
      setSvg(renderedSvg)
      setError(null)
    } catch (err) {
      console.error('Mermaid render failed:', err)
      setError(err instanceof Error ? err.message : 'Failed to render diagram')
    } finally {
      setLoading(false)
    }
  })
```

#### Step 3: Update Error UI

Update the fallback/render section (lines 67-78):

```tsx
<Show when={!loading() && !error() && svg()} fallback={
  <Show when={error()} fallback={
    <div class="p-1">
      <pre class="text-xs text-dark-text-muted/80">{props.content}</pre>
    </div>
  }>
    <div class="mermaid-error p-2 text-sm text-accent-danger border border-accent-danger/30 rounded bg-accent-danger/10">
      <div class="flex items-start gap-2">
        <svg class="w-4 h-4 mt-0.5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <div>
          <p class="font-medium">Failed to render chart</p>
          <p class="text-xs mt-1 opacity-80">{error()}</p>
        </div>
      </div>
    </div>
  </Show>
}>
  <div innerHTML={svg()!} />
</Show>
```

### Testing Checklist

- [ ] Valid mermaid diagram → Renders correctly
- [ ] Invalid syntax (e.g., `graph TD\nA -- B` with no arrow) → Shows error, doesn't crash
- [ ] Empty code block → Shows "Empty diagram content" error
- [ ] Very large diagram (>5000 chars) → Shows "too large" error
- [ ] Multiple invalid diagrams on page → Each shows error, page doesn't crash

---

## Bug #5: Chat Panel Over Mermaid Modal

### Problem
Mermaid modal opens but chat panel covers zoom/close buttons. Cannot interact with modal controls.

### Root Cause Analysis

1. MermaidModal renders at `z-50` (line 100)
2. Chat panel in ChatContainer.tsx uses same z-index
3. Chat panel renders later in DOM, so it stacks higher
4. No `<Portal>` used, so modal is inside chat component tree and subject to its stacking context

### Implementation Steps

#### Step 1: Add Portal Import

Add to MermaidModal.tsx imports (line 5):

```typescript
import { Portal } from 'solid-js/web'
```

#### Step 2: Wrap Modal in Portal

Wrap the modal content (lines 97-221):

```typescript
return (
  <Portal>  {/* ADD THIS */}
    <Show when={props.isOpen}>
      <div class="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm">
        {/* All existing modal content stays the same */}
      </div>
    </Show>
  </Portal>  {/* ADD THIS */}
)
```

#### Step 3: Increase Z-Index

Change z-index from `z-50` to `z-[100]` to ensure it's above all other UI elements.

### Testing Checklist

- [ ] Open mermaid modal from chat → Modal appears above chat panel
- [ ] Zoom controls clickable and functional
- [ ] Close button clickable
- [ ] Modal closes properly
- [ ] No z-index issues with other elements

---

## Bug #6: Execution Graph Not Showing for Groups

### Problem
Execution graph preview doesn't show when starting group workflow. Virtual workflows bypass the preview step. showExecutionGraph setting only affects "start all" not groups.

### Root Cause Analysis

1. App.tsx line 813: `onStartGroup={() => taskGroupsStore.startGroup(groupId)}`
2. This bypasses the `onToggleExecution` handler that checks `showExecutionGraph`
3. Group start goes directly to API without execution graph check
4. Separate code path for groups vs. regular workflow start

### Implementation Steps

#### Step 1: Add Pending Group State

In App.tsx, add state to track pending group start (around line 100):

```typescript
// Add with other local state
const [pendingGroupStart, setPendingGroupStart] = createSignal<string | null>(null)
```

#### Step 2: Create Group Start Handler

Add new handler function (around line 500, near other handlers):

```typescript
const onStartGroup = async (groupId: string) => {
  // Check if execution graph should be shown (same as regular workflow)
  if (optionsStore.options()?.showExecutionGraph) {
    setPendingGroupStart(groupId)
    uiStore.openModal('executionGraph')
  } else {
    await executeGroupStart(groupId)
  }
}

const executeGroupStart = async (groupId: string) => {
  try {
    await taskGroupsStore.startGroup(groupId)
    uiStore.showToast('Group workflow started', 'success')
    await runsStore.loadRuns()
    await tasksStore.loadTasks()
  } catch (e) {
    uiStore.showToast('Failed to start group: ' + (e instanceof Error ? e.message : String(e)), 'error')
  } finally {
    setPendingGroupStart(null)
  }
}
```

#### Step 3: Update KanbanBoard Props

Update the onStartGroup prop (line 813):

```typescript
onStartGroup={onStartGroup}  // Changed from inline arrow function
```

#### Step 4: Pass Pending State to ExecutionGraphModal

Update ExecutionGraphModal to accept pending group ID (this requires modifying ExecutionGraphModal props and confirm handler). You'll need to:

1. Add `pendingGroupId?: string` prop to ExecutionGraphModal
2. Modify the `startExecution` function to check for pending group
3. In App.tsx, pass the pending group when opening the modal

### Testing Checklist

- [ ] showExecutionGraph = true, start group → Execution graph modal appears first
- [ ] Confirm in modal → Group workflow starts
- [ ] Cancel in modal → Group doesn't start, pending cleared
- [ ] showExecutionGraph = false, start group → Group starts immediately (no modal)
- [ ] Regular workflow start still works with showExecutionGraph

---

## Bug #2: Thinking Blocks Styling

### Problem
Thinking/internal reasoning blocks have the same color as normal agent messages. Need to make them less prominent (dim gray color) and use italic text.

### Root Cause Analysis

1. ChatMessage.tsx line 240: Only applies styling to outer container
2. Individual blocks via `renderedBlocks()` don't inherit thinking styling
3. Code blocks, mermaid diagrams, etc. appear at full contrast
4. No italic styling applied

### Implementation Steps

#### Step 1: Add Thinking Classes

Add CSS to `src/kanban-solid/src/styles/theme.css`:

```css
/* Thinking content styling */
.thinking-content {
  opacity: 0.6;
}

.thinking-block {
  font-style: italic;
  color: var(--dark-text-muted);
}

/* Dim nested elements within thinking blocks */
.thinking-block pre,
.thinking-block .mermaid-wrap,
.thinking-block code {
  opacity: 0.8;
  filter: grayscale(0.3);
}

/* Keep thinking indicator visible */
.thinking-indicator {
  font-size: 0.75rem;
  color: var(--dark-text-muted);
  font-style: italic;
  margin-top: 0.5rem;
}
```

#### Step 2: Update ChatMessage Container

Update the container div (line 240):

```tsx
<div class={`chat-message-content ${isThinking() ? 'thinking-content' : ''}`}>
```

#### Step 3: Wrap Blocks with Thinking Class

Update the For each render (around line 270-306):

```tsx
<For each={renderedBlocks()}>
  {(block, index) => {
    // Wrap each block with thinking class if applicable
    const blockContent = () => {
      if (block.type === 'text' && block.content.startsWith('<')) {
        return <div innerHTML={block.content} />
      }

      if (block.type === 'text') {
        return (
          <div class="message-text" innerHTML={renderMarkdown(block.content)} />
        )
      }

      if (block.type === 'mermaid' && block.id) {
        return (
          <MermaidBlock
            content={block.content}
            id={block.id}
            onMaximize={openMermaidModal}
          />
        )
      }

      if (block.type === 'code') {
        const highlighted = highlightedCode().get(block.content) || block.content
        return (
          <div class="my-1 rounded-lg overflow-hidden bg-dark-bg border border-dark-border">
            <div class="text-xs text-dark-text-muted/60 px-2 py-1 bg-dark-surface2 border-b border-dark-border flex items-center justify-between">
              <span class="font-mono">{block.language}</span>
            </div>
            <pre class="p-2 overflow-x-auto"><code class={`hljs language-${block.language}`} innerHTML={highlighted} /></pre>
          </div>
        )
      }

      return null
    }

    return (
      <div class={isThinking() ? 'thinking-block' : ''}>
        {blockContent()}
      </div>
    )
  }}
</For>
```

#### Step 4: Update Thinking Indicator

Update the thinking indicator (lines 327-331):

```tsx
<Show when={isThinking()}>
  <div class="thinking-indicator">
    thinking...
  </div>
</Show>
```

### Testing Checklist

- [ ] Thinking message appears → Text is italic and dimmed (60% opacity)
- [ ] Thinking message with code block → Code block also dimmed
- [ ] Thinking message with mermaid → Mermaid diagram dimmed
- [ ] Normal agent message → Full opacity, no italic
- [ ] Multiple thinking messages in conversation → All styled consistently

---

## Testing Strategy

### Unit Testing

No unit tests needed - these are UI/integration fixes.

### Manual Testing Protocol

1. **Setup**: Start dev server, create test planning session
2. **Bug #4 & #1**: Test message sending with various inputs
3. **Bug #3**: Test mermaid rendering with valid/invalid diagrams
4. **Bug #5**: Test mermaid modal from chat panel
5. **Bug #6**: Test group execution with showExecutionGraph enabled/disabled
6. **Bug #2**: Test conversation with thinking blocks

### Regression Testing

- [ ] Normal workflow start still works
- [ ] Chat message editing/retry still works
- [ ] All other keyboard shortcuts functional
- [ ] Mobile/responsive layout unaffected

---

## Rollback Plan

If issues arise:

1. Git revert to pre-implementation commit
2. All changes are isolated to specific components
3. No database migrations or API changes
4. Can disable features individually

---

## Files to Modify

| File | Lines | Changes |
|------|-------|---------|
| `src/kanban-solid/src/components/chat/ChatPanel.tsx` | 32, 113-121, 191-210, 520-528 | Add ref, fix handleSend, fix handleKeyDown, bind ref |
| `src/kanban-solid/src/components/chat/ChatMessage.tsx` | 240, 270-306, 327-331 | Add thinking classes, wrap blocks |
| `src/kanban-solid/src/components/chat/MermaidBlock.tsx` | 15-17, 19-34, 67-78 | Add error state, fix error handling, update UI |
| `src/kanban-solid/src/components/chat/MermaidModal.tsx` | 5, 97-221 | Add Portal, wrap modal |
| `src/kanban-solid/src/App.tsx` | 100, ~500, 813 | Add pending state, add handlers, update prop |
| `src/kanban-solid/src/styles/theme.css` | ~1880 | Add disabled button styles, thinking styles |

---

## Estimated Timeline

| Phase | Duration |
|-------|----------|
| Bug #4 (Multi-line) | 1.5 hours |
| Bug #1 (Shift+Enter) | 0.5 hours |
| Bug #3 (Mermaid) | 1 hour |
| Bug #5 (Z-index) | 0.5 hours |
| Bug #6 (Execution graph) | 1.5 hours |
| Bug #2 (Thinking) | 0.5 hours |
| Testing | 1 hour |
| **Total** | **~6 hours** |

---

## Notes

- All fixes are additive and don't break existing functionality
- Bug #4 is the most critical - affects core user workflow
- Bug #3 provides stability against edge cases
- Bug #6 improves feature parity between regular and group workflows
- Consider adding E2E tests for critical paths after implementation
