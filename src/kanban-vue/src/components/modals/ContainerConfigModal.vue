<script setup lang="ts">
import { ref, computed, inject, onMounted, watch } from 'vue'
import type { useToasts } from '@/composables/useToasts'
import type { useApi } from '@/composables/useApi'

interface ContainerPackage {
  id?: number
  name: string
  category: string
  versionConstraint?: string
  installOrder: number
  source?: string
}

interface ContainerProfile {
  id: string
  name: string
  description: string
  packages: Array<{ name: string; category: string }>
  extends?: string
}

interface ContainerBuild {
  id: number
  status: 'pending' | 'running' | 'success' | 'failed' | 'cancelled'
  startedAt: number | null
  completedAt: number | null
  packagesHash: string | null
  errorMessage: string | null
  imageTag: string | null
}

const emit = defineEmits<{
  close: []
}>()

const toasts = inject<ReturnType<typeof useToasts>>('toasts')!
const api = inject<ReturnType<typeof useApi>>('api', {} as ReturnType<typeof useApi>)

// Tab state
const activeTab = ref<'packages' | 'build'>('packages')

// Data state
const profiles = ref<ContainerProfile[]>([])
const packages = ref<ContainerPackage[]>([])
const builds = ref<ContainerBuild[]>([])
const selectedProfile = ref('')
const newPackageName = ref('')
const newPackageCategory = ref('tool')
const customDockerfileContent = ref('')
const generatedDockerfilePreview = ref('')
const isLoading = ref(false)
const isValidating = ref(false)
const validationMessage = ref('')
const buildLogs = ref<string[]>([])
const currentBuildStatus = ref<ContainerBuild | null>(null)

// Container feature availability
const containerStatus = ref<{ enabled: boolean; available: boolean; message: string } | null>(null)
const isContainerEnabled = computed(() => containerStatus.value?.enabled ?? false)

// Package categories
const categories = ['browser', 'language', 'tool', 'build', 'system', 'math']

// Computed
const packagesByCategory = computed(() => {
  const grouped: Record<string, ContainerPackage[]> = {}
  for (const cat of categories) {
    grouped[cat] = packages.value.filter(p => p.category === cat)
  }
  // Add any packages with unknown categories
  const otherPackages = packages.value.filter(p => !categories.includes(p.category))
  if (otherPackages.length > 0) {
    grouped['other'] = otherPackages
  }
  return grouped
})

const hasPackages = computed(() => packages.value.length > 0)

const isBuilding = computed(() => currentBuildStatus.value?.status === 'running')

