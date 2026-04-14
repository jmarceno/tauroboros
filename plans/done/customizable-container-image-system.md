# Customizable Container Image System - Implementation Plan

## Executive Summary

A dual-interface system allowing users to customize the Pi Agent container image through either a visual Web UI modal or a guided Planning Chat experience. The system generates a custom Dockerfile from user-selected Alpine packages and preset profiles, validates packages before building, and provides explicit rebuild controls.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  Frontend (Vue)                                             │
│  ┌─────────────────────┐  ┌──────────────────────────────┐ │
│  │ ContainerConfigModal│  │ "container_config" agent     │ │
│  │ (Primary Interface) │  │ (Guided experience)         │ │
│  └─────────────────────┘  └──────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  Backend API                                                │
│  POST /api/container/packages          (CRUD packages)      │
│  GET  /api/container/profiles          (List presets)         │
│  POST /api/container/validate          (Validate packages)    │
│  POST /api/container/build             (Trigger rebuild)      │
│  GET  /api/container/build-status      (Progress stream)      │
│  GET  /api/container/dockerfile        (View generated)       │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  Runtime Layer                                              │
│  ContainerImageManager (extended)                           │
│  ├─ generateDockerfile()      (Template + packages)          │
│  ├─ validatePackages()      (Alpk APK index check)         │
│  ├─ buildCustomImage()      (Podman build)                 │
│  └─ Custom Dockerfile stored in .pi/tauroboros/         │
└─────────────────────────────────────────────────────────────┘
```

---

## Phase 1: Data Layer

### 1.1 Database Schema

**New Table: `container_packages`**
```sql
CREATE TABLE container_packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  version_constraint TEXT,
  install_order INTEGER DEFAULT 0,
  added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  source TEXT DEFAULT 'manual'
);

CREATE INDEX idx_container_packages_category ON container_packages(category);
CREATE INDEX idx_container_packages_order ON container_packages(install_order);
```

**New Table: `container_builds` (for history/tracking)**
```sql
CREATE TABLE container_builds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL,
  started_at DATETIME,
  completed_at DATETIME,
  packages_hash TEXT,
  error_message TEXT,
  image_tag TEXT
);
```

### 1.2 Configuration Files

**`.pi/tauroboros/container-config.json`** (Tauri-safe)
```json
{
  "version": 1,
  "baseImage": "docker.io/alpine:3.19",
  "customDockerfilePath": ".pi/tauroboros/Dockerfile.custom",
  "generatedDockerfilePath": ".pi/tauroboros/Dockerfile.generated",
  "packages": [
    { "name": "chromium", "category": "browser", "installOrder": 0 },
    { "name": "chromium-chromedriver", "category": "browser", "installOrder": 1 },
    { "name": "rust", "category": "language", "installOrder": 2 }
  ],
  "lastBuild": {
    "timestamp": "2024-01-15T10:30:00Z",
    "imageTag": "pi-agent:custom-abc123",
    "success": true
  }
}
```

**`.pi/tauroboros/Dockerfile.custom`** (User-editable, optional)
- Created empty with comments if doesn't exist
- User can add custom RUN commands
- Never modified by the system
- Merged into generated Dockerfile during build

---

## Phase 2: Backend Implementation

### 2.1 Extended ContainerImageManager

```typescript
// src/runtime/container-image-manager.ts

interface PackageDefinition {
  name: string;
  category: string;
  versionConstraint?: string;
  installOrder: number;
}

interface ContainerConfig {
  baseImage: string;
  packages: PackageDefinition[];
  customDockerfilePath?: string;
}

class ContainerImageManager {
  /**
   * Generate Dockerfile from template + packages
   */
  async generateDockerfile(config: ContainerConfig): Promise<string>;

  /**
   * Validate packages exist in Alpine repos
   */
  async validatePackages(packages: string[]): Promise<{
    valid: string[];
    invalid: string[];
    suggestions: Record<string, string[]>;
  }>;

  /**
   * Build custom image with generated Dockerfile
   */
  async buildCustomImage(config: ContainerConfig): Promise<{
    success: boolean;
    imageTag: string;
    logs: string[];
  }>;

