<script setup lang="ts">
import { ref, computed, inject, onMounted, watch } from 'vue'
import type { useToasts } from '@/composables/useToasts'
import type { Task } from '@/types/api'

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

interface ContainerImage {
  tag: string
  createdAt: number
  source: 'build' | 'podman'
  inUseByTasks: number
}

interface TaskUsingImage {
  id: string
  name: string
  status: string
}

const emit = defineEmits<{
  close: []
}>()

const toasts = inject<ReturnType<typeof useToasts>>('toasts')!
const workflowRunning = inject<ReturnType<typeof import('@/composables/useWorkflowStatus').useWorkflowStatus>>('workflowRunning', { hasRunningWorkflows: ref(false), checkStatus: async () => {} })

const activeTab = ref<'build' | 'images'>('build')

const profiles = ref<ContainerProfile[]>([])
const builds = ref<ContainerBuild[]>([])
const selectedProfileId = ref('')
const customDockerfile = ref('')
const originalDockerfile = ref('')
const isBuilding = ref(false)
const currentBuildId = ref<number | null>(null)
const showSaveProfileModal = ref(false)
const newProfileName = ref('')
const newProfileId = ref('')
const selectedBuildForLogs = ref<ContainerBuild | null>(null)

// Container feature availability
const containerStatus = ref<{ enabled: boolean; available: boolean; hasRunningWorkflows: boolean; message: string } | null>(null)
const isContainerEnabled = computed(() => {
  if (!containerStatus.value) {
    throw new Error('Container status not loaded: cannot determine if container feature is enabled')
  }
  return containerStatus.value.enabled
})
const hasRunningWorkflows = computed(() => {
  if (workflowRunning.hasRunningWorkflows?.value === undefined) {
    throw new Error('Workflow status not loaded: cannot determine if workflows are running')
  }
  return workflowRunning.hasRunningWorkflows.value
})

const availableImages = ref<ContainerImage[]>([])
const isLoadingImages = ref(false)

const showDeleteModal = ref(false)
const imageToDelete = ref<ContainerImage | null>(null)
const tasksUsingImage = ref<TaskUsingImage[]>([])
const isLoadingTasksUsing = ref(false)

watch(customDockerfile, (value) => {
  if (value === undefined) {
    throw new Error('Invalid state: Dockerfile value cannot be undefined')
  }
  if (value === null) {
    throw new Error('Invalid state: Dockerfile value cannot be null')
  }
}, { immediate: true })

watch(selectedProfileId, (value) => {
  if (value === undefined) {
    throw new Error('Invalid state: selectedProfileId cannot be undefined')
  }
  if (value === null) {
    throw new Error('Invalid state: selectedProfileId cannot be null')
  }
})

watch(selectedProfileId, async (profileId) => {
  if (!profileId) {
    customDockerfile.value = ''
    originalDockerfile.value = ''
    return
  }

  try {
    const response = await fetch(`/api/container/dockerfile/${profileId}`)
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }
    const data: { dockerfile?: string } = await response.json()
    if (data.dockerfile === undefined) {
      throw new Error(`Invalid response: 'dockerfile' is required but was undefined for profile '${profileId}'`)
    }
    customDockerfile.value = data.dockerfile
    originalDockerfile.value = data.dockerfile
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    toasts.showToast(`Failed to load Dockerfile template: ${errorMessage}`, 'error')
    throw new Error(`Failed to load Dockerfile template for profile '${profileId}': ${errorMessage}`)
  }
})

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

const canDeleteImage = computed(() => {
  if (!imageToDelete.value) return false
  return imageToDelete.value.inUseByTasks === 0 && availableImages.value.length > 1
})

const loadProfiles = async () => {
  try {
    const response = await fetch('/api/container/profiles')
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }
    const data: { profiles?: unknown } = await response.json()
    profiles.value = Array.isArray(data.profiles) ? data.profiles : []
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    toasts.showToast(`Failed to load profiles: ${errorMessage}`, 'error')
    throw new Error(`Failed to load container profiles: ${errorMessage}`)
  }
}

