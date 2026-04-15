# Per-Task Container Images Implementation Plan

## Overview

This plan implements per-task container image selection, allowing users to specify which container image each task should use. The system will support multiple images, validate image existence before execution, and display the selected image on task cards.

## User Requirements Summary

1. **Default behavior**: Tasks without a specified container image will use the system default from settings
2. **Image deletion protection**: Cannot delete images currently used by tasks not in "done" status
3. **Workflow validation**: Refuse to start entire workflow if any task has an invalid/non-existent container image
4. **Display format**: Show full image tag on task cards

---

## 1. Database & Types Changes

### Files to Modify:
- `src/db.ts` (MIGRATIONS array)
- `src/types.ts`
- `src/db/types.ts`

### Migration v11:
```typescript
{
  version: 11,
  description: "Add container_image column to tasks table for per-task image selection",
  statements: [
    `ALTER TABLE tasks ADD COLUMN container_image TEXT;`,
  ],
}
```

### Type Updates:
- Add `containerImage?: string` to `Task` interface in `src/types.ts`
- Add `containerImage?: string` to `CreateTaskInput` in `src/db/types.ts`
- Add `containerImage?: string` to `UpdateTaskInput` in `src/db/types.ts`

---

## 2. Backend API Changes

### Files to Modify:
- `src/server/server.ts`

### New Endpoints:

#### `GET /api/container/images`
Lists all available container images from:
- `container_builds` table (successful builds with imageTag)
- Podman `podman images` command output (to catch manually built images)

**Response:**
```typescript
{
  images: [
    {
      tag: string,           // e.g., "pi-agent:custom-1234567890"
      createdAt: number,     // Unix timestamp
      source: 'build' | 'podman',  // 'build' = from container_builds, 'podman' = from podman images
      inUseByTasks: number   // Count of non-done tasks using this image
    }
  ]
}
```

#### `DELETE /api/container/images/:tag`
Deletes a container image with validation:
- Returns 400 if image is used by any non-done task
- Prevents deletion if it would leave zero images available
- Runs `podman rmi <tag>`

**Response:**
```typescript
{
  success: boolean,
  message: string,
  tasksUsing?: string[]  // Task IDs using this image (if deletion blocked)
}
```

#### `POST /api/container/validate-image`
Pre-flight validation endpoint:

**Request:**
```typescript
{ tag: string }
```

**Response:**
```typescript
{
  exists: boolean,
  tag: string,
  availableInPodman: boolean
}
```

### Modified Endpoints:

#### `POST /api/tasks` & `PUT /api/tasks/:id`
- Accept `containerImage` in request body
- Validate that `containerImage` is either:
  - Empty/undefined/null (use system default)
  - A valid existing image from available images list
- Return 400 if specified image doesn't exist

---

## 3. Frontend Types & API Changes

### Files to Modify:
- `src/kanban-vue/src/types/api.ts`
- `src/kanban-vue/src/composables/useApi.ts`

### Type Additions:
```typescript
// src/kanban-vue/src/types/api.ts

export interface ContainerImage {
  tag: string
  createdAt: number
  source: 'build' | 'podman'
  inUseByTasks: number
}

// Update Task interface
export interface Task {
  // ... existing fields
  containerImage?: string  // Full image tag
}

// Update CreateTaskDTO
export interface CreateTaskDTO {
  // ... existing fields
  containerImage?: string
}

// Update UpdateTaskDTO
export interface UpdateTaskDTO {
  // ... existing fields
  containerImage?: string
}
```

### API Methods:
```typescript
// src/kanban-vue/src/composables/useApi.ts

getContainerImages(): Promise<{ images: ContainerImage[] }>
deleteContainerImage(tag: string): Promise<{ success: boolean; message: string; tasksUsing?: string[] }>
validateContainerImage(tag: string): Promise<{ exists: boolean; tag: string; availableInPodman: boolean }>
```

---

## 4. Task Modal Changes

### Files to Modify:
- `src/kanban-vue/src/components/modals/TaskModal.vue`

### Implementation Details:

#### Form State Addition:
```typescript
const form = ref({
  // ... existing fields
  containerImage: '',  // Empty string = use system default
})
```

#### New Form Section (after "Execution Strategy"):
Add a form group with:

1. **Label**: "Container Image"
2. **Help icon tooltip**: "Select the container image for this task. Uses system default if not specified."
3. **Dropdown select**:
   - `<option value="">System Default (${defaultImage})</option>`
   - `<option v-for="img in availableImages" :key="img.tag" :value="img.tag">{{ img.tag }}</option>`
4. **Info text**: "Build custom images in the Image Builder"

#### Load Available Images:
- Fetch available images when modal opens via `onMounted`
- Cache images list to avoid repeated API calls
- Handle loading state gracefully

