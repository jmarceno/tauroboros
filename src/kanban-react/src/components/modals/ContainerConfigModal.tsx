import { useState, useEffect, useCallback } from 'react'
import { useApi } from '@/hooks'
import type { ContainerImage, Task } from '@/types'
import { formatLocalDateTime } from '@/utils/date'

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

interface ContainerConfigModalProps {
  isOpen: boolean
  onClose: () => void
}

export function ContainerConfigModal({ isOpen, onClose }: ContainerConfigModalProps) {
  const api = useApi()

  const [activeTab, setActiveTab] = useState<'build' | 'images'>('build')
  const [profiles, setProfiles] = useState<ContainerProfile[]>([])
  const [builds, setBuilds] = useState<ContainerBuild[]>([])
  const [selectedProfileId, setSelectedProfileId] = useState('')
  const [customDockerfile, setCustomDockerfile] = useState('')
  const [originalDockerfile, setOriginalDockerfile] = useState('')
  const [isBuilding, setIsBuilding] = useState(false)
  const [currentBuildId, setCurrentBuildId] = useState<number | null>(null)
  const [showSaveProfileModal, setShowSaveProfileModal] = useState(false)
  const [newProfileName, setNewProfileName] = useState('')
  const [newProfileId, setNewProfileId] = useState('')
  const [selectedBuildForLogs, setSelectedBuildForLogs] = useState<ContainerBuild | null>(null)
  const [containerStatus, setContainerStatus] = useState<{ enabled: boolean; available: boolean; hasRunningWorkflows: boolean; message: string } | null>(null)
  const [availableImages, setAvailableImages] = useState<ContainerImage[]>([])
  const [isLoadingImages, setIsLoadingImages] = useState(false)
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [imageToDelete, setImageToDelete] = useState<ContainerImage | null>(null)
  const [tasksUsingImage, setTasksUsingImage] = useState<{ id: string; name: string; status: string }[]>([])
  const [isLoadingTasksUsing, setIsLoadingTasksUsing] = useState(false)

  const isContainerEnabled = containerStatus?.enabled ?? false
  const hasRunningWorkflows = containerStatus?.hasRunningWorkflows ?? false

  const selectedProfile = profiles.find(p => p.id === selectedProfileId)
  const hasUnsavedChanges = customDockerfile !== originalDockerfile
  const canBuild = !isBuilding && !hasRunningWorkflows && customDockerfile.trim().length > 0

  const buildButtonText = isBuilding ? 'Building...' : hasRunningWorkflows ? 'Stop Workflow to Build' : 'Save & Build'

  const loadProfiles = useCallback(async () => {
    try {
      const response = await fetch('/api/container/profiles')
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = await response.json()
      setProfiles(Array.isArray(data.profiles) ? data.profiles : [])
    } catch (e) {
      console.error('Failed to load profiles:', e)
    }
  }, [])

  const loadBuilds = useCallback(async () => {
    try {
      const response = await fetch('/api/container/build-status?limit=10')
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = await response.json()
      setBuilds(Array.isArray(data.builds) ? data.builds : [])
    } catch (e) {
      console.error('Failed to load builds:', e)
    }
  }, [])

  const loadContainerStatus = useCallback(async () => {
    try {
      const response = await fetch('/api/container/status')
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = await response.json()
      setContainerStatus({
        enabled: data.enabled,
        available: data.available,
        hasRunningWorkflows: data.hasRunningWorkflows,
        message: data.message,
      })
    } catch (e) {
      console.error('Failed to load container status:', e)
    }
  }, [])

  const loadImages = useCallback(async () => {
    setIsLoadingImages(true)
    try {
      const response = await fetch('/api/container/images')
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = await response.json()
      setAvailableImages(Array.isArray(data.images) ? data.images : [])
    } catch (e) {
      console.error('Failed to load images:', e)
    } finally {
      setIsLoadingImages(false)
    }
  }, [])

  const loadTasksUsingImage = useCallback(async (tag: string) => {
    setIsLoadingTasksUsing(true)
    try {
      const tasks = await api.getTasks()
      setTasksUsingImage(
        tasks
          .filter((t: Task) => t.containerImage === tag && t.status !== 'done')
          .map((t: Task) => ({ id: t.id, name: t.name, status: t.status }))
      )
    } catch (e) {
      console.error('Failed to load tasks using image:', e)
    } finally {
      setIsLoadingTasksUsing(false)
    }
  }, [])

  useEffect(() => {
    if (!isOpen) return

    const loadData = async () => {
      setSelectedProfileId('')
      setCustomDockerfile('')
      setOriginalDockerfile('')
      setIsBuilding(false)
      setCurrentBuildId(null)
      setShowSaveProfileModal(false)
      setNewProfileName('')
      setNewProfileId('')
      setSelectedBuildForLogs(null)
      setActiveTab('build')
      setShowDeleteModal(false)
      setImageToDelete(null)
      setTasksUsingImage([])

      await Promise.all([
        loadContainerStatus(),
        loadProfiles(),
        loadBuilds(),
        loadImages(),
      ])
    }
    loadData()
  }, [isOpen, loadContainerStatus, loadProfiles, loadBuilds, loadImages])

  useEffect(() => {
    if (!selectedProfileId) {
      setCustomDockerfile('')
      setOriginalDockerfile('')
      return
    }

    const loadDockerfile = async () => {
      try {
        const response = await fetch(`/api/container/dockerfile/${selectedProfileId}`)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const data = await response.json()
        if (data.dockerfile !== undefined) {
          setCustomDockerfile(data.dockerfile)
          setOriginalDockerfile(data.dockerfile)
        }
      } catch (e) {
        console.error('Failed to load Dockerfile:', e)
      }
    }
    loadDockerfile()
  }, [selectedProfileId])

  const startBuild = async () => {
    if (hasRunningWorkflows) {
      alert('Cannot build while workflow is running. Please stop all workflows first.')
      return
    }

    if (!customDockerfile.trim()) {
      alert('Dockerfile is empty')
      return
    }

    setIsBuilding(true)

    try {
      const response = await fetch('/api/container/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profileId: selectedProfileId || 'custom',
          dockerfile: customDockerfile,
        }),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Failed to start build')
      }

      const data = await response.json()
      setCurrentBuildId(data.buildId)
      pollBuildStatus(data.buildId)
    } catch (e) {
      setIsBuilding(false)
      alert(e instanceof Error ? e.message : 'Failed to start build')
    }
  }

  const pollBuildStatus = async (buildId: number) => {
    const checkStatus = async () => {
      try {
        const response = await fetch('/api/container/build-status?limit=1')
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const data = await response.json()

        const build = (data.builds as ContainerBuild[]).find((b: ContainerBuild) => b.id === buildId)

        if (build && build.status !== 'running' && build.status !== 'pending') {
          setIsBuilding(false)
          setCurrentBuildId(null)
          loadBuilds()

          if (build.status === 'success') {
            alert(`Build completed successfully: ${build.imageTag}`)
          } else {
            alert(`Build failed: ${build.errorMessage}`)
          }
          return
        }

        setTimeout(checkStatus, 2000)
      } catch (e) {
        console.error('Build status error:', e)
        setTimeout(checkStatus, 2000)
      }
    }

    checkStatus()
  }

  const openSaveProfileModal = () => {
    if (!customDockerfile.trim()) {
      alert('Dockerfile is empty')
      return
    }

    const baseId = selectedProfile?.id || 'custom'
    setNewProfileId(`${baseId}-modified-${Date.now()}`)
    setNewProfileName(selectedProfile ? `${selectedProfile.name} (Modified)` : 'Custom Profile')
    setShowSaveProfileModal(true)
  }

  const saveAsNewProfile = async () => {
    if (!newProfileId.trim() || !newProfileName.trim()) {
      alert('Profile name and ID are required')
      return
    }

    if (!/^[a-z0-9-]+$/.test(newProfileId)) {
      alert('Profile ID must be lowercase alphanumeric with hyphens only')
      return
    }

    try {
      const response = await fetch('/api/container/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: newProfileId,
          name: newProfileName,
          description: `Custom profile based on ${selectedProfile?.name || 'manual edit'}`,
          image: selectedProfile?.image || 'custom',
          dockerfileTemplate: customDockerfile,
        }),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Failed to save profile')
      }

      alert(`Profile "${newProfileName}" saved successfully`)
      setShowSaveProfileModal(false)
      await loadProfiles()
      setSelectedProfileId(newProfileId)
      setOriginalDockerfile(customDockerfile)
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to save profile')
    }
  }

  const resetDockerfile = () => {
    setCustomDockerfile(originalDockerfile)
  }

  const formatDate = (timestamp: number | null) => {
    if (!timestamp) return '-'
    return formatLocalDateTime(timestamp)
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
    if (!imageToDelete) return

    const tag = imageToDelete.tag

    try {
      const result = await api.deleteContainerImage(tag)
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

  const canDeleteImage = imageToDelete && imageToDelete.inUseByTasks === 0 && availableImages.length > 1

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80" onClick={onClose}>
      <div
        className="bg-dark-surface2 rounded-lg shadow-2xl w-[min(900px,calc(100vw-40px))] max-h-[90vh] flex flex-col border border-dark-surface3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-dark-surface3">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-dark-text">
            <svg className="w-5 h-5 text-accent-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
            </svg>
            Image Builder
          </h2>
          <button
            className="p-1.5 rounded hover:bg-dark-surface3 text-dark-text-muted hover:text-dark-text transition-colors text-2xl leading-none"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className="flex border-b border-dark-surface3">
          <button
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'build'
                ? 'border-accent-primary text-accent-primary'
                : 'border-transparent text-dark-text-muted hover:text-dark-text'
            }`}
            onClick={() => setActiveTab('build')}
          >
            <span className="flex items-center gap-2">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
              </svg>
              Build
            </span>
          </button>
          <button
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'images'
                ? 'border-accent-primary text-accent-primary'
                : 'border-transparent text-dark-text-muted hover:text-dark-text'
            }`}
            onClick={() => setActiveTab('images')}
          >
            <span className="flex items-center gap-2">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79 8-4" />
              </svg>
              Images
              {availableImages.length > 0 && (
                <span className="text-xs bg-dark-surface3 px-1.5 py-0.5 rounded">
                  {availableImages.length}
                </span>
              )}
            </span>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {!isContainerEnabled ? (
            <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3">
              <div className="flex items-start gap-2">
                <svg className="w-5 h-5 text-yellow-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <div>
                  <h3 className="text-sm font-medium text-yellow-400">Container Mode Disabled</h3>
                  <p className="text-xs text-dark-text-muted mt-1">
                    {containerStatus?.message || 'Container mode is not enabled. Edit .tauroboros/settings.json to enable.'}
                  </p>
                </div>
              </div>
            </div>
          ) : hasRunningWorkflows && activeTab === 'build' ? (
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3">
              <div className="flex items-start gap-2">
                <svg className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <div>
                  <h3 className="text-sm font-medium text-red-400">Workflow Running</h3>
                  <p className="text-xs text-dark-text-muted mt-1">
                    Cannot build container image while a workflow is running. Please stop all workflows first.
                  </p>
                </div>
              </div>
            </div>
          ) : null}

          {activeTab === 'build' && (
            <div className="space-y-4">
              <div className="form-group">
                <label className="flex items-center gap-2 mb-2 text-sm font-medium text-dark-text">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                  </svg>
                  Select Profile
                </label>
                <select
                  className="form-select"
                  value={selectedProfileId}
                  disabled={isBuilding}
                  onChange={(e) => setSelectedProfileId(e.target.value)}
                >
                  <option value="">-- Select a base profile --</option>
                  {profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name} - {profile.description}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-dark-text-muted mt-1">
                  Select a base profile to pre-populate the Dockerfile. You can edit it below before building.
                </p>
              </div>

              <div className="form-group">
                <div className="flex items-center justify-between mb-2">
                  <label className="flex items-center gap-2 text-sm font-medium text-dark-text">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    Dockerfile
                    {hasUnsavedChanges && <span className="text-xs text-yellow-400">(modified)</span>}
                  </label>
                  <div className="flex gap-2">
                    {hasUnsavedChanges && selectedProfileId && (
                      <button
                        className="btn btn-sm"
                        disabled={isBuilding}
                        onClick={openSaveProfileModal}
                      >
                        Save as New Profile
                      </button>
                    )}
                    {hasUnsavedChanges && (
                      <button
                        className="btn btn-sm"
                        disabled={isBuilding}
                        onClick={resetDockerfile}
                      >
                        Reset
                      </button>
                    )}
                  </div>
                </div>
                <textarea
                  className="form-textarea font-mono text-xs"
                  rows={16}
                  disabled={isBuilding}
                  value={customDockerfile}
                  onChange={(e) => setCustomDockerfile(e.target.value)}
                  placeholder="# Select a profile above or write your own Dockerfile here..."
                />
                <p className="text-xs text-dark-text-muted mt-1">
                  Edit the Dockerfile directly. Changes are not saved until you click "Save & Build" or "Save as New Profile".
                </p>
              </div>

              <button
                className="btn btn-primary flex-1 w-full flex items-center justify-center gap-2"
                disabled={!canBuild}
                onClick={startBuild}
              >
                {isBuilding ? (
                  <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                  </svg>
                )}
                {buildButtonText}
              </button>

              <div>
                <label className="flex items-center gap-2 mb-2 text-sm font-medium text-dark-text">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  Build History
                </label>
                {builds.length === 0 ? (
                  <div className="text-sm text-dark-text-muted bg-dark-surface rounded-lg p-3 text-center">
                    No builds yet. Select a profile and click "Save & Build" to create your first image.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {builds.slice(0, 5).map((build) => (
                      <div
                        key={build.id}
                        className="flex items-center justify-between p-2 bg-dark-surface rounded-lg text-sm"
                      >
                        <div className="flex items-center gap-2">
                          <span className={formatStatus(build.status).color}>
                            {formatStatus(build.status).text}
                          </span>
                          <span className="text-dark-text">{build.imageTag}</span>
                          <span className="text-xs text-dark-text-muted">{formatDate(build.startedAt)}</span>
                        </div>
                        {build.errorMessage && (
                          <div className="text-xs text-red-400">
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

          {activeTab === 'images' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium flex items-center gap-2 text-dark-text">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79 8-4" />
                  </svg>
                  Available Images
                </h3>
                <button
                  className="text-xs btn btn-sm"
                  disabled={isLoadingImages}
                  onClick={loadImages}
                >
                  {isLoadingImages ? 'Loading...' : 'Refresh'}
                </button>
              </div>

              {availableImages.length === 0 ? (
                <div className="text-sm text-dark-text-muted bg-dark-surface rounded-lg p-8 text-center">
                  <svg className="w-12 h-12 mx-auto mb-3 text-dark-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79 8-4" />
                  </svg>
                  <p>No images available.</p>
                  <p className="text-xs mt-1">Build an image in the Build tab to see it here.</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-xs text-dark-text-muted uppercase bg-dark-surface">
                      <tr>
                        <th className="px-3 py-2 text-left">Image Tag</th>
                        <th className="px-3 py-2 text-left">Created</th>
                        <th className="px-3 py-2 text-left">Source</th>
                        <th className="px-3 py-2 text-left">In Use</th>
                        <th className="px-3 py-2 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-dark-surface3">
                      {availableImages.map((img) => (
                        <tr key={img.tag} className="hover:bg-dark-surface/50">
                          <td className="px-3 py-2 font-mono text-xs text-accent-info">{img.tag}</td>
                          <td className="px-3 py-2 text-xs">{formatDate(img.createdAt)}</td>
                          <td className="px-3 py-2">
                            <span
                              className={`text-xs px-2 py-0.5 rounded ${
                                img.source === 'build'
                                  ? 'bg-green-500/20 text-green-400'
                                  : 'bg-blue-500/20 text-blue-400'
                              }`}
                            >
                              {img.source === 'build' ? 'Build' : 'Podman'}
                            </span>
                          </td>
                          <td className="px-3 py-2">
                            <span
                              className={`text-xs ${
                                img.inUseByTasks > 0 ? 'text-yellow-400 font-medium' : 'text-dark-text-muted'
                              }`}
                            >
                              {img.inUseByTasks} task{img.inUseByTasks === 1 ? '' : 's'}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-right">
                            <button
                              className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50 disabled:cursor-not-allowed px-2 py-1 rounded hover:bg-red-500/10 transition-colors"
                              disabled={img.inUseByTasks > 0 || availableImages.length <= 1}
                              title={
                                img.inUseByTasks > 0
                                  ? 'Cannot delete: image is in use by tasks'
                                  : availableImages.length <= 1
                                  ? 'Cannot delete the last available image'
                                  : 'Delete image'
                              }
                              onClick={() => openDeleteModal(img)}
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="bg-dark-surface rounded-lg p-3 text-xs text-dark-text-muted space-y-1">
                <p className="flex items-center gap-2">
                  <svg className="w-4 h-4 text-yellow-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  Images with active tasks using them cannot be deleted.
                </p>
                <p className="flex items-center gap-2">
                  <svg className="w-4 h-4 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  The last available image also cannot be deleted.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {showSaveProfileModal && (
        <div
          className="fixed inset-0 z-[1001] flex items-center justify-center bg-black/50"
          onClick={() => setShowSaveProfileModal(false)}
        >
          <div
            className="bg-dark-surface2 rounded-lg shadow-xl w-[min(400px,calc(100vw-40px))] border border-dark-surface3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-dark-surface3">
              <h3 className="text-lg font-medium text-dark-text">Save as New Profile</h3>
              <button
                className="text-2xl leading-none text-dark-text-muted hover:text-dark-text"
                onClick={() => setShowSaveProfileModal(false)}
              >
                ×
              </button>
            </div>
            <div className="p-4 space-y-3">
              <div className="form-group">
                <label className="block text-sm font-medium text-dark-text mb-1">Profile Name</label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="My Custom Profile"
                  value={newProfileName}
                  onChange={(e) => setNewProfileName(e.target.value)}
                />
              </div>
              <div className="form-group">
                <label className="block text-sm font-medium text-dark-text mb-1">Profile ID</label>
                <input
                  type="text"
                  className="form-input font-mono text-xs"
                  placeholder="my-custom-profile"
                  value={newProfileId}
                  onChange={(e) => setNewProfileId(e.target.value)}
                />
                <p className="text-xs text-dark-text-muted mt-1">
                  Lowercase alphanumeric with hyphens only. Cannot be changed later.
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2 px-4 py-3 border-t border-dark-surface3">
              <button className="btn btn-sm" onClick={() => setShowSaveProfileModal(false)}>
                Cancel
              </button>
              <button className="btn btn-primary btn-sm" onClick={saveAsNewProfile}>
                Save Profile
              </button>
            </div>
          </div>
        </div>
      )}

      {showDeleteModal && imageToDelete && (
        <div
          className="fixed inset-0 z-[1001] flex items-center justify-center bg-black/50"
          onClick={closeDeleteModal}
        >
          <div
            className="bg-dark-surface2 rounded-lg shadow-xl w-[min(480px,calc(100vw-40px))] border border-dark-surface3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-dark-surface3">
              <h3 className="flex items-center gap-2 text-lg font-medium text-red-400">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
                Delete Image
              </h3>
              <button
                className="text-2xl leading-none text-dark-text-muted hover:text-dark-text"
                onClick={closeDeleteModal}
              >
                ×
              </button>
            </div>
            <div className="p-4 space-y-4">
              <div className="bg-dark-surface rounded-lg p-3">
                <div className="text-sm text-dark-text-muted mb-1">Image Tag</div>
                <div className="font-mono text-sm text-accent-info">{imageToDelete.tag}</div>
              </div>

              {tasksUsingImage.length > 0 && (
                <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3">
                  <div className="flex items-start gap-2">
                    <svg className="w-5 h-5 text-yellow-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                    <div>
                      <h4 className="text-sm font-medium text-yellow-400">Cannot Delete</h4>
                      <p className="text-xs text-dark-text-muted mt-1">
                        This image is currently being used by {tasksUsingImage.length} task(s). Tasks must be completed or use a different image before this image can be deleted.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {availableImages.length <= 1 && (
                <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3">
                  <div className="flex items-start gap-2">
                    <svg className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <div>
                      <h4 className="text-sm font-medium text-red-400">Cannot Delete Last Image</h4>
                      <p className="text-xs text-dark-text-muted mt-1">
                        This is the last available pi-agent image. You must build another image before deleting this one.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {tasksUsingImage.length > 0 && (
                <div>
                  <h4 className="text-xs font-medium text-dark-text-muted uppercase mb-2">Tasks Using This Image</h4>
                  <div className="max-h-40 overflow-y-auto space-y-1">
                    {tasksUsingImage.map((task) => (
                      <div
                        key={task.id}
                        className="flex items-center justify-between p-2 bg-dark-surface rounded text-sm"
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-dark-text-muted">#{task.id}</span>
                          <span className="text-dark-text">{task.name}</span>
                        </div>
                        <span className="text-xs px-2 py-0.5 rounded bg-yellow-500/20 text-yellow-400">
                          {task.status}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {canDeleteImage && (
                <div className="text-sm text-dark-text">
                  <p>Are you sure you want to delete this image?</p>
                  <p className="text-xs text-dark-text-muted mt-1">This action cannot be undone.</p>
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 px-4 py-3 border-t border-dark-surface3">
              <button className="btn btn-sm" onClick={closeDeleteModal}>
                {canDeleteImage ? 'Cancel' : 'Close'}
              </button>
              {canDeleteImage && (
                <button className="btn btn-sm bg-accent-danger text-white" onClick={confirmDeleteImage}>
                  Delete Image
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {selectedBuildForLogs && (
        <div
          className="fixed inset-0 z-[1001] flex items-center justify-center bg-black/50"
          onClick={() => setSelectedBuildForLogs(null)}
        >
          <div
            className="bg-dark-surface2 rounded-lg shadow-xl w-[min(700px,calc(100vw-40px))] max-h-[80vh] flex flex-col border border-dark-surface3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-dark-surface3">
              <h3 className="text-lg font-medium text-dark-text">Build Logs</h3>
              <button
                className="text-2xl leading-none text-dark-text-muted hover:text-dark-text"
                onClick={() => setSelectedBuildForLogs(null)}
              >
                ×
              </button>
            </div>
            <div className="flex-1 overflow-auto p-4">
              <pre className="font-mono text-xs text-dark-text whitespace-pre-wrap">
                {selectedBuildForLogs.logs || 'No logs available'}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
