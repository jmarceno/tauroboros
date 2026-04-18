import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { ContainersTab } from './ContainersTab'
import type { ContainerImage, Task } from '@/types'

// Mock global fetch
const mockFetch = vi.fn<typeof fetch>()
const mockGetTasks = vi.fn()
const mockDeleteContainerImage = vi.fn()

// Use type assertion for global fetch mock (required for vi.fn() return type compatibility)
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
global.fetch = mockFetch as typeof fetch

// Mock the useApi hook
vi.mock('@/hooks', () => ({
  useApi: () => ({
    getTasks: mockGetTasks,
    deleteContainerImage: mockDeleteContainerImage,
  }),
}))

// Mock the date formatter
vi.mock('@/utils/date', () => ({
  formatLocalDateTime: (timestamp: number | null) => {
    if (!timestamp) return '-'
    return new Date(timestamp).toLocaleString()
  },
}))

describe('ContainersTab', () => {
  const mockProfiles = [
    {
      id: 'node-18',
      name: 'Node.js 18',
      description: 'Node.js 18 with npm and yarn',
      image: 'node:18-alpine',
      dockerfileTemplate: 'FROM node:18-alpine\nWORKDIR /app',
    },
    {
      id: 'python-3-11',
      name: 'Python 3.11',
      description: 'Python 3.11 with pip',
      image: 'python:3.11-slim',
      dockerfileTemplate: 'FROM python:3.11-slim\nWORKDIR /app',
    },
  ]

  const mockBuilds = [
    {
      id: 1,
      status: 'success' as const,
      startedAt: Date.now() - 3600000,
      completedAt: Date.now() - 3500000,
      packagesHash: 'abc123',
      errorMessage: null,
      imageTag: 'pi-agent:node-18-abc123',
      logs: 'Build successful',
    },
    {
      id: 2,
      status: 'failed' as const,
      startedAt: Date.now() - 7200000,
      completedAt: Date.now() - 7100000,
      packagesHash: 'def456',
      errorMessage: 'Docker build failed: no space left on device',
      imageTag: 'pi-agent:python-3-11-def456',
      logs: null,
    },
  ]

  const mockImages: ContainerImage[] = [
    {
      tag: 'pi-agent:node-18-abc123',
      createdAt: Date.now() - 3500000,
      source: 'build' as const,
      inUseByTasks: 2,
    },
    {
      tag: 'pi-agent:python-3-11-def456',
      createdAt: Date.now() - 7000000,
      source: 'podman' as const,
      inUseByTasks: 0,
    },
    {
      tag: 'pi-agent:custom-latest',
      createdAt: Date.now() - 1000000,
      source: 'build' as const,
      inUseByTasks: 0,
    },
  ]

  const mockContainerStatus = {
    enabled: true,
    available: true,
    hasRunningWorkflows: false,
    message: 'Container mode is enabled',
  }

  const mockDockerfile = 'FROM node:18-alpine\nWORKDIR /app\nCOPY . .\nRUN npm install'

  const mockTasks: Task[] = [
    {
      id: 'task-1',
      idx: 0,
      name: 'Test Task 1',
      prompt: 'Test prompt',
      status: 'backlog',
      branch: 'main',
      planmode: false,
      autoApprovePlan: false,
      review: false,
      codeStyleReview: false,
      autoCommit: true,
      deleteWorktree: true,
      skipPermissionAsking: true,
      requirements: [],
      thinkingLevel: 'default',
      planThinkingLevel: 'default',
      executionThinkingLevel: 'default',
      executionStrategy: 'standard',
      reviewCount: 0,
      jsonParseRetryCount: 0,
      planRevisionCount: 0,
      executionPhase: '',
      awaitingPlanApproval: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      containerImage: 'pi-agent:node-18-abc123',
    },
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ shouldAdvanceTime: true })

    // Default successful fetch responses
    mockFetch.mockImplementation((url: string) => {
      if (url === '/api/container/status') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockContainerStatus),
        })
      }
      if (url === '/api/container/profiles') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ profiles: mockProfiles }),
        })
      }
      if (url === '/api/container/build-status?limit=10') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ builds: mockBuilds }),
        })
      }
      if (url === '/api/container/images') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ images: mockImages }),
        })
      }
      if (url === '/api/container/build-status?limit=1') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ builds: mockBuilds }),
        })
      }
      if (url.match(/\/api\/container\/dockerfile\/.+/)) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ dockerfile: mockDockerfile }),
        })
      }
      if (url === '/api/container/build' && mockFetch.mock.calls.some(call => call[1]?.method === 'POST')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ buildId: 3 }),
        })
      }

      return Promise.resolve({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      })
    })

    mockGetTasks.mockResolvedValue(mockTasks)
    mockDeleteContainerImage.mockResolvedValue({ success: true })

    // Mock alert and confirm
    vi.stubGlobal('alert', vi.fn())
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  describe('Initial Load', () => {
    it('should render the component with initial data', async () => {
      render(<ContainersTab />)

      await waitFor(() => {
        expect(screen.getByText('Container Image Builder')).toBeInTheDocument()
      })

      // Check that tabs are rendered
      expect(screen.getByText('Build')).toBeInTheDocument()
      expect(screen.getByText('Images')).toBeInTheDocument()

      // Verify Build tab is active by default
      expect(screen.getByText('Select Profile')).toBeInTheDocument()
    })

    it('should display error banner when initialization fails', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'))

      render(<ContainersTab />)

      await waitFor(() => {
        expect(screen.getByText('Error')).toBeInTheDocument()
      })

      expect(screen.getByText(/Failed to load container data/)).toBeInTheDocument()
    })

    it('should allow dismissing error banner', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'))

      render(<ContainersTab />)

      await waitFor(() => {
        expect(screen.getByText('Error')).toBeInTheDocument()
      })

      const closeButton = screen.getByLabelText('Close error message')
      fireEvent.click(closeButton)

      await waitFor(() => {
        expect(screen.queryByText('Error')).not.toBeInTheDocument()
      })
    })
  })

  describe('Tab Switching', () => {
    it('should switch between Build and Images tabs', async () => {
      render(<ContainersTab />)

      await waitFor(() => {
        expect(screen.getByText('Container Image Builder')).toBeInTheDocument()
      })

      // Initially on Build tab
      expect(screen.getByText('Select Profile')).toBeInTheDocument()
      expect(screen.getByText('Dockerfile')).toBeInTheDocument()

      // Click Images tab
      const imagesTab = screen.getByText('Images')
      fireEvent.click(imagesTab)

      await waitFor(() => {
        expect(screen.getByText('Available Images')).toBeInTheDocument()
      })

      // Verify images are displayed
      expect(screen.getByText('pi-agent:node-18-abc123')).toBeInTheDocument()
      expect(screen.getByText('pi-agent:python-3-11-def456')).toBeInTheDocument()
    })

    it('should show image count badge on Images tab', async () => {
      render(<ContainersTab />)

      await waitFor(() => {
        expect(screen.getByText('Container Image Builder')).toBeInTheDocument()
      })

      const imagesTab = screen.getByText('Images')
      expect(imagesTab.textContent).toContain('3') // 3 mock images
    })
  })

  describe('Profile Selection', () => {
    it('should load profiles and populate dropdown', async () => {
      render(<ContainersTab />)

      await waitFor(() => {
        expect(screen.getByText('Container Image Builder')).toBeInTheDocument()
      })

      const select = screen.getByRole('combobox')
      expect(select).toBeInTheDocument()

      // Check options are loaded
      const options = screen.getAllByRole('option')
      expect(options.length).toBeGreaterThan(1)
      expect(options[0].textContent).toContain('Select a base profile')
    })

    it('should load Dockerfile when profile is selected', async () => {
      render(<ContainersTab />)

      await waitFor(() => {
        expect(screen.getByText('Container Image Builder')).toBeInTheDocument()
      })

      // Select a profile
      const select = screen.getByRole('combobox')
      fireEvent.change(select, { target: { value: 'node-18' } })

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith('/api/container/dockerfile/node-18')
      })
    })

    it('should show modified indicator when Dockerfile is edited', async () => {
      render(<ContainersTab />)

      await waitFor(() => {
        expect(screen.getByText('Container Image Builder')).toBeInTheDocument()
      })

      // Select a profile first
      const select = screen.getByRole('combobox')
      fireEvent.change(select, { target: { value: 'node-18' } })

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith('/api/container/dockerfile/node-18')
      })

      // Edit the Dockerfile textarea
      const textarea = screen.getByPlaceholderText(/Select a profile above/)
      fireEvent.change(textarea, { target: { value: 'FROM node:20-alpine' } })

      // Check for modified indicator
      await waitFor(() => {
        expect(screen.getByText(/modified/)).toBeInTheDocument()
      })
    })

    it('should show Save and Reset buttons when Dockerfile is modified', async () => {
      render(<ContainersTab />)

      await waitFor(() => {
        expect(screen.getByText('Container Image Builder')).toBeInTheDocument()
      })

      // Select a profile
      const select = screen.getByRole('combobox')
      fireEvent.change(select, { target: { value: 'node-18' } })

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith('/api/container/dockerfile/node-18')
      })

      // Edit the Dockerfile textarea
      const textarea = screen.getByPlaceholderText(/Select a profile above/)
      fireEvent.change(textarea, { target: { value: 'FROM node:20-alpine' } })

      // Check for buttons
      await waitFor(() => {
        expect(screen.getByText('Save as New Profile')).toBeInTheDocument()
        expect(screen.getByText('Reset')).toBeInTheDocument()
      })
    })

    it('should reset Dockerfile to original when Reset is clicked', async () => {
      render(<ContainersTab />)

      await waitFor(() => {
        expect(screen.getByText('Container Image Builder')).toBeInTheDocument()
      })

      // Select a profile
      const select = screen.getByRole('combobox')
      fireEvent.change(select, { target: { value: 'node-18' } })

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith('/api/container/dockerfile/node-18')
      })

      // Edit the Dockerfile textarea
      const textarea = screen.getByPlaceholderText(/Select a profile above/)
      fireEvent.change(textarea, { target: { value: 'FROM node:20-alpine' } })

      // Click Reset
      await waitFor(() => {
        const resetButton = screen.getByText('Reset')
        fireEvent.click(resetButton)
      })

      // The modified indicator should be gone (Dockerfile reset to original)
      await waitFor(() => {
        expect(screen.queryByText(/modified/)).not.toBeInTheDocument()
      })
    })
  })

  describe('Build Functionality', () => {
    it('should disable build button when no Dockerfile content', async () => {
      render(<ContainersTab />)

      await waitFor(() => {
        expect(screen.getByText('Container Image Builder')).toBeInTheDocument()
      })

      const buildButton = screen.getByText('Save & Build')
      expect(buildButton).toBeDisabled()
    })

    it('should trigger build when Save & Build is clicked', async () => {
      const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})

      render(<ContainersTab />)

      await waitFor(() => {
        expect(screen.getByText('Container Image Builder')).toBeInTheDocument()
      })

      // Select a profile to populate Dockerfile
      const select = screen.getByRole('combobox')
      fireEvent.change(select, { target: { value: 'node-18' } })

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith('/api/container/dockerfile/node-18')
      })

      // Click Save & Build
      const buildButton = screen.getByText('Save & Build')
      fireEvent.click(buildButton)

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          '/api/container/build',
          expect.objectContaining({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: expect.stringContaining('node-18'),
          })
        )
      })

      alertSpy.mockRestore()
    })

    it('should show alert when trying to build with running workflows', async () => {
      const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})

      mockFetch.mockImplementation((url: string) => {
        if (url === '/api/container/status') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              ...mockContainerStatus,
              hasRunningWorkflows: true,
            }),
          })
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ profiles: mockProfiles, builds: mockBuilds, images: mockImages }),
        })
      })

      render(<ContainersTab />)

      await waitFor(() => {
        expect(screen.getByText('Workflow Running')).toBeInTheDocument()
      })

      alertSpy.mockRestore()
    })
  })

  describe('Build Status Polling', () => {
    it('should poll build status after starting build', async () => {
      const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})

      let buildStatusCallCount = 0
      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (url === '/api/container/status') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(mockContainerStatus),
          })
        }
        if (url === '/api/container/profiles') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ profiles: mockProfiles }),
          })
        }
        if (url === '/api/container/build-status?limit=10') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ builds: mockBuilds }),
          })
        }
        if (url === '/api/container/images') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ images: mockImages }),
          })
        }
        if (url === '/api/container/dockerfile/node-18') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ dockerfile: mockDockerfile }),
          })
        }
        if (url === '/api/container/build' && options?.method === 'POST') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ buildId: 3 }),
          })
        }
        if (url === '/api/container/build-status?limit=1') {
          buildStatusCallCount++
          // First call returns running, second returns success
          if (buildStatusCallCount === 1) {
            return Promise.resolve({
              ok: true,
              json: () => Promise.resolve({
                builds: [{
                  id: 3,
                  status: 'running',
                  startedAt: Date.now(),
                  completedAt: null,
                  packagesHash: 'xyz789',
                  errorMessage: null,
                  imageTag: 'pi-agent:test-xyz789',
                  logs: 'Building...',
                }],
              }),
            })
          }
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              builds: [{
                id: 3,
                status: 'success',
                startedAt: Date.now(),
                completedAt: Date.now(),
                packagesHash: 'xyz789',
                errorMessage: null,
                imageTag: 'pi-agent:test-xyz789',
                logs: 'Build successful',
              }],
            }),
          })
        }

        return Promise.resolve({
          ok: false,
          status: 404,
        })
      })

      render(<ContainersTab />)

      await waitFor(() => {
        expect(screen.getByText('Container Image Builder')).toBeInTheDocument()
      })

      // Select a profile
      const select = screen.getByRole('combobox')
      fireEvent.change(select, { target: { value: 'node-18' } })

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith('/api/container/dockerfile/node-18')
      })

      // Click Save & Build
      const buildButton = screen.getByText('Save & Build')
      fireEvent.click(buildButton)

      // Verify build was initiated
      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          '/api/container/build',
          expect.objectContaining({ method: 'POST' })
        )
      })

      // Wait for polling to start
      await act(async () => {
        vi.advanceTimersByTime(2100)
      })

      // Check that polling occurred
      expect(buildStatusCallCount).toBeGreaterThan(0)

      alertSpy.mockRestore()
    })

    it('should stop polling when build completes', async () => {
      const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})

      let buildStatusCallCount = 0
      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (url === '/api/container/status') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(mockContainerStatus),
          })
        }
        if (url === '/api/container/profiles') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ profiles: mockProfiles }),
          })
        }
        if (url === '/api/container/build-status?limit=10') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ builds: mockBuilds }),
          })
        }
        if (url === '/api/container/images') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ images: mockImages }),
          })
        }
        if (url === '/api/container/dockerfile/node-18') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ dockerfile: mockDockerfile }),
          })
        }
        if (url === '/api/container/build' && options?.method === 'POST') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ buildId: 3 }),
          })
        }
        if (url === '/api/container/build-status?limit=1') {
          buildStatusCallCount++
          // Return success immediately
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              builds: [{
                id: 3,
                status: 'success',
                startedAt: Date.now(),
                completedAt: Date.now(),
                packagesHash: 'xyz789',
                errorMessage: null,
                imageTag: 'pi-agent:test-xyz789',
                logs: 'Build successful',
              }],
            }),
          })
        }

        return Promise.resolve({
          ok: false,
          status: 404,
        })
      })

      render(<ContainersTab />)

      await waitFor(() => {
        expect(screen.getByText('Container Image Builder')).toBeInTheDocument()
      })

      // Select a profile and start build
      const select = screen.getByRole('combobox')
      fireEvent.change(select, { target: { value: 'node-18' } })

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith('/api/container/dockerfile/node-18')
      })

      const buildButton = screen.getByText('Save & Build')
      fireEvent.click(buildButton)

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          '/api/container/build',
          expect.objectContaining({ method: 'POST' })
        )
      })

      // Wait for polling
      await act(async () => {
        vi.advanceTimersByTime(2100)
      })

      const callsAfterFirstPoll = buildStatusCallCount

      // Advance time again - should not poll anymore since build is complete
      await act(async () => {
        vi.advanceTimersByTime(5000)
      })

      // Should not have made additional polling calls
      expect(buildStatusCallCount).toBe(callsAfterFirstPoll)

      alertSpy.mockRestore()
    })

    it('should stop polling and show error on build status check failure', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      let buildStatusCallCount = 0
      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (url === '/api/container/status') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(mockContainerStatus),
          })
        }
        if (url === '/api/container/profiles') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ profiles: mockProfiles }),
          })
        }
        if (url === '/api/container/build-status?limit=10') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ builds: mockBuilds }),
          })
        }
        if (url === '/api/container/images') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ images: mockImages }),
          })
        }
        if (url === '/api/container/dockerfile/node-18') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ dockerfile: mockDockerfile }),
          })
        }
        if (url === '/api/container/build' && options?.method === 'POST') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ buildId: 3 }),
          })
        }
        if (url === '/api/container/build-status?limit=1') {
          buildStatusCallCount++
          // Always fail to test error handling
          return Promise.reject(new Error('Network error'))
        }

        return Promise.resolve({
          ok: false,
          status: 404,
        })
      })

      render(<ContainersTab />)

      await waitFor(() => {
        expect(screen.getByText('Container Image Builder')).toBeInTheDocument()
      })

      // Select a profile and start build
      const select = screen.getByRole('combobox')
      fireEvent.change(select, { target: { value: 'node-18' } })

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith('/api/container/dockerfile/node-18')
      })

      const buildButton = screen.getByText('Save & Build')
      fireEvent.click(buildButton)

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          '/api/container/build',
          expect.objectContaining({ method: 'POST' })
        )
      })

      // First poll with error
      await act(async () => {
        vi.advanceTimersByTime(2100)
      })

      // Error should be logged
      expect(consoleSpy).toHaveBeenCalledWith('Build polling error:', expect.any(String))

      // Error should be displayed to user
      await waitFor(() => {
        expect(screen.getByText(/Build polling failed/)).toBeInTheDocument()
      })

      // Polling should stop after error (only 1 call made)
      expect(buildStatusCallCount).toBe(1)

      // Build button should be re-enabled after polling error
      await waitFor(() => {
        const button = screen.getByRole('button', { name: /Save & Build/i })
        expect(button).not.toBeDisabled()
      })

      consoleSpy.mockRestore()
    })
  })

  describe('Images Tab', () => {
    it('should display images table with correct data', async () => {
      render(<ContainersTab />)

      await waitFor(() => {
        expect(screen.getByText('Container Image Builder')).toBeInTheDocument()
      })

      // Switch to Images tab
      const imagesTab = screen.getByText(/Images/)
      fireEvent.click(imagesTab)

      await waitFor(() => {
        expect(screen.getByText('Available Images')).toBeInTheDocument()
      }, { timeout: 3000 })

      // Check image tags are displayed
      expect(screen.getByText('pi-agent:node-18-abc123')).toBeInTheDocument()
      expect(screen.getByText('pi-agent:python-3-11-def456')).toBeInTheDocument()
      expect(screen.getByText('pi-agent:custom-latest')).toBeInTheDocument()

      // Check source badges (look for them in the table)
      const buildBadges = screen.getAllByText('Build')
      expect(buildBadges.length).toBeGreaterThan(0)

      const podmanBadges = screen.getAllByText('Podman')
      expect(podmanBadges.length).toBeGreaterThan(0)

      // Check in-use counts (at least one with 2 tasks and one with 0)
      const twoTasksElements = screen.getAllByText('2 tasks')
      expect(twoTasksElements.length).toBeGreaterThan(0)

      const zeroTasksElements = screen.getAllByText('0 tasks')
      expect(zeroTasksElements.length).toBeGreaterThan(0)
    })

    it('should disable delete button for images in use', async () => {
      render(<ContainersTab />)

      await waitFor(() => {
        expect(screen.getByText('Container Image Builder')).toBeInTheDocument()
      })

      // Switch to Images tab
      const imagesTab = screen.getByText('Images')
      fireEvent.click(imagesTab)

      await waitFor(() => {
        expect(screen.getByText('Available Images')).toBeInTheDocument()
      })

      // Find delete buttons
      const deleteButtons = screen.getAllByTitle(/Cannot delete/)
      expect(deleteButtons.length).toBeGreaterThan(0)
    })

    it('should refresh images when Refresh button is clicked', async () => {
      render(<ContainersTab />)

      await waitFor(() => {
        expect(screen.getByText('Container Image Builder')).toBeInTheDocument()
      })

      // Switch to Images tab
      const imagesTab = screen.getByText('Images')
      fireEvent.click(imagesTab)

      await waitFor(() => {
        expect(screen.getByText('Available Images')).toBeInTheDocument()
      })

      // Clear previous fetch calls
      mockFetch.mockClear()

      // Click Refresh
      const refreshButton = screen.getByText('Refresh')
      fireEvent.click(refreshButton)

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith('/api/container/images')
      })
    })
  })

  describe('Image Deletion', () => {
    it('should open delete modal when delete button is clicked for unused image', async () => {
      render(<ContainersTab />)

      await waitFor(() => {
        expect(screen.getByText('Container Image Builder')).toBeInTheDocument()
      })

      // Switch to Images tab
      const imagesTab = screen.getByText(/Images/)
      fireEvent.click(imagesTab)

      await waitFor(() => {
        expect(screen.getByText('Available Images')).toBeInTheDocument()
      }, { timeout: 3000 })

      // Find rows and get the one with unused image (python-3-11 with 0 tasks)
      const rows = screen.getAllByRole('row')
      let unusedImageRow: HTMLElement | null = null

      for (const row of rows) {
        // Look specifically for the python image row with 0 tasks
        if (row.textContent?.includes('pi-agent:python-3-11-def456') && row.textContent?.includes('0 tasks')) {
          unusedImageRow = row
          break
        }
      }

      expect(unusedImageRow).not.toBeNull()

      if (unusedImageRow) {
        // Find delete button in that row (has trash icon)
        const deleteButton = unusedImageRow.querySelector('button')
        expect(deleteButton).not.toBeNull()
        if (deleteButton) {
          fireEvent.click(deleteButton)

          // Check delete modal opened - look for the specific heading in the modal
          await waitFor(() => {
            const modalHeading = screen.getByRole('heading', { name: 'Delete Image' })
            expect(modalHeading).toBeInTheDocument()
          })
        }
      }
    })

    it('should validate delete button states based on image usage', async () => {
      render(<ContainersTab />)

      await waitFor(() => {
        expect(screen.getByText('Container Image Builder')).toBeInTheDocument()
      })

      // Switch to Images tab
      const imagesTab = screen.getByText(/Images/)
      fireEvent.click(imagesTab)

      await waitFor(() => {
        expect(screen.getByText('Available Images')).toBeInTheDocument()
      }, { timeout: 3000 })

      // Check that buttons exist in the table - some should be disabled (in use) and some enabled (not in use)
      const rows = screen.getAllByRole('row')
      let foundDisabledButton = false
      let foundEnabledButton = false

      for (const row of rows) {
        const deleteBtn = row.querySelector('button')
        if (deleteBtn) {
          if (deleteBtn.hasAttribute('disabled')) {
            foundDisabledButton = true
          } else {
            foundEnabledButton = true
          }
        }
      }

      // We should have both disabled buttons (images in use) and enabled buttons (images not in use)
      // The node-18 image with 2 tasks should have a disabled button
      expect(foundDisabledButton).toBe(true)
      // The custom-latest image with 0 tasks should have an enabled button
      expect(foundEnabledButton).toBe(true)
    })

    it('should close delete modal when Cancel is clicked', async () => {
      render(<ContainersTab />)

      await waitFor(() => {
        expect(screen.getByText('Container Image Builder')).toBeInTheDocument()
      })

      // Switch to Images tab
      const imagesTab = screen.getByText(/Images/)
      fireEvent.click(imagesTab)

      await waitFor(() => {
        expect(screen.getByText('Available Images')).toBeInTheDocument()
      }, { timeout: 3000 })

      // Find and click delete button for unused image (python-3-11)
      const rows = screen.getAllByRole('row')
      let unusedImageRow: HTMLElement | null = null

      for (const row of rows) {
        if (row.textContent?.includes('pi-agent:python-3-11-def456') && row.textContent?.includes('0 tasks')) {
          unusedImageRow = row
          break
        }
      }

      expect(unusedImageRow).not.toBeNull()

      if (unusedImageRow) {
        const deleteButton = unusedImageRow.querySelector('button')
        expect(deleteButton).not.toBeNull()
        if (deleteButton) {
          fireEvent.click(deleteButton)

          // Wait for modal - look for the heading
          await waitFor(() => {
            expect(screen.getByRole('heading', { name: 'Delete Image' })).toBeInTheDocument()
          })

          // Click Cancel button in the modal footer
          const cancelButton = screen.getByRole('button', { name: 'Cancel' })
          fireEvent.click(cancelButton)

          // Modal should close
          await waitFor(() => {
            expect(screen.queryByRole('heading', { name: 'Delete Image' })).not.toBeInTheDocument()
          })
        }
      }
    })

    it('should delete image when confirmed in modal', async () => {
      const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})

      mockDeleteContainerImage.mockResolvedValue({ success: true })

      render(<ContainersTab />)

      await waitFor(() => {
        expect(screen.getByText('Container Image Builder')).toBeInTheDocument()
      })

      // Switch to Images tab
      const imagesTab = screen.getByText(/Images/)
      fireEvent.click(imagesTab)

      await waitFor(() => {
        expect(screen.getByText('Available Images')).toBeInTheDocument()
      }, { timeout: 3000 })

      // Find delete button for an unused image (custom-latest with 0 tasks)
      const rows = screen.getAllByRole('row')
      let targetRow: HTMLElement | null = null

      for (const row of rows) {
        if (row.textContent?.includes('pi-agent:custom-latest') && row.textContent?.includes('0 tasks')) {
          targetRow = row
          break
        }
      }

      expect(targetRow).not.toBeNull()

      if (targetRow) {
        const deleteBtn = targetRow.querySelector('button')
        expect(deleteBtn).not.toBeNull()
        if (deleteBtn) {
          fireEvent.click(deleteBtn)

          // Wait for modal with confirmation - look for the modal content
          await waitFor(() => {
            expect(screen.getByText('Delete Image', { selector: 'h3' })).toBeInTheDocument()
          })

          // Look for the red Delete Image button (has bg-accent-danger class)
          const buttons = screen.getAllByRole('button')
          const confirmDeleteBtn = buttons.find(btn => btn.className.includes('accent-danger'))

          expect(confirmDeleteBtn).toBeDefined()
          if (confirmDeleteBtn) {
            fireEvent.click(confirmDeleteBtn)

            // Verify delete API was called
            await waitFor(() => {
              expect(mockDeleteContainerImage).toHaveBeenCalled()
            })
          }
        }
      }

      alertSpy.mockRestore()
    })
  })

  describe('Modal Interactions', () => {
    it('should open save profile modal when Save as New Profile is clicked', async () => {
      render(<ContainersTab />)

      await waitFor(() => {
        expect(screen.getByText('Container Image Builder')).toBeInTheDocument()
      })

      // Select a profile
      const select = screen.getByRole('combobox')
      fireEvent.change(select, { target: { value: 'node-18' } })

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith('/api/container/dockerfile/node-18')
      })

      // Edit Dockerfile to enable save button
      const textarea = screen.getByPlaceholderText(/Select a profile above/)
      fireEvent.change(textarea, { target: { value: 'FROM node:20-alpine' } })

      // Wait for Save as New Profile button to appear
      await waitFor(() => {
        expect(screen.getByText('Save as New Profile')).toBeInTheDocument()
      })

      // Click Save as New Profile
      const saveButton = screen.getByText('Save as New Profile')
      fireEvent.click(saveButton)

      // Check modal opened
      await waitFor(() => {
        expect(screen.getByText('Save as New Profile', { selector: 'h3' })).toBeInTheDocument()
      })

      // Check form fields
      expect(screen.getByPlaceholderText('My Custom Profile')).toBeInTheDocument()
      expect(screen.getByPlaceholderText('my-custom-profile')).toBeInTheDocument()
    })

    it('should close save profile modal when Cancel is clicked', async () => {
      render(<ContainersTab />)

      await waitFor(() => {
        expect(screen.getByText('Container Image Builder')).toBeInTheDocument()
      })

      // Select a profile and edit Dockerfile
      const select = screen.getByRole('combobox')
      fireEvent.change(select, { target: { value: 'node-18' } })

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith('/api/container/dockerfile/node-18')
      })

      const textarea = screen.getByPlaceholderText(/Select a profile above/)
      fireEvent.change(textarea, { target: { value: 'FROM node:20-alpine' } })

      await waitFor(() => {
        expect(screen.getByText('Save as New Profile')).toBeInTheDocument()
      })

      // Open modal
      const saveButton = screen.getByText('Save as New Profile')
      fireEvent.click(saveButton)

      await waitFor(() => {
        expect(screen.getByText('Save as New Profile', { selector: 'h3' })).toBeInTheDocument()
      })

      // Click Cancel
      const cancelButton = screen.getByText('Cancel')
      fireEvent.click(cancelButton)

      // Modal should close
      await waitFor(() => {
        expect(screen.queryByText('Save as New Profile', { selector: 'h3' })).not.toBeInTheDocument()
      })
    })

    it('should open build logs modal when build history item is clicked', async () => {
      render(<ContainersTab />)

      await waitFor(() => {
        expect(screen.getByText('Container Image Builder')).toBeInTheDocument()
      })

      // Wait for build history to load
      await waitFor(() => {
        expect(screen.getByText('Build History')).toBeInTheDocument()
      })

      // Find and click on a build history item
      const buildItems = screen.getAllByText(/Success|Failed/).filter(el => {
        const parent = el.closest('[class*="cursor-pointer"]')
        return parent !== null
      })

      if (buildItems.length > 0) {
        fireEvent.click(buildItems[0])

        // Check logs modal opened
        await waitFor(() => {
          expect(screen.getByText('Build Logs')).toBeInTheDocument()
        })
      }
    })

    it('should close build logs modal when close button is clicked', async () => {
      render(<ContainersTab />)

      await waitFor(() => {
        expect(screen.getByText('Container Image Builder')).toBeInTheDocument()
      })

      // Wait for build history
      await waitFor(() => {
        expect(screen.getByText('Build History')).toBeInTheDocument()
      })

      // Click on a build
      const buildItems = screen.getAllByText(/Success|Failed/).filter(el => {
        const parent = el.closest('[class*="cursor-pointer"]')
        return parent !== null
      })

      if (buildItems.length > 0) {
        fireEvent.click(buildItems[0])

        await waitFor(() => {
          expect(screen.getByText('Build Logs')).toBeInTheDocument()
        })

        // Click close button
        const closeButton = screen.getByText('×')
        fireEvent.click(closeButton)

        // Modal should close
        await waitFor(() => {
          expect(screen.queryByText('Build Logs')).not.toBeInTheDocument()
        })
      }
    })
  })

  describe('Cleanup on Unmount', () => {
    it('should clean up polling timeout when component unmounts', async () => {
      const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})

      let buildStatusCallCount = 0
      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (url === '/api/container/status') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(mockContainerStatus),
          })
        }
        if (url === '/api/container/profiles') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ profiles: mockProfiles }),
          })
        }
        if (url === '/api/container/build-status?limit=10') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ builds: mockBuilds }),
          })
        }
        if (url === '/api/container/images') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ images: mockImages }),
          })
        }
        if (url === '/api/container/dockerfile/node-18') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ dockerfile: mockDockerfile }),
          })
        }
        if (url === '/api/container/build' && options?.method === 'POST') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ buildId: 3 }),
          })
        }
        if (url === '/api/container/build-status?limit=1') {
          buildStatusCallCount++
          // Keep returning running status to keep polling active
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              builds: [{
                id: 3,
                status: 'running',
                startedAt: Date.now(),
                completedAt: null,
                packagesHash: 'xyz789',
                errorMessage: null,
                imageTag: 'pi-agent:test-xyz789',
                logs: 'Building...',
              }],
            }),
          })
        }

        return Promise.resolve({
          ok: false,
          status: 404,
        })
      })

      const { unmount } = render(<ContainersTab />)

      await waitFor(() => {
        expect(screen.getByText('Container Image Builder')).toBeInTheDocument()
      })

      // Select profile and start build
      const select = screen.getByRole('combobox')
      fireEvent.change(select, { target: { value: 'node-18' } })

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith('/api/container/dockerfile/node-18')
      })

      const buildButton = screen.getByText('Save & Build')
      fireEvent.click(buildButton)

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          '/api/container/build',
          expect.objectContaining({ method: 'POST' })
        )
      })

      // Let polling start
      await act(async () => {
        vi.advanceTimersByTime(2100)
      })

      const callsBeforeUnmount = buildStatusCallCount

      // Unmount component
      unmount()

      // Advance time significantly
      await act(async () => {
        vi.advanceTimersByTime(10000)
      })

      // No additional polling calls should have been made after unmount
      expect(buildStatusCallCount).toBe(callsBeforeUnmount)

      alertSpy.mockRestore()
    })
  })

  describe('Concurrent Build Prevention', () => {
    it('should clear existing polling before starting new build', async () => {
      const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})

      let buildIdCounter = 3
      let buildStatusCallCount = 0

      mockFetch.mockImplementation((url: string, options?: RequestInit) => {
        if (url === '/api/container/status') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(mockContainerStatus),
          })
        }
        if (url === '/api/container/profiles') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ profiles: mockProfiles }),
          })
        }
        if (url === '/api/container/build-status?limit=10') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ builds: mockBuilds }),
          })
        }
        if (url === '/api/container/images') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ images: mockImages }),
          })
        }
        if (url === '/api/container/dockerfile/node-18') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ dockerfile: mockDockerfile }),
          })
        }
        if (url === '/api/container/build' && options?.method === 'POST') {
          const currentBuildId = buildIdCounter++
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ buildId: currentBuildId }),
          })
        }
        if (url === '/api/container/build-status?limit=1') {
          buildStatusCallCount++
          // Return success quickly to end the first build, allowing second build to start
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              builds: [{
                id: buildIdCounter - 1,
                status: 'success',
                startedAt: Date.now(),
                completedAt: Date.now(),
                packagesHash: 'xyz789',
                errorMessage: null,
                imageTag: 'pi-agent:test-xyz789',
                logs: 'Build successful',
              }],
            }),
          })
        }

        return Promise.resolve({
          ok: false,
          status: 404,
        })
      })

      render(<ContainersTab />)

      await waitFor(() => {
        expect(screen.getByText('Container Image Builder')).toBeInTheDocument()
      }, { timeout: 3000 })

      // Select profile
      const select = screen.getByRole('combobox')
      fireEvent.change(select, { target: { value: 'node-18' } })

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith('/api/container/dockerfile/node-18')
      }, { timeout: 3000 })

      // Start first build
      const buildButton = screen.getByText('Save & Build')
      fireEvent.click(buildButton)

      await waitFor(() => {
        const buildCalls = mockFetch.mock.calls.filter(call => call[0] === '/api/container/build' && call[1]?.method === 'POST')
        expect(buildCalls.length).toBeGreaterThanOrEqual(1)
      }, { timeout: 3000 })

      // Let first build complete via polling
      await act(async () => {
        vi.advanceTimersByTime(2100)
      })

      // Wait for first build to complete and button to be re-enabled
      await waitFor(() => {
        const button = screen.getByRole('button', { name: /Save & Build/i })
        expect(button).not.toBeDisabled()
      }, { timeout: 3000 })

      // Start second build (first one is complete, so button should be enabled)
      fireEvent.click(buildButton)

      await waitFor(() => {
        // Should have made second build API call
        const buildCalls = mockFetch.mock.calls.filter(call => call[0] === '/api/container/build' && call[1]?.method === 'POST')
        expect(buildCalls.length).toBe(2)
      }, { timeout: 3000 })

      alertSpy.mockRestore()
    })
  })
})