#### Save Integration:
- Include `containerImage` in `CreateTaskDTO` when saving
- If empty string, send `undefined` or omit field (backend will use default)

---

## 5. Task Card Changes

### Files to Modify:
- `src/kanban-vue/src/components/board/TaskCard.vue`

### Implementation Details:

Add a new tag in the task-tags section (around line 340-350, after branch tag):

```vue
<!-- Container Image Tag - always visible if set -->
<span 
  v-if="task.containerImage" 
  class="task-tag border-accent-info/30 text-accent-info" 
  :title="'Container Image: ' + task.containerImage"
>
  🐳 {{ task.containerImage }}
</span>
```

**Design notes:**
- Uses `border-accent-info/30 text-accent-info` styling (blue/cyan theme)
- Docker whale emoji (🐳) as visual indicator
- Full tag displayed (not truncated)
- Tooltip shows full info on hover
- Visible in ALL task states (template, backlog, executing, review, done, failed, stuck)

---

## 6. Container Config Modal Changes

### Files to Modify:
- `src/kanban-vue/src/components/modals/ContainerConfigModal.vue`

### Implementation Details:

#### Tabbed Interface:
Convert modal to use tabs:
1. **Build** tab - Current Dockerfile editor and build functionality
2. **Images** tab - NEW: Image management interface

#### Images Tab Features:

**Image List Table:**
Columns:
- Image Tag (full tag name)
- Created (formatted date)
- Source (Build/Podman badge)
- In Use (count of non-done tasks using this image)
- Actions (Delete button)

**Delete Functionality:**
- Delete button disabled if:
  - Image is the last available image
  - Image is used by non-done tasks
- Clicking delete shows confirmation modal with:
  - Warning if tasks are using it
  - Confirmation message
- After deletion, refresh image list

**API Integration:**
```typescript
// Load images on tab switch
const loadImages = async () => {
  const response = await fetch('/api/container/images')
  const data = await response.json()
  availableImages.value = data.images
}

// Delete image
const deleteImage = async (tag: string) => {
  const response = await fetch(`/api/container/images/${encodeURIComponent(tag)}`, {
    method: 'DELETE'
  })
  const result = await response.json()
  if (result.success) {
    toasts.showToast('Image deleted successfully', 'success')
    loadImages() // Refresh list
  } else {
    toasts.showToast(result.message, 'error')
  }
}
```

---

## 7. Execution Validation

### Files to Modify:
- `src/orchestrator.ts`
- `src/server/server.ts` (workflow start endpoints)

### Implementation Details:

#### Image Existence Check:
Add method to check if image exists:
```typescript
// In orchestrator or container manager
async checkImageExists(imageName: string): Promise<boolean> {
  try {
    await this.containerManager.execPodman(['image', 'exists', imageName])
    return true
  } catch {
    return false
  }
}
```

#### Workflow Validation (Before Start):
Add validation in workflow start flow:
```typescript
async validateWorkflowImages(taskIds: string[]): Promise<{
  valid: boolean
  invalid: { taskId: string; taskName: string; image: string }[]
}> {
  const invalid = []
  for (const taskId of taskIds) {
    const task = this.db.getTask(taskId)
    const imageToCheck = task?.containerImage || this.settings?.workflow?.container?.image
    
    if (imageToCheck) {
      const exists = await this.checkImageExists(imageToCheck)
      if (!exists) {
        invalid.push({
          taskId,
          taskName: task.name,
          image: imageToCheck
        })
      }
    }
  }
  return { valid: invalid.length === 0, invalid }
}
```

#### Workflow Start Enforcement:
In the start workflow endpoint (`POST /api/start`, `POST /api/execution/start`):
```typescript
// Before starting workflow
const validation = await orchestrator.validateWorkflowImages(taskOrder)
if (!validation.valid) {
  const details = validation.invalid
    .map(i => `"${i.taskName}" (${i.taskId}): ${i.image}`)
    .join('; ')
  return json({
    error: `Cannot start workflow: The following tasks have invalid container images: ${details}. Build the images first.`
  }, 409)
}
```

#### Single Task Start Validation:
In single task start (`POST /api/tasks/:id/start`):
```typescript
const task = this.db.getTask(params.id)
const imageToUse = task?.containerImage || this.settings?.workflow?.container?.image

if (imageToUse) {
  const exists = await this.containerManager.checkImageExists(imageToUse)
  if (!exists) {
    // Log to event system
    await this.logTaskEvent(task.id, 'image_missing', {
      message: `Task start prevented: Container image '${imageToUse}' not found`,
      recommendation: 'Build the image using the Image Builder or select a different image'
    })
    return json({
      error: `Cannot start task: Container image '${imageToUse}' not found. Build the image first.`
    }, 409)
  }
}
```

