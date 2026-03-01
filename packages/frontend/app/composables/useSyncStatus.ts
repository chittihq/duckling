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

let pollTimer: ReturnType<typeof setInterval> | null = null
let subscribers = 0
let isFetching = false

export function useSyncStatus() {
  const { get } = useApi()
  const { getApiUrlWithDatabase, selectedDatabaseId } = useDatabase()
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

  const refresh = async () => {
    if (isFetching) return
    isFetching = true
    try {
      const [progress, syncStatus, automationStatus] = await Promise.all([
        get<SyncProgressResponse>(getApiUrlWithDatabase('/sync/progress')),
        get<any>(getApiUrlWithDatabase('/sync/status')),
        get<any>(getApiUrlWithDatabase('/automation/status'))
      ])

      const recentLogs = Array.isArray(syncStatus?.recentLogs) ? syncStatus.recentLogs : []
      const latestSuccess = recentLogs.find((log: any) => log?.status === 'success')
      const latestError = recentLogs.find((log: any) => log?.status === 'error')
      const latestSuccessDate = parseDate(latestSuccess?.created_at || latestSuccess?.createdAt)
      const latestErrorDate = parseDate(latestError?.created_at || latestError?.createdAt)

      const intervalMinutes = Number(automationStatus?.status?.sync?.intervalMinutes || 0)
      const hasSyncSchedule = Boolean(automationStatus?.status?.sync?.enabled && intervalMinutes > 0 && latestSuccessDate)
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
        lastSync: latestSuccessDate ? latestSuccessDate.toISOString() : null,
        nextSync: nextSyncDate ? nextSyncDate.toISOString() : null,
        lastError: progress?.lastError || (shouldShowError ? (latestError?.error_message || latestError?.errorMessage || 'Sync failed') : null),
        lastUpdatedAt: new Date().toISOString()
      }
    } catch {
      syncState.value.lastUpdatedAt = new Date().toISOString()
    } finally {
      isFetching = false
    }
  }

  const startPolling = () => {
    if (!process.client) return
    subscribers += 1
    if (pollTimer) return
    refresh()
    pollTimer = setInterval(refresh, 5000)
  }

  const stopPolling = () => {
    if (!process.client) return
    subscribers = Math.max(0, subscribers - 1)
    if (subscribers > 0 || !pollTimer) return
    clearInterval(pollTimer)
    pollTimer = null
  }

  watch(selectedDatabaseId, () => {
    if (process.client) {
      refresh()
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
