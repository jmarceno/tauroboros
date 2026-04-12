import { ref, onMounted } from 'vue'
import { useApi } from './useApi'

export function useVersion() {
  const version = ref<string | null>(null)
  const loading = ref(true)
  const error = ref<string | null>(null)

  const api = useApi()

  onMounted(async () => {
    try {
      const response = await api.getVersion()
      version.value = response.displayVersion
    } catch (e) {
      error.value = 'Failed to load version'
    } finally {
      loading.value = false
    }
  })

  return { version, loading, error }
}
