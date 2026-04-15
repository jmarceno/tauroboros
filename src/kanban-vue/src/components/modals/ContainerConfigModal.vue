<script setup lang="ts">
import { ref, computed, inject, onMounted, watch } from 'vue'
import type { useToasts } from '@/composables/useToasts'

interface ContainerProfile {
  id: string
  name: string
  description: string
  image: string
  dockerfileTemplate: string
}

interface ContainerBuild {
  id: number
  status: 'pending' | 'running' | 'success' | 'failed' | 'cancelled'
  startedAt: number | null
  completedAt: number | null
  packagesHash: string | null
  errorMessage: string | null
  imageTag: string | null
  logs: string | null
}

const emit = defineEmits<{
  close: []
}>()

const toasts = inject<ReturnType<typeof useToasts>>('toasts')!
const workflowRunning = inject<ReturnType<typeof import('@/composables/useWorkflowStatus').useWorkflowStatus>>('workflowRunning', { hasRunningWorkflows: ref(false), checkStatus: async () => {} })

// Data state
const profiles = ref<ContainerProfile[]>([])
const builds = ref<ContainerBuild[]>([])
const selectedProfileId = ref('')
const customDockerfile = ref('')
const originalDockerfile = ref('') // Track if user made edits
const isBuilding = ref(false)
const currentBuildId = ref<number | null>(null)
const showSaveProfileModal = ref(false)
const newProfileName = ref('')
const newProfileId = ref('')
const selectedBuildForLogs = ref<ContainerBuild | null>(null)

// Container feature availability
const containerStatus = ref<{ enabled: boolean; available: boolean; hasRunningWorkflows: boolean; message: string } | null>(null)
const isContainerEnabled = computed(() => containerStatus.value?.enabled ?? false)
const hasRunningWorkflows = computed(() => workflowRunning.hasRunningWorkflows?.value ?? false)

// Watchers to ensure values never become undefined (prevents .trim() errors)
watch(customDockerfile, (value) => {
  if (value === undefined || value === null) {
    customDockerfile.value = ''
  }
}, { immediate: true })

watch(selectedProfileId, (value) => {
  if (value === undefined || value === null) {
    selectedProfileId.value = ''
  }
})

// Watch for profile selection changes and load Dockerfile
watch(selectedProfileId, async (profileId) => {
  if (!profileId) {
    customDockerfile.value = ''
    originalDockerfile.value = ''
    return
  }

  try {
    const response = await fetch(`/api/container/dockerfile/${profileId}`)
    if (!response.ok) throw new Error('Failed to load Dockerfile')
    const data = await response.json()
    const dockerfile = data.dockerfile || ''
    customDockerfile.value = dockerfile
    originalDockerfile.value = dockerfile
  } catch (error) {
    toasts.showToast('Failed to load Dockerfile template', 'error')
    customDockerfile.value = ''
    originalDockerfile.value = ''
  }
})

// Computed
const selectedProfile = computed(() => {
  return profiles.value.find(p => p.id === selectedProfileId.value)
})

const hasUnsavedChanges = computed(() => {
  return customDockerfile.value !== originalDockerfile.value
})

const canBuild = computed(() => {
  return !isBuilding.value && !hasRunningWorkflows.value && customDockerfile.value.trim().length > 0
})

const buildButtonText = computed(() => {
  if (isBuilding.value) return 'Building...'
  if (hasRunningWorkflows.value) return 'Stop Workflow to Build'
  return 'Save & Build'
})

// Methods
const loadProfiles = async () => {
  try {
    const response = await fetch('/api/container/profiles')
    const data = await response.json()
    profiles.value = data.profiles || []
  } catch (error) {
    toasts.showToast('Failed to load profiles', 'error')
  }
}

const loadBuilds = async () => {
  try {
    const response = await fetch('/api/container/build-status?limit=10')
    const data = await response.json()
    builds.value = data.builds || []
  } catch (error) {
    // Silent fail - builds are non-critical
  }
}