  /**
   * Load/save container configuration
   */
  async loadContainerConfig(): Promise<ContainerConfig>;
  async saveContainerConfig(config: ContainerConfig): Promise<void>;
}
```

### 2.2 API Endpoints

```typescript
// src/server/server.ts (add to router)

// Package management
POST   /api/container/packages
DELETE /api/container/packages/:name
GET    /api/container/packages

// Preset profiles
GET    /api/container/profiles
POST   /api/container/profiles/:id/apply

// Build operations
POST   /api/container/validate
POST   /api/container/build
GET    /api/container/build-status
POST   /api/container/build/cancel

// Dockerfile
GET    /api/container/dockerfile
GET    /api/container/dockerfile/custom
PUT    /api/container/dockerfile/custom
```

### 2.3 Preset Profiles (JSON file)

**`src/config/container-profiles.json`**
```json
{
  "profiles": [
    {
      "id": "web-dev",
      "name": "Web Development",
      "description": "Chrome, Playwright dependencies, Node.js tools",
      "packages": [
        { "name": "chromium", "category": "browser" },
        { "name": "chromium-chromedriver", "category": "browser" },
        { "name": "nss", "category": "system" },
        { "name": "freetype", "category": "system" },
        { "name": "harfbuzz", "category": "system" },
        { "name": "ttf-freefont", "category": "system" }
      ]
    },
    {
      "id": "rust-dev",
      "name": "Rust Development",
      "description": "Rust compiler, Cargo, and build essentials",
      "packages": [
        { "name": "rust", "category": "language" },
        { "name": "cargo", "category": "language" },
        { "name": "build-base", "category": "build" },
        { "name": "openssl-dev", "category": "build" },
        { "name": "pkgconfig", "category": "build" }
      ]
    },
    {
      "id": "python-dev",
      "name": "Python Development",
      "description": "Python 3, pip, and development headers",
      "packages": [
        { "name": "python3", "category": "language" },
        { "name": "py3-pip", "category": "language" },
        { "name": "python3-dev", "category": "build" },
        { "name": "gcc", "category": "build" },
        { "name": "musl-dev", "category": "build" }
      ]
    },
    {
      "id": "data-science",
      "name": "Data Science",
      "description": "Python with common data science libraries support",
      "extends": "python-dev",
      "packages": [
        { "name": "lapack-dev", "category": "math" },
        { "name": "openblas-dev", "category": "math" },
        { "name": "libffi-dev", "category": "build" }
      ]
    }
  ]
}
```

---

## Phase 3: Frontend Modal Implementation

### 3.1 ContainerConfigModal.vue Structure

```vue
<template>
  <div class="modal-overlay" @mousedown="closeOnOverlay">
    <div class="modal w-[800px]">
      
      <!-- Header -->
      <div class="modal-header">
        <h2>Container Configuration</h2>
        <button class="modal-close" @click="emit('close')">×</button>
      </div>

      <div class="modal-body">
        <!-- Build Status Banner -->
        <div v-if="buildStatus" :class="['build-banner', buildStatus.type]">
          <span class="status-icon">{{ buildStatus.icon }}</span>
          <span class="status-text">{{ buildStatus.message }}</span>
          <button v-if="buildStatus.canCancel" @click="cancelBuild">
            Cancel
          </button>
        </div>

        <!-- Tabs -->
        <div class="tabs">
          <button 
            v-for="tab in tabs" 
            :key="tab.id"
            :class="['tab', { active: activeTab === tab.id }]"
            @click="activeTab = tab.id"
          >
            {{ tab.label }}
          </button>
        </div>

        <!-- Tab: Packages -->
        <div v-if="activeTab === 'packages'" class="tab-content">
          <!-- Profile Selector -->
          <div class="section">
            <h3>Quick Setup</h3>
            <select v-model="selectedProfile" @change="applyProfile">
              <option value="">Select a preset profile...</option>
              <option 
                v-for="profile in profiles" 
                :key="profile.id" 
                :value="profile.id"
              >
                {{ profile.name }} - {{ profile.description }}
              </option>
            </select>
          </div>

          <!-- Package List -->
          <div class="section">
            <h3>Installed Packages</h3>
            <div class="package-categories">
              <div 
                v-for="category in categories" 
                :key="category"
                class="category-group"
              >
                <h4>{{ formatCategory(category) }}</h4>
                <div class="package-list">
                  <div 
                    v-for="pkg in packagesByCategory[category]" 
                    :key="pkg.name"
                    class="package-item"
                  >
                    <span class="package-name">{{ pkg.name }}</span>
                    <button 
                      class="btn-icon"
                      @click="removePackage(pkg.name)"
                      title="Remove"
                    >
                      ×
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Add Package -->
          <div class="section">
            <h3>Add Package</h3>
            <div class="add-package-form">
              <input 
                v-model="newPackage.name"
                placeholder="Package name (e.g., vim)"
                @keyup.enter="addPackage"
              />
              <select v-model="newPackage.category">
                <option value="browser">Browser</option>
                <option value="language">Language</option>
                <option value="tool">Tool</option>
                <option value="build">Build</option>
                <option value="system">System</option>
              </select>
              <button class="btn" @click="addPackage" :disabled="!isValidPackage">
                Add
              </button>
            </div>
            <div v-if="validationMessage" class="validation-message">
              {{ validationMessage }}
            </div>
          </div>
        </div>

        <!-- Tab: Build -->
        <div v-if="activeTab === 'build'" class="tab-content">
          <div class="section">
            <h3>Build Configuration</h3>
            <div class="info-row">
              <label>Generated Dockerfile:</label>
              <code>{{ generatedDockerfilePath }}</code>
            </div>
            <div class="info-row">
              <label>Custom Dockerfile:</label>
              <code>{{ customDockerfilePath }}</code>
              <span class="hint">Edit manually for advanced customization</span>
            </div>
          </div>

          <div class="section">
            <h3>Preview</h3>
            <pre class="dockerfile-preview"><code>{{ previewDockerfile }}</code></pre>
          </div>

          <!-- PROMINENT REBUILD BUTTON -->
          <div class="section build-section">
            <button 
              class="btn btn-primary btn-large rebuild-btn"
              @click="triggerRebuild"
              :disabled="isBuilding || packages.length === 0"
            >
              <span v-if="isBuilding" class="spinner"></span>
              <span v-else>🔄 Rebuild Container Image</span>
            </button>
            <p class="build-hint">
              This will create a new image with your selected packages.
              The build may take several minutes.
            </p>
          </div>

          <!-- Build Log -->
          <div v-if="buildLogs.length > 0" class="section">
            <h3>Build Log</h3>
            <pre class="build-log"><code>{{ buildLogs.join('\n') }}</code></pre>
          </div>
        </div>
      </div>

      <!-- Footer -->
      <div class="modal-footer">
        <button class="btn" @click="emit('close')">Close</button>
        <button 
          class="btn btn-primary" 
          @click="saveAndClose"
          :disabled="isBuilding"
        >
          Save
        </button>
      </div>
    </div>
  </div>
