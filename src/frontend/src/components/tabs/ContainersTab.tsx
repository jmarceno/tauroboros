/**
 * ContainersTab Component - Container management
 * Ported from React to SolidJS
 */

import { createSignal, createEffect, onMount, onCleanup } from 'solid-js'
import { createQuery, useQueryClient } from '@tanstack/solid-query'
import { containersApi, runApiEffect, sleepMs, tasksApi, type ContainerBuild, type ContainerProfile, type ContainerStatus } from '@/api'
import { uiStore } from '@/stores'
import type { ContainerImage, Task } from '@/types'
import { formatLocalDateTime } from '@/utils/date'

const buildStatuses = ['pending', 'running', 'success', 'failed', 'cancelled'] as const
type BuildStatus = (typeof buildStatuses)[number]

export function ContainersTab() {
  const queryClient = useQueryClient()

  const [activeTab, setActiveTab] = createSignal<'build' | 'images'>('build')
  const [profiles, setProfiles] = createSignal<ContainerProfile[]>([])
  const [builds, setBuilds] = createSignal<ContainerBuild[]>([])
  const [selectedProfileId, setSelectedProfileId] = createSignal('')
  const [customDockerfile, setCustomDockerfile] = createSignal('')
  const [originalDockerfile, setOriginalDockerfile] = createSignal('')
  const [isBuilding, setIsBuilding] = createSignal(false)
  const [currentBuildId, setCurrentBuildId] = createSignal<number | null>(null)
  const [showSaveProfileModal, setShowSaveProfileModal] = createSignal(false)
  const [newProfileName, setNewProfileName] = createSignal('')
  const [newProfileId, setNewProfileId] = createSignal('')
  const [selectedBuildForLogs, setSelectedBuildForLogs] = createSignal<ContainerBuild | null>(null)
  const [containerStatus, setContainerStatus] = createSignal<ContainerStatus | null>(null)
  const [availableImages, setAvailableImages] = createSignal<ContainerImage[]>([])
  const [isLoadingImages, setIsLoadingImages] = createSignal(false)
  const [showDeleteModal, setShowDeleteModal] = createSignal(false)
  const [imageToDelete, setImageToDelete] = createSignal<ContainerImage | null>(null)
  const [tasksUsingImage, setTasksUsingImage] = createSignal<{ id: string; name: string; status: string }[]>([])
  const [isLoadingTasksUsing, setIsLoadingTasksUsing] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  const isContainerEnabled = () => containerStatus()?.enabled === true
  const hasRunningWorkflows = () => containerStatus()?.hasRunningWorkflows === true

  const selectedProfile = () => profiles().find(p => p.id === selectedProfileId())
  const hasUnsavedChanges = () => customDockerfile() !== originalDockerfile()
  const canBuild = () => !isBuilding() && !hasRunningWorkflows() && customDockerfile().trim().length > 0

  const buildButtonText = () => isBuilding() ? 'Building...' : hasRunningWorkflows() ? 'Stop Workflow to Build' : 'Save & Build'

  const loadProfiles = async () => {
    const data = await runApiEffect(containersApi.getProfiles())
    setProfiles(data.profiles)
  }

  const loadBuilds = async () => {
    const data = await runApiEffect(containersApi.getBuilds(10))
    setBuilds(data.builds)
  }

  const loadContainerStatus = async () => {
    setContainerStatus(await runApiEffect(containersApi.getStatus()))
  }

  const loadImages = async () => {
    setIsLoadingImages(true)
    try {
      const data = await runApiEffect(containersApi.getImages())
      setAvailableImages(data.images)
    } finally {
      setIsLoadingImages(false)
    }
  }

  const loadTasksUsingImage = async (tag: string) => {
    setIsLoadingTasksUsing(true)
    try {
      const tasks = await runApiEffect(tasksApi.getAll())
      setTasksUsingImage(
        tasks
          .filter((t: Task) => t.containerImage === tag && t.status !== 'done')
          .map((t: Task) => ({ id: t.id, name: t.name, status: t.status }))
      )
    } finally {
      setIsLoadingTasksUsing(false)
    }
  }

  // Initial load
  onMount(async () => {
    try {
      await Promise.all([
        loadContainerStatus(),
        loadProfiles(),
        loadBuilds(),
        loadImages(),
      ])
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : 'Failed to load container data'
      setError(`Failed to load container data: ${errorMessage}`)
    }
  })

  // Load Dockerfile when profile changes
  createEffect(() => {
    const profileId = selectedProfileId()
    if (!profileId) {
      setCustomDockerfile('')
      setOriginalDockerfile('')
      return
    }

    const loadDockerfile = async () => {
      try {
        const data = await runApiEffect(containersApi.getDockerfile(profileId))
        setCustomDockerfile(data.dockerfile)
        setOriginalDockerfile(data.dockerfile)
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : 'Failed to load Dockerfile'
        setError(`Failed to load Dockerfile: ${errorMessage}`)
      }
    }
    loadDockerfile()
  })

  let pollToken = 0

  onCleanup(() => {
    pollToken += 1
  })

  const startBuild = async () => {
    if (hasRunningWorkflows()) {
      alert('Cannot build while workflow is running. Please stop all workflows first.')
      return
    }

    if (!canBuild()) {
      return
    }

    const token = ++pollToken
    setIsBuilding(true)
    setError(null)

    try {
      const data = await runApiEffect(containersApi.build({
        profileId: selectedProfileId() || 'custom',
        dockerfile: customDockerfile(),
      }))

      setCurrentBuildId(data.buildId)
      await pollBuildStatus(data.buildId, token)
    } catch (e) {
      if (token !== pollToken) {
        return
      }
      setIsBuilding(false)
      const errorMessage = e instanceof Error ? e.message : 'Failed to start build'
      setError(errorMessage)
      alert(errorMessage)
    }
  }

  const pollBuildStatus = async (buildId: number, token: number) => {
    while (token === pollToken) {
      try {
        const data = await runApiEffect(containersApi.getBuilds(1))

        const build = data.builds.find((b: unknown) => {
          if (typeof b !== 'object' || b === null) return false
          const candidate = b as Record<string, unknown>
          return typeof candidate.id === 'number' && candidate.id === buildId
        })

        if (build === undefined) {
          setIsBuilding(false)
          setCurrentBuildId(null)
          alert(`Build ${buildId} not found in status response`)
          return
        }

        const typedBuild = build as ContainerBuild
        if (typedBuild.status !== 'running' && typedBuild.status !== 'pending') {
          setIsBuilding(false)
          setCurrentBuildId(null)
          await loadBuilds()

          if (typedBuild.status === 'success') {
            alert(`Build completed successfully: ${typedBuild.imageTag}`)
          } else {
            alert(`Build failed: ${typedBuild.errorMessage}`)
          }
          return
        }

        await sleepMs(2000)
      } catch (e) {
        if (token !== pollToken) {
          return
        }
        const errorMessage = e instanceof Error ? e.message : 'Build status check failed'
        setIsBuilding(false)
        setCurrentBuildId(null)
        setError(`Build polling failed: ${errorMessage}. Build may still be running in the background.`)
        return
      }
    }
  }

  const openSaveProfileModal = () => {
    if (!customDockerfile().trim()) {
      alert('Dockerfile is empty')
      return
    }

    const baseId = selectedProfile()?.id || 'custom'
    setNewProfileId(`${baseId}-modified-${Date.now()}`)
    setNewProfileName(selectedProfile() ? `${selectedProfile()!.name} (Modified)` : 'Custom Profile')
    setShowSaveProfileModal(true)
  }

  const saveAsNewProfile = async () => {
    if (!newProfileId().trim() || !newProfileName().trim()) {
      alert('Profile name and ID are required')
      return
    }

    if (!/^[a-z0-9-]+$/.test(newProfileId())) {
      alert('Profile ID must be lowercase alphanumeric with hyphens only')
      return
    }

    try {
      await runApiEffect(containersApi.createProfile({
          id: newProfileId(),
          name: newProfileName(),
          description: `Custom profile based on ${selectedProfile()?.name || 'manual edit'}`,
          image: selectedProfile()?.image || 'custom',
          dockerfileTemplate: customDockerfile(),
        }))

      alert(`Profile "${newProfileName()}" saved successfully`)
      setShowSaveProfileModal(false)
      await loadProfiles()
      setSelectedProfileId(newProfileId())
      setOriginalDockerfile(customDockerfile())
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to save profile')
    }
  }

  const resetDockerfile = () => {
    setCustomDockerfile(originalDockerfile())
  }

  const formatDate = (timestamp: number | null) => {
    if (!timestamp) return '-'
    return formatLocalDateTime(timestamp)
  }

  const formatStatus = (status: string): { text: string; color: string } => {
    const statusMap: Record<BuildStatus, { text: string; color: string }> = {
      success: { text: 'Success', color: 'text-green-400' },
      failed: { text: 'Failed', color: 'text-red-400' },
      running: { text: 'Running', color: 'text-yellow-400' },
      pending: { text: 'Pending', color: 'text-blue-400' },
      cancelled: { text: 'Cancelled', color: 'text-gray-400' },
    }

    const isValidStatus = (s: string): s is BuildStatus =>
      buildStatuses.includes(s as BuildStatus)

    if (isValidStatus(status)) {
      return statusMap[status]
    }
    return { text: status, color: 'text-gray-400' }
  }

  const truncateError = (errorMessage: string | null, maxLength: number = 100): string => {
    if (!errorMessage) return ''
    const lines = errorMessage.split('\n')
    const firstLine = lines[0]
    if (firstLine.length > maxLength) {
      return firstLine.slice(0, maxLength) + '...'
    }
    return firstLine
  }

  const openDeleteModal = async (image: ContainerImage) => {
    setImageToDelete(image)
    setShowDeleteModal(true)
    await loadTasksUsingImage(image.tag)
  }

  const closeDeleteModal = () => {
    setShowDeleteModal(false)
    setImageToDelete(null)
    setTasksUsingImage([])
  }

  const confirmDeleteImage = async () => {
    if (!imageToDelete()) return

    const tag = imageToDelete()!.tag

    try {
      const result = await runApiEffect(containersApi.deleteImage(tag))
      if (result.success) {
        alert('Image deleted successfully')
        closeDeleteModal()
        loadImages()
      } else {
        alert(result.message || 'Failed to delete image')
      }
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to delete image')
    }
  }

  const canDeleteImage = () => imageToDelete() && imageToDelete()!.inUseByTasks === 0 && availableImages().length > 1

  const clearError = () => setError(null)

  return (
    <div class="flex-1 overflow-y-auto p-6">
      <div class="max-w-5xl mx-auto space-y-6">
        {error() && (
          <div class="bg-red-500/10 border border-red-500/30 rounded-lg p-3">
            <div class="flex items-start gap-2">
              <svg class="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div class="flex-1">
                <h3 class="text-sm font-medium text-red-400">Error</h3>
                <p class="text-xs text-dark-text-muted mt-1">{error()}</p>
              </div>
              <button
                class="text-dark-text-muted hover:text-dark-text"
                onClick={clearError}
                aria-label="Close error message"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        )}

        <div class="flex items-center justify-between pb-4 border-b border-dark-surface3">
          <h2 class="text-xl font-semibold text-dark-text flex items-center gap-2">
            <svg class="w-5 h-5 text-accent-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
            </svg>
            Container Image Builder
          </h2>
        </div>

        <div class="flex border-b border-dark-surface3">
          <button
            class={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab() === 'build'
                ? 'border-accent-primary text-accent-primary'
                : 'border-transparent text-dark-text-muted hover:text-dark-text'
            }`}
            onClick={() => setActiveTab('build')}
          >
            <span class="flex items-center gap-2">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
              </svg>
              Build
            </span>
          </button>
          <button
            class={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab() === 'images'
                ? 'border-accent-primary text-accent-primary'
                : 'border-transparent text-dark-text-muted hover:text-dark-text'
            }`}
            onClick={() => setActiveTab('images')}
          >
            <span class="flex items-center gap-2">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79 8-4" />
              </svg>
              Images
              {availableImages().length > 0 && (
                <span class="text-xs bg-dark-surface3 px-1.5 py-0.5 rounded">
                  {availableImages().length}
                </span>
              )}
            </span>
          </button>
        </div>

        {!isContainerEnabled() ? (
          <div class="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3">
            <div class="flex items-start gap-2">
              <svg class="w-5 h-5 text-yellow-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <div>
                <h3 class="text-sm font-medium text-yellow-400">Container Mode Disabled</h3>
                <p class="text-xs text-dark-text-muted mt-1">
                  {containerStatus()?.message || 'Container mode is not enabled. Edit .tauroboros/settings.json to enable.'}
                </p>
              </div>
            </div>
          </div>
        ) : hasRunningWorkflows() && activeTab() === 'build' ? (
          <div class="bg-red-500/10 border border-red-500/30 rounded-lg p-3">
            <div class="flex items-start gap-2">
              <svg class="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div>
                <h3 class="text-sm font-medium text-red-400">Workflow Running</h3>
                <p class="text-xs text-dark-text-muted mt-1">
                  Cannot build container image while a workflow is running. Please stop all workflows first.
                </p>
              </div>
            </div>
          </div>
        ) : null}

        {activeTab() === 'build' && (
          <div class="space-y-6">
            <div class="form-group">
              <label class="flex items-center gap-2 mb-2 text-sm font-medium text-dark-text">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                </svg>
                Select Profile
              </label>
              <select
                class="form-select"
                value={selectedProfileId()}
                disabled={isBuilding()}
                onChange={(e) => setSelectedProfileId(e.currentTarget.value)}
              >
                <option value="">-- Select a base profile --</option>
                {profiles().map((profile) => (
                  <option value={profile.id}>
                    {profile.name} - {profile.description}
                  </option>
                ))}
              </select>
              <p class="text-xs text-dark-text-muted mt-1">
                Select a base profile to pre-populate the Dockerfile. You can edit it below before building.
              </p>
            </div>

            <div class="form-group">
              <div class="flex items-center justify-between mb-2">
                <label class="flex items-center gap-2 text-sm font-medium text-dark-text">
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  Dockerfile
                  {hasUnsavedChanges() && <span class="text-xs text-yellow-400">(modified)</span>}
                </label>
                <div class="flex gap-2">
                  {hasUnsavedChanges() && selectedProfileId() && (
                    <button
                      class="btn btn-sm"
                      disabled={isBuilding()}
                      onClick={openSaveProfileModal}
                    >
                      Save as New Profile
                    </button>
                  )}
                  {hasUnsavedChanges() && (
                    <button
                      class="btn btn-sm"
                      disabled={isBuilding()}
                      onClick={resetDockerfile}
                    >
                      Reset
                    </button>
                  )}
                </div>
              </div>
              <textarea
                class="form-textarea font-mono text-xs min-h-[300px]"
                disabled={isBuilding()}
                value={customDockerfile()}
                onChange={(e) => setCustomDockerfile(e.currentTarget.value)}
                placeholder="# Select a profile above or write your own Dockerfile here..."
              />
              <p class="text-xs text-dark-text-muted mt-1">
                Edit the Dockerfile directly. Changes are not saved until you click "Save & Build" or "Save as New Profile".
              </p>
            </div>

            <button
              class="btn btn-primary w-full flex items-center justify-center gap-2"
              disabled={!canBuild()}
              onClick={startBuild}
            >
              {isBuilding() ? (
                <svg class="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
              ) : (
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                </svg>
              )}
              {buildButtonText()}
            </button>

            <div>
              <label class="flex items-center gap-2 mb-3 text-sm font-medium text-dark-text">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Build History
              </label>
              {builds().length === 0 ? (
                <div class="text-sm text-dark-text-muted bg-dark-surface rounded-lg p-4 text-center">
                  No builds yet. Select a profile and click "Save & Build" to create your first image.
                </div>
              ) : (
                <div class="space-y-2">
                  {builds().slice(0, 5).map((build) => (
                    <div
                      class="flex items-center justify-between p-3 bg-dark-surface rounded-lg text-sm cursor-pointer hover:bg-dark-surface3 transition-colors"
                      onClick={() => setSelectedBuildForLogs(build)}
                    >
                      <div class="flex items-center gap-3">
                        <span class={formatStatus(build.status).color}>
                          {formatStatus(build.status).text}
                        </span>
                        <span class="text-dark-text font-mono text-xs">{build.imageTag}</span>
                        <span class="text-xs text-dark-text-muted">{formatDate(build.startedAt)}</span>
                      </div>
                      {build.errorMessage && (
                        <div class="text-xs text-red-400">
                          {truncateError(build.errorMessage)}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab() === 'images' && (
          <div class="space-y-4">
            <div class="flex items-center justify-between">
              <h3 class="text-sm font-medium flex items-center gap-2 text-dark-text">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79 8-4" />
                </svg>
                Available Images
              </h3>
              <button
                class="text-xs btn btn-sm"
                disabled={isLoadingImages()}
                onClick={loadImages}
              >
                {isLoadingImages() ? 'Loading...' : 'Refresh'}
              </button>
            </div>

            {availableImages().length === 0 ? (
              <div class="text-sm text-dark-text-muted bg-dark-surface rounded-lg p-8 text-center">
                <svg class="w-12 h-12 mx-auto mb-3 text-dark-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79 8-4" />
                </svg>
                <p>No images available.</p>
                <p class="text-xs mt-1">Build an image in the Build tab to see it here.</p>
              </div>
            ) : (
              <div class="overflow-x-auto">
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
                    {availableImages().map((img) => (
                      <tr class="hover:bg-dark-surface/50">
                        <td class="px-3 py-2 font-mono text-xs text-accent-info">{img.tag}</td>
                        <td class="px-3 py-2 text-xs">{formatDate(img.createdAt)}</td>
                        <td class="px-3 py-2">
                          <span
                            class={`text-xs px-2 py-0.5 rounded ${
                              img.source === 'build'
                                ? 'bg-green-500/20 text-green-400'
                                : 'bg-blue-500/20 text-blue-400'
                            }`}
                          >
                            {img.source === 'build' ? 'Build' : 'Podman'}
                          </span>
                        </td>
                        <td class="px-3 py-2">
                          <span
                            class={`text-xs ${
                              img.inUseByTasks > 0 ? 'text-yellow-400 font-medium' : 'text-dark-text-muted'
                            }`}
                          >
                            {img.inUseByTasks} task{img.inUseByTasks === 1 ? '' : 's'}
                          </span>
                        </td>
                        <td class="px-3 py-2 text-right">
                          <button
                            class="text-xs text-red-400 hover:text-red-300 disabled:opacity-50 disabled:cursor-not-allowed px-2 py-1 rounded hover:bg-red-500/10 transition-colors"
                            disabled={img.inUseByTasks > 0 || availableImages().length <= 1}
                            title={
                              img.inUseByTasks > 0
                                ? 'Cannot delete: image is in use by tasks'
                                : availableImages().length <= 1
                                ? 'Cannot delete the last available image'
                                : 'Delete image'
                            }
                            onClick={() => openDeleteModal(img)}
                          >
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div class="bg-dark-surface rounded-lg p-3 text-xs text-dark-text-muted space-y-1">
              <p class="flex items-center gap-2">
                <svg class="w-4 h-4 text-yellow-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                Images with active tasks using them cannot be deleted.
              </p>
              <p class="flex items-center gap-2">
                <svg class="w-4 h-4 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                The last available image also cannot be deleted.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Save Profile Modal */}
      {showSaveProfileModal() && (
        <div
          class="fixed inset-0 z-[1001] flex items-center justify-center bg-black/50"
          onClick={() => setShowSaveProfileModal(false)}
        >
          <div
            class="bg-dark-surface2 rounded-lg shadow-xl w-[min(400px,calc(100vw-40px))] border border-dark-surface3"
            onClick={(e) => e.stopPropagation()}
          >
            <div class="flex items-center justify-between px-4 py-3 border-b border-dark-surface3">
              <h3 class="text-lg font-medium text-dark-text">Save as New Profile</h3>
              <button
                class="text-2xl leading-none text-dark-text-muted hover:text-dark-text"
                onClick={() => setShowSaveProfileModal(false)}
              >
                ×
              </button>
            </div>
            <div class="p-4 space-y-3">
              <div class="form-group">
                <label class="block text-sm font-medium text-dark-text mb-1">Profile Name</label>
                <input
                  type="text"
                  class="form-input"
                  placeholder="My Custom Profile"
                  value={newProfileName()}
                  onChange={(e) => setNewProfileName(e.currentTarget.value)}
                />
              </div>
              <div class="form-group">
                <label class="block text-sm font-medium text-dark-text mb-1">Profile ID</label>
                <input
                  type="text"
                  class="form-input font-mono text-xs"
                  placeholder="my-custom-profile"
                  value={newProfileId()}
                  onChange={(e) => setNewProfileId(e.currentTarget.value)}
                />
                <p class="text-xs text-dark-text-muted mt-1">
                  Lowercase alphanumeric with hyphens only. Cannot be changed later.
                </p>
              </div>
            </div>
            <div class="flex justify-end gap-2 px-4 py-3 border-t border-dark-surface3">
              <button class="btn btn-sm" onClick={() => setShowSaveProfileModal(false)}>
                Cancel
              </button>
              <button class="btn btn-primary btn-sm" onClick={saveAsNewProfile}>
                Save Profile
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Image Modal */}
      {showDeleteModal() && imageToDelete() && (
        <div
          class="fixed inset-0 z-[1001] flex items-center justify-center bg-black/50"
          onClick={closeDeleteModal}
        >
          <div
            class="bg-dark-surface2 rounded-lg shadow-xl w-[min(480px,calc(100vw-40px))] border border-dark-surface3"
            onClick={(e) => e.stopPropagation()}
          >
            <div class="flex items-center justify-between px-4 py-3 border-b border-dark-surface3">
              <h3 class="flex items-center gap-2 text-lg font-medium text-red-400">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
                Delete Image
              </h3>
              <button
                class="text-2xl leading-none text-dark-text-muted hover:text-dark-text"
                onClick={closeDeleteModal}
              >
                ×
              </button>
            </div>
            <div class="p-4 space-y-4">
              <div class="bg-dark-surface rounded-lg p-3">
                <div class="text-sm text-dark-text-muted mb-1">Image Tag</div>
                <div class="font-mono text-sm text-accent-info">{imageToDelete()!.tag}</div>
              </div>

              {tasksUsingImage().length > 0 && (
                <div class="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3">
                  <div class="flex items-start gap-2">
                    <svg class="w-5 h-5 text-yellow-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                    <div>
                      <h4 class="text-sm font-medium text-yellow-400">Cannot Delete</h4>
                      <p class="text-xs text-dark-text-muted mt-1">
                        This image is currently being used by {tasksUsingImage().length} task(s). Tasks must be completed or use a different image before this image can be deleted.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {availableImages().length <= 1 && (
                <div class="bg-red-500/10 border border-red-500/30 rounded-lg p-3">
                  <div class="flex items-start gap-2">
                    <svg class="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <div>
                      <h4 class="text-sm font-medium text-red-400">Cannot Delete Last Image</h4>
                      <p class="text-xs text-dark-text-muted mt-1">
                        This is the last available pi-agent image. You must build another image before deleting this one.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {tasksUsingImage().length > 0 && (
                <div>
                  <h4 class="text-xs font-medium text-dark-text-muted uppercase mb-2">Tasks Using This Image</h4>
                  <div class="max-h-40 overflow-y-auto space-y-1">
                    {tasksUsingImage().map((task) => (
                      <div class="flex items-center justify-between p-2 bg-dark-surface rounded text-sm">
                        <div class="flex items-center gap-2">
                          <span class="text-xs text-dark-text-muted">#{task.id}</span>
                          <span class="text-dark-text">{task.name}</span>
                        </div>
                        <span class="text-xs px-2 py-0.5 rounded bg-yellow-500/20 text-yellow-400">
                          {task.status}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {canDeleteImage() && (
                <div class="text-sm text-dark-text">
                  <p>Are you sure you want to delete this image?</p>
                  <p class="text-xs text-dark-text-muted mt-1">This action cannot be undone.</p>
                </div>
              )}
            </div>
            <div class="flex justify-end gap-2 px-4 py-3 border-t border-dark-surface3">
              <button class="btn btn-sm" onClick={closeDeleteModal}>
                {canDeleteImage() ? 'Cancel' : 'Close'}
              </button>
              {canDeleteImage() && (
                <button class="btn btn-sm bg-accent-danger text-white" onClick={confirmDeleteImage}>
                  Delete Image
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Build Logs Modal */}
      {selectedBuildForLogs() && (
        <div
          class="fixed inset-0 z-[1001] flex items-center justify-center bg-black/50"
          onClick={() => setSelectedBuildForLogs(null)}
        >
          <div
            class="bg-dark-surface2 rounded-lg shadow-xl w-[min(700px,calc(100vw-40px))] max-h-[80vh] flex flex-col border border-dark-surface3"
            onClick={(e) => e.stopPropagation()}
          >
            <div class="flex items-center justify-between px-4 py-3 border-b border-dark-surface3">
              <h3 class="text-lg font-medium text-dark-text">Build Logs</h3>
              <button
                class="text-2xl leading-none text-dark-text-muted hover:text-dark-text"
                onClick={() => setSelectedBuildForLogs(null)}
              >
                ×
              </button>
            </div>
            <div class="flex-1 overflow-auto p-4">
              <pre class="font-mono text-xs text-dark-text whitespace-pre-wrap">
                {selectedBuildForLogs()!.logs || 'No logs available'}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