const loadBuilds = async () => {
  try {
    const response = await fetch('/api/container/build-status?limit=10')
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }
    const data: { builds?: unknown } = await response.json()
    builds.value = Array.isArray(data.builds) ? data.builds : []
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to load container build status: ${errorMessage}`)
  }
}

const loadContainerStatus = async () => {
  const response = await fetch('/api/container/status')
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  }
  const data: { enabled?: boolean; available?: boolean; hasRunningWorkflows?: boolean; message?: string } = await response.json()
  
  if (typeof data.enabled !== 'boolean') {
    throw new Error(`Invalid response: 'enabled' must be a boolean, got ${typeof data.enabled}`)
  }
  if (typeof data.available !== 'boolean') {
    throw new Error(`Invalid response: 'available' must be a boolean, got ${typeof data.available}`)
  }
  if (typeof data.hasRunningWorkflows !== 'boolean') {
    throw new Error(`Invalid response: 'hasRunningWorkflows' must be a boolean, got ${typeof data.hasRunningWorkflows}`)
  }
  if (typeof data.message !== 'string') {
    throw new Error(`Invalid response: 'message' must be a string, got ${typeof data.message}`)
  }
  
  containerStatus.value = {
    enabled: data.enabled,
    available: data.available,
    hasRunningWorkflows: data.hasRunningWorkflows,
    message: data.message,
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
    const response = await fetch('/api/container/build-status?limit=1')
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }
    const data: { builds?: unknown } = await response.json()
    
    if (!Array.isArray(data.builds)) {
      throw new Error(`Invalid response: 'builds' must be an array, got ${typeof data.builds}`)
    }
    
    const build = data.builds.find((b: ContainerBuild) => b.id === buildId)
    
    if (build && build.status !== 'running' && build.status !== 'pending') {
      isBuilding.value = false
      currentBuildId.value = null
      loadBuilds()
      
      if (build.status === 'success') {
        toasts.showToast(`Build completed successfully: ${build.imageTag}`, 'success')
      } else {
        if (!build.errorMessage) {
          throw new Error(`Build failed but no error message was provided for build ${buildId}`)
        }
        toasts.showToast(`Build failed: ${build.errorMessage}`, 'error')
      }
      return
    }
    
    setTimeout(checkStatus, 2000)
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
  if (originalDockerfile.value === undefined) {
    throw new Error('Cannot reset Dockerfile: original Dockerfile value is undefined')
  }
  customDockerfile.value = originalDockerfile.value
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
  activeTab.value = 'build'
  showDeleteModal.value = false
  imageToDelete.value = null
  tasksUsingImage.value = []
}

const loadImages = async () => {
  isLoadingImages.value = true
  try {
    const response = await fetch('/api/container/images')
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }
    const data: { images?: unknown } = await response.json()
    if (!Array.isArray(data.images)) {
      throw new Error(`Invalid response: 'images' must be an array, got ${typeof data.images}`)
    }
    availableImages.value = data.images.filter((img): img is ContainerImage => 
      typeof img === 'object' && img !== null &&
      'tag' in img && typeof img.tag === 'string' &&
      'createdAt' in img && typeof img.createdAt === 'number' &&
      'source' in img && (img.source === 'build' || img.source === 'podman') &&
      'inUseByTasks' in img && typeof img.inUseByTasks === 'number'
    )
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    toasts.showToast(`Failed to load images: ${errorMessage}`, 'error')
    throw new Error(`Failed to load container images: ${errorMessage}`)
  } finally {
    isLoadingImages.value = false
  }
}

const loadTasksUsingImage = async (tag: string) => {
  isLoadingTasksUsing.value = true
  try {
    const response = await fetch('/api/tasks')
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }
    const tasks: Task[] = await response.json()
    if (!Array.isArray(tasks)) {
      throw new Error(`Invalid response: expected array of tasks, got ${typeof tasks}`)
    }
    tasksUsingImage.value = tasks
      .filter((t) => t.containerImage === tag && t.status !== 'done')
      .map((t) => ({ id: t.id, name: t.name, status: t.status }))
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to load tasks using image '${tag}': ${errorMessage}`)
  } finally {
    isLoadingTasksUsing.value = false
  }
}

const openDeleteModal = async (image: ContainerImage) => {
  imageToDelete.value = image
  showDeleteModal.value = true
  await loadTasksUsingImage(image.tag)
}

const closeDeleteModal = () => {
  showDeleteModal.value = false
  imageToDelete.value = null
  tasksUsingImage.value = []
}

