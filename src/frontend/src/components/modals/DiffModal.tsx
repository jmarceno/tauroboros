import { Show, createSignal, createEffect, onCleanup, onMount } from 'solid-js'
import { ModalWrapper } from '../common/ModalWrapper'
import { tasksApi } from '@/api/tasks'
import { runApiEffect } from '@/api'
import type { TaskDiff } from '@/types'

interface DiffModalProps {
  isOpen: boolean
  taskId: string
  taskName: string
  onClose: () => void
}

export function DiffModal(props: DiffModalProps) {
  const [diffs, setDiffs] = createSignal<TaskDiff[]>([])
  const [selectedFile, setSelectedFile] = createSignal<string | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  let diffContainerRef: HTMLDivElement | undefined
  let fileTreeRef: HTMLDivElement | undefined

  let fileDiffInstance: any = null
  let fileTreeInstance: any = null

  const loadDiffs = async () => {
    if (!props.isOpen) return
    setLoading(true)
    setError(null)
    try {
      const response = await runApiEffect(tasksApi.getTaskDiffs(props.taskId))
      setDiffs(response.diffs)
      if (response.diffs.length > 0) {
        setSelectedFile(response.diffs[0].filePath)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  onMount(() => {
    loadDiffs()
  })

  createEffect(() => {
    if (props.isOpen) {
      loadDiffs()
    }
  })

  const renderDiff = (filePath: string) => {
    if (!diffContainerRef) return

    // Clear previous instance by dropping the reference (cleanUp on close only)
    fileDiffInstance = null
    diffContainerRef.innerHTML = ''

    const diff = diffs().find(d => d.filePath === filePath)
    if (!diff) {
      diffContainerRef.textContent = 'No diff content available'
      return
    }

    import('@pierre/diffs').then(({ FileDiff, parsePatchFiles }) => {
      const instance = new FileDiff({
        theme: 'pierre-dark',
        diffStyle: 'split',
        themeType: 'system',
        disableLineNumbers: false,
      })

      try {
        const patches = parsePatchFiles(diff.diffContent)
        const fileDiff = patches?.[0]?.files?.[0]
        if (fileDiff) {
          instance.render({
            containerWrapper: diffContainerRef!,
            fileDiff,
          })
        } else {
          diffContainerRef!.textContent = 'Could not parse diff content'
        }
      } catch {
        diffContainerRef!.textContent = 'Could not parse diff content'
      }

      fileDiffInstance = instance
    }).catch(() => {
      diffContainerRef!.textContent = 'Failed to load diff renderer'
    })
  }

  const tryRenderFileTree = () => {
    if (!fileTreeRef || diffs().length === 0) return

    import('@pierre/trees').then(({ FileTree }) => {
      if (fileTreeInstance) {
        fileTreeInstance.cleanUp()
        fileTreeInstance = null
      }

      const paths = diffs().map(d => d.filePath)

      const tree = new FileTree({
        paths,
        initialExpansion: 'open',
        initialSelectedPaths: selectedFile() ? [selectedFile()!] : [],
        onSelectionChange: (selectedPaths: readonly string[]) => {
          if (selectedPaths.length > 0) {
            setSelectedFile(selectedPaths[0])
          }
        },
      })

      tree.render({
        fileTreeContainer: fileTreeRef!,
      })

      if (selectedFile()) {
        tree.focusPath(selectedFile()!)
      }

      fileTreeInstance = tree
    }).catch(() => {
      if (fileTreeRef) {
        fileTreeRef.textContent = 'File tree unavailable'
      }
    })
  }

  createEffect(() => {
    if (diffs().length > 0) {
      tryRenderFileTree()
    }
  })

  createEffect(() => {
    const currentFile = selectedFile()
    if (currentFile && props.isOpen) {
      renderDiff(currentFile)
    }
  })

  onCleanup(() => {
    if (fileDiffInstance) {
      fileDiffInstance.cleanUp()
      fileDiffInstance = null
    }
    if (fileTreeInstance) {
      fileTreeInstance.cleanUp()
      fileTreeInstance = null
    }
  })

  return (
    <Show when={props.isOpen}>
      <style>{`
        diffs-container { display: block; }
        .modal-overlay:has(.diff-grid) .modal { max-width: 90vw !important; width: 90vw !important; }
      `}</style>
      <ModalWrapper title={`Diffs: ${props.taskName}`} onClose={props.onClose}>
        <div class="diff-grid" style="display: grid; grid-template-columns: 192px 1fr; gap: 1rem;">
          <div>
            <div class="text-sm font-medium text-dark-text-secondary mb-2">Files</div>
            <Show
              when={diffs().length > 0}
              fallback={
                <div class="text-sm text-dark-text-muted">
                  <Show when={loading()} fallback="No diffs available">
                    Loading diffs...
                  </Show>
                </div>
              }
            >
              <div
                ref={fileTreeRef}
                class="border border-dark-border rounded bg-dark-surface2 overflow-auto"
                style="height: 600px;"
              />
            </Show>

            <Show when={error()}>
              <div class="text-xs text-accent-danger mt-2">{error()}</div>
            </Show>
          </div>

          <div style="height: 600px; display: flex; flex-direction: column; min-width: 0;">
            <div class="text-sm font-medium text-dark-text-secondary mb-2">
              {selectedFile() || 'Select a file'}
            </div>
            <Show when={loading()}>
              <div class="flex items-center justify-center h-32 text-dark-text-muted">
                Loading diffs...
              </div>
            </Show>
            <div
              ref={diffContainerRef}
              style="flex: 1; overflow: auto;"
            />
          </div>
        </div>
      </ModalWrapper>
    </Show>
  )
}