const canRebuild = computed(() => {
  return !isBuilding.value && hasPackages.value
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

const loadPackages = async () => {
  try {
    const response = await fetch('/api/container/packages')
    const data = await response.json()
    packages.value = data.packages || []
  } catch (error) {
    toasts.showToast('Failed to load packages', 'error')
  }
}

const loadDockerfilePreview = async () => {
  try {
    const response = await fetch('/api/container/dockerfile')
    const data = await response.json()
    generatedDockerfilePreview.value = data.dockerfile || ''
  } catch (error) {
    // Silent fail - preview is non-critical
  }
}

const loadCustomDockerfile = async () => {
  try {
    const response = await fetch('/api/container/dockerfile/custom')
    const data = await response.json()
    customDockerfileContent.value = data.content || ''
  } catch (error) {
    // Silent fail
  }
}

const loadBuilds = async () => {
  try {
    const response = await fetch('/api/container/build-status?limit=5')
    const data = await response.json()
    builds.value = data.builds || []
    // Set current build status if there's a running build
    const runningBuild = builds.value.find(b => b.status === 'running')
    if (runningBuild) {
      currentBuildStatus.value = runningBuild
    }
  } catch (error) {
    // Silent fail
  }
}

const loadContainerStatus = async () => {
  try {
    const response = await fetch('/api/container/status')
    if (response.ok) {
      containerStatus.value = await response.json()
    }
  } catch (error) {
    // Silent fail - assume disabled if endpoint fails
    containerStatus.value = { enabled: false, available: false, message: 'Container status unavailable' }
  }
}

const applyProfile = async () => {
  if (!selectedProfile.value) return

  try {
    isLoading.value = true
    const response = await fetch(`/api/container/profiles/${selectedProfile.value}/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })

    if (!response.ok) {
      const error = await response.json()
      throw new Error(error.error || 'Failed to apply profile')
    }

    const data = await response.json()
    packages.value = data.packages || []
    selectedProfile.value = ''
    toasts.showToast(`Profile applied: ${data.packagesAdded} packages added`, 'success')
    await loadDockerfilePreview()
  } catch (error) {
    toasts.showToast('Failed to apply profile: ' + (error instanceof Error ? error.message : String(error)), 'error')
  } finally {
    isLoading.value = false
  }
}

const validatePackageName = async (name: string): Promise<boolean> => {
  if (!name.trim()) return false

  isValidating.value = true
  validationMessage.value = 'Checking package availability...'

  try {
    const response = await fetch('/api/container/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ packages: [name.trim()] }),
    })

    const data = await response.json()

    if (data.invalid?.length > 0) {
      const invalid = data.invalid[0]
      const suggestions = data.suggestions?.[invalid] || []
      validationMessage.value = suggestions.length > 0
        ? `Package '${invalid}' not found. Did you mean: ${suggestions.slice(0, 3).join(', ')}?`
        : `Package '${invalid}' not found in Alpine repositories`
      return false
    }

    validationMessage.value = `Package '${name}' is available`
    return true
  } catch (error) {
    validationMessage.value = 'Validation failed, but you can still add the package'
    return true // Allow adding even if validation fails
  } finally {
    isValidating.value = false
  }
}

const addPackage = async () => {
  const name = newPackageName.value.trim()
  if (!name) {
    validationMessage.value = 'Package name is required'
    return
  }

  // Check if package already exists
  if (packages.value.some(p => p.name === name)) {
    validationMessage.value = `Package '${name}' is already in the list`
    return
  }

  // Validate if desired
  if (newPackageCategory.value === 'browser' || newPackageCategory.value === 'language') {
    const isValid = await validatePackageName(name)
    if (!isValid) return
  }

  try {
    const response = await fetch('/api/container/packages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        category: newPackageCategory.value,
        installOrder: packages.value.length,
      }),
    })

    if (!response.ok) {
      const error = await response.json()
      throw new Error(error.error || 'Failed to add package')
    }

    const added = await response.json()
    packages.value.push(added)
    newPackageName.value = ''
    validationMessage.value = ''
    toasts.showToast(`Package '${name}' added`, 'success')
    await loadDockerfilePreview()
  } catch (error) {
    toasts.showToast('Failed to add package: ' + (error instanceof Error ? error.message : String(error)), 'error')
  }
}

const removePackage = async (name: string) => {
  try {
    const response = await fetch(`/api/container/packages/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    })

    if (!response.ok) {
      const error = await response.json()
      throw new Error(error.error || 'Failed to remove package')
    }

    packages.value = packages.value.filter(p => p.name !== name)
    toasts.showToast(`Package '${name}' removed`, 'success')
    await loadDockerfilePreview()
  } catch (error) {
    toasts.showToast('Failed to remove package: ' + (error instanceof Error ? error.message : String(error)), 'error')
  }
}

const triggerRebuild = async () => {
  if (!hasPackages.value) {
    toasts.showToast('Add at least one package before building', 'error')
    return
  }

  if (!confirm('This will build a new container image with the selected packages. The build may take several minutes. Continue?')) {
    return
  }

  try {
    isLoading.value = true
    buildLogs.value = []

    const response = await fetch('/api/container/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        packages: packages.value,
        imageTag: `pi-agent:custom-${Date.now()}`,
      }),
    })

    if (!response.ok) {
      const error = await response.json()
      throw new Error(error.error || 'Failed to start build')
    }

    const data = await response.json()
    currentBuildStatus.value = {
      id: data.buildId,
      status: 'running',
      startedAt: Math.floor(Date.now() / 1000),
      completedAt: null,
      packagesHash: null,
      errorMessage: null,
      imageTag: data.imageTag,
    }

    toasts.showToast('Container build started', 'success')

    // Poll for build updates
    pollBuildStatus(data.buildId)
  } catch (error) {
    toasts.showToast('Failed to start build: ' + (error instanceof Error ? error.message : String(error)), 'error')
  } finally {
    isLoading.value = false
  }
}