</template>
```

### 3.2 Key Interactions

| Action | Behavior |
|--------|----------|
| **Apply Profile** | Adds all profile packages to the list, shows confirmation toast |
| **Add Package** | Validates package name against Alpine repos, shows validation state |
| **Remove Package** | Immediate removal from list, marks config dirty |
| **Rebuild Button** | Shows confirmation dialog, starts build process, streams logs |
| **Cancel Build** | Sends cancel request, shows "cancelling" state |
| **Save** | Persists package list to database and JSON config |

---

## Phase 4: Planning Chat Agent

### 4.1 New Session Kind

**`src/db/types.ts`**
```typescript
export type PiSessionKind =
  | "task"
  | "task_run_worker"
  | "task_run_reviewer"
  | "task_run_final_applier"
  | "review_scratch"
  | "repair"
  | "plan"
  | "plan_revision"
  | "planning"
  | "container_config";  // NEW
```

### 4.2 System Prompt Template

**Database: `prompt_templates` table**
```markdown
---
name: container_assistant
description: "Assistant for customizing container images with user-friendly guidance"
---

You are a Container Configuration Assistant helping users customize their Pi Agent container image.

Your goal is to understand what tools the user needs and help them configure the container image accordingly.

## Available Profiles
- **web-dev**: Chrome, Playwright, web testing tools
- **rust-dev**: Rust compiler, Cargo, build tools
- **python-dev**: Python 3, pip, development headers
- **data-science**: Python with NumPy/SciPy/pandas support

