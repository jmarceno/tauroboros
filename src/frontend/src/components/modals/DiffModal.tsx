import { Show, For, createSignal, createEffect, onCleanup, onMount } from 'solid-js'
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
    diffContainerRef.innerHTML = ''

    const diff = diffs().find(d => d.filePath === filePath)
    if (!diff) {
      diffContainerRef.textContent = 'No diff content available'
      return
    }

    import('@pierre/diffs').then(({ FileDiff, parsePatchFiles }) => {
      if (fileDiffInstance) {
        fileDiffInstance.cleanUp()
        fileDiffInstance = null
      }

      const instance = new FileDiff({
        diffStyle: 'unified',
        themeType: 'system',
        disableLineNumbers: false,
      })

      try {
        const patch: any = parsePatchFiles(diff.diffContent)
        const fileDiff = patch.files?.[0]
        if (fileDiff) {
          instance.render({
            fileContainer: diffContainerRef!,
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

    import('@pierre/trees').then(({ FileTree, prepareFileTreeInput }) => {
      if (fileTreeInstance) {
        fileTreeInstance.cleanUp()
        fileTreeInstance = null
      }

      const paths = diffs().map(d => d.filePath)
      const prepared = prepareFileTreeInput(paths)

      const tree = new FileTree({
        preparedInput: prepared,
        initialExpansion: 'open',
      })

      tree.render({
        fileTreeContainer: fileTreeRef!,
      })

      fileTreeInstance = tree
    }).catch(() => {
      if (fileTreeRef) {
        fileTreeRef.textContent = 'File tree unavailable'
      }
    })
  }

  createEffect(() => {
    const currentDiffs = diffs()
    if (currentDiffs.length > 0) {
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

  const fileList = () => diffs().map(d => d.filePath)

  return (
    <Show when={props.isOpen}>
      <ModalWrapper title={`Diffs: ${props.taskName}`} onClose={props.onClose} size="xl">
        <div class="flex gap-4">
          <div class="w-64 flex-shrink-0">
            <div class="text-sm font-medium text-dark-text-secondary mb-2">Files</div>
            <Show
              when={fileList().length > 0}
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
                style="max-height: 500px;"
              />
              <div class="mt-2 space-y-0.5">
                <For each={fileList()}>
                  {(filePath) => (
                    <button
                      class={`w-full text-left px-2 py-1 text-xs rounded transition-colors ${
                        selectedFile() === filePath
                          ? 'bg-accent-primary/20 text-accent-primary'
                          : 'text-dark-text-secondary hover:bg-dark-surface hover:text-dark-text'
                      }`}
                      onClick={() => setSelectedFile(filePath)}
                    >
                      {filePath}
                    </button>
                  )}
                </For>
              </div>
            </Show>

            <Show when={error()}>
              <div class="text-xs text-accent-danger mt-2">{error()}</div>
            </Show>
          </div>

          <div class="flex-1 min-w-0">
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
              class="border border-dark-border rounded bg-dark-surface2 overflow-auto"
              style="min-height: 300px; max-height: 600px;"
            />
          </div>
        </div>
      </ModalWrapper>
    </Show>
  )
}