const confirmDeleteImage = async () => {
  if (!imageToDelete.value) {
    throw new Error('No image selected for deletion')
  }
  
  const tag = imageToDelete.value.tag
  
  const response = await fetch(`/api/container/images/${encodeURIComponent(tag)}`, {
    method: 'DELETE'
  })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  }
  const result: { success: boolean; message?: string } = await response.json()
  
  if (typeof result.success !== 'boolean') {
    throw new Error(`Invalid response: 'success' must be a boolean, got ${typeof result.success}`)
  }
  
  if (result.success) {
    toasts.showToast('Image deleted successfully', 'success')
    closeDeleteModal()
    loadImages()
  } else {
    if (!result.message) {
      throw new Error('Image deletion failed but no error message was provided by server')
    }
    toasts.showToast(result.message, 'error')
  }
}

const deleteImage = async (tag: string) => {
  const image = availableImages.value.find(img => img.tag === tag)
  if (!image) return
  
  await openDeleteModal(image)
}

onMounted(async () => {
  resetFormState()
  
  await Promise.all([
    loadContainerStatus(),
    loadProfiles(),
    loadBuilds(),
    loadImages(),
  ])
  
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

      <!-- Tabs -->
      <div class="border-b border-dark-surface3">
        <div class="flex">
          <button
            class="px-4 py-2 text-sm font-medium border-b-2 transition-colors"
            :class="activeTab === 'build' ? 'border-accent-primary text-accent-primary' : 'border-transparent text-dark-text-muted hover:text-dark-text'"
            @click="activeTab = 'build'"
          >
            <span class="flex items-center gap-2">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
              </svg>
              Build
            </span>
          </button>
          <button
            class="px-4 py-2 text-sm font-medium border-b-2 transition-colors"
            :class="activeTab === 'images' ? 'border-accent-primary text-accent-primary' : 'border-transparent text-dark-text-muted hover:text-dark-text'"
            @click="activeTab = 'images'"
          >
            <span class="flex items-center gap-2">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
              </svg>
              Images
              <span v-if="availableImages.length > 0" class="text-xs bg-dark-surface3 px-1.5 py-0.5 rounded">
                {{ availableImages.length }}
              </span>
            </span>
          </button>
        </div>
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

        <!-- Workflow Running Warning (Build tab only) -->
        <div v-else-if="hasRunningWorkflows && activeTab === 'build'" class="bg-red-500/10 border border-red-500/30 rounded-lg p-3">
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

        <!-- Build Tab -->
        <div v-if="activeTab === 'build'" class="space-y-4">
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
                  {{ truncateError(build.errorMessage) }}
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Images Tab -->
        <div v-else-if="activeTab === 'images'" class="space-y-4">
          <div class="flex items-center justify-between">
            <h3 class="text-sm font-medium flex items-center gap-2">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
              </svg>
              Available Images
            </h3>
            <button 
              class="text-xs btn btn-sm" 
              :disabled="isLoadingImages"
              @click="loadImages"
            >
              <svg class="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              {{ isLoadingImages ? 'Loading...' : 'Refresh' }}
            </button>
          </div>
          
          <div v-if="availableImages.length === 0" class="text-sm text-dark-text-muted bg-dark-surface rounded-lg p-8 text-center">
            <svg class="w-12 h-12 mx-auto mb-3 text-dark-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
            </svg>
            <p>No images available.</p>
            <p class="text-xs mt-1">Build an image in the Build tab to see it here.</p>
          </div>
          
          <div v-else class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead class="text-xs text-dark-text-muted uppercase bg-dark-surface">
                <tr>
                  <th class="px-3 py-2 text-left">Image Tag</th>
                  <th class="px-3 py-2 text-left">Created</th>
                  <th class="px-3 py-2 text-left">Source</th>
                  <th class="px-3 py-2 text-left">In Use</th>
                  <th class="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-dark-surface3">
                <tr 
                  v-for="img in availableImages" 
                  :key="img.tag"
                  class="hover:bg-dark-surface/50"
                >
                  <td class="px-3 py-2 font-mono text-xs text-accent-info">{{ img.tag }}</td>
                  <td class="px-3 py-2 text-xs">{{ formatDate(img.createdAt) }}</td>
                  <td class="px-3 py-2">
                    <span 
                      :class="img.source === 'build' ? 'bg-green-500/20 text-green-400' : 'bg-blue-500/20 text-blue-400'"
                      class="text-xs px-2 py-0.5 rounded"
                    >
                      {{ img.source === 'build' ? 'Build' : 'Podman' }}
                    </span>
                  </td>
                  <td class="px-3 py-2">
                    <span 
                      :class="img.inUseByTasks > 0 ? 'text-yellow-400 font-medium' : 'text-dark-text-muted'"
                      class="text-xs"
                    >
                      {{ img.inUseByTasks }} task{{ img.inUseByTasks === 1 ? '' : 's' }}
                    </span>
                  </td>
                  <td class="px-3 py-2 text-right">
                    <button
                      class="text-xs text-red-400 hover:text-red-300 disabled:opacity-50 disabled:cursor-not-allowed px-2 py-1 rounded hover:bg-red-500/10 transition-colors"
                      :disabled="img.inUseByTasks > 0 || availableImages.length <= 1"
                      :title="img.inUseByTasks > 0 ? 'Cannot delete: image is in use by tasks' : availableImages.length <= 1 ? 'Cannot delete the last available image' : 'Delete image'"
                      @click="openDeleteModal(img)"
                    >
                      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          
          <div class="bg-dark-surface rounded-lg p-3 text-xs text-dark-text-muted space-y-1">
            <p class="flex items-center gap-2">
              <svg class="w-4 h-4 text-yellow-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              Images with active tasks using them cannot be deleted.
            </p>
            <p class="flex items-center gap-2">
              <svg class="w-4 h-4 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              The last available image also cannot be deleted.
            </p>
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

      <!-- Delete Confirmation Modal -->
      <div v-if="showDeleteModal" class="modal-overlay z-[1001]" @mousedown="closeDeleteModal">
        <div class="modal w-[min(480px,calc(100vw-40px))]" @mousedown.stop>
          <div class="modal-header">
            <h2 class="flex items-center gap-2 text-red-400">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
              Delete Image
            </h2>
            <button class="modal-close" @click="closeDeleteModal">×</button>
          </div>
          <div class="modal-body space-y-4">
            <!-- Image Info -->
            <div class="bg-dark-surface rounded-lg p-3">
              <div class="text-sm text-dark-text-muted mb-1">Image Tag</div>
              <div class="font-mono text-sm text-accent-info">{{ imageToDelete?.tag }}</div>
            </div>

            <!-- Warning if tasks are using this image -->
            <div v-if="tasksUsingImage.length > 0" class="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3">
              <div class="flex items-start gap-2">
                <svg class="w-5 h-5 text-yellow-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <div>
                  <h3 class="text-sm font-medium text-yellow-400">Cannot Delete</h3>
                  <p class="text-xs text-dark-text-muted mt-1">
                    This image is currently being used by {{ tasksUsingImage.length }} task(s). 
                    Tasks must be completed or use a different image before this image can be deleted.
                  </p>
                </div>
              </div>
            </div>

            <!-- Warning if this is the last image -->
            <div v-else-if="availableImages.length <= 1" class="bg-red-500/10 border border-red-500/30 rounded-lg p-3">
              <div class="flex items-start gap-2">
                <svg class="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <div>
                  <h3 class="text-sm font-medium text-red-400">Cannot Delete Last Image</h3>
                  <p class="text-xs text-dark-text-muted mt-1">
                    This is the last available pi-agent image. You must build another image before deleting this one.
                  </p>
                </div>
              </div>
            </div>

            <!-- Tasks List -->
            <div v-if="tasksUsingImage.length > 0">
              <h4 class="text-xs font-medium text-dark-text-muted uppercase mb-2">Tasks Using This Image</h4>
              <div class="max-h-40 overflow-y-auto space-y-1">
                <div 
                  v-for="task in tasksUsingImage" 
                  :key="task.id"
                  class="flex items-center justify-between p-2 bg-dark-surface rounded text-sm"
                >
                  <div class="flex items-center gap-2">
                    <span class="text-xs text-dark-text-muted">#{{ task.id }}</span>
                    <span class="text-dark-text">{{ task.name }}</span>
                  </div>
                  <span class="text-xs px-2 py-0.5 rounded bg-yellow-500/20 text-yellow-400">
                    {{ task.status }}
                  </span>
                </div>
              </div>
            </div>

            <!-- Confirmation Message -->
            <div v-if="canDeleteImage" class="text-sm text-dark-text">
              <p>Are you sure you want to delete this image?</p>
              <p class="text-xs text-dark-text-muted mt-1">This action cannot be undone.</p>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn" @click="closeDeleteModal">
              {{ canDeleteImage ? 'Cancel' : 'Close' }}
            </button>
            <button 
              v-if="canDeleteImage"
              class="btn btn-danger" 
              @click="confirmDeleteImage"
            >
              Delete Image
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