## Capabilities
1. Recommend profiles based on user needs
2. Suggest specific Alpine packages
3. Explain what each package does
4. Validate package names (use validate_packages tool)
5. Trigger image rebuilds when ready

## Interaction Flow
1. Ask what kind of development work they do
2. Suggest appropriate profile(s)
3. Ask about specific tools they need
4. Build package list with explanations
5. Confirm before triggering rebuild

## Tools Available
- `validate_packages`: Check if package names exist in Alpine repos
- `apply_profile`: Add all packages from a profile
- `add_package`: Add a specific package
- `remove_package`: Remove a package
- `trigger_build`: Start the image rebuild process
- `get_build_status`: Check current build progress

Be conversational but focused. Don't overwhelm with technical details unless asked.
```

### 4.3 Chat Interface Integration

- User can start a "Container Config" chat from a button in the ContainerConfigModal
- Or from a new menu item in the main chat container
- Chat uses same WebSocket streaming as other planning sessions
- Special UI indicators show this is a config session (different color/icon)

---

## Phase 5: Tauri Compatibility

### 5.1 File Access Strategy

**Core Principle**: Never touch internal bundled files

| File Type | Location | Access Mode |
|-----------|----------|-------------|
| Base Dockerfile | Internal (bundled) | Read-only, never modified |
| Generated Dockerfile | `.pi/tauroboros/Dockerfile.generated` | Write by system |
| Custom Dockerfile | `.pi/tauroboros/Dockerfile.custom` | Write by user |
| Config JSON | `.pi/tauroboros/container-config.json` | Read/Write by system |
| Package Database | SQLite `container_packages` table | Read/Write by system |

### 5.2 Implementation Notes

1. **Path Resolution**: Use `findProjectRoot()` + `.pi/tauroboros/` prefix
2. **File Watching**: Watch `.pi/tauroboros/Dockerfile.custom` for external edits
3. **Error Handling**: Graceful fallback if file system access restricted
4. **Dockerfile Merge**: System reads custom Dockerfile and appends it to generated one

---

## Phase 6: Validation & Package Management

### 6.1 Alpine Package Validation

```typescript
// Validation strategy
async function validateAlpinePackage(name: string): Promise<ValidationResult> {
  // Option 1: Query Alpine APK index (cached)
  // Option 2: Use `apk search --exact` in temp container
  // Option 3: Check local cache first, fall back to online
  
  return {
    valid: boolean,
    exactMatch: boolean,
    suggestions: string[],
    description?: string
  };
}
```

### 6.2 Cache Strategy

- Maintain local cache of Alpine package index (daily refresh)
- Cache validation results per session
- Show "checking..." state while validating

---

## Key Design Decisions

1. **Explicit Rebuild**: Large, prominent rebuild button with confirmation to ensure users are aware of the time cost
2. **Manual Dockerfile**: System-generated Dockerfile is immutable by users; custom Dockerfile is user-editable and appended
3. **Profile System**: Pre-defined profiles for common use cases, but users can mix/match and add custom packages
4. **Validation**: Pre-flight validation to catch typos and missing packages before long build process
5. **Dual Interface**: Both visual modal and conversational agent for different user preferences
6. **Tauri-Safe**: All mutable data in `.pi/tauroboros/`, never touching internal bundled files

---

## Open Questions

1. **Build Notifications**: Should we add Telegram/webhook notifications when builds complete/fail?

2. **Image Tagging**: Should each build get a unique tag (e.g., `pi-agent:custom-20240115-abc123`) or overwrite `pi-agent:custom`?

3. **Rollback**: Should we keep the last N successful images for quick rollback?

4. **Package Versions**: Do you want to support specific version constraints (e.g., `rust=1.75`)?

5. **Build Scheduling**: Should we support "build at night" or scheduled builds?