const loadContainerStatus = async () => {
  try {
    const response = await fetch('/api/container/status')
    containerStatus.value = await response.json()
  } catch (error) {
    containerStatus.value = { enabled: false, available: false, hasRunningWorkflows: false, message: 'Failed to load status' }
  }
}

const startBuild = async () => {
  if (hasRunningWorkflows.value) {
    toasts.showToast('Cannot build while workflow is running. Please stop all workflows first.', 'error')
    return
  }

  if (!customDockerfile.value.trim()) {
    toasts.showToast('Dockerfile is empty', 'error')
    return
  }

  isBuilding.value = true
  
  try {
    const response = await fetch('/api/container/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profileId: selectedProfileId.value || 'custom',
        dockerfile: customDockerfile.value,
      }),
    })

    if (!response.ok) {
      const error = await response.json()
      throw new Error(error.error || 'Failed to start build')
    }

    const data = await response.json()
    currentBuildId.value = data.buildId
    toasts.showToast('Build started', 'success')
    
    // Poll for build status
    pollBuildStatus(data.buildId)
  } catch (error) {
    isBuilding.value = false
    toasts.showToast(error instanceof Error ? error.message : 'Failed to start build', 'error')
  }
}

const pollBuildStatus = async (buildId: number) => {
  const checkStatus = async () => {
    try {
      const response = await fetch('/api/container/build-status?limit=1')
      const data = await response.json()
      const build = data.builds?.find((b: ContainerBuild) => b.id === buildId)
      
      if (build && build.status !== 'running' && build.status !== 'pending') {
        isBuilding.value = false
        currentBuildId.value = null
        loadBuilds()
        
        if (build.status === 'success') {
          toasts.showToast(`Build completed successfully: ${build.imageTag}`, 'success')
        } else {
          toasts.showToast(`Build failed: ${build.errorMessage || 'Unknown error'}`, 'error')
        }
        return
      }
      
      // Continue polling
      setTimeout(checkStatus, 2000)
    } catch (error) {
      // Continue polling on error
      setTimeout(checkStatus, 2000)
    }
  }
  
  checkStatus()
}

const openSaveProfileModal = () => {
  if (!customDockerfile.value.trim()) {
    toasts.showToast('Dockerfile is empty', 'error')
    return
  }
  
  // Generate default ID from selected profile or timestamp
  const baseId = selectedProfile.value?.id || 'custom'
  newProfileId.value = `${baseId}-modified-${Date.now()}`
  newProfileName.value = selectedProfile.value 
    ? `${selectedProfile.value.name} (Modified)`
    : 'Custom Profile'
  showSaveProfileModal.value = true
}

const saveAsNewProfile = async () => {
  if (!newProfileId.value.trim() || !newProfileName.value.trim()) {
    toasts.showToast('Profile name and ID are required', 'error')
    return
  }
  
  // Validate ID format
  if (!/^[a-z0-9-]+$/.test(newProfileId.value)) {
    toasts.showToast('Profile ID must be lowercase alphanumeric with hyphens only', 'error')
    return
  }
  
  try {
    const response = await fetch('/api/container/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: newProfileId.value,
        name: newProfileName.value,
        description: `Custom profile based on ${selectedProfile.value?.name || 'manual edit'}`,
        image: selectedProfile.value?.image || 'custom',
        dockerfileTemplate: customDockerfile.value,
      }),
    })
    
    if (!response.ok) {
      const error = await response.json()
      throw new Error(error.error || 'Failed to save profile')
    }
    
    const data = await response.json()
    toasts.showToast(`Profile "${newProfileName.value}" saved successfully`, 'success')
    showSaveProfileModal.value = false
    
    // Reload profiles and select the new one
    await loadProfiles()
    selectedProfileId.value = newProfileId.value
    originalDockerfile.value = customDockerfile.value
  } catch (error) {
    toasts.showToast(error instanceof Error ? error.message : 'Failed to save profile', 'error')
  }
}