const pollBuildStatus = async (buildId: number) => {
  const checkStatus = async () => {
    try {
      const response = await fetch('/api/container/build-status?limit=1')
      const data = await response.json()
      const build = data.builds?.find((b: ContainerBuild) => b.id === buildId)

      if (build) {
        currentBuildStatus.value = build

        if (build.status === 'success') {
          toasts.showToast('Container build completed successfully!', 'success')
        } else if (build.status === 'failed') {
          toasts.showToast('Container build failed: ' + (build.errorMessage || 'Unknown error'), 'error')
        } else if (build.status === 'running') {
          // Continue polling
          setTimeout(checkStatus, 2000)
        }
      }
    } catch {
      // Silent fail, stop polling
    }
  }

  checkStatus()
}

const cancelBuild = async () => {
  if (!currentBuildStatus.value || currentBuildStatus.value.status !== 'running') return

  try {
    const response = await fetch('/api/container/build/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ buildId: currentBuildStatus.value.id }),
    })

    if (response.ok) {
      currentBuildStatus.value = { ...currentBuildStatus.value, status: 'cancelled' }
      toasts.showToast('Build cancelled', 'info')
    }
  } catch (error) {
    toasts.showToast('Failed to cancel build', 'error')
  }
}

const saveCustomDockerfile = async () => {
  try {
    const response = await fetch('/api/container/dockerfile/custom', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: customDockerfileContent.value }),
    })

    if (response.ok) {
      toasts.showToast('Custom Dockerfile saved', 'success')
      await loadDockerfilePreview()
    }
  } catch (error) {
    toasts.showToast('Failed to save custom Dockerfile', 'error')
  }
}

const saveConfig = async () => {
  try {
    const response = await fetch('/api/container/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: 1,
        baseImage: 'docker.io/alpine:3.19',
        packages: packages.value,
      }),
    })

    if (response.ok) {
      toasts.showToast('Configuration saved', 'success')
    }
  } catch (error) {
    toasts.showToast('Failed to save configuration', 'error')
  }
}

const saveAndClose = async () => {
  await saveConfig()
  emit('close')
}

const startContainerConfigChat = async () => {
  try {
    isLoading.value = true
    const response = await fetch('/api/planning/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionKind: 'container_config',
        model: 'default',
        thinkingLevel: 'default',
      }),
    })

    if (!response.ok) {
      const error = await response.json()
      throw new Error(error.error || 'Failed to start chat')
    }

    const data = await response.json()
    toasts.showToast('Container config chat started', 'success')
    
    // Open the session in a new tab or navigate to it
    if (data.sessionUrl) {
      window.open(data.sessionUrl, '_blank')
    }
  } catch (error) {
    toasts.showToast('Failed to start chat: ' + (error instanceof Error ? error.message : String(error)), 'error')
  } finally {
    isLoading.value = false
  }
}

const closeOnOverlay = (e: MouseEvent) => {
  if (e.target === e.currentTarget) {
    emit('close')
  }
}

const formatCategory = (category: string): string => {
  return category.charAt(0).toUpperCase() + category.slice(1)
}

const getStatusIcon = (status: string): string => {
  const icons: Record<string, string> = {
    running: '⏳',
    success: '✅',
    failed: '❌',
    cancelled: '🚫',
    pending: '⏸️',
  }
  return icons[status] || '❓'
}

