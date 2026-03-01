import { computed } from 'vue'

interface SyncProgressResponse {
  inProgress: boolean
  type: 'full' | 'incremental' | null
  tablesCompleted: number
  tablesTotal: number
  currentTable: string | null
  recordsProcessed: number
  startedAt: string | null
  lastError: string | null
}

interface SyncState {
  isRunning: boolean
  tablesProcessed: number
  totalTables: number
  currentTable: string | null
  recordsProcessed: number
  lastSync: string | null
  nextSync: string | null
  lastError: string | null
  lastUpdatedAt: string | null
}

let eventSource: EventSource | null = null
let subscribers = 0
let heartbeatTimeout: ReturnType<typeof setTimeout> | null = null

export function useSyncStatus() {
  const config = useRuntimeConfig()
  const apiBase = config.public.apiBase
  const { getAuthToken } = useAuth()
  const { selectedDatabaseId } = useDatabase()
  const syncState = useState<SyncState>('sync-status', () => ({
    isRunning: false,
    tablesProcessed: 0,
    totalTables: 0,
    currentTable: null,
    recordsProcessed: 0,
    lastSync: null,
    nextSync: null,
    lastError: null,
    lastUpdatedAt: null
  }))

  const parseDate = (value: unknown): Date | null => {
    if (!value) return null
    const date = new Date(String(value))
    return Number.isNaN(date.getTime()) ? null : date
  }

  const applyEvent = (event: { progress?: SyncProgressResponse; syncStatus?: any; autoStatus?: any }) => {
    const progress = event.progress
    const syncStatus = event.syncStatus
    const automationStatus = event.autoStatus

    const recentLogs = Array.isArray(syncStatus?.recentLogs) ? syncStatus.recentLogs : []
    const latestSuccess = recentLogs.find((log: any) => log?.status === 'success')
    const latestError = recentLogs.find((log: any) => log?.status === 'error')
    const latestSuccessDate = parseDate(latestSuccess?.created_at || latestSuccess?.createdAt)
    const latestErrorDate = parseDate(latestError?.created_at || latestError?.createdAt)

    const intervalMinutes = Number(automationStatus?.sync?.intervalMinutes || 0)
    const hasSyncSchedule = Boolean(automationStatus?.sync?.enabled && intervalMinutes > 0 && latestSuccessDate)
    const nextSyncDate = hasSyncSchedule
      ? new Date(latestSuccessDate!.getTime() + (intervalMinutes * 60 * 1000))
      : null

    const shouldShowError = Boolean(
      latestError &&
      (!latestSuccessDate || (latestErrorDate && latestErrorDate > latestSuccessDate))
    )

    syncState.value = {
      isRunning: Boolean(progress?.inProgress),
      tablesProcessed: Number(progress?.tablesCompleted || 0),
      totalTables: Number(progress?.tablesTotal || 0),
      currentTable: progress?.currentTable || null,
      recordsProcessed: Number(progress?.recordsProcessed || 0),
      lastSync: syncState.value.lastSync,
      nextSync: syncState.value.nextSync,
      lastError: progress?.lastError || (shouldShowError ? (latestError?.error_message || latestError?.errorMessage || 'Sync failed') : null),
      lastUpdatedAt: new Date().toISOString()
    }

    // Only update lastSync/nextSync when we have syncStatus data (initial full state)
    if (syncStatus) {
      syncState.value.lastSync = latestSuccessDate ? latestSuccessDate.toISOString() : syncState.value.lastSync
      syncState.value.nextSync = nextSyncDate ? nextSyncDate.toISOString() : syncState.value.nextSync
    }
  }

  const connect = () => {
    disconnect()
    const token = getAuthToken()
    const dbId = selectedDatabaseId.value
    const url = `${apiBase}/sync/events?db=${dbId}${token ? `&token=${token}` : ''}`
    eventSource = new EventSource(url)

    eventSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data)
        applyEvent(data)
      } catch {
        // ignore malformed messages
      }
    }

    eventSource.onerror = () => {
      // Browser auto-reconnects EventSource; no custom retry needed
    }
  }

  const disconnect = () => {
    if (eventSource) {
      eventSource.close()
      eventSource = null
    }
    if (heartbeatTimeout) {
      clearTimeout(heartbeatTimeout)
      heartbeatTimeout = null
    }
  }

  const refresh = async () => {
    // For SSE, reconnecting fetches fresh state
    if (subscribers > 0) {
      connect()
    }
  }

  const startPolling = () => {
    if (!process.client) return
    subscribers += 1
    if (eventSource) return
    connect()
  }

  const stopPolling = () => {
    if (!process.client) return
    subscribers = Math.max(0, subscribers - 1)
    if (subscribers > 0) return
    disconnect()
  }

  watch(selectedDatabaseId, () => {
    if (process.client && subscribers > 0) {
      connect()
    }
  })

  const statusType = computed<'syncing' | 'error' | 'idle' | 'scheduled'>(() => {
    if (syncState.value.isRunning) return 'syncing'
    if (syncState.value.lastError) return 'error'
    if (!syncState.value.lastSync && syncState.value.nextSync) return 'scheduled'
    return 'idle'
  })

  return {
    syncState: computed(() => syncState.value),
    statusType,
    refresh,
    startPolling,
    stopPolling
  }
}