const resetDockerfile = () => {
  customDockerfile.value = originalDockerfile.value || ''
}

const formatDate = (timestamp: number | null) => {
  if (!timestamp) return '-'
  return new Date(timestamp * 1000).toLocaleString()
}

const formatStatus = (status: string) => {
  const statusMap: Record<string, { text: string; color: string }> = {
    success: { text: 'Success', color: 'text-green-400' },
    failed: { text: 'Failed', color: 'text-red-400' },
    running: { text: 'Running', color: 'text-yellow-400' },
    pending: { text: 'Pending', color: 'text-blue-400' },
    cancelled: { text: 'Cancelled', color: 'text-gray-400' },
  }
  return statusMap[status] || { text: status, color: 'text-gray-400' }
}

const viewBuildLogs = (build: ContainerBuild) => {
  selectedBuildForLogs.value = build
}

const closeBuildLogs = () => {
  selectedBuildForLogs.value = null
}

// Truncate error message for display in list
const truncateError = (errorMessage: string | null, maxLength: number = 100): string => {
  if (!errorMessage) return ''
  const lines = errorMessage.split('\n')
  const firstLine = lines[0]
  if (firstLine.length > maxLength) {
    return firstLine.slice(0, maxLength) + '...'
  }
  return firstLine
}

// Reset form state when modal opens
const resetFormState = () => {
  selectedProfileId.value = ''
  customDockerfile.value = ''
  originalDockerfile.value = ''
  isBuilding.value = false
  currentBuildId.value = null
  showSaveProfileModal.value = false
  newProfileName.value = ''
  newProfileId.value = ''
  selectedBuildForLogs.value = null
}

// Initialize
onMounted(async () => {
  // Reset state first to prevent stale data issues
  resetFormState()
  
  await Promise.all([
    loadContainerStatus(),
    loadProfiles(),
    loadBuilds(),
  ])
  
  // Check workflow status
  workflowRunning.checkStatus?.()
})
</script>

