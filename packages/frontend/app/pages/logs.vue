<script setup lang="ts">
import { ref, computed, onBeforeUnmount } from 'vue'

definePageMeta({
  middleware: 'auth',
  layout: 'default'
})

const config = useRuntimeConfig()
const apiBase = config.public.apiBase

interface SyncLog {
  id: number
  table_name: string
  sync_type: string
  records_processed: number
  duration_ms: number
  status: 'success' | 'error'
  error_message?: string
  created_at: string
}

const logs = ref<SyncLog[]>([])
const isPolling = ref(false)
const isPaused = ref(false)
const autoScroll = ref(true)
const pollInterval = ref<ReturnType<typeof setInterval> | null>(null)
const lastUpdate = ref<number | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const filters = ref<{ status: string[] }>({ status: [] })
const logsContainer = ref<HTMLElement | null>(null)

const startPolling = () => {
  isPolling.value = true
  fetchLogs() // Initial fetch

  // Poll every 5 seconds for sync logs
  pollInterval.value = setInterval(() => {
    if (!isPaused.value) {
      fetchLogs()
    }
  }, 5000)
}

const stopPolling = () => {
  isPolling.value = false
  if (pollInterval.value) {
    clearInterval(pollInterval.value)
    pollInterval.value = null
  }
}

const fetchLogs = async () => {
  if (loading.value) return

  loading.value = true
  error.value = null

  try {
    const params = new URLSearchParams({ limit: '100' })

    if (filters.value.status.length > 0) {
      params.append('status', filters.value.status.join(','))
    }

    const response = await $fetch<{ success: boolean; logs: SyncLog[] }>(
      `${apiBase}/api/sync-logs?${params}`,
      { credentials: 'include' }
    )

    if (response.success && response.logs) {
      logs.value = response.logs
      lastUpdate.value = Date.now()

      // Auto-scroll if enabled
      if (autoScroll.value) {
        scrollToBottom()
      }
    }
  } catch (err: any) {
    console.error('Failed to fetch sync logs:', error)
    error.value = err.message || 'Unknown error'
  } finally {
    loading.value = false
  }
}

const toggleStatus = (status: string) => {
  const index = filters.value.status.indexOf(status)
  if (index > -1) {
    filters.value.status.splice(index, 1)
  } else {
    filters.value.status.push(status)
  }
  fetchLogs()
}

const togglePause = () => {
  isPaused.value = !isPaused.value
}

const clearLogs = () => {
  logs.value = []
}

const scrollToBottom = () => {
  setTimeout(() => {
    if (logsContainer.value) {
      logsContainer.value.scrollTop = logsContainer.value.scrollHeight
    }
  }, 100)
}

const handleScroll = () => {
  if (logsContainer.value) {
    const isScrolledToBottom =
      logsContainer.value.scrollHeight - logsContainer.value.scrollTop <=
      logsContainer.value.clientHeight + 50
    autoScroll.value = isScrolledToBottom
  }
}

const formatLogTime = (timestamp: string) => {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  return date.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3
  })
}