---

## 8. Container Manager Changes

### Files to Modify:
- `src/runtime/container-manager.ts`

### Implementation Details:

#### New Methods:

```typescript
/**
 * Check if a specific image exists in Podman
 */
async checkImageExists(imageName: string): Promise<boolean> {
  try {
    await this.execPodman(['image', 'exists', imageName])
    return true
  } catch {
    return false
  }
}

/**
 * List all available images
 */
async listImages(): Promise<Array<{
  tag: string
  createdAt: number
  size: string
}>> {
  const result = await this.execPodman([
    'images',
    '--format', 'json',
    '--filter', 'reference=*pi-agent*'  // Filter for project images
  ])
  // Parse JSON output and return array
}

/**
 * Delete an image
 */
async deleteImage(imageName: string): Promise<void> {
  await this.execPodman(['rmi', imageName])
}

/**
 * Create container with specific image
 */
async createContainer(config: ContainerConfig & { imageName?: string }): Promise<ContainerProcess> {
  const imageToUse = config.imageName || this.imageName
  // Use imageToUse instead of this.imageName in podman run command
}
```

---

## 9. Session Manager Changes

### Files to Modify:
- `src/runtime/session-manager.ts`

### Implementation Details:

Modify session creation to pass task's container image:
```typescript
// When creating a container session for a task
const imageToUse = task.containerImage || this.settings?.workflow?.container?.image

await this.containerManager.createContainer({
  sessionId,
  worktreeDir,
  repoRoot: this.projectRoot,
  env: { /* ... */ },
  imageName: imageToUse,  // Pass the task-specific image
})
```

---

## 10. Event Logging

### Files to Modify:
- `src/orchestrator.ts`

### Implementation Details:

When a task cannot start due to missing image, log to the event system:
```typescript
private async logTaskEvent(
  taskId: string,
  eventType: string,
  data: Record<string, unknown>
): Promise<void> {
  // Create a system session message for the task
  const sessionId = this.db.getTask(taskId)?.sessionId
  if (sessionId) {
    await this.db.createSessionMessage({
      sessionId,
      taskId,
      role: 'system',
      messageType: 'error',
      contentJson: {
        eventType,
        timestamp: Date.now(),
        ...data
      },
    })
  }
}
```

Usage when blocking task start:
```typescript
await this.logTaskEvent(task.id, 'execution_blocked', {
  reason: 'missing_container_image',
  image: imageToUse,
  message: `Task execution blocked: Container image '${imageToUse}' not found`,
  recommendation: 'Build the image in Image Builder or select a valid image in task settings'
})
```

---

## 11. Settings Handling

### Files to Modify:
- `src/config/settings.ts` (if needed for default image access)

The system default image is already stored in:
```typescript
settings.workflow.container.image  // e.g., "pi-agent:alpine"
```

Ensure this is accessible to the orchestrator for fallback when `task.containerImage` is not set.

---

## Implementation Order

1. **Database & Types** - Add migration and type definitions
2. **Backend API** - Create new endpoints and modify existing ones
3. **Container Manager** - Add helper methods (checkImageExists, listImages, deleteImage)
4. **Execution Validation** - Add validation logic in orchestrator
5. **Frontend Types & API** - Update type definitions and API composable
6. **Task Modal** - Add container image selector
7. **Task Card** - Add image display tag
8. **Container Config Modal** - Add image management tab
9. **Testing** - Verify all scenarios work correctly

---

## Testing Scenarios

1. Create task without specifying image → should use system default
2. Create task with specific image → should store and display correctly
3. Edit task to change image → should update correctly
4. Start task with valid image → should execute normally
5. Start task with invalid/missing image → should refuse with clear error
6. Start workflow with mixed valid/invalid images → should refuse entire workflow
7. Delete image not in use → should succeed
8. Delete image in use by backlog task → should be blocked
9. Delete image in use by done task → should succeed (or warn)
10. Delete last available image → should be blocked

---

## Files Summary

### Backend:
- `src/db.ts` - Migration v11
- `src/types.ts` - Task interface update
- `src/db/types.ts` - Input types update
- `src/server/server.ts` - New endpoints, validation
- `src/runtime/container-manager.ts` - Image management methods
- `src/runtime/session-manager.ts` - Use task-specific image
- `src/orchestrator.ts` - Validation logic

### Frontend:
- `src/kanban-vue/src/types/api.ts` - Type definitions
- `src/kanban-vue/src/composables/useApi.ts` - API methods
- `src/kanban-vue/src/components/modals/TaskModal.vue` - Image selector
- `src/kanban-vue/src/components/board/TaskCard.vue` - Image display
- `src/kanban-vue/src/components/modals/ContainerConfigModal.vue` - Image management