<template>
  <div class="modal-overlay" @mousedown="emit('close')">
    <div class="modal w-[min(900px,calc(100vw-40px))]" @mousedown.stop>
      <div class="modal-header">
        <h2 class="flex items-center gap-2">
          <svg class="w-5 h-5 text-accent-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
          </svg>
          Image Builder
        </h2>
        <button class="modal-close" @click="emit('close')">×</button>
      </div>

      <div class="modal-body space-y-4">
        <!-- Container Status Warning -->
        <div v-if="!isContainerEnabled" class="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3">
          <div class="flex items-start gap-2">
            <svg class="w-5 h-5 text-yellow-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <div>
              <h3 class="text-sm font-medium text-yellow-400">Container Mode Disabled</h3>
              <p class="text-xs text-dark-text-muted mt-1">
                {{ containerStatus?.message || 'Container mode is not enabled. Edit .tauroboros/settings.json to enable.' }}
              </p>
            </div>
          </div>
        </div>

        <!-- Workflow Running Warning -->
        <div v-else-if="hasRunningWorkflows" class="bg-red-500/10 border border-red-500/30 rounded-lg p-3">
          <div class="flex items-start gap-2">
            <svg class="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div>
              <h3 class="text-sm font-medium text-red-400">Workflow Running</h3>
              <p class="text-xs text-dark-text-muted mt-1">
                Cannot build container image while a workflow is running. Please stop all workflows first.
              </p>
            </div>
          </div>
        </div>

        <!-- Profile Selector -->
        <div class="form-group">
          <label class="flex items-center gap-2 mb-2">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
            Select Profile
          </label>
          <select 
            v-model="selectedProfileId"
            class="form-select"
            :disabled="isBuilding"
          >
            <option value="">-- Select a base profile --</option>
            <option
              v-for="profile in profiles"
              :key="profile.id"
              :value="profile.id"
            >
              {{ profile.name }} - {{ profile.description }}
            </option>
          </select>
          <p class="text-xs text-dark-text-muted mt-1">
            Select a base profile to pre-populate the Dockerfile. You can edit it below before building.
          </p>
        </div>

        <!-- Dockerfile Editor -->
        <div class="form-group">
          <div class="flex items-center justify-between mb-2">
            <label class="flex items-center gap-2">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              Dockerfile
              <span v-if="hasUnsavedChanges" class="text-xs text-yellow-400">(modified)</span>
            </label>
            <div class="flex gap-2">
              <button
                v-if="hasUnsavedChanges && selectedProfileId"
                class="btn btn-sm"
                :disabled="isBuilding"
                @click="openSaveProfileModal"
              >
                Save as New Profile
              </button>
              <button
                v-if="hasUnsavedChanges"
                class="btn btn-sm"
                :disabled="isBuilding"
                @click="resetDockerfile"
              >
                Reset
              </button>
            </div>
          </div>
          <textarea
            v-model="customDockerfile"
            class="form-textarea font-mono text-xs"
            rows="16"
            :disabled="isBuilding"
            placeholder="# Select a profile above or write your own Dockerfile here..."
          />
          <p class="text-xs text-dark-text-muted mt-1">
            Edit the Dockerfile directly. Changes are not saved until you click "Save & Build" or "Save as New Profile".
          </p>
        </div>

        <!-- Build Button -->
        <div class="flex gap-2">
          <button
            class="btn btn-primary flex-1 flex items-center justify-center gap-2"
            :disabled="!canBuild"
            @click="startBuild"
          >
            <svg v-if="isBuilding" class="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            <svg v-else class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
            {{ buildButtonText }}
          </button>
        </div>

        <!-- Build History -->
        <div>
          <label class="flex items-center gap-2 mb-2">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Build History
          </label>
          <div v-if="builds.length === 0" class="text-sm text-dark-text-muted bg-dark-surface rounded-lg p-3 text-center">
            No builds yet. Select a profile and click "Save & Build" to create your first image.
          </div>
          <div v-else class="space-y-2">
            <div
              v-for="build in builds.slice(0, 5)"
              :key="build.id"
              class="flex items-center justify-between p-2 bg-dark-surface rounded-lg text-sm"
            >
              <div class="flex items-center gap-2">
                <span :class="formatStatus(build.status).color" class="font-medium">
                  {{ formatStatus(build.status).text }}
                </span>
                <span class="text-dark-text">{{ build.imageTag }}</span>
                <span class="text-xs text-dark-text-muted">{{ formatDate(build.startedAt) }}</span>
              </div>
              <div v-if="build.errorMessage" class="text-xs text-red-400">
                {{ build.errorMessage }}
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Save Profile Modal (nested) -->
      <div v-if="showSaveProfileModal" class="modal-overlay" style="z-index: 1001;" @mousedown="showSaveProfileModal = false">
        <div class="modal w-[min(400px,calc(100vw-40px))]" @mousedown.stop>
          <div class="modal-header">
            <h2>Save as New Profile</h2>
            <button class="modal-close" @click="showSaveProfileModal = false">×</button>
          </div>
          <div class="modal-body space-y-3">
            <div class="form-group">
              <label>Profile Name</label>
              <input
                v-model="newProfileName"
                type="text"
                class="form-input"
                placeholder="My Custom Profile"
              />
            </div>
            <div class="form-group">
              <label>Profile ID</label>
              <input
                v-model="newProfileId"
                type="text"
                class="form-input font-mono text-xs"
                placeholder="my-custom-profile"
              />
              <p class="text-xs text-dark-text-muted mt-1">
                Lowercase alphanumeric with hyphens only. Cannot be changed later.
              </p>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn" @click="showSaveProfileModal = false">
              Cancel
            </button>
            <button class="btn btn-primary" @click="saveAsNewProfile">
              Save Profile
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