// Initialize
onMounted(async () => {
  await loadContainerStatus()
  await Promise.all([
    loadProfiles(),
    loadPackages(),
    loadDockerfilePreview(),
    loadCustomDockerfile(),
    loadBuilds(),
  ])
})

// Watch for tab changes
watch(activeTab, async (tab) => {
  if (tab === 'build') {
    await loadDockerfilePreview()
    await loadCustomDockerfile()
  }
})
</script>

<template>
  <div class="modal-overlay" @mousedown="closeOnOverlay">
    <div class="modal w-[900px] max-h-[85vh]">
      <!-- Header -->
      <div class="modal-header">
        <h2 class="flex items-center gap-2">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
          </svg>
          Container Configuration
        </h2>
        <button class="modal-close" @click="emit('close')">×</button>
      </div>

      <!-- Container Mode Disabled Banner -->
      <div
        v-if="!isContainerEnabled"
        class="px-4 py-4 border-b bg-amber-500/10 border-amber-500/30"
      >
        <div class="flex items-start gap-3">
          <span class="text-lg">⚠️</span>
          <div class="flex-1">
            <p class="text-sm font-medium text-amber-300">
              Container mode is disabled
            </p>
            <p class="text-xs text-amber-200/80 mt-1">
              {{ containerStatus?.message || 'Container features are currently unavailable.' }}
            </p>
          </div>
        </div>
      </div>

      <!-- Build Status Banner -->
      <div
        v-if="currentBuildStatus"
        class="px-4 py-3 border-b"
        :class="{
          'bg-yellow-500/10 border-yellow-500/20': currentBuildStatus.status === 'running',
          'bg-green-500/10 border-green-500/20': currentBuildStatus.status === 'success',
          'bg-red-500/10 border-red-500/20': currentBuildStatus.status === 'failed',
          'bg-slate-500/10 border-slate-500/20': currentBuildStatus.status === 'cancelled',
        }"
      >
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span class="text-lg">{{ getStatusIcon(currentBuildStatus.status) }}</span>
            <span class="text-sm font-medium">
              Build {{ currentBuildStatus.status }}
              <span v-if="currentBuildStatus.imageTag" class="text-dark-text-muted">- {{ currentBuildStatus.imageTag }}</span>
            </span>
          </div>
          <button
            v-if="currentBuildStatus.status === 'running'"
            class="text-xs px-2 py-1 bg-slate-600 hover:bg-slate-500 rounded"
            @click="cancelBuild"
          >
            Cancel
          </button>
        </div>
      </div>

      <!-- Tabs -->
      <div class="flex border-b border-dark-surface3">
        <button
          v-for="tab in [{ id: 'packages', label: 'Packages' }, { id: 'build', label: 'Build' }]"
          :key="tab.id"
          class="px-4 py-2 text-sm font-medium border-b-2 transition-colors"
          :class="[
            activeTab === tab.id
              ? 'border-indigo-500 text-indigo-400'
              : 'border-transparent text-dark-text-muted hover:text-dark-text',
          ]"
          @click="activeTab = tab.id as 'packages' | 'build'"
        >
          {{ tab.label }}
        </button>
      </div>

      <!-- Tab Content -->
      <div class="modal-body overflow-y-auto" style="max-height: calc(85vh - 180px);">
        <!-- Packages Tab -->
        <div v-if="activeTab === 'packages'" class="space-y-6">
          <!-- Profile Selector -->
          <div class="section">
            <h3 class="text-sm font-semibold mb-2 flex items-center gap-2">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
              </svg>
              Quick Setup with Profiles
            </h3>
            <div class="flex gap-2">
              <select v-model="selectedProfile" class="form-select flex-1">
                <option value="">Select a preset profile...</option>
                <option
                  v-for="profile in profiles"
                  :key="profile.id"
                  :value="profile.id"
                >
                  {{ profile.name }} - {{ profile.description }}
                </option>
              </select>
              <button
                class="btn btn-primary"
                :disabled="!selectedProfile || isLoading || !isContainerEnabled"
                @click="applyProfile"
              >
                Apply
              </button>
            </div>
          </div>

          <!-- Container Config Chat -->
          <div class="section bg-indigo-500/5 border border-indigo-500/20 rounded-lg p-4">
            <h3 class="text-sm font-semibold mb-2 flex items-center gap-2 text-indigo-300">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
              Need Help?
            </h3>
            <p class="text-sm text-dark-text-muted mb-3">
              Not sure which packages you need? Chat with our Container Configuration Assistant to get personalized recommendations.
            </p>
            <button
              class="btn btn-primary flex items-center gap-2"
              :disabled="isLoading || !isContainerEnabled"
              @click="startContainerConfigChat"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
              </svg>
              Start Config Chat
            </button>
          </div>

          <!-- Package List -->
          <div class="section">
            <h3 class="text-sm font-semibold mb-3 flex items-center gap-2">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 10h16M4 14h16M4 18h16" />
              </svg>
              Installed Packages
              <span v-if="packages.length > 0" class="text-xs text-dark-text-muted">({{ packages.length }})</span>
            </h3>

            <div v-if="packages.length === 0" class="text-sm text-dark-text-muted bg-dark-surface rounded-lg p-4 text-center">
              No packages added yet. Select a profile above or add packages individually.
            </div>

            <div v-else class="space-y-3">
              <div
                v-for="category in categories"
                :key="category"
                v-if="packagesByCategory[category]?.length > 0"
              >
                <h4 class="text-xs font-medium text-dark-text-muted uppercase tracking-wider mb-2">
                  {{ formatCategory(category) }}
                </h4>
                <div class="flex flex-wrap gap-2">
                  <div
                    v-for="pkg in packagesByCategory[category]"
                    :key="pkg.name"
                    class="flex items-center gap-1 bg-dark-surface border border-dark-surface3 rounded-full px-3 py-1 text-sm"
                  >
                    <span>{{ pkg.name }}</span>
                    <button
                      class="text-dark-text-muted hover:text-red-400 ml-1"
                      title="Remove package"
                      @click="removePackage(pkg.name)"
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
            <h3 class="text-sm font-semibold mb-3 flex items-center gap-2">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
              </svg>
              Add Package
            </h3>
            <div class="flex gap-2">
              <input
                v-model="newPackageName"
                type="text"
                class="form-input flex-1"
                placeholder="Package name (e.g., vim, python3, chromium)"
                @keyup.enter="addPackage"
              />
              <select v-model="newPackageCategory" class="form-select w-32">
                <option value="browser">Browser</option>
                <option value="language">Language</option>
                <option value="tool">Tool</option>
                <option value="build">Build</option>
                <option value="system">System</option>
                <option value="math">Math</option>
              </select>
              <button
                class="btn btn-primary"
                :disabled="!newPackageName.trim() || isValidating || !isContainerEnabled"
                @click="addPackage"
              >
                {{ isValidating ? 'Checking...' : 'Add' }}
              </button>
            </div>
            <div v-if="validationMessage" class="mt-2 text-xs" :class="{
              'text-green-400': validationMessage.includes('is available') || validationMessage.includes('is valid'),
              'text-yellow-400': validationMessage.includes('failed') || validationMessage.includes('but'),
              'text-red-400': validationMessage.includes('not found') || validationMessage.includes('already'),
            }">
              {{ validationMessage }}
            </div>
          </div>
        </div>

        <!-- Build Tab -->
        <div v-if="activeTab === 'build'" class="space-y-6">
          <!-- Build Info -->
          <div class="section">
            <h3 class="text-sm font-semibold mb-3">Build Configuration</h3>
            <div class="space-y-2 text-sm">
              <div class="flex justify-between py-1 border-b border-dark-surface3">
                <span class="text-dark-text-muted">Base Image:</span>
                <code class="text-xs bg-dark-surface px-2 py-0.5 rounded">docker.io/alpine:3.19</code>
              </div>
              <div class="flex justify-between py-1 border-b border-dark-surface3">
                <span class="text-dark-text-muted">Generated Dockerfile:</span>
                <code class="text-xs bg-dark-surface px-2 py-0.5 rounded">.pi/tauroboros/Dockerfile.generated</code>
              </div>
              <div class="flex justify-between py-1 border-b border-dark-surface3">
                <span class="text-dark-text-muted">Custom Dockerfile:</span>
                <code class="text-xs bg-dark-surface px-2 py-0.5 rounded">.pi/tauroboros/Dockerfile.custom</code>
              </div>
            </div>
          </div>

          <!-- Dockerfile Preview -->
          <div class="section">
            <h3 class="text-sm font-semibold mb-3">Generated Dockerfile Preview</h3>
            <pre class="bg-dark-surface border border-dark-surface3 rounded-lg p-3 text-xs overflow-x-auto" style="max-height: 200px;"><code>{{ generatedDockerfilePreview || 'Loading...' }}</code></pre>
          </div>

          <!-- Custom Dockerfile -->
          <div class="section">
            <h3 class="text-sm font-semibold mb-3 flex items-center justify-between">
              <span>Custom Dockerfile (User Editable)</span>
              <button class="text-xs btn btn-sm" @click="saveCustomDockerfile">Save</button>
            </h3>
            <textarea
              v-model="customDockerfileContent"
              class="form-textarea w-full font-mono text-xs"
              rows="6"
              placeholder="# Add your custom RUN commands here..."
            />
            <p class="text-xs text-dark-text-muted mt-1">
              Custom commands will be appended to the generated Dockerfile during build.
            </p>
          </div>

          <!-- Build History -->
          <div v-if="builds.length > 0" class="section">
            <h3 class="text-sm font-semibold mb-3">Recent Builds</h3>
            <div class="space-y-2">
              <div
                v-for="build in builds.slice(0, 5)"
                :key="build.id"
                class="flex items-center justify-between py-2 px-3 bg-dark-surface rounded-lg text-sm"
              >
                <div class="flex items-center gap-2">
                  <span>{{ getStatusIcon(build.status) }}</span>
                  <span class="text-dark-text-muted">#{{ build.id }}</span>
                  <span v-if="build.imageTag" class="text-xs">{{ build.imageTag }}</span>
                </div>
                <span class="text-xs text-dark-text-muted">
                  {{ build.startedAt ? new Date(build.startedAt * 1000).toLocaleString() : 'Unknown' }}
                </span>
              </div>
            </div>
          </div>

          <!-- PROMINENT REBUILD BUTTON -->
          <div class="section pt-4 border-t border-dark-surface3">
            <button
              class="w-full py-4 px-6 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-600 disabled:cursor-not-allowed text-white font-semibold rounded-lg flex items-center justify-center gap-3 transition-colors"
              :disabled="!canRebuild"
              @click="triggerRebuild"
            >
              <svg v-if="isBuilding" class="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              <svg v-else class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              <span>{{ isBuilding ? 'Building...' : 'Rebuild Container Image' }}</span>
            </button>
            <p class="text-xs text-dark-text-muted mt-2 text-center">
              This will create a new image with your {{ packages.length }} selected package{{ packages.length === 1 ? '' : 's' }}.
              The build may take several minutes.
            </p>
          </div>
        </div>
      </div>

      <!-- Footer -->
      <div class="modal-footer">
        <button class="btn" @click="emit('close')">Close</button>
        <button
          class="btn btn-primary"
          :disabled="isBuilding || !isContainerEnabled"
          @click="saveAndClose"
        >
          Save
        </button>
      </div>
    </div>
  </div>
</template>