const formatTime = (timestamp: number) => {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  return date.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

const filteredLogs = computed(() => {
  if (filters.value.status.length === 0) {
    return logs.value
  }
  return logs.value.filter(log => filters.value.status.includes(log.status))
})

onMounted(() => {
  startPolling()
})

onBeforeUnmount(() => {
  stopPolling()
})
</script>

<template>
  <div class="flex flex-col h-full">
    <!-- Header -->
    <header class="border-b bg-card px-6 py-4">
      <div class="flex justify-between items-center">
        <div>
          <h1 class="text-2xl font-bold">Sync Logs</h1>
          <p class="text-sm text-muted-foreground">Real-time table synchronization activity</p>
        </div>
        <div class="flex gap-2 items-center">
          <div class="flex gap-1 bg-muted p-1 rounded-md">
            <Button
              @click="toggleStatus('success')"
              :variant="filters.status.includes('success') ? 'secondary' : 'ghost'"
              size="sm"
            >
              Success
            </Button>
            <Button
              @click="toggleStatus('error')"
              :variant="filters.status.includes('error') ? 'secondary' : 'ghost'"
              size="sm"
            >
              Error
            </Button>
          </div>
          <Button
            @click="togglePause()"
            :disabled="!isPolling"
            variant="outline"
            size="sm"
          >
            {{ isPaused ? 'Resume' : 'Pause' }}
          </Button>
          <Button
            @click="clearLogs()"
            variant="outline"
            size="sm"
          >
            Clear
          </Button>
          <Button
            @click="scrollToBottom()"
            variant="outline"
            size="sm"
          >
            Scroll Down
          </Button>
          <label class="flex items-center gap-2 text-sm">
            <input v-model="autoScroll" type="checkbox" class="rounded" />
            Auto-scroll
          </label>
        </div>
      </div>
    </header>

    <!-- Content -->
    <div class="flex-1 overflow-hidden p-6">
      <div class="bg-card border rounded-lg h-full flex flex-col">
        <!-- Status Bar -->
        <div class="border-b px-4 py-3 flex items-center justify-between bg-muted/50">
          <div class="flex items-center gap-2">
            <div
              class="w-2 h-2 rounded-full"
              :class="isPolling ? 'bg-green-500 animate-pulse' : 'bg-red-500'"
            ></div>
            <span class="text-sm">{{ isPolling ? 'Auto-refresh enabled' : 'Auto-refresh disabled' }}</span>
          </div>
          <span class="text-sm text-muted-foreground">
            <span>{{ logs.length }}</span> sync operations
            <span v-if="filters.status.length === 0">(all)</span>
            <span v-else>(showing: {{ filters.status.join(', ') }})</span>
            <span v-if="lastUpdate" class="ml-2">
              Last update: {{ formatTime(lastUpdate) }}
            </span>
          </span>
        </div>

        <!-- Logs Container -->
        <div
          ref="logsContainer"
          @scroll="handleScroll()"
          class="flex-1 overflow-auto font-mono text-xs"
        >
          <div
            v-for="log in filteredLogs"
            :key="log.id"
            class="flex items-start gap-3 px-4 py-2 border-b hover:bg-accent transition-colors"
            :class="{
              'bg-red-500/10 border-l-4 border-l-red-500': log.status === 'error',
              'bg-green-500/10 border-l-4 border-l-green-500': log.status === 'success'
            }"
          >
            <div class="text-muted-foreground min-w-[90px] flex-shrink-0">
              {{ formatLogTime(log.created_at) }}
            </div>
            <div
              class="min-w-[60px] flex-shrink-0 font-semibold uppercase"
              :class="{
                'text-red-500': log.status === 'error',
                'text-green-500': log.status === 'success'
              }"
            >
              {{ log.status }}
            </div>
            <div class="flex-1">
              <div>
                <span class="inline-block bg-accent px-2 py-0.5 rounded font-medium">
                  {{ log.table_name }}
                </span>
                <span v-if="log.error_message" class="ml-2 text-red-500">
                  {{ log.error_message }}
                </span>
              </div>
              <div class="flex gap-4 mt-1 text-muted-foreground">
                <div>
                  <span>Type:</span>
                  <strong class="ml-1">{{ log.sync_type }}</strong>
                </div>
                <div>
                  <span>Records:</span>
                  <strong class="ml-1">{{ log.records_processed?.toLocaleString() || '0' }}</strong>
                </div>
                <div>
                  <span>Duration:</span>
                  <strong class="ml-1">{{ log.duration_ms }}ms</strong>
                </div>
              </div>
            </div>
          </div>

          <!-- Empty State -->
          <div v-if="filteredLogs.length === 0 && !loading" class="text-center py-12 text-muted-foreground">
            <svg class="mx-auto mb-4 opacity-50" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
            </svg>
            <h3 class="font-medium mb-2">No sync logs to display</h3>
            <p class="text-sm">
              <span v-if="filters.status.length > 0">Try adjusting the status filters</span>
              <span v-else>No sync operations recorded yet</span>
            </p>
          </div>

          <!-- Loading State -->
          <div v-if="loading && logs.length === 0" class="text-center py-12 text-muted-foreground">
            <div class="inline-block w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin mb-4"></div>
            <h3 class="font-medium mb-2">Loading sync logs...</h3>
          </div>

          <!-- Error State -->
          <div v-if="error && !loading" class="text-center py-12 text-muted-foreground">
            <svg class="mx-auto mb-4 opacity-50" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="8" x2="12" y2="12"/>
              <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <h3 class="font-medium mb-2">Failed to load logs</h3>
            <p class="text-sm mb-4">{{ error }}</p>
            <Button
              @click="fetchLogs()"
              size="sm"
            >
              Retry
            </Button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
